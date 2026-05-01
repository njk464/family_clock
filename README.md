# Family Clock

Three real ticking clocks plus three small OLED labels, hung on a wall.
The clocks track each kid's local time wherever they are; the labels show
name plus city/country; updates happen automatically when anyone travels.

```
   ┌─────────┐   ┌─────────┐   ┌─────────┐
   │  ┌───┐  │   │  ┌───┐  │   │  ┌───┐  │
   │  │ ⏰ │  │   │  │ ⏰ │  │   │  │ ⏰ │  │     <- quartz movements
   │  └───┘  │   │  └───┘  │   │  └───┘  │
   │ ╔═════╗ │   │ ╔═════╗ │   │ ╔═════╗ │
   │ ║ALEX ║ │   │ ║JORDAN║ │   │ ║NICK ║ │     <- 2.9" e-paper labels
   │ ║Brook║ │   │ ║Denver║ │   │ ║Seatt║ │
   │ ║ , US║ │   │ ║ , US ║ │   │ ║ , US║ │
   │ ╚═════╝ │   │ ╚═════╝ │   │ ╚═════╝ │
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
                              └─ 3× 2.9" e-paper labels
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
| 2.9" e-paper module, 296×128, SPI (Waveshare or compatible) | 3 | ~$70 total | **SPI variant only** — check "2.9inch e-Paper Module" on Waveshare or Amazon |
| Hall effect sensor (A3144 or 49E) | 3 | $5 | Usually sold in 10-packs |
| Neodymium disc magnet, 3mm × 1mm | 3 | $6–10 | Comes in packs of 50–100 |
| 1/4 W resistor assortment kit | 1 | $10 | Need 220–470 Ω; assortment kit covers years of projects |
| Jumper wire + perfboard + 2.54mm header pins | 1 | $20 | Mixed M-M/M-F jumper pack + 5×7cm perfboard multi-pack |
| Shadow-box picture frame, ~12"×6" | 1 | $20–30 | ≥30mm internal depth (was ≥50mm with e-paper) |
| Plywood or MDF face plate | 1 | $5 | Cut to frame opening, or laser-cut from a service |
| 5V USB-C wall wart + cable | 1 | $10 | 1A is plenty for ~150 mA total draw |
| Cord cover (paint-matchable) | 1 | $8 | Hides the wall-power cable from frame to outlet |

**Total: ~$180–215** plus paint/finish.

> **Why 2.9" e-paper?** Four reasons this is the right choice for a
> multi-year wall gift:
>
> - **Readable across a room.** 2.9" at 296×128 px is ~8× the active area
>   of a 0.96" SSD1306 OLED. The name is comfortably legible from the
>   couch; the city is readable by walking up.
> - **No burn-in over years.** A static OLED label ghosts after 1–2 years
>   of 24/7 display. E-paper holds its image indefinitely with zero power —
>   the pixels are bistable ink. A gift that's still sharp in 10 years.
> - **Matte paper-print aesthetic.** Black ink on off-white paper matches
>   the "framed print" feel far better than a glowing OLED screen on a
>   dark-themed background. The preview site mirrors this.
> - **Near-zero idle power.** ~50 mA briefly during a refresh, then zero.
>   The whole clock runs off a 1A USB wall wart with plenty of headroom.
>
> The trade: full refresh takes ~2 seconds and flickers through black/white.
> This is invisible in practice because labels only change when someone
> travels — you're not watching it refresh. Partial refresh (~0.4 sec) is
> available in GxEPD2 but not used here; the current code only refreshes
> when the city or timezone actually changes.

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
E-paper RST:   4 (shared by all three)
Display 0:     CS=5,  DC=17, BUSY=34
Display 1:     CS=14, DC=16, BUSY=35
Display 2:     CS=21, DC=22, BUSY=39
Motor 0:       A=25, B=26
Motor 1:       A=27, B=13
Motor 2:       A=32, B=33
Hall 0/1/2:    36, 19, 15
```

All e-paper modules share VCC (3.3V), GND, SCK (CLK), MOSI (DIN), and
RST. Each gets its own CS, DC, and BUSY line. BUSY pins 34, 35, and 39
are input-only GPIOs on the ESP32 (no output driver) — they are safe to
use as BUSY inputs and are otherwise unused in this design. The e-paper
module holds BUSY low while refreshing; the GxEPD2 library polls it
before sending the next command.

Each Lavet coil connects between its two motor pins (A, B). The ESP32
drives them push-pull alternately each tick — no driver IC needed, just
the series resistor.

### 3. Frame the whole thing

1. Cut your face plate to fit the frame opening.
2. Mark and drill three holes for the clock movement shafts (typically
   8mm), evenly spaced across the upper half.
3. Cut three rectangular windows for the e-paper modules below each clock.
   Active area on the 2.9" panel is ~67×29mm — the faceplate SVG uses
   70×32mm cut windows (1.5mm tolerance each side). Use the provided
   `faceplate.svg` with a laser cutter or print it as a drilling template.
4. Mount movements from behind (their nuts go on the front), e-paper modules
   from behind with the active area aligned to the windows. The modules are
   light enough to hot-glue or double-stick-tape directly to the faceplate
   back. Route the ribbon/flex cable to the ESP32 board.
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
   (Benoit Blanchon, v7+), **GxEPD2** (Jean-Marc Zingg), **Adafruit GFX**.
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

**E-paper stays blank on first power-up.** Most likely cause: driver IC
variant mismatch. 2.9" modules ship with either a UC8151 or SSD1675 driver
IC, and GxEPD2 has different constructors for each. The default firmware
uses `GxEPD2_290_BS` (UC8151). If the panel stays white or shows scrambled
pixels, open `family-clock.ino` and change all three display declarations
to use `GxEPD2_290_T94` instead. If that also fails, try `GxEPD2_290`.
Only physical bring-up with your specific modules determines the right one.

**Ghosting / faint previous image visible.** Normal for e-paper; the panel
retains a faint ghost of past content. The GxEPD2 full refresh (used in
this firmware) clears the ghost by cycling black-white before drawing the
new image. If ghosting persists, call `display.clearScreen()` before
`display.display(false)` to force a double-clear cycle.

**BUSY pin stuck low (panel never becomes ready).** The e-paper module
holds BUSY low while refreshing (typically ~2 seconds). If BUSY stays
low for more than 5 seconds: (1) verify the BUSY wire is connected to
pins 34/35/39 and not floating, (2) check that VCC is solid 3.3V (not
drooping from a shared rail), (3) check that CS is not held asserted by
another device. A stuck BUSY usually means the panel is not receiving a
valid reset sequence — confirm RST (pin 4) is wired correctly.

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
