/*
 * Family Clock — ESP32 firmware
 *
 * Drives 3 quartz clock movements (Lavet-motor hack) and 3× 2.9" e-paper
 * labels (296×128 px, Waveshare-compatible) over SPI. Polls a Cloudflare
 * Worker every 15 minutes for each kid's timezone offset, city, and
 * country, then ticks each clock's hands toward the correct local time.
 *
 * @decision DEC-EPAPER-001 / DEC-EPAPER-002
 * OLEDs (SSD1306) → 2.9" Waveshare e-paper (~$23 each × 3 = ~$70).
 * Reason: 0.96" SSD1306 panels were unreadable across a room; 2.9" e-paper
 * gives 8× active area (296×128 vs 128×64), no burn-in over years on a wall,
 * paper-print aesthetic. Library swapped from Adafruit_SSD1306 → GxEPD2_BW.
 * BUSY pins added on 34/35/39 (input-only ESP32 GPIOs, otherwise unused).
 *
 * Hardware (default ESP32 dev board pin map; adjust below if needed):
 *   Shared SPI:            SCK=18, MOSI=23
 *   E-paper RST (shared):  4
 *   Display 0:             CS=5,  DC=17, BUSY=34
 *   Display 1:             CS=14, DC=16, BUSY=35
 *   Display 2:             CS=21, DC=22, BUSY=39
 *   Motor 0 coil:          A=25, B=26
 *   Motor 1 coil:          A=27, B=13
 *   Motor 2 coil:          A=32, B=33
 *   Hall sensors:          0=36, 1=19, 2=15
 *
 * Required libraries (Library Manager):
 *   - WiFiManager by tzapu
 *   - ArduinoJson (v7+)
 *   - GxEPD2 (by Jean-Marc Zingg)
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
#include <GxEPD2_BW.h>
#include <Fonts/FreeSerifBold24pt7b.h>
#include <Fonts/FreeSerif12pt7b.h>

// ===== CONFIG ===========================================================

#define SERVER_URL  "https://family-clock.YOUR-SUBDOMAIN.workers.dev/clock/YOUR_CLOCK_TOKEN"
#define POLL_INTERVAL_MS  (15UL * 60UL * 1000UL)
#define HOMING_TIMEOUT_MS (90UL * 1000UL)
#define LAVET_PULSE_MS    35    // 30-50 ms typical for hacked quartz movements
#define MOTOR_TICK_MIN_MS 30    // minimum spacing between any two pulses

// Pin map (see header comment)
const int MOTOR_PINS[3][2] = { {25, 26}, {27, 13}, {32, 33} };
const int HALL_PINS[3]      = { 36, 19, 15 };
const int EPD_RST_SHARED    = 4;

// BUSY pins on ESP32 input-only GPIOs (34, 35, 39 cannot be output pins —
// they have no output driver, so they are safe to use as BUSY inputs only).
const int BUSY_0 = 34;
const int BUSY_1 = 35;
const int BUSY_2 = 39;

// E-paper display dimensions: 2.9" panel is 296 px wide × 128 px tall.
#define EPD_W 296
#define EPD_H 128

// GxEPD2_BW display instances — share SCK/MOSI/RST, separate CS/DC/BUSY.
//
// Default constructor: GxEPD2_290_BS (UC8151 driver IC, Waveshare V2 common).
//
// DRIVER IC VARIANT WARNING: 2.9" modules ship with either a UC8151 or SSD1675
// driver IC depending on vendor and revision. GxEPD2 provides different
// constructors for each:
//   UC8151  → GxEPD2_290_BS   (try this first)
//   SSD1675 → GxEPD2_290_T94  (try if panel stays blank or scrambles on boot)
//   Older   → GxEPD2_290      (try if both above fail)
// Only physical bring-up determines which constructor matches your module.
GxEPD2_BW<GxEPD2_290_BS, GxEPD2_290_BS::HEIGHT> display0(
    GxEPD2_290_BS(/*CS=*/ 5,  /*DC=*/ 17, /*RST=*/ EPD_RST_SHARED, /*BUSY=*/ BUSY_0));
GxEPD2_BW<GxEPD2_290_BS, GxEPD2_290_BS::HEIGHT> display1(
    GxEPD2_290_BS(/*CS=*/ 14, /*DC=*/ 16, /*RST=*/ EPD_RST_SHARED, /*BUSY=*/ BUSY_1));
GxEPD2_BW<GxEPD2_290_BS, GxEPD2_290_BS::HEIGHT> display2(
    GxEPD2_290_BS(/*CS=*/ 21, /*DC=*/ 22, /*RST=*/ EPD_RST_SHARED, /*BUSY=*/ BUSY_2));

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

// Previous label values per kid — tracked to avoid full e-paper refresh when
// nothing changed. Full refresh (~2 sec, briefly visible) only runs when the
// displayed name+city differ from the last drawn value.
String        prevName[3];
String        prevCity[3];

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
  // GxEPD2 init: 115200 baud diagnostic serial, SPIClass, no reset on power-up.
  // Each call wakes the panel and performs the hardware reset sequence.
  display0.init(115200);
  display1.init(115200);
  display2.init(115200);
  Serial.println("[epd] displays initialised");
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

// ===== E-PAPER LABELS ===================================================

/**
 * Helper: draw a full-refresh frame on one e-paper display.
 * Sets white background, then renders nameStr (large serif bold) centred
 * in the upper portion and cityStr (smaller serif) centred below.
 * Calls display(false) for a full refresh — visible ~2 sec flicker.
 *
 * @decision DEC-EPAPER-004
 * Font theme A (Editorial): FreeSerifBold24pt7b for kid name (visually
 * similar to Playfair Display used in web preview) and FreeSerif12pt7b
 * for city (similar to Lora). These are bundled with Adafruit GFX — no
 * custom font conversion needed.
 *
 * Cursor positions are hand-tuned for 296×128 landscape e-paper:
 *   Name:  baseline at y=68 (FreeSerifBold24pt7b cap-height ~36px, so
 *          top of text ≈ y=32; centred with a rough X calculation)
 *   City:  baseline at y=105 (FreeSerif12pt7b cap-height ~16px)
 * Text centering uses getTextBounds() when available; falls back to a
 * fixed left margin if bounds are zero (first-call edge case).
 */
static void drawEpaperLabel(GxEPD2_BW<GxEPD2_290_BS, GxEPD2_290_BS::HEIGHT>& d,
                             const String& nameStr, const String& cityStr) {
  d.setRotation(1);  // landscape: 296 wide × 128 tall
  d.setFullWindow();
  d.firstPage();
  do {
    d.fillScreen(GxEPD_WHITE);
    d.setTextColor(GxEPD_BLACK);

    // ---- Name (large bold serif) ----------------------------------------
    d.setFont(&FreeSerifBold24pt7b);
    String nameUp = nameStr;
    nameUp.toUpperCase();
    int16_t bx, by;
    uint16_t bw, bh;
    d.getTextBounds(nameUp, 0, 0, &bx, &by, &bw, &bh);
    int16_t nx = (bw > 0) ? ((EPD_W - (int16_t)bw) / 2 - bx) : 8;
    int16_t ny = 68;  // baseline; cap-height ~36px → top ≈ y=32 (centred vertically in top 80px)
    d.setCursor(nx, ny);
    d.print(nameUp);

    // ---- City + country (smaller serif) ----------------------------------
    d.setFont(&FreeSerif12pt7b);
    d.getTextBounds(cityStr, 0, 0, &bx, &by, &bw, &bh);
    int16_t cx = (bw > 0) ? ((EPD_W - (int16_t)bw) / 2 - bx) : 8;
    int16_t cy = 108;  // baseline; cap-height ~16px → top ≈ y=92
    d.setCursor(cx, cy);
    d.print(cityStr);

  } while (d.nextPage());
}

void drawSplash() {
  // One-time boot splash: "Family Clock" centred on all three panels.
  // Uses a full refresh — acceptable at power-on before WiFi connects.
  auto doSplash = [](GxEPD2_BW<GxEPD2_290_BS, GxEPD2_290_BS::HEIGHT>& d) {
    d.setRotation(1);
    d.setFullWindow();
    d.firstPage();
    do {
      d.fillScreen(GxEPD_WHITE);
      d.setTextColor(GxEPD_BLACK);
      d.setFont(&FreeSerifBold24pt7b);
      const char* title = "Family Clock";
      int16_t bx, by;
      uint16_t bw, bh;
      d.getTextBounds(title, 0, 0, &bx, &by, &bw, &bh);
      int16_t tx = (bw > 0) ? ((EPD_W - (int16_t)bw) / 2 - bx) : 8;
      d.setCursor(tx, 68);
      d.print(title);
    } while (d.nextPage());
  };
  doSplash(display0);
  doSplash(display1);
  doSplash(display2);
  Serial.println("[epd] splash drawn");
}

void drawLabels() {
  // Full refresh only when content changed for a given kid slot.
  // First call after boot always refreshes (prevName/prevCity are empty).
  // Refresh strategy: track previous (name, city) per display; skip the
  // ~2 sec full refresh if content is unchanged — e-paper holds the image
  // indefinitely with zero power.
  for (int i = 0; i < 3; i++) {
    String newCity = "";
    String newName = kids[i].valid ? kids[i].name : "";
    if (kids[i].valid) {
      newCity = kids[i].city;
      if (kids[i].country.length() > 0) {
        newCity += ", ";
        newCity += kids[i].country;
      }
    }

    if (newName == prevName[i] && newCity == prevCity[i]) {
      continue;  // content unchanged — no refresh needed
    }

    Serial.printf("[epd] display %d updating: '%s' / '%s'\n",
                  i, newName.c_str(), newCity.c_str());

    auto doUpdate = [&](GxEPD2_BW<GxEPD2_290_BS, GxEPD2_290_BS::HEIGHT>& d) {
      if (kids[i].valid) {
        drawEpaperLabel(d, newName, newCity);
      } else {
        // Kid removed — blank the panel.
        d.setFullWindow();
        d.firstPage();
        do { d.fillScreen(GxEPD_WHITE); } while (d.nextPage());
      }
    };

    if      (i == 0) doUpdate(display0);
    else if (i == 1) doUpdate(display1);
    else             doUpdate(display2);

    prevName[i] = newName;
    prevCity[i] = newCity;
  }
}
