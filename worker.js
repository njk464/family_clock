/**
 * Family Clock — Cloudflare Worker
 *
 * Two endpoints:
 *   POST /location/<kid_token>   — body: { "lat": 40.7, "lng": -74.0 }
 *                                  Called by each kid's iOS Shortcut.
 *   GET  /clock/<clock_token>    — Returns array of { id, name, city,
 *                                  timezone, offset_seconds, updated_at }.
 *                                  Called by the ESP32 clock every 15 min.
 *
 * KV keys used:
 *   token:<kid_token>      -> kid_id     (one per kid)
 *   kid:<kid_id>           -> JSON record (name, lat, lng, city, tz, …)
 *   clock_token            -> the secret the clock presents
 *
 * Setup these via `wrangler kv key put` — see README.
 *
 * @decision Timezone resolution uses the bundled `tz-lookup` package rather
 * than an external API. The geotimezone.com API was unreliable (TLS SNI
 * failures), and tz-lookup is ~200KB, zero-deps, synchronous, and runs
 * fine in Workers. City lookup still hits BigDataCloud since coordinate
 * → place name needs a real database.
 */

import tzlookup from "tz-lookup";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }

    try {
      const url = new URL(request.url);

      const locMatch = url.pathname.match(/^\/location\/([^/]+)\/?$/);
      if (locMatch && request.method === "POST") {
        return handleLocation(locMatch[1], request, env);
      }

      const clockMatch = url.pathname.match(/^\/clock\/([^/]+)\/?$/);
      if (clockMatch && request.method === "GET") {
        return handleClock(clockMatch[1], env);
      }

      const previewMatch = url.pathname.match(/^\/preview\/([^/]+)\/?$/);
      if (previewMatch && request.method === "GET") {
        return handlePreview();
      }

      if (url.pathname === "/" || url.pathname === "/health") {
        return json({ ok: true, service: "family-clock" });
      }

      return new Response("Not found", { status: 404, headers: cors() });
    } catch (err) {
      return new Response("Server error: " + err.message, {
        status: 500,
        headers: cors(),
      });
    }
  },
};

// ---- handlers ----------------------------------------------------------

async function handleLocation(token, request, env) {
  const kidId = await env.CLOCK.get(`token:${token}`);
  if (!kidId) return new Response("Unknown token", { status: 401, headers: cors() });

  const body = await request.json().catch(() => ({}));
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return new Response("Need numeric lat and lng", { status: 400, headers: cors() });
  }

  const timezone = lookupTimezone(lat, lng);
  const { city, country } = await lookupPlace(lat, lng);

  const existing = (await env.CLOCK.get(`kid:${kidId}`, "json")) || {};
  const record = {
    id: kidId,
    name: existing.name || kidId,
    lat,
    lng,
    timezone,
    city,
    country,
    updated_at: new Date().toISOString(),
  };
  await env.CLOCK.put(`kid:${kidId}`, JSON.stringify(record));

  return json({ ok: true, timezone, city, country });
}

async function handleClock(token, env) {
  const expected = await env.CLOCK.get("clock_token");
  if (!expected || token !== expected) {
    return new Response("Unauthorized", { status: 401, headers: cors() });
  }

  const list = await env.CLOCK.list({ prefix: "kid:" });
  const out = [];
  for (const k of list.keys) {
    const kid = await env.CLOCK.get(k.name, "json");
    if (!kid) continue;
    out.push({
      id: kid.id,
      name: kid.name,
      city: kid.city || "Unknown",
      country: kid.country || "",
      timezone: kid.timezone || "UTC",
      offset_seconds: offsetSeconds(kid.timezone || "UTC"),
      updated_at: kid.updated_at,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));

  return json(out);
}

// ---- preview page ------------------------------------------------------

function handlePreview() {
  return new Response(PREVIEW_HTML, {
    headers: {
      "content-type": "text/html;charset=UTF-8",
      "cache-control": "no-store",
      ...cors(),
    },
  });
}

/**
 * @decision DEC-EPAPER-004
 * @title Preview site is the design source-of-truth for label aesthetic
 * @status accepted
 * @rationale Web preview is fast to iterate; firmware mirrors it via
 * Adafruit_GFX-bundled fonts. Theme A (Editorial): Playfair Display +
 * Lora via Google Fonts on the preview; FreeSerifBold24pt7b + FreeSerif12pt7b
 * in firmware. Preview background #f7f3ec (paper off-white), label cards
 * #fdfaf3 with 1px #1a1a1a border — faithful mock of black-on-paper e-paper.
 * Live-update JS (60s poll + 1s render) retained from previous version.
 * Dial sized to physical scale (~290 px desktop / ~210 px mobile) so preview
 * faithfully mocks ~68 mm wall-mounted clock face next to the 70 mm e-paper
 * card. Updated 2026-04-30.
 */
const PREVIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Family Clock — Preview</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Lora:wght@400;500&display=swap">
<style>
  /* ---- Page shell ---- */
  *, *::before, *::after { box-sizing: border-box; }
  body {
    background: #f7f3ec;
    color: #1a1a1a;
    margin: 0;
    padding: 2.5rem 1.5rem 3rem;
    min-height: 100vh;
    font-family: 'Lora', Georgia, serif;
  }

  /* ---- Header ---- */
  .page-header {
    text-align: center;
    margin: 0 0 2.5rem;
  }
  .page-header h1 {
    font-family: 'Playfair Display', Georgia, serif;
    font-weight: 900;
    font-size: 2rem;
    letter-spacing: -0.02em;
    margin: 0 0 0.25rem;
    color: #1a1a1a;
  }
  .page-header .subtitle {
    font-family: 'Lora', Georgia, serif;
    font-weight: 400;
    font-size: 0.85rem;
    color: #888;
    letter-spacing: 0.04em;
  }

  /* ---- Frame mockup ---- */
  .frame-wrap {
    max-width: 1100px;
    margin: 0 auto 1rem;
    padding: 1.5rem 2rem 1.75rem;
    background: linear-gradient(170deg, #5a3a22, #3a2010);
    border-radius: 8px;
  }
  .frame-inner {
    background: #f0ede5;
    border-radius: 3px;
    padding: 2rem 1.5rem 1.5rem;
  }

  /* ---- Dial + label row ---- */
  .clock-row {
    display: flex;
    flex-wrap: wrap;
    gap: 24px;
    justify-content: center;
    align-items: flex-start;
  }
  .clock-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    flex: 1;
    min-width: 280px;
    max-width: 320px;
  }

  /* ---- Analog dial ---- */
  .dial-svg {
    width: 290px;
    height: 290px;
    display: block;
  }
  .dial-face  { fill: #fff; stroke: #2a2a2a; stroke-width: 1.5; }
  .dial-tick  { stroke: #2a2a2a; stroke-width: 1.2; }
  .dial-tick.major { stroke-width: 2.5; }
  .dial-hand-h { stroke: #1a1a1a; stroke-width: 4;   stroke-linecap: round; }
  .dial-hand-m { stroke: #1a1a1a; stroke-width: 2.5; stroke-linecap: round; }
  .dial-hand-s { stroke: #c33;    stroke-width: 1;   stroke-linecap: round; }
  .dial-pivot  { fill: #1a1a1a; }

  /* ---- E-paper label card ---- */
  /* Dimensions ~300×130px ≈ 4.5× scale of 66.9×29.1mm active area */
  .epaper-card {
    width: 300px;
    height: 130px;
    border: 1px solid #1a1a1a;
    border-radius: 12px;
    background: #fdfaf3;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 10px 16px;
    gap: 6px;
  }
  .epaper-name {
    font-family: 'Playfair Display', Georgia, serif;
    font-weight: 900;
    font-size: 3.5rem;
    line-height: 1;
    text-transform: uppercase;
    color: #1a1a1a;
    letter-spacing: 0.02em;
  }
  .epaper-city {
    font-family: 'Lora', Georgia, serif;
    font-weight: 500;
    font-size: 1.25rem;
    color: #444;
    line-height: 1.2;
  }
  .epaper-time {
    font-family: 'Lora', Georgia, serif;
    font-weight: 400;
    font-size: 0.9rem;
    color: #888;
    font-variant-numeric: tabular-nums;
  }
  .epaper-card.empty {
    opacity: 0.35;
    font-style: italic;
    font-family: 'Lora', Georgia, serif;
    color: #888;
    font-size: 0.9rem;
    justify-content: center;
  }

  /* ---- Status bar ---- */
  .meta {
    text-align: center;
    font-size: 0.78rem;
    color: #aaa;
    margin-top: 0.75rem;
    font-family: 'Lora', Georgia, serif;
  }
  .err { color: #c44; }

  /* ---- Responsive ---- */
  @media (max-width: 700px) {
    body { padding: 1.5rem 0.75rem 2rem; }
    .page-header h1 { font-size: 1.5rem; }
    .frame-wrap { padding: 1rem; }
    .frame-inner { padding: 1.25rem 0.5rem 1rem; }
    .clock-row { gap: 16px; }
    .clock-cell { min-width: 200px; }
    .epaper-card { width: 220px; height: 100px; }
    .epaper-name { font-size: 2.5rem; }
    .epaper-city { font-size: 1rem; }
    .dial-svg { width: 210px; height: 210px; }
  }
</style>
</head>
<body>

<div class="page-header">
  <h1>Family Clock</h1>
  <div class="subtitle">Live preview &mdash; updates every minute</div>
</div>

<div class="frame-wrap">
  <div class="frame-inner">
    <div class="clock-row" id="clockRow"></div>
  </div>
</div>
<div class="meta" id="meta"></div>

<script>
const token = location.pathname.split('/')[2];
const clockRow = document.getElementById('clockRow');
const meta = document.getElementById('meta');
let kids = [];

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function dialSvg(localSec) {
  const h = (localSec / 3600) % 12;
  const m = (localSec % 3600) / 60;
  const s = localSec % 60;
  const hAng = (h / 12) * 360;
  const mAng = (m / 60) * 360;
  const sAng = (s / 60) * 360;
  let ticks = '';
  for (let i = 0; i < 60; i++) {
    const a = i * 6 * Math.PI / 180;
    const r1 = i % 5 === 0 ? 84 : 90;
    const r2 = 96;
    ticks += '<line class="dial-tick ' + (i % 5 === 0 ? 'major' : '') +
      '" x1="' + (100 + r1 * Math.sin(a)) + '" y1="' + (100 - r1 * Math.cos(a)) +
      '" x2="' + (100 + r2 * Math.sin(a)) + '" y2="' + (100 - r2 * Math.cos(a)) + '"/>';
  }
  const hand = (cls, len, ang) =>
    '<line class="' + cls + '" x1="100" y1="100" x2="' +
    (100 + len * Math.sin(ang * Math.PI / 180)) + '" y2="' +
    (100 - len * Math.cos(ang * Math.PI / 180)) + '"/>';
  return '<svg class="dial-svg" viewBox="0 0 200 200">' +
    '<circle class="dial-face" cx="100" cy="100" r="98"/>' +
    ticks +
    hand('dial-hand-h', 50, hAng) +
    hand('dial-hand-m', 75, mAng) +
    hand('dial-hand-s', 82, sAng) +
    '<circle class="dial-pivot" cx="100" cy="100" r="4"/>' +
    '</svg>';
}

function fmtTime(localSec) {
  const h = Math.floor(localSec / 3600) % 24;
  const m = Math.floor((localSec % 3600) / 60);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return h12 + ':' + String(m).padStart(2, '0') + ' ' + ampm;
}

function render() {
  const nowUtc = Math.floor(Date.now() / 1000);
  if (!kids.length) {
    clockRow.innerHTML = '<div style="opacity:.5;font-style:italic;padding:2rem;text-align:center">No data yet — waiting for a location update.</div>';
    return;
  }
  clockRow.innerHTML = kids.map(k => {
    const localSec = ((nowUtc + (k.offset_seconds || 0)) % 86400 + 86400) % 86400;
    const cityLine = esc((k.city || 'Unknown') + (k.country ? ', ' + k.country : ''));
    const name = esc(k.name || '?');
    const timeStr = esc(fmtTime(localSec));
    return '<div class="clock-cell">' +
      dialSvg(localSec) +
      '<div class="epaper-card">' +
        '<div class="epaper-name">' + name + '</div>' +
        '<div class="epaper-city">' + cityLine + '</div>' +
        '<div class="epaper-time">' + timeStr + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function poll() {
  try {
    const r = await fetch('/clock/' + encodeURIComponent(token));
    if (!r.ok) {
      meta.innerHTML = '<span class="err">fetch failed: ' + r.status + ' ' + esc(r.statusText) + '</span>';
      return;
    }
    kids = await r.json();
    meta.textContent = 'loaded ' + kids.length + ' kid' + (kids.length === 1 ? '' : 's') +
      ' · last sync ' + new Date().toLocaleTimeString();
  } catch (e) {
    meta.innerHTML = '<span class="err">' + esc(e.message) + '</span>';
  }
}

poll();
render();
setInterval(poll, 60000);
setInterval(render, 1000);
</script>
</body>
</html>`;

// ---- external lookups --------------------------------------------------

function lookupTimezone(lat, lng) {
  try {
    return tzlookup(lat, lng);
  } catch (e) {
    console.log("[tz] error:", e.message, "lat:", lat, "lng:", lng);
    return "UTC";
  }
}

// @decision Reverse geocoding uses OpenStreetMap Nominatim. BigDataCloud's
// `reverse-geocode-client` endpoint (used previously) is browser-only — it
// 400s with a "ip is now banned" message when called from a Worker. Their
// server endpoint requires a paid key. Nominatim is free, allows server
// use with a User-Agent identifier, and is rate-limited at 1 req/sec which
// is far more than this gift project will ever need.
async function lookupPlace(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lng}`;
  try {
    const r = await fetch(url, {
      headers: {
        "user-agent": "family-clock/0.1 (kantorkids.workers.dev)",
        "accept-language": "en",
      },
      cf: { cacheTtl: 86400 },
    });
    const text = await r.text();
    if (!r.ok) {
      console.log("[place] HTTP", r.status, "body:", text.slice(0, 200));
      return { city: "Unknown", country: "" };
    }
    const d = JSON.parse(text);
    const a = d.address || {};
    const city = a.city || a.town || a.village || a.suburb || a.county || a.state || "Unknown";
    // ISO 3166-1 alpha-2 code, uppercased ("US", "JP", "GB"). Short and
    // unambiguous on the small e-paper labels.
    const country = (a.country_code || "").toUpperCase();
    if (city === "Unknown") {
      console.log("[place] no usable field, address keys:", Object.keys(a).slice(0, 10).join(","));
    }
    return { city, country };
  } catch (e) {
    console.log("[place] error:", e.message);
    return { city: "Unknown", country: "" };
  }
}

// ---- timezone math -----------------------------------------------------

/**
 * Returns the current offset from UTC in seconds for an IANA timezone.
 * Uses Intl.DateTimeFormat which is supported in Workers.
 */
function offsetSeconds(timezone, date = new Date()) {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
      year: "numeric",
    });
    const parts = dtf.formatToParts(date);
    const tzName = parts.find((p) => p.type === "timeZoneName")?.value || "GMT+00:00";
    // Some runtimes use the Unicode minus sign (U+2212) in longOffset
    // instead of an ASCII hyphen, so accept either.
    const m = tzName.match(/GMT([+\-−])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return 0;
    const sign = m[1] === "+" ? 1 : -1;
    const hours = parseInt(m[2], 10);
    const mins = parseInt(m[3] || "0", 10);
    return sign * (hours * 3600 + mins * 60);
  } catch (_) {
    return 0;
  }
}

// ---- helpers -----------------------------------------------------------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...cors() },
  });
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
