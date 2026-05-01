# MASTER_PLAN.md — Family Clock Gift

## Identity

**Project:** Family Clock — a wall-hung shadowbox gift for parents showing each
of three kids' local times via real ticking quartz movements plus three small
e-paper labels (name + city/country). Updates happen automatically when any kid
travels (iOS Shortcut → Cloudflare Worker → KV → ESP32 polling).

**Status:** Hardware built with original 0.96" SSD1306 OLEDs; firmware
compile-clean; end-to-end loop verified (phone → Worker → KV → preview) for
one kid. Currently in field-readiness phase: physical labels are unreadable
across a room — this initiative replaces them with 2.9" e-paper modules and
upgrades the preview/aesthetic to match.

## Architecture

| Path | Role |
|---|---|
| `worker.js` | Cloudflare Worker — `/location/<token>` POST, `/clock/<token>` GET, `/preview/<token>` HTML view. Reverse-geocode (Nominatim) + IANA timezone (tz-lookup). |
| `wrangler.toml` | Worker deploy config; KV binding `CLOCK`. |
| `family-clock.ino` | ESP32 firmware — WiFiManager, NTP UTC sync, 15-min HTTP poll, 3× Lavet-coil drive, 3× SPI label render. |
| `faceplate.svg` | Laser-cut template for the front face plate (cut paths only — outer perimeter, shaft holes, label windows). 254 × 102 mm. |
| `README.md` | Build guide: BOM, wiring, Worker deploy, iOS Shortcut, firmware flash, troubleshooting. |
| `package.json` / `node_modules/` | Worker dev deps (`wrangler`, `tz-lookup`). |
| `TOKENS.toml` | Local-only secrets (per-kid tokens, clock token). Not committed. |

## Original Intent

A gift for the parents that physically embodies "the kids are out there in
the world." Three real ticking clocks make it feel alive and present in a
way a digital readout cannot. Phone → Worker → ESP32 keeps zero work for
the parents and minimal work for the kids (one geofence shortcut, set once).

## Principles

1. **Physical presence over screens.** The hands move. Even when one kid is
   in the same timezone as the parents, their second-hand sweeps. The labels
   are supporting actors — but they must be readable from the couch.
2. **Zero parent maintenance.** No buttons to press, no app to open. Power
   cycle and it homes itself, polls, and ticks.
3. **Cheap and replaceable.** Off-the-shelf modules; anything that fails
   can be swapped without rebuilding the whole thing.
4. **Ship-quality readability.** Anything visible from the parents' couch
   has to be legible from the parents' couch.
5. **"Framed print" aesthetic.** This is a wall-hung gift, not a desk gadget.
   Matte, paper-like, no glow, editorial typography. The preview should look
   like the wall version.

## Decision Log

| Date | DEC-ID | Initiative | Decision | Rationale |
|---|---|---|---|---|
| 2026-04-30 | DEC-OLED-001 | oled-label-upgrade *(abandoned)* | Swap 0.96" SSD1306 → 2.42" SSD1309 OLEDs | Superseded — see DEC-EPAPER-001. |
| 2026-04-30 | DEC-EPAPER-001 | epaper-upgrade-2.9 | Swap 0.96" SSD1306 OLEDs → 2.9" e-paper modules (296×128, SPI, ~$23 each) | After exploring tiers (4.2", 7.5", 5.83", raw panels), 2.9" is the only e-paper size with fast Amazon shipping. ~8× active area vs 0.96" OLED, no burn-in over years on a wall, matte aesthetic matches "framed print" principle. |
| 2026-04-30 | DEC-EPAPER-002 | epaper-upgrade-2.9 | Swap library `Adafruit_SSD1306` → `GxEPD2_BW` | Required for e-paper. Well-supported on ESP32. Adds 3 BUSY-pin GPIO assignments (input-only pins 34/35/39). |
| 2026-04-30 | DEC-EPAPER-003 | epaper-upgrade-2.9 | Keep faceplate at 254 × 102 mm | Existing frame is purchased. New active area 66.9 × 29.1 mm + 1.5 mm tolerance = 70 × 32 mm windows; fits with margin. |
| 2026-04-30 | DEC-EPAPER-004 | epaper-upgrade-2.9 | Preview site is the design source-of-truth for label aesthetic | Web preview is fast to iterate; firmware mirrors it via Adafruit_GFX-bundled fonts. Theme picked once, applied to both. |

## Active Initiatives

### Initiative: epaper-upgrade-2.9

**Status:** active

**Summary:** Swap the three 0.96" SSD1306 OLED labels for 2.9" e-paper modules
(296×128, SPI, Waveshare or compatible). Update the Worker preview site to be
larger, match the e-paper aesthetic (black-on-paper, no glow), and use an
artsy editorial font. Update the faceplate SVG, BOM, and firmware accordingly.

#### Goals
- **REQ-GOAL-001** Labels readable from across a typical living room (~3-4 m) — name comfortably, city by walking up if needed.
- **REQ-GOAL-002** Preview site is a faithful visual mock of what the wall version will look like, including font and proportions.
- **REQ-GOAL-003** Frame stays the same physical size; user does not need to buy a new frame.

#### Non-Goals
- **REQ-NOGO-001** No frame size change. (254 × 102 mm stays.)
- **REQ-NOGO-002** No analog-dial size or hand upgrade in this initiative.
- **REQ-NOGO-003** No cleanup of stale worktrees or session files.
- **REQ-NOGO-004** No custom font conversion to Adafruit_GFX format unless Theme B is chosen.

#### Requirements (P0)
- **REQ-P0-001** `worker.js` `handlePreview()` renders labels at proportionally-larger size with a paper-tone background, high-contrast black text, and the chosen artsy font loaded via Google Fonts.
- **REQ-P0-002** `faceplate.svg` label windows enlarged from 23×12 mm to 70×32 mm, recentered on existing column centers (x=42.3, 127, 211.7), still inside the 254×102 mm frame.
- **REQ-P0-003** `family-clock.ino` uses `GxEPD2_BW` for three 2.9" panels (CS/DC/RST/BUSY pin map updated; BUSY pins on 34/35/39).
- **REQ-P0-004** Firmware label rendering uses an Adafruit_GFX-bundled font that visually matches the preview's chosen Google Font theme (e.g. `FreeSerifBold24pt7b` for Theme A).
- **REQ-P0-005** README BOM, wiring section, "Why" sidebar, faceplate window dimensions, and troubleshooting all reflect the new e-paper modules.
- **REQ-P0-006** Firmware compiles clean for ESP32 and ESP32-S3 with `arduino-cli` (existing baseline).

#### Phases

##### Phase 1: 2.9" e-paper upgrade + preview redesign

**Status:** active

**Definition of Done:**
- All four work items complete and internally consistent (preview, SVG, firmware, README all reference 2.9" e-paper, 70×32 mm windows, chosen font theme).
- Preview site, when viewed in a browser, looks recognizably like an e-paper wall display (black on off-white, editorial type, no glow).
- Firmware compiles for both ESP32 and ESP32-S3 targets.
- User has answered the three open questions OR implementer used recommended defaults and surfaced the choice in the commit message.

**Work items** (one wave; recommend dispatching as a single combined implementer task — the four files are tightly coupled in meaning):

- **W1-PREVIEW** | Weight: M | Deps: Q-FONT-THEME answer | Gate: visual review | Issue: TBD
  - Edit `worker.js` `handlePreview()` (~line 125):
    - Background: paper-tone `#f7f3ec` (off-white) or `#fafafa`; subtle paper-grain via CSS noise filter optional.
    - Label cards: white-ish background, black text, high contrast, no shadows or glow; 1px black border to evoke a framed card.
    - Font: load chosen Google Fonts theme via `<link rel=stylesheet>` from fonts.googleapis.com.
    - Sizing: each kid's label card grows ~3× from current; name in display-size weight (~48-56 px on screen), city in body weight (~22-28 px).
    - Layout: three cards in a row, centered, with a subtle "Family Clock" header in the same font.
  - **Acceptance:** Browser preview at `/preview/<token>` looks recognizably e-paper-ish at first glance; user does the visual gut-check before signoff.
  - **Satisfies:** REQ-P0-001, REQ-GOAL-002.

- **W1-SVG** | Weight: S | Deps: none | Gate: review | Issue: TBD
  - Edit `faceplate.svg`:
    - Update header comment block: window dimensions `23 × 12 mm` → `70 × 32 mm` (with note: 66.9 × 29.1 mm active area + 1.5 mm tolerance each side).
    - Replace each `<rect>` for label windows: `width=70, height=32`, recentered on column centers x=42.3/127/211.7 → `x = (cx - 35), y = 64`. New rects: `x="7.3" y="64" width="70" height="32"`, `x="92" y="64" width="70" height="32"`, `x="176.7" y="64" width="70" height="32"`.
    - Sanity: leftmost x=7.3 (7.3 mm left margin), rightmost x=176.7+70=246.7 (7.3 mm right margin). Top y=64 → 30 mm clearance from shaft-hole edge (shaft center y=30, radius 4). Bottom y=96 → 6 mm bottom margin.
    - Note in comment: this clearance limits faceplate-drawn dial markings to a ~50 mm diameter circle around each shaft.
  - **Acceptance:** SVG opens correctly in a browser; rectangles inside 254×102 viewBox; no overlap with shaft-hole circles.
  - **Satisfies:** REQ-P0-002, REQ-NOGO-001.

- **W1-FW** | Weight: M | Deps: Q-FONT-THEME answer | Gate: compile-check | Issue: TBD
  - Edit `family-clock.ino`:
    - Replace `#include <Adafruit_SSD1306.h>` with `#include <GxEPD2_BW.h>`.
    - Replace the three `Adafruit_SSD1306 displayN(...)` declarations with `GxEPD2_BW<GxEPD2_290_BS, GxEPD2_290_BS::HEIGHT> displayN(GxEPD2_290_BS(/*CS=*/, /*DC=*/, /*RST=*/, /*BUSY=*/));` (or `GxEPD2_290_T94` if the user's modules ship with the SSD1675-variant driver — flag this for first bring-up).
    - Add 3× `BUSY` pin assignments: `BUSY_0=34, BUSY_1=35, BUSY_2=39` (ESP32 input-only pins, cannot conflict with existing motor/hall outputs).
    - Update `@decision` block (top of file): "OLEDs (SSD1306) → 2.9" Waveshare e-paper. Reason: 8× active area, no burn-in, matte aesthetic. Library swapped to GxEPD2_BW; BUSY pins added on 34/35/39 (input-only, otherwise unused)."
    - Add a comment near the display constructors flagging the UC8151-vs-SSD1675 driver IC variant: first physical bring-up determines whether `GxEPD2_290_BS` or `GxEPD2_290_T94` is the correct constructor.
    - In `drawLabels()`: switch fonts to chosen theme (e.g. Theme A: `FreeSerifBold24pt7b` for name, `FreeSerif12pt7b` for city). Center text in the 296×128 frame. Recompute cursor positions for the new font metrics.
    - Refresh strategy: full refresh only on label change (track previous values; skip refresh if unchanged). Initial draw at boot is a full refresh.
  - **Acceptance:**
    - `arduino-cli compile --fqbn esp32:esp32:esp32 family-clock.ino` succeeds.
    - `arduino-cli compile --fqbn esp32:esp32:esp32s3 family-clock.ino` succeeds.
    - `@decision` annotations present and current.
  - **Satisfies:** REQ-P0-003, REQ-P0-004, REQ-P0-006.

- **W1-README** | Weight: S | Deps: W1-FW pin map | Gate: none | Issue: TBD
  - BOM row 45: `0.96" SSD1306 SPI OLED, 128×64, 3, $10–15 total` → `2.9" e-paper module, 296×128, SPI (Waveshare or compatible), 3, ~$70 total`.
  - Total at line 55: `~$120–150` → `~$180–215`.
  - Rewrite "Why OLED instead of e-paper?" sidebar (lines 57-63) → "Why 2.9" e-paper": defends the new choice — paper aesthetic, no burn-in over years, low power, readable from across an apartment-sized room.
  - Build instruction (line 117-118): window dimensions `~22×11mm` → `~67×29mm` active area; faceplate cut size `70×32 mm`.
  - Wiring section: add BUSY pins to the pin-map block.
  - Troubleshooting: replace OLED entries with e-paper-specific ones (refresh time ~2 sec full / ~0.4 sec partial; ghosting on partial refresh; UC8151-vs-SSD1675 driver variant on first bring-up; "BUSY pin stuck low" failure mode).
  - **Acceptance:** `grep -nE "0\.96|SSD1306|SSD1309"` returns only justified historical references (the abandoned-decision context, if kept).
  - **Satisfies:** REQ-P0-005.

**Critical path:** 1 wave, all four items dispatch-able together.
**Max width:** 4 (or 1 combined dispatch — recommended).

#### Open Questions for the User

- **Q-FONT-THEME** *(blocking W1-PREVIEW and W1-FW)* — Pick the artsy font theme:
  - **A. Editorial** *(recommended)* — Playfair Display (names, bold serif, magazine-masthead feel) + Lora (cities, balanced serif). Firmware equivalents in Adafruit_GFX: `FreeSerifBold24pt7b` + `FreeSerif12pt7b`. Lowest-effort visual parity between preview and hardware.
  - **B. Handwritten Gift** — Caveat (names, handwritten warmth) + Inter (cities, clean sans). Warmer/more personal feel; downside is firmware needs a custom-converted font for parity (Caveat → Adafruit_GFX format via fontconvert utility, ~30 min one-time setup).
  - **C. Typewriter Letter** — Special Elite or Courier Prime (names + cities). Characterful, retro. Firmware uses `FreeMonoBold24pt7b` + `FreeMono12pt7b` — different glyph shapes than Special Elite but mono spirit preserved.
  - **Default if no answer:** A.

- **Q-DIAL-SIZE** — Keep current small dial markings (faceplate-drawn ≤ 50 mm dia. circle around each shaft) vs upgrade to longer hands later in a separate initiative?
  - **Default if no answer:** keep small for now; revisit after the e-paper upgrade is on the wall and we see what the proportions actually look like.

- **Q-PAPER-TEXTURE** — Should the preview include a subtle paper-grain texture (CSS noise filter) for extra "framed print" vibe, or keep it flat off-white?
  - **Default if no answer:** flat off-white (`#f7f3ec`); easier to read, less risk of looking gimmicky.

#### Risks

1. **Driver IC variant on the 2.9" module.** Modules ship with either UC8151 or SSD1675 driver IC. GxEPD2 has different constructors (`GxEPD2_290_BS` vs `GxEPD2_290_T94` vs `GxEPD2_290`). Not testable until the user has a physical module in hand. **Mitigation:** firmware comment near constructors lists both options; first bring-up determines which one displays correctly.
2. **Font preview/firmware parity.** Theme A is a clean visual match because Adafruit_GFX ships `FreeSerifBold24pt7b` which is similar in spirit to Playfair Display. Themes B and C require either a custom font conversion (B) or accept that firmware uses a different glyph family than the preview (C). **Mitigation:** recommend Theme A; flag the parity gap if user picks B or C.
3. **Dial / window vertical clearance.** With windows at y=64 and shaft holes at y=30 (radius 4), 30 mm of vertical clearance for the dial. Fine for ≤ 50 mm diameter dials, tight for larger movements. **Mitigation:** out of scope — addressed in a future dial-size initiative if needed.
4. **Stale plan transition.** Previous initiative `oled-label-upgrade` was never executed; its work items disappear cleanly with this rewrite, but if any worktree was created for it, that worktree is now orphaned. **Mitigation:** orchestrator verifies no worktree exists for the abandoned initiative before creating a new one.

## Completed Initiatives

### Initiative: oled-label-upgrade *(abandoned 2026-04-30)*

**Status:** completed

**Compressed:** Proposed a 2.42" SSD1309 OLED swap from the 0.96" SSD1306s.
Plan written but not implemented. User rejected mid-planning in favor of
e-paper after considering 4.2"/5.83"/7.5" alternatives and landing on 2.9"
based on shipping availability. Superseded by `epaper-upgrade-2.9`. No code
changes were made; only the (now-replaced) MASTER_PLAN.md draft.
