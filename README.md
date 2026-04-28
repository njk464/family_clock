# Family Clock

Three real ticking clocks plus three small OLED labels, hung on a wall.
The clocks track each kid's local time wherever they are; the labels show
name plus city/country; updates happen automatically when anyone travels.

```
   ┌─────────┐   ┌─────────┐   ┌─────────┐
   │  ┌───┐  │   │  ┌───┐  │   │  ┌───┐  │
   │  │ ⏰ │  │   │  │ ⏰ │  │   │  │ ⏰ │  │     <- quartz movements
   │  └───┘  │   │  └───┘  │   │  └───┘  │
   │ ALEX    │   │ JORDAN  │   │ NICK    │     <- 0.96" OLED labels
   │ Brooklyn│   │ Denver  │   │ Seattle │
   │ , US    │   │ , US    │   │ , US    │
   └─────────┘   └─────────┘   └─────────┘
```

## Architecture

```
  iPhone (Alex)  ──┐
  iPhone (Jordan)──┼──HTTPS──▶  Cloudflare Worker  ──▶  KV
  iPhone (Nick)  ──┘                  │
                                      │ HTTPS poll every 15 min
                                      ▼
                              ESP32 in the clock
                              ├─ NTP (UTC)
                              ├─ 3× Lavet motor coils
                              └─ 3× SSD1306 OLED labels
```

Each phone runs an iOS Shortcut (geofence + periodic timer → POST). The
Worker reverse-geocodes the coordinate (Nominatim), looks up the IANA
timezone (bundled `tz-lookup` package), and stores the result in KV. The
clock polls the Worker, computes the current local time per kid using
the offset returned by the Worker, and pulses each Lavet coil to advance
its hands.

## Bill of Materials

| Part | Qty | Approx | Notes |
|---|---|---|---|
| ESP32 dev board (DevKitC, NodeMCU-32S, ESP32-S3) | 1 | $10 | USB-C connector preferred |
| Quartz clock movement w/ hands | 3 (buy 5) | $15–25 | "High torque" — first one or two will be casualties from the Lavet hack |
| 0.96" SSD1306 SPI OLED, 128×64 | 3 | $10–15 total | **SPI variant only** — I2C needs a multiplexer |
| Hall effect sensor (A3144 or 49E) | 3 | $5 | Usually sold in 10-packs |
| Neodymium disc magnet, 3mm × 1mm | 3 | $6–10 | Comes in packs of 50–100 |
| 1/4 W resistor assortment kit | 1 | $10 | Need 220–470 Ω; assortment kit covers years of projects |
| Jumper wire + perfboard + 2.54mm header pins | 1 | $20 | Mixed M-M/M-F jumper pack + 5×7cm perfboard multi-pack |
| Shadow-box picture frame, ~12"×6" | 1 | $20–30 | ≥30mm internal depth (was ≥50mm with e-paper) |
| Plywood or MDF face plate | 1 | $5 | Cut to frame opening, or laser-cut from a service |
| 5V USB-C wall wart + cable | 1 | $10 | 1A is plenty for ~150 mA total draw |
| Cord cover (paint-matchable) | 1 | $8 | Hides the wall-power cable from frame to outlet |

**Total: ~$120–150** plus paint/finish.

> **Why OLED instead of e-paper?** Three Waveshare 1.54" e-paper modules
> would run $50–60 with 1–2 week shipping; three SSD1306 OLEDs run $10–15
> with next-day Prime. The tradeoffs are ~60 mA always-on draw (fine on
> wall power) and burn-in risk over years (mitigated because labels only
> change when someone travels). If you want the "framed print" look back,
> swap the firmware's `Adafruit_SSD1306` includes for `GxEPD2_BW` and use
> Waveshare 1.54" modules instead.

## Build (hardware)

### 1. Hack the quartz movements

For each movement:

1. Pop off the back cover (usually clips, sometimes a single screw).
2. Locate the tiny coil and the controller IC. The coil has two thin
   wires going to two pins on the IC.
3. Cut those two traces between the IC and the coil.
4. Solder a thin wire to each coil terminal. Route them out through a
   small slot in the case. Add a 220–470 Ω series resistor on one of the
   two wires (limits current to the coil).
5. Glue a 3×1mm neodymium magnet to the back of the minute-hand shaft
   (the inner gear that drives the minute hand). Position it so it
   rotates past where you'll mount the Hall sensor.
6. Mount a Hall sensor on the back of the movement case so its sensitive
   face is ~1mm from the magnet's path. The sensor goes LOW when the
   magnet passes — that's "12 o'clock."
7. Reassemble. Test by manually setting hands to 12:00 and confirming
   the Hall sensor reads LOW.

### 2. Wire the ESP32

Default pin map (in `family-clock.ino`):

```
SPI shared:    SCK=18, MOSI=23
OLED RST:      4 (shared by all three)
Display 0:     CS=5,  DC=17
Display 1:     CS=14, DC=16
Display 2:     CS=21, DC=22
Motor 0:       A=25, B=26
Motor 1:       A=27, B=13
Motor 2:       A=32, B=33
Hall 0/1/2:    36, 19, 15
```

All OLED modules share VCC (3.3V), GND, SCK (CLK/D0), MOSI (DIN/D1), and
RST. Each gets its own CS and DC. SSD1306 modules don't have a BUSY pin
— ignore that pin on the module if it has one.

Each Lavet coil connects between its two motor pins (A, B). The ESP32
drives them push-pull alternately each tick — no driver IC needed, just
the series resistor.

### 3. Frame the whole thing

1. Cut your face plate to fit the frame opening.
2. Mark and drill three holes for the clock movement shafts (typically
   8mm), evenly spaced across the upper half.
3. Cut three rectangular windows for the OLED modules below each clock.
   Active area on the 0.96" 128×64 SSD1306 is roughly 22×11mm — leave a
   ~2mm border so the module's PCB isn't visible from the front.
4. Mount movements from behind (their nuts go on the front), OLED modules
   from behind with the screen aligned to the windows. The OLEDs are
   light enough to hot-glue or double-stick-tape directly to the
   faceplate back.
5. Mount the ESP32 and wiring on a small piece of perfboard glued to
   the back panel. USB-C cable exits through a small notch.
6. Run the USB-C cable through a paint-matched cord cover from the frame
   down to the wall outlet. From across the room it disappears.
7. Paint or stain the face plate. Number markings on the clock faces
   are up to you — stickers, painted stencils, or laser-etched.

## Deploy the Cloudflare Worker

Prereqs: a free Cloudflare account, Node 18+, `wrangler` CLI.

```bash
cd worker
npm install

# Log in once (opens browser)
npx wrangler login

# Create a KV namespace; copy the printed id into wrangler.toml
npx wrangler kv namespace create CLOCK

# Deploy
npx wrangler deploy
# → prints something like https://family-clock.YOUR-SUBDOMAIN.workers.dev
```

### Initialize the kids and tokens

Make up three random kid tokens (one per phone) and one clock token. Use
something like `openssl rand -hex 16` for each.

```bash
# The clock's secret. The ESP32 puts this in its URL.
npx wrangler kv key put --binding=CLOCK clock_token "YOUR_CLOCK_TOKEN"

# One mapping per kid: token -> kid_id (use simple IDs like 1, 2, 3 to
# control display order — they sort alphabetically)
npx wrangler kv key put --binding=CLOCK "token:ALEX_TOKEN"   "1"
npx wrangler kv key put --binding=CLOCK "token:JORDAN_TOKEN" "2"
npx wrangler kv key put --binding=CLOCK "token:NICK_TOKEN"   "3"

# Initial kid records. Name shows up on the OLED label; city/country/
# timezone get filled in once their phone reports a location.
npx wrangler kv key put --binding=CLOCK "kid:1" '{"id":"1","name":"Alex"}'
npx wrangler kv key put --binding=CLOCK "kid:2" '{"id":"2","name":"Jordan"}'
npx wrangler kv key put --binding=CLOCK "kid:3" '{"id":"3","name":"Nick"}'
```

Test the clock endpoint:

```bash
curl https://family-clock.YOUR-SUBDOMAIN.workers.dev/clock/YOUR_CLOCK_TOKEN
# → [{"id":"1","name":"Alex","city":"Unknown","country":"","timezone":"UTC","offset_seconds":0,...}, ...]
```

Test a location POST:

```bash
curl -X POST \
  -H "content-type: application/json" \
  -d '{"lat":40.6782,"lng":-73.9442}' \
  https://family-clock.YOUR-SUBDOMAIN.workers.dev/location/ALEX_TOKEN
# → {"ok":true,"timezone":"America/New_York","city":"New York","country":"US"}
```

For a live browser view of all three clocks ticking:

```
https://family-clock.YOUR-SUBDOMAIN.workers.dev/preview/YOUR_CLOCK_TOKEN
```

## iOS Shortcut (one per phone)

Each kid does this once on their iPhone.

### Build the shortcut

1. Open **Shortcuts** → tap **+** to create a new shortcut.
2. Name it "Update Family Clock".
3. Add these actions in order:

   - **Get Current Location**
   - **Dictionary** → add two keys:
     - `lat` → value: tap, choose Magic Variable → Current Location → **Latitude**
     - `lng` → value: Magic Variable → Current Location → **Longitude**
   - **Get Contents of URL**
     - URL: `https://family-clock.YOUR-SUBDOMAIN.workers.dev/location/THIS_KIDS_TOKEN`
     - Method: **POST**
     - Request Body: **JSON**
     - Pass the Dictionary from the previous step as the body.

4. Save. Tap the play button to test — you should see `{"ok":true,...}`
   in the result.

### Trigger it automatically

Set up two or three Personal Automations that all call this shortcut:

1. **Time of Day**: every 6 hours (or "Daily" at 6am, noon, 6pm, midnight).
2. **When I leave** [home address] → run shortcut.
3. **When I arrive** [home address] → run shortcut.

For each, toggle **Run Immediately** ON so iOS doesn't ask first.

> **Why not "significant location change"?** iOS doesn't expose that
> trigger to Shortcuts. Geofence + periodic timer covers the same ground.

Alternative for less-techy siblings: install **Owntracks** (free, App
Store), point it at your `/location/<token>` URL with HTTP mode, and it
handles significant-location reporting natively.

## Flash the firmware

1. Install Arduino IDE 2.x and add the ESP32 board package.
2. Library Manager → install: **WiFiManager** (tzapu), **ArduinoJson**
   (Benoit Blanchon, v7+), **Adafruit SSD1306**, **Adafruit GFX**.
3. Open `firmware/family-clock.ino`. Edit `SERVER_URL` to your Worker
   URL with your clock token.
4. Board: ESP32 Dev Module. Partition Scheme: **Default** is fine.
5. Upload.
6. First boot: ESP32 creates a WiFi network called "FamilyClockSetup".
   Connect from any phone, the captive portal lets you pick the parents'
   home WiFi.
7. After WiFi: clocks home themselves to 12:00, then start ticking
   forward to the correct local time. Initial sync from 12:00 to "now"
   takes up to ~10 minutes (the worst case is wrapping ~6 hours of
   ticks at ~30ms each).

## Troubleshooting

**Clock hands don't move at all.** Polarity matters — the Lavet coil
won't step if you only ever drive one direction. Confirm the firmware
is alternating (`lavetPolarity[i] = !lavetPolarity[i]`). Confirm the
series resistor isn't too large (>1kΩ will starve the coil).

**Clock runs but skips ticks.** Pulse too short or current too low. Try
increasing `LAVET_PULSE_MS` to 50, or drop the resistor to 220Ω.

**Hand position drifts over days.** Power loss between saves loses up to
60 seconds of position. The hourly NTP sync isn't enough by itself
because we only know UTC, not where the hand physically is. If this
matters, add a manual "rehome" button (one GPIO with a pushbutton to
GND) that retriggers `homeClock()` for all three.

**OLED shows nothing.** Most common cause: I2C-only module (no MOSI
input). Check the silkscreen for `SCL/SDA` (I2C) vs `CLK/DIN` (SPI) — we
need SPI. Second most common: the module has a built-in jumper / 0Ω
resistor for switching between I2C and SPI; consult the datasheet for
your specific board.

**OLED text shifts or flickers.** Loose CS or DC pin — verify the
header pins are seated. Try slowing SPI by passing a slower bus to
`Adafruit_SSD1306` if you're seeing artifacts on long wires.

**Burn-in over time.** Static text on OLEDs ghosts after 1–2 years of
24/7 display. The labels here only change on travel, so this is real.
Mitigation: shift the cursor X by a few pixels every poll cycle (random
walk within a small range) — easy to add in `drawLabels()`.

**Worker returns `"city":"Unknown"`.** Nominatim's free endpoint occasionally
returns no `address.city`/`town`/`village` for remote coordinates. Worker
falls back to `"Unknown"` but the timezone is still correct. The next phone
trigger usually clears it (you may have moved a few meters).

**Sibling never installs the shortcut.** Worker has no data for them →
clock label says "Unknown" and the offset stays at 0 (UTC). You can
hardcode an initial timezone by writing it directly to KV:
`wrangler kv key put --binding=CLOCK "kid:2" '{"id":"2","name":"Jordan","timezone":"America/Denver","city":"Denver","country":"US"}'`.

## Privacy notes

- Coordinates are stored in KV but never exposed via the `/clock` endpoint
  — only city name and offset are returned.
- The Worker has no auth on the `/location` endpoint beyond the per-kid
  token. If a token leaks, an attacker could write fake locations to
  that kid's record. Worst case: their clock face on the wall shows the
  wrong time. Easy to rotate (`wrangler kv key put` with a new value).
- HTTPS is enforced by Cloudflare. The ESP32 uses `client.setInsecure()`
  for simplicity; if you want stricter cert validation, pin Cloudflare's
  root cert in `WiFiClientSecure::setCACert()`.

## License

Yours. Have fun.
