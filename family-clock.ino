/*
 * Family Clock — ESP32 firmware
 *
 * Drives 3 quartz clock movements (Lavet-motor hack) and 3 small SSD1306
 * 128x64 OLED labels over SPI. Polls a Cloudflare Worker every 15 minutes
 * for each kid's timezone offset, city, and country, then ticks each
 * clock's hands toward the correct local time.
 *
 * @decision OLEDs (SSD1306) instead of e-paper: cheaper (~$10/3 vs $50/3),
 * faster Amazon shipping, brighter at a distance. Tradeoff is ~60 mA
 * always-on draw and burn-in risk over years; mitigated by USB wall
 * power and labels that change rarely (only on travel).
 *
 * Hardware (default ESP32 dev board pin map; adjust below if needed):
 *   Shared SPI:            SCK=18, MOSI=23
 *   OLED RST (shared):     4
 *   Display 0:             CS=5,  DC=17
 *   Display 1:             CS=14, DC=16
 *   Display 2:             CS=21, DC=22
 *   Motor 0 coil:          A=25, B=26
 *   Motor 1 coil:          A=27, B=13
 *   Motor 2 coil:          A=32, B=33
 *   Hall sensors:          0=36, 1=19, 2=15
 *
 * Required libraries (Library Manager):
 *   - WiFiManager by tzapu
 *   - ArduinoJson (v7+)
 *   - Adafruit SSD1306
 *   - Adafruit GFX
 *
 * Configure SERVER_URL below before flashing.
 */

#include <Arduino.h>
#include <SPI.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <time.h>

#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Fonts/FreeSansBold9pt7b.h>
#include <Fonts/FreeSans9pt7b.h>

// ===== CONFIG ===========================================================

#define SERVER_URL  "https://family-clock.YOUR-SUBDOMAIN.workers.dev/clock/YOUR_CLOCK_TOKEN"
#define POLL_INTERVAL_MS  (15UL * 60UL * 1000UL)
#define HOMING_TIMEOUT_MS (90UL * 1000UL)
#define LAVET_PULSE_MS    35    // 30-50 ms typical for hacked quartz movements
#define MOTOR_TICK_MIN_MS 30    // minimum spacing between any two pulses

// Pin map (see header comment)
const int MOTOR_PINS[3][2] = { {25, 26}, {27, 13}, {32, 33} };
const int HALL_PINS[3]      = { 36, 19, 15 };
const int OLED_RST_SHARED   = 4;

#define OLED_W 128
#define OLED_H 64

// SSD1306 SPI instances — share SCK/MOSI/RST, separate CS and DC per display.
Adafruit_SSD1306 display0(OLED_W, OLED_H, &SPI, /*DC=*/ 17, /*RST=*/ OLED_RST_SHARED, /*CS=*/ 5);
Adafruit_SSD1306 display1(OLED_W, OLED_H, &SPI, /*DC=*/ 16, /*RST=*/ OLED_RST_SHARED, /*CS=*/ 14);
Adafruit_SSD1306 display2(OLED_W, OLED_H, &SPI, /*DC=*/ 22, /*RST=*/ OLED_RST_SHARED, /*CS=*/ 21);

// ===== STATE ============================================================

struct Kid {
  String  id;
  String  name;
  String  city;
  String  country;
  long    offsetSeconds;
  bool    valid;
};

Kid           kids[3];
int           handPosSec[3]   = { -1, -1, -1 };   // 0..43199; -1 = unknown
bool          lavetPolarity[3]= { false, false, false };
unsigned long lastPulseMs     = 0;
unsigned long lastPollMs      = 0;
bool          labelsDirty     = true;
Preferences   prefs;

// ===== ENTRY POINTS =====================================================

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[boot] family-clock starting");

  initPins();
  prefs.begin("clock", false);
  loadHandPositions();

  initDisplays();
  drawSplash();

  connectWifi();
  syncNtp();

  // Home any clock whose hand position we don't trust.
  for (int i = 0; i < 3; i++) {
    if (handPosSec[i] < 0) homeClock(i);
  }

  fetchKids();
  lastPollMs = millis();
}

void loop() {
  if (millis() - lastPollMs > POLL_INTERVAL_MS) {
    fetchKids();
    lastPollMs = millis();
  }

  if (labelsDirty) {
    drawLabels();
    labelsDirty = false;
  }

  tickClocks();
}

// ===== INIT =============================================================

void initPins() {
  for (int i = 0; i < 3; i++) {
    pinMode(MOTOR_PINS[i][0], OUTPUT);
    pinMode(MOTOR_PINS[i][1], OUTPUT);
    digitalWrite(MOTOR_PINS[i][0], LOW);
    digitalWrite(MOTOR_PINS[i][1], LOW);
    pinMode(HALL_PINS[i], INPUT_PULLUP);
  }
}

void initDisplays() {
  Adafruit_SSD1306* dpys[3] = { &display0, &display1, &display2 };
  for (int i = 0; i < 3; i++) {
    if (!dpys[i]->begin(SSD1306_SWITCHCAPVCC)) {
      Serial.printf("[oled] display %d init failed\n", i);
    }
    dpys[i]->clearDisplay();
    dpys[i]->setTextColor(SSD1306_WHITE);
    dpys[i]->display();
  }
}

void connectWifi() {
  WiFiManager wm;
  wm.setConfigPortalTimeout(300);
  if (!wm.autoConnect("FamilyClockSetup")) {
    Serial.println("[wifi] portal timed out — restarting");
    ESP.restart();
  }
  Serial.print("[wifi] connected: ");
  Serial.println(WiFi.localIP());
}

void syncNtp() {
  // We always work in UTC and apply per-kid offsets ourselves.
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  Serial.print("[ntp] syncing");
  while (time(nullptr) < 1700000000) {
    Serial.print(".");
    delay(500);
  }
  Serial.println(" done");
}

void loadHandPositions() {
  for (int i = 0; i < 3; i++) {
    String key = "pos" + String(i);
    handPosSec[i] = prefs.getInt(key.c_str(), -1);
  }
}

void savePosition(int i) {
  String key = "pos" + String(i);
  prefs.putInt(key.c_str(), handPosSec[i]);
}

// ===== LAVET MOTOR ======================================================

/**
 * One Lavet step: drive coil one direction for LAVET_PULSE_MS, then idle.
 * Next call drives the opposite direction. Each call advances the second
 * hand exactly one tick.
 */
void pulseLavet(int i) {
  int a = MOTOR_PINS[i][0];
  int b = MOTOR_PINS[i][1];
  if (lavetPolarity[i]) {
    digitalWrite(a, HIGH); digitalWrite(b, LOW);
  } else {
    digitalWrite(a, LOW);  digitalWrite(b, HIGH);
  }
  delay(LAVET_PULSE_MS);
  digitalWrite(a, LOW);
  digitalWrite(b, LOW);
  lavetPolarity[i] = !lavetPolarity[i];
}

/** Pulse motor i until its Hall sensor sees the magnet (12 o'clock). */
void homeClock(int i) {
  Serial.printf("[home] clock %d homing...\n", i);
  unsigned long start = millis();
  while (digitalRead(HALL_PINS[i]) == HIGH) {
    pulseLavet(i);
    delay(MOTOR_TICK_MIN_MS);
    if (millis() - start > HOMING_TIMEOUT_MS) {
      Serial.printf("[home] clock %d TIMEOUT\n", i);
      return;
    }
  }
  handPosSec[i] = 0;
  savePosition(i);
  Serial.printf("[home] clock %d found 12 o'clock\n", i);
}

// ===== TICK LOGIC =======================================================

/**
 * Each iteration advances at most one motor by one tick. Spreads the
 * pulses out so we don't draw too much current at once and keeps the
 * main loop responsive.
 */
void tickClocks() {
  if (millis() - lastPulseMs < MOTOR_TICK_MIN_MS) return;

  time_t now = time(nullptr);
  if (now < 1700000000) return;  // NTP not ready

  for (int i = 0; i < 3; i++) {
    if (!kids[i].valid || handPosSec[i] < 0) continue;

    long localSecOfDay =
        ((long)((now + kids[i].offsetSeconds) % 86400L) + 86400L) % 86400L;
    int target = localSecOfDay % 43200;  // 12-hour face

    if (handPosSec[i] != target) {
      pulseLavet(i);
      handPosSec[i] = (handPosSec[i] + 1) % 43200;
      if (handPosSec[i] % 60 == 0) savePosition(i);
      lastPulseMs = millis();
      return;  // one tick per loop pass
    }
  }
}

// ===== HTTP =============================================================

void fetchKids() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[http] no wifi");
    return;
  }

  WiFiClientSecure client;
  client.setInsecure();  // workers.dev cert chain — pin if you want stricter

  HTTPClient http;
  http.begin(client, SERVER_URL);
  http.setTimeout(10000);
  int code = http.GET();
  if (code != 200) {
    Serial.printf("[http] GET failed: %d\n", code);
    http.end();
    return;
  }

  String body = http.getString();
  http.end();

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, body);
  if (err) {
    Serial.printf("[json] parse error: %s\n", err.c_str());
    return;
  }
  if (!doc.is<JsonArray>()) {
    Serial.println("[json] expected array");
    return;
  }

  // Snapshot prior validity so we can detect removed kids below.
  bool prevValid[3];
  for (int i = 0; i < 3; i++) prevValid[i] = kids[i].valid;

  // Reset validity before parsing — slots not present in the response
  // (kid removed from KV) end this function with valid=false.
  for (int i = 0; i < 3; i++) kids[i].valid = false;

  bool changed = false;
  JsonArray arr = doc.as<JsonArray>();
  int n = min((int)arr.size(), 3);
  for (int i = 0; i < n; i++) {
    String name    = arr[i]["name"]    | "";
    String city    = arr[i]["city"]    | "Unknown";
    String country = arr[i]["country"] | "";
    long   offset  = arr[i]["offset_seconds"] | 0L;
    String id      = arr[i]["id"]      | "";

    if (!prevValid[i] || kids[i].name != name || kids[i].city != city ||
        kids[i].country != country || kids[i].offsetSeconds != offset) {
      changed = true;
    }
    kids[i].id = id;
    kids[i].name = name;
    kids[i].city = city;
    kids[i].country = country;
    kids[i].offsetSeconds = offset;
    kids[i].valid = true;
  }

  // A slot that was valid before but isn't now means a kid was removed.
  for (int i = n; i < 3; i++) {
    if (prevValid[i]) changed = true;
  }

  if (changed) labelsDirty = true;
  Serial.printf("[http] got %d kids (changed=%d)\n", n, changed);
}

// ===== OLED LABELS ======================================================

void drawSplash() {
  Adafruit_SSD1306* dpys[3] = { &display0, &display1, &display2 };
  const char* lines[3] = { "Connecting", "to WiFi...", "" };
  for (int i = 0; i < 3; i++) {
    auto* d = dpys[i];
    d->clearDisplay();
    d->setTextColor(SSD1306_WHITE);
    d->setFont(&FreeSansBold9pt7b);
    d->setCursor(2, 38);
    d->print(lines[i]);
    d->display();
  }
}

void drawLabels() {
  Adafruit_SSD1306* dpys[3] = { &display0, &display1, &display2 };

  for (int i = 0; i < 3; i++) {
    auto* d = dpys[i];
    // clearDisplay() blanks the buffer; removed-kid slots end up empty.
    d->clearDisplay();
    if (kids[i].valid) {
      d->setTextColor(SSD1306_WHITE);

      d->setFont(&FreeSansBold9pt7b);
      d->setCursor(2, 18);
      d->print(kids[i].name);

      d->setFont(&FreeSans9pt7b);
      d->setCursor(2, 40);
      String place = kids[i].city;
      if (kids[i].country.length() > 0) {
        place += ", ";
        place += kids[i].country;
      }
      d->print(place);
    }
    d->display();
  }
}
