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

const PREVIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Family Clock — Preview</title>
<style>
  body { background:#1a1a1a; color:#eee; font-family:-apple-system,system-ui,sans-serif; margin:0; padding:2rem; min-height:100vh; box-sizing:border-box; }
  h1 { font-weight:300; margin:0 0 1.5rem; opacity:.6; font-size:1rem; letter-spacing:.05em; text-transform:uppercase; text-align:center; }
  .row { display:flex; gap:2rem; flex-wrap:wrap; justify-content:center; }
  .kid { background:#2a2a2a; border-radius:1rem; padding:1.5rem; width:240px; max-width:100%; box-sizing:border-box; text-align:center; box-shadow:0 4px 16px rgba(0,0,0,.3); }
  .clock { width:200px; height:200px; margin:0 auto; display:block; }
  .face { fill:#f5f5f5; stroke:#333; stroke-width:2; }
  .tick { stroke:#333; stroke-width:1.5; }
  .tick.major { stroke-width:3; }
  .hand-h { stroke:#222; stroke-width:5; stroke-linecap:round; }
  .hand-m { stroke:#222; stroke-width:3; stroke-linecap:round; }
  .hand-s { stroke:#c33; stroke-width:1.2; stroke-linecap:round; }
  .pivot { fill:#222; }
  .name { font-weight:600; font-size:1.25rem; margin-top:.75rem; letter-spacing:.02em; }
  .city { opacity:.7; font-size:.95rem; margin-top:.25rem; }
  .digital { font-variant-numeric:tabular-nums; opacity:.5; font-size:.85rem; margin-top:.5rem; }
  .empty { opacity:.4; font-style:italic; padding:5rem 0; text-align:center; }
  .meta { margin-top:2rem; opacity:.4; font-size:.8rem; text-align:center; }
  .err { color:#f88; }

  /* Physical-clock mockup */
  .mockup-title { text-align:center; opacity:.55; font-size:.85rem; letter-spacing:.06em; text-transform:uppercase; margin:3rem 0 1rem; font-weight:300; }
  .frame { max-width:720px; margin:0 auto; padding:1.5rem; background:linear-gradient(180deg,#5a3a22,#3d2616); border-radius:10px; box-shadow:0 8px 32px rgba(0,0,0,.6), inset 0 0 0 2px rgba(0,0,0,.5); }
  .frame-inner { background:#f0ede5; border-radius:3px; padding:2rem 1rem 1.75rem; box-shadow:inset 0 4px 16px rgba(0,0,0,.15); }
  .mockup-row { display:flex; justify-content:space-around; align-items:flex-start; gap:1rem; }
  .mockup-cell { display:flex; flex-direction:column; align-items:center; gap:1rem; flex:1; min-width:0; }
  .real-clock { width:100%; max-width:140px; height:auto; display:block; }
  .real-face { fill:#fff; stroke:#2a2a2a; stroke-width:1.5; }
  .real-tick { stroke:#2a2a2a; stroke-width:1.2; }
  .real-tick.major { stroke-width:2.5; }
  .real-hand-h { stroke:#1a1a1a; stroke-width:4; stroke-linecap:round; }
  .real-hand-m { stroke:#1a1a1a; stroke-width:2.5; stroke-linecap:round; }
  .real-hand-s { stroke:#c33; stroke-width:1; stroke-linecap:round; }
  .real-pivot { fill:#1a1a1a; }
  .oled { background:#050a14; border:1px solid #1a1a1a; border-radius:2px; padding:.4rem .5rem; min-width:100px; max-width:130px; text-align:center; box-shadow:0 0 6px rgba(255,255,255,.04); }
  .oled-name { color:#fff; font-weight:700; font-size:.72rem; letter-spacing:.05em; font-family:ui-monospace,Menlo,monospace; line-height:1.2; }
  .oled-city { color:#fff; font-size:.6rem; opacity:.85; font-family:ui-monospace,Menlo,monospace; line-height:1.3; margin-top:2px; }
  .mockup-caption { text-align:center; opacity:.4; font-size:.7rem; margin:.75rem 0 0; font-style:italic; }

  @media (max-width: 600px) {
    body { padding:1rem 0.75rem; }
    h1 { margin:0 0 1rem; font-size:.85rem; }
    .row { gap:1rem; }
    .kid { width:100%; max-width:360px; padding:1.25rem; }
    .clock { width:240px; height:240px; }
    .name { font-size:1.4rem; margin-top:1rem; }
    .city { font-size:1rem; }
    .digital { font-size:.9rem; }
    .frame { padding:1rem; }
    .frame-inner { padding:1.25rem .25rem 1rem; }
    .mockup-row { gap:.4rem; }
    .real-clock { max-width:90px; }
    .oled { min-width:70px; max-width:100px; padding:.3rem .35rem; }
    .oled-name { font-size:.6rem; letter-spacing:.03em; }
    .oled-city { font-size:.5rem; }
  }
</style>
</head>
<body>
<h1>Family Clock — Live Preview</h1>

<div class="frame"><div class="frame-inner"><div class="mockup-row" id="mockupRoot"></div></div></div>
<div class="mockup-caption">Approximate proportions, ~12"×6" shadow box</div>

<div class="meta" id="meta"></div>

<script>
const token = location.pathname.split('/')[2];
const mockupRoot = document.getElementById('mockupRoot');
const meta = document.getElementById('meta');
let kids = [];

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function clockSvg(localSec, p) {
  p = p || '';
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
    ticks += '<line class="' + p + 'tick ' + (i%5===0?'major':'') + '" x1="' + (100 + r1*Math.sin(a)) + '" y1="' + (100 - r1*Math.cos(a)) + '" x2="' + (100 + r2*Math.sin(a)) + '" y2="' + (100 - r2*Math.cos(a)) + '"/>';
  }
  const hand = (cls, len, ang) => '<line class="' + cls + '" x1="100" y1="100" x2="' + (100 + len*Math.sin(ang*Math.PI/180)) + '" y2="' + (100 - len*Math.cos(ang*Math.PI/180)) + '"/>';
  return '<svg class="' + p + 'clock" viewBox="0 0 200 200">' +
    '<circle class="' + p + 'face" cx="100" cy="100" r="98"/>' +
    ticks +
    hand(p + 'hand-h', 50, hAng) +
    hand(p + 'hand-m', 75, mAng) +
    hand(p + 'hand-s', 82, sAng) +
    '<circle class="' + p + 'pivot" cx="100" cy="100" r="4"/>' +
    '</svg>';
}

function fmtDigital(localSec) {
  const h = Math.floor(localSec / 3600) % 24;
  const m = Math.floor((localSec % 3600) / 60);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return h12 + ':' + String(m).padStart(2,'0') + ' ' + ampm;
}

function render() {
  if (!kids.length) {
    mockupRoot.innerHTML = '';
    return;
  }
  const nowUtc = Math.floor(Date.now() / 1000);
  mockupRoot.innerHTML = kids.map(k => {
    const localSec = ((nowUtc + (k.offset_seconds || 0)) % 86400 + 86400) % 86400;
    const cityLine = (k.city || 'Unknown') + (k.country ? ', ' + k.country : '');
    return '<div class="mockup-cell">' + clockSvg(localSec, 'real-') +
      '<div class="oled">' +
      '<div class="oled-name">' + esc((k.name || '?').toUpperCase()) + '</div>' +
      '<div class="oled-city">' + esc(cityLine) + '</div>' +
      '</div></div>';
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
    meta.textContent = 'loaded ' + kids.length + ' kid' + (kids.length===1?'':'s') + ' · last sync ' + new Date().toLocaleTimeString();
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
