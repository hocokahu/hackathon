/**
 * Okahu / Team Mosaic — storefront chat backend.
 *
 * One HTTPS endpoint that:
 *   1. Answers the shopper with Gemini (key stays server-side).
 *   2. Extracts structured preferences from the message (favorite_color, location, style, budget).
 *   3. If the shopper is a logged-in customer (email), writes those preferences onto their
 *      Bloomreach Engagement profile via the Customers tracking API (new properties auto-create).
 *
 * No external dependencies — uses Node 20 built-ins (global fetch, node:http).
 * All secrets come from environment variables (never hard-code them; this repo is public).
 */
"use strict";
const http = require("node:http");
const crypto = require("node:crypto");

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
// Image generation (the "image OUTPUT" leg). Gemini 3 Pro Image (Nano Banana Pro) accepts text and,
// optionally, an input image (image IN → image OUT), and returns inline JPEG/PNG bytes.
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3-pro-image-preview";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://okahu-hackathon.myshopify.com"; // no wildcard default

// Bloomreach Engagement tracking Batch API (optional — if unset, attribute writes are skipped, chat still works).
// Auth = project Public API group Token; hard identifier = email_id (NOT registered — a wrong id is silently dropped).
const BR_API_BASE = (process.env.BLOOMREACH_API_BASE_URL || "").replace(/\/+$/, ""); // https://api-engagement.bloomreach.com
const BR_PROJECT_TOKEN = process.env.BLOOMREACH_PROJECT_TOKEN || "";
const BR_API_TOKEN = process.env.BLOOMREACH_API_TOKEN || "";
const BR_READY = Boolean(BR_API_BASE && BR_PROJECT_TOKEN && BR_API_TOKEN); // boolean, never expose the token

// Shopify Admin (optional) — resolve a logged-in shopper's email from their storefront customerId, so profile
// writes work without a theme-side email injection. Uses the read_customers Admin token.
const SHOP_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || "";
const SHOP_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN || "";
const SHOP_VER = process.env.SHOPIFY_API_VERSION || "2025-01";

// Shopify App Proxy (the real identity lock). When the storefront calls us THROUGH the app proxy
// (/apps/<subpath>/*), Shopify appends a `signature` (HMAC-SHA256 of the sorted query params, keyed by
// the app's client secret) and a SERVER-SET `logged_in_customer_id` that the client cannot forge. We
// verify the signature and trust ONLY that customer id — never a client-asserted email or customer_id.
// SHOPIFY_APP_PROXY_SECRET = the chat app's client secret. REQUIRE_APP_PROXY=true enforces the lock
// (identity accepted only from a verified proxy request); false keeps the pre-proxy behavior during rollout.
const APP_PROXY_SECRET = process.env.SHOPIFY_APP_PROXY_SECRET || "";
const REQUIRE_APP_PROXY = String(process.env.REQUIRE_APP_PROXY || "").toLowerCase() === "true";

// Public storefront vision (POST /vision-chat): lets an anonymous shopper (real device_id) or a
// verified app-proxy shopper upload a photo and get a visual recommendation. It runs vision + image
// generation, so it is behind a feature flag and its OWN stricter rate limit. Never trusts a
// client-asserted email — anonymous writes go to the cookie profile only. Default OFF.
const PUBLIC_VISION = String(process.env.PUBLIC_VISION || "").toLowerCase() === "true";

// Shared secret for the internal enrichment routes (/enrich, /agent/run). Fail closed: if unset, those
// routes are disabled (401). Callers pass `Authorization: Bearer <key>` or `x-enrich-key: <key>`.
const ENRICH_API_KEY = process.env.ENRICH_API_KEY || "";
const EMAIL_RE = /^[^\s@]{1,254}@[^\s@]+\.[^\s@]+$/;

// Verify a Shopify App Proxy request. Returns { valid, logged_in_customer_id }. Signature algorithm:
// take all query params except `signature`, sort by key, join as key=value with NO separator (array
// values joined by comma), HMAC-SHA256 with the app secret, hex-compare (timing-safe) to `signature`.
function verifyAppProxy(searchParams) {
  if (!APP_PROXY_SECRET) return { valid: false, logged_in_customer_id: null };
  const sig = searchParams.get("signature");
  if (!sig) return { valid: false, logged_in_customer_id: null };
  const keys = [];
  for (const k of searchParams.keys()) if (k !== "signature" && !keys.includes(k)) keys.push(k);
  keys.sort();
  const msg = keys.map((k) => `${k}=${searchParams.getAll(k).join(",")}`).join("");
  const digest = crypto.createHmac("sha256", APP_PROXY_SECRET).update(msg).digest("hex");
  const a = Buffer.from(digest, "utf8"), b = Buffer.from(sig, "utf8");
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { valid, logged_in_customer_id: valid ? (searchParams.get("logged_in_customer_id") || null) : null };
}

// Databricks (optional) — mirror the chat signal into a Delta table so the Databricks agent can
// reason over it. Uses the SQL Statement Execution API against a serverless warehouse. If unset,
// the Databricks write is skipped and chat still works. Host/token/warehouse come from env.
const DBX_HOST = (process.env.DATABRICKS_HOST || "").replace(/\/+$/, "");
const DBX_TOKEN = process.env.DATABRICKS_TOKEN || "";
const DBX_WAREHOUSE = process.env.DATABRICKS_WAREHOUSE_ID || "";
const DBX_SIGNALS_TABLE = process.env.DATABRICKS_SIGNALS_TABLE || "workspace.default.mosaic_chat_signals";
const DBX_READY = Boolean(DBX_HOST && DBX_TOKEN && DBX_WAREHOUSE);
// The Databricks-hosted brain the service calls for VISION reasoning. This is a real Databricks Model
// Serving endpoint (Claude Sonnet 4.5) invoked over the OpenAI-compatible /invocations API — the same
// governed endpoint a deployed Mosaic AI Agent would front. It receives the image inline (data URI) in
// the request body; Databricks never dials out (all egress stays in Cloud Run). See databricks/agent.py
// for the committable Agent Framework version (Claude + UC tools + Genie) that productionizes this call.
const DBX_VISION_ENDPOINT = process.env.DATABRICKS_VISION_ENDPOINT || "databricks-claude-sonnet-4-5";
const DBX_VISION_TABLE = process.env.DATABRICKS_VISION_TABLE || "workspace.default.mosaic_vision_reco";
const VISION_READY = Boolean(DBX_READY && GEMINI_API_KEY);

const SYSTEM_PROMPT = [
  "You are the Team Mosaic Shopping Assistant on an online store.",
  "Be warm, concise (1-3 sentences), and genuinely helpful with product discovery and styling.",
  "As you chat, quietly capture any durable shopper preferences they reveal:",
  "favorite color, location/region, style preference, budget band, and — especially for",
  "outdoor or seasonal plans — their favorite activity, the place they are headed, and their summer interest.",
  "Only fill an attribute when the shopper actually states it; otherwise leave it out.",
  "Never invent order details or specific product/stock claims you weren't given.",
].join(" ");

// Structured output: one call returns both the reply and the extracted attributes.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string", description: "The assistant's chat reply to show the shopper." },
    attributes: {
      type: "object",
      description: "Durable preferences the shopper explicitly stated in THIS message. Omit anything not stated.",
      properties: {
        favorite_color: { type: "string" },
        preferred_location: { type: "string" },
        style_preference: { type: "string" },
        budget_band: { type: "string" },
        favorite_activity: { type: "string", description: "e.g. hiking, snowboarding, running" },
        favorite_location: { type: "string", description: "a place/destination the shopper is headed, e.g. Denver, the Rockies" },
        summer_interest: { type: "string", description: "what they want to do this summer, e.g. hiking, trail running" },
      },
    },
  },
  required: ["reply"],
};

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// Body cap: chat payloads are tiny, but /vision-enrich carries a base64 image, so allow up to ~10 MB.
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 10 * 1024 * 1024);
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > MAX_BODY_BYTES) { reject(new Error("payload too large")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

// Lightweight per-IP rate limit (defense-in-depth on a public, unauthenticated endpoint — NOT a
// substitute for real auth). Fixed window; lenient by default so it never blocks normal chat.
const RL_MAX = Number(process.env.RATE_LIMIT_MAX || 60);
const RL_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RL_MAX_KEYS = Number(process.env.RATE_LIMIT_MAX_KEYS || 10000);
const rlHits = new Map(); // ip -> { count, reset } (insertion-ordered for oldest-first eviction)
function rateLimited(ip) {
  const now = Date.now();
  let e = rlHits.get(ip);
  if (!e || now > e.reset) { e = { count: 0, reset: now + RL_WINDOW_MS }; rlHits.delete(ip); rlHits.set(ip, e); }
  e.count++;
  // Bound memory: evict oldest keys once over capacity, regardless of expiry (spoofed keys can't grow it unbounded).
  while (rlHits.size > RL_MAX_KEYS) { const oldest = rlHits.keys().next().value; if (oldest === undefined) break; rlHits.delete(oldest); }
  return e.count > RL_MAX;
}

// Separate, much stricter limiter for the public vision route (each call runs vision + image-gen).
const VISION_RL_MAX = Number(process.env.VISION_RATE_LIMIT_MAX || 6);
const vrlHits = new Map();
function visionRateLimited(ip) {
  const now = Date.now();
  let e = vrlHits.get(ip);
  if (!e || now > e.reset) { e = { count: 0, reset: now + RL_WINDOW_MS }; vrlHits.delete(ip); vrlHits.set(ip, e); }
  e.count++;
  while (vrlHits.size > RL_MAX_KEYS) { const oldest = vrlHits.keys().next().value; if (oldest === undefined) break; vrlHits.delete(oldest); }
  return e.count > VISION_RL_MAX;
}

async function askGemini({ message, history }) {
  // Gemini Interactions API (the replacement for generateContent). Stateless: we pass full history.
  const clip = (s) => String(s == null ? "" : s).slice(0, 2000); // cap per-turn text
  const input = [{ type: "text", text: SYSTEM_PROMPT }];
  for (const h of (Array.isArray(history) ? history : []).slice(-10)) {
    if (!h || !h.text) continue;
    if (h.role === "model") input.push({ type: "model_output", content: [{ type: "text", text: clip(h.text) }] });
    else input.push({ type: "user_input", content: clip(h.text) });
  }
  input.push({ type: "user_input", content: clip(message) });

  const url = "https://generativelanguage.googleapis.com/v1beta/interactions";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: GEMINI_MODEL,
        store: false,
        input,
        response_format: { type: "text", mime_type: "application/json", schema: RESPONSE_SCHEMA },
      }),
    });
  } finally { clearTimeout(t); }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`gemini ${resp.status}: ${body.slice(0, 300)}`);
  }
  const data = await resp.json();
  // Extract the last model_output text part from steps[].
  const steps = Array.isArray(data.steps) ? data.steps : [];
  let text = "{}";
  for (let i = steps.length - 1; i >= 0; i--) {
    const parts = steps[i] && steps[i].content;
    if (Array.isArray(parts)) {
      const tp = parts.find((p) => p && p.type === "text" && p.text);
      if (tp) { text = tp.text; break; }
    }
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { reply: text }; }
  return { reply: parsed.reply || "Sorry, I didn't catch that — could you rephrase?", attributes: parsed.attributes || {} };
}

// Build Bloomreach customer_ids. Hard id = email_id (when known); soft ids = cookie (=device_id) and
// shopify_id. Passing BOTH email_id and cookie in one command is what stitches an anonymous (cookie)
// profile into the known (email) one — the anonymous→known merge.
function brCustomerIds({ email, customer_id, device_id }) {
  const ids = {};
  if (email) ids.email_id = String(email);
  if (device_id) ids.cookie = String(device_id);
  if (customer_id) ids.shopify_id = String(customer_id);
  return ids;
}

// Low-level tracking Batch API call (Public-group Token auth). Never returns the upstream body to the client.
async function brTrack(customer_ids, properties) {
  const url = `${BR_API_BASE}/track/v2/projects/${BR_PROJECT_TOKEN}/batch`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Token ${BR_API_TOKEN}` },
    body: JSON.stringify({ commands: [{ name: "customers", data: { customer_ids, properties: properties || {} } }] }),
  });
  const body = await resp.text().catch(() => "");
  let ok = false;
  try { const j = JSON.parse(body); ok = !!(j.success && j.results && j.results[0] && j.results[0].success); } catch {}
  if (!ok) console.error("bloomreach write failed", resp.status, body.slice(0, 300)); // log server-side only
  return { ok, status: resp.status };
}

async function writeBloomreach({ email, customer_id, device_id, attributes }) {
  // Model output is untrusted: allowlist keys, cap length, reject markup/template/url/control chars.
  const ALLOWED_ATTRS = {
    favorite_color: 60, preferred_location: 80, style_preference: 60, budget_band: 40,
    favorite_activity: 60, favorite_location: 80, summer_interest: 60,
  };
  const props = {};
  for (const [k, max] of Object.entries(ALLOWED_ATTRS)) {
    let v = attributes && attributes[k];
    if (typeof v !== "string") continue;
    v = v.trim();
    if (!v || v.length > max) continue;
    if (/[<>{}$\u0000-\u001f]/.test(v) || /https?:\/\//i.test(v)) continue;
    props[k] = v;
  }
  if (!BR_READY || Object.keys(props).length === 0) return { wrote: false, props };

  // Identity: email_id when known (writes onto the known profile, and stitches any cookie); otherwise
  // cookie=device_id (writes onto the anonymous profile). Sending both ids also performs the merge.
  const ids = brCustomerIds({ email, customer_id, device_id });
  if (!ids.email_id && !ids.cookie) return { wrote: false, props, reason: "no identity (need email or device_id)" };

  const { ok, status } = await brTrack(ids, props);
  return { wrote: ok, props, status, identity: ids.email_id ? "email_id" : "cookie", merged: !!(ids.email_id && ids.cookie) };
}

// Explicit anonymous→known merge: send ONE command carrying both cookie (device_id) and email_id so
// Bloomreach stitches the anonymous profile into the known one. Identity is TRUSTED ONLY when the email
// is resolved SERVER-SIDE from the Shopify customer_id — a client-asserted email is never accepted (that
// would let anyone stitch a device into any email profile). Residual: customer_id is itself client-
// supplied; the full fix is Shopify App Proxy HMAC (planned auth phase). Responses are uniform to avoid a
// customer_id enumeration oracle.
async function mergeBloomreach({ device_id, customer_id }) {
  if (!BR_READY || !device_id || !customer_id) return { merged: false };
  let idEmail = null;
  try { idEmail = await resolveEmail(customer_id); } catch {}
  if (!idEmail) return { merged: false };
  const { ok } = await brTrack(brCustomerIds({ email: idEmail, device_id }), {});
  return { merged: ok };
}

// Mirror the extracted signal into Databricks (Delta table) so the Databricks agent can reason over it.
// SQL string literals are built from allowlisted props (already validated) + a single-quote-escaped message.
async function writeDatabricks({ email, attributes, message }) {
  if (!DBX_READY || !email) return { dbx: false };
  const ALLOWED = ["favorite_activity", "favorite_location", "summer_interest", "favorite_color", "style_preference", "budget_band"];
  const q = (v) => (v == null ? null : `'${String(v).replace(/'/g, "''").slice(0, 200)}'`);
  const cols = ["email", ...ALLOWED, "raw_message", "source", "created_at"];
  const vals = [
    q(email),
    ...ALLOWED.map((k) => {
      const v = attributes && attributes[k];
      return typeof v === "string" && v.trim() ? q(v.trim()) : "NULL";
    }),
    q(String(message || "").slice(0, 500)),
    q("storefront_chat"),
    "current_timestamp()",
  ];
  const sql = `INSERT INTO ${DBX_SIGNALS_TABLE} (${cols.join(",")}) VALUES (${vals.join(",")})`;
  try {
    const resp = await fetch(`${DBX_HOST}/api/2.0/sql/statements`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${DBX_TOKEN}` },
      body: JSON.stringify({ statement: sql, warehouse_id: DBX_WAREHOUSE, wait_timeout: "30s" }),
    });
    const j = await resp.json().catch(() => ({}));
    const ok = (j && j.status && j.status.state === "SUCCEEDED");
    if (!ok) console.error("databricks write failed", resp.status, JSON.stringify(j.status || {}).slice(0, 300));
    return { dbx: ok };
  } catch (e) {
    console.error("databricks write error", String(e).slice(0, 300));
    return { dbx: false };
  }
}

// Resolve a shopper's email from their Shopify storefront customerId (read_customers). Returns null if unavailable.
async function resolveEmail(customerId) {
  if (!SHOP_DOMAIN || !SHOP_TOKEN || !customerId) return null;
  if (!/^\d+$/.test(String(customerId))) return null; // storefront customerId is numeric
  try {
    const r = await fetch(`https://${SHOP_DOMAIN}/admin/api/${SHOP_VER}/customers/${customerId}.json`, {
      headers: { "X-Shopify-Access-Token": SHOP_TOKEN },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return (d && d.customer && d.customer.email) || null;
  } catch { return null; }
}

// ── Phase 1: enrichment leg (weather → reasoning → activation) ──────────────────────────────────
// Cloud Run does all egress (Open-Meteo weather); Databricks is the brain it calls (ai_query). Reuses
// the mosaic_weather / mosaic_recommendations Delta tables and writes activation attrs to Bloomreach.

// Run a SQL statement on the Databricks serverless warehouse; return rows for SELECTs.
async function dbxExec(statement) {
  if (!DBX_READY) return { ok: false, rows: [], cols: [] };
  try {
    const resp = await fetch(`${DBX_HOST}/api/2.0/sql/statements`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${DBX_TOKEN}` },
      body: JSON.stringify({ statement, warehouse_id: DBX_WAREHOUSE, wait_timeout: "50s" }),
    });
    const j = await resp.json().catch(() => ({}));
    const ok = !!(j && j.status && j.status.state === "SUCCEEDED");
    const cols = (((j.manifest || {}).schema || {}).columns || []).map((c) => c.name);
    const rows = ((j.result || {}).data_array) || [];
    if (!ok) console.error("dbx exec failed", JSON.stringify((j || {}).status || {}).slice(0, 300));
    return { ok, rows, cols };
  } catch (e) { console.error("dbx exec error", String(e).slice(0, 200)); return { ok: false, rows: [], cols: [] }; }
}

// Store a generated image (a data URI) INTO a Unity Catalog Volume so Databricks holds a copy too.
// Cloud Run is the courier: it PUTs the bytes into Databricks (inbound = allowed); Databricks never
// dials out to fetch an image. Returns { path, url } (the Files-API url) or null on failure.
const DBX_IMAGE_VOLUME = process.env.DATABRICKS_IMAGE_VOLUME || "/Volumes/workspace/default/mosaic_images";
async function saveImageToDatabricks(dataUri, keyHint) {
  if (!DBX_READY || !dataUri) return null;
  const m = String(dataUri).match(/^data:([^;]+);base64,(.*)$/s);
  if (!m) return null;
  const ext = ((m[1].split("/")[1] || "png").replace(/[^a-z0-9]/gi, "")) || "png";
  const safe = String(keyHint || "anon").replace(/[^a-z0-9]/gi, "_").slice(0, 40);
  const vpath = `${DBX_IMAGE_VOLUME}/vision_${safe}_${Date.now()}.${ext}`;
  try {
    const resp = await fetch(`${DBX_HOST}/api/2.0/fs/files${vpath}?overwrite=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", Authorization: `Bearer ${DBX_TOKEN}` },
      body: Buffer.from(m[2], "base64"),
    });
    if (resp.status !== 204 && resp.status !== 200) { console.error("dbx image save http", resp.status); return null; }
    return { path: vpath, url: `${DBX_HOST}/api/2.0/fs/files${vpath}` };
  } catch (e) { console.error("dbx image save error", String(e).slice(0, 200)); return null; }
}
const sqlLit = (v) => (v == null ? "NULL" : `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "''").slice(0, 800)}'`);
const sqlNum = (v) => (typeof v === "number" && isFinite(v) ? String(v) : "NULL");
const sqlBool = (v) => (v === true ? "true" : v === false ? "false" : "NULL");

// Open-Meteo geocode (Cloud Run egress; no API key needed).
async function geocodeLocation(name) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(String(name).slice(0, 80))}&count=1&language=en&format=json`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const d = await r.json().catch(() => ({}));
  const g = d && d.results && d.results[0];
  if (!g) return null;
  return { lat: g.latitude, lon: g.longitude, name: [g.name, g.admin1, g.country_code].filter(Boolean).join(", ") };
}

// Open-Meteo 7-day forecast → summarized weather.
async function fetchForecast(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&forecast_days=7&timezone=auto`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const d = await r.json().catch(() => ({}));
  const day = d && d.daily;
  if (!day || !Array.isArray(day.time)) return null;
  const highs = (day.temperature_2m_max || []).filter((x) => typeof x === "number");
  const lows = (day.temperature_2m_min || []).filter((x) => typeof x === "number");
  const precs = (day.precipitation_probability_max || []).filter((x) => typeof x === "number");
  const hi = highs.length ? Math.round(Math.max(...highs)) : null;
  const lo = lows.length ? Math.round(Math.min(...lows)) : null;
  const pr = precs.length ? Math.max(...precs) : null;
  const summary = `Highs to ${hi}F, lows to ${lo}F, max rain chance ${pr}% over the next 7 days`;
  return { temp_high_f: hi, temp_low_f: lo, precip_prob_max: pr, summary, week_start: day.time[0], forecast_json: JSON.stringify(day).slice(0, 4000) };
}

// Pull the shopper's latest chat signal as context for reasoning (activity, interest, location, style).
async function getCustomerContext(email) {
  const ctxCols = ["favorite_activity", "favorite_location", "summer_interest", "favorite_color", "style_preference", "budget_band"];
  const q = await dbxExec(
    `SELECT ${ctxCols.join(",")} FROM ${DBX_SIGNALS_TABLE} WHERE email = ${sqlLit(email)} ORDER BY created_at DESC LIMIT 1`
  );
  const ctx = {};
  if (q.ok && q.rows[0]) q.cols.forEach((c, i) => { if (q.rows[0][i] != null) ctx[c] = q.rows[0][i]; });
  return ctx;
}

// Ask the Databricks-hosted Claude (ai_query) for the next-best product + propensity, given context + weather.
async function reason({ email, context, weather }) {
  const ctxLine = Object.entries(context || {}).map(([k, v]) => `${k}=${v}`).join(", ") || "no stated preferences yet";
  const w = weather ? `Weather for ${weather.location} next week: ${weather.summary}.` : "Weather unknown.";
  const prompt = [
    "You are a product recommendation engine for an outdoor and snowboard store.",
    `Shopper context: ${ctxLine}.`, w,
    "Recommend the single best next product to cross-sell and a purchase propensity from 0 to 1.",
    'Return ONLY compact JSON, no prose: {"recommended_product":"<name>","propensity":<0-1>,"rationale":"<one sentence>"}',
  ].join(" ");
  const q = await dbxExec(`SELECT ai_query('databricks-claude-sonnet-4-5', ${sqlLit(prompt)}) AS out`);
  if (!q.ok || !q.rows[0]) return null;
  let text = String(q.rows[0][0] || "");
  const m = text.match(/\{[\s\S]*\}/); // pull the JSON object out of any wrapper text
  if (m) text = m[0];
  try {
    const p = JSON.parse(text);
    const prop = Number(p.propensity);
    return {
      recommended_product: typeof p.recommended_product === "string" ? p.recommended_product.slice(0, 80) : null,
      propensity: isFinite(prop) ? Math.max(0, Math.min(1, Math.round(prop * 100) / 100)) : null,
      rationale: typeof p.rationale === "string" ? p.rationale.slice(0, 300) : null,
    };
  } catch { return null; }
}

// Validate + write activation attributes to Bloomreach (product/rationale come from the LLM — untrusted).
function activationProps({ rec, weather }) {
  const props = {};
  const clean = (v, max) => {
    if (typeof v !== "string") return null; v = v.trim();
    if (!v || v.length > max) return null;
    if (/[<>{}$\u0000-\u001f]/.test(v) || /https?:\/\//i.test(v)) return null;
    return v;
  };
  if (rec) {
    const p = clean(rec.recommended_product, 80);
    if (p) { props.next_best_product = p; props.predicted_next_purchase = p; }
    if (typeof rec.propensity === "number") props.recommendation_propensity = rec.propensity;
    const r = clean(rec.rationale, 300);
    if (r) props.recommendation_rationale = r;
    props.recommendation_model = "databricks-claude-sonnet-4-5 (Databricks Model Serving)";
  }
  if (weather) {
    const wl = clean(weather.location, 80); if (wl) props.weather_location = wl;
    if (typeof weather.temp_high_f === "number") props.weather_next_week_high_f = weather.temp_high_f;
    if (typeof weather.temp_low_f === "number") props.weather_next_week_low_f = weather.temp_low_f;
    const ws = clean(weather.summary, 200); if (ws) props.weather_next_week_summary = ws;
  }
  return props;
}

// Resolve a location name → 7-day weather (Cloud Run egress) and persist it to mosaic_weather so the
// Databricks agent's get_weather_forecast tool can read it. Returns the weather object or null.
async function getWeatherForLocation(loc) {
  const geo = await geocodeLocation(loc);
  if (!geo) return null;
  const fc = await fetchForecast(geo.lat, geo.lon);
  if (!fc) return null;
  const weather = { location: geo.name, lat: geo.lat, lon: geo.lon, ...fc };
  await dbxExec(
    `INSERT INTO workspace.default.mosaic_weather (location,lat,lon,week_start,temp_high_f,temp_low_f,precip_prob_max,summary,forecast_json,fetched_at) VALUES (` +
    `${sqlLit(weather.location)},${sqlNum(weather.lat)},${sqlNum(weather.lon)},${sqlLit(weather.week_start)},${sqlNum(weather.temp_high_f)},${sqlNum(weather.temp_low_f)},${sqlNum(weather.precip_prob_max)},${sqlLit(weather.summary)},${sqlLit(weather.forecast_json)},current_timestamp())`
  );
  return weather;
}

// Orchestrate: resolve location → weather (+store) → reason → write recommendation (+ activate Bloomreach).
async function enrich({ email, device_id, location }) {
  if (!email || !EMAIL_RE.test(email)) return { ok: false, reason: "valid identity required" };
  const context = await getCustomerContext(email);
  const loc = (typeof location === "string" && location.trim()) || context.favorite_location || context.preferred_location || null;
  if (!loc) return { ok: false, reason: "no location (pass location, or set favorite_location via chat first)" };

  const weather = await getWeatherForLocation(loc);

  const rec = await reason({ email, context, weather });
  if (!rec || !rec.recommended_product) return { ok: false, reason: "reasoning failed" };

  // store the recommendation
  const ownsSnowboard = context.favorite_activity && /snowboard/i.test(context.favorite_activity) ? true : null;
  await dbxExec(
    `INSERT INTO workspace.default.mosaic_recommendations (email,recommended_product,propensity,rationale,weather_summary,owns_snowboard,model,created_at) VALUES (` +
    `${sqlLit(email)},${sqlLit(rec.recommended_product)},${sqlNum(rec.propensity)},${sqlLit(rec.rationale)},${sqlLit(weather && weather.summary)},${sqlBool(ownsSnowboard)},${sqlLit("databricks-claude-sonnet-4-5")},current_timestamp())`
  );

  // activate onto the Bloomreach profile
  let activated = false;
  if (BR_READY) {
    const props = activationProps({ rec, weather });
    const ids = brCustomerIds({ email, device_id });
    const { ok } = await brTrack(ids, props);
    activated = ok;
  }
  return { ok: true, location: loc, weather, recommendation: rec, activated };
}

// ── Phase 2: multimodal "Vision Stylist" leg ─────────────────────────────────────────────────────
// Image IN → Databricks Claude (vision) analysis grounded in cross-platform context + live weather →
// real product resolution (Shopify) → generated lifestyle image OUT (Gemini). This is the leg that does
// what Bloomreach's behavioral engine cannot: reason over the shopper's OWN photo.

const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 7 * 1024 * 1024);
const IMG_MIME_OK = new Set(["image/png", "image/jpeg", "image/webp"]);

// Parse a client-supplied image into { mime, b64, dataUri } or null. Accepts a data: URI or raw base64.
// Rejects oversize / non-image payloads (untrusted input).
function parseImage(input, mimeHint) {
  if (typeof input !== "string" || !input) return null;
  let mime = mimeHint || "image/jpeg", b64 = input.trim();
  const m = b64.match(/^data:([^;]+);base64,(.*)$/s);
  if (m) { mime = m[1]; b64 = m[2]; }
  b64 = b64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(b64) || b64.length < 100) return null;
  if (!IMG_MIME_OK.has(mime)) mime = "image/jpeg";
  if (Math.floor((b64.length * 3) / 4) > MAX_IMAGE_BYTES) return null;
  return { mime, b64, dataUri: `data:${mime};base64,${b64}` };
}

// Cache the Shopify catalog briefly so product resolution doesn't refetch on every call.
let _catalog = { at: 0, items: [] };
async function getCatalog() {
  if (!SHOP_DOMAIN || !SHOP_TOKEN) return [];
  if (Date.now() - _catalog.at < 300000 && _catalog.items.length) return _catalog.items;
  try {
    const r = await fetch(`https://${SHOP_DOMAIN}/admin/api/${SHOP_VER}/products.json?limit=250&fields=id,title,handle,product_type,image,variants`, {
      headers: { "X-Shopify-Access-Token": SHOP_TOKEN },
    });
    if (!r.ok) return _catalog.items;
    const d = await r.json();
    const items = (d.products || []).filter((p) => (p.product_type || "").toLowerCase() !== "giftcard").map((p) => ({
      id: p.id, title: p.title, handle: p.handle, product_type: p.product_type,
      price: ((p.variants || [])[0] || {}).price || null,
      image: (p.image || {}).src || null,
      url: `https://${SHOP_DOMAIN}/products/${p.handle}`,
    }));
    if (items.length) _catalog = { at: Date.now(), items };
    return _catalog.items;
  } catch { return _catalog.items; }
}

// Match an LLM-named product to a real catalog item (exact title, else best token overlap).
function matchProduct(name, catalog) {
  if (!name) return null;
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const exact = catalog.find((p) => p.title.toLowerCase() === String(name).toLowerCase());
  if (exact) return exact;
  const target = norm(name);
  let best = null, bestScore = 0;
  for (const p of catalog) {
    const set = new Set(norm(p.title));
    const score = target.reduce((n, t) => n + (set.has(t) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return bestScore > 0 ? best : null;
}

// Call the Databricks-hosted Claude (vision) with the shopper's image + cross-platform context + weather.
// Returns structured JSON. All egress stays in Cloud Run; the image travels inline in the request body.
async function analyzeImageWithClaude({ imageDataUri, context, weather, catalog }) {
  const ctxLine = Object.entries(context || {}).map(([k, v]) => `${k}=${v}`).join(", ") || "no stated preferences yet";
  const w = weather ? `Live 7-day forecast for ${weather.location}: ${weather.summary}.` : "Weather unknown.";
  const menu = catalog.map((p) => `- ${p.title}${p.price ? ` ($${p.price})` : ""}`).join("\n");
  const sys = [
    "You are Mosaic's visual merchandising analyst for an outdoor & snowboard store.",
    "You are given a SHOPPER'S OWN PHOTO plus their cross-platform profile and the live weather forecast.",
    "Study the photo for signals a behavioral engine cannot see: the setting/terrain, the season, the",
    "gear they already own and its apparent condition/suitability, their activity, and weather cues.",
    "Then recommend the single best next product to cross-sell FROM THE CATALOG BELOW (use the exact title).",
  ].join(" ");
  const userText = [
    `Shopper profile: ${ctxLine}.`, w, "", "CATALOG (choose exactly one title):", menu, "",
    'Return ONLY compact JSON, no prose: {"visual_analysis":"<2-3 sentences on what the photo reveals and why it matters>","recommended_product":"<exact catalog title>","propensity":<0-1>,"rationale":"<one sentence that explicitly references what you saw in the photo>","lifestyle_image_prompt":"<a vivid prompt to generate a lifestyle photo of the recommended product in a scene matching this shopper>"}',
  ].join("\n");
  const payload = {
    messages: [
      { role: "system", content: sys },
      { role: "user", content: [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: imageDataUri } },
      ] },
    ],
    max_tokens: 700, temperature: 0.2,
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  let resp;
  try {
    resp = await fetch(`${DBX_HOST}/serving-endpoints/${DBX_VISION_ENDPOINT}/invocations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${DBX_TOKEN}` },
      signal: ctrl.signal, body: JSON.stringify(payload),
    });
  } catch (e) { clearTimeout(t); console.error("vision call error", String(e).slice(0, 200)); return null; }
  clearTimeout(t);
  if (!resp.ok) { console.error("vision http", resp.status, (await resp.text().catch(() => "")).slice(0, 200)); return null; }
  const data = await resp.json().catch(() => ({}));
  let text = "";
  const c = ((data.choices || [])[0] || {}).message;
  if (c) text = Array.isArray(c.content) ? c.content.map((p) => p.text || "").join("") : String(c.content || "");
  const mm = text.match(/\{[\s\S]*\}/);
  if (mm) text = mm[0];
  try {
    const p = JSON.parse(text);
    const prop = Number(p.propensity);
    return {
      visual_analysis: typeof p.visual_analysis === "string" ? p.visual_analysis.slice(0, 600) : null,
      recommended_product: typeof p.recommended_product === "string" ? p.recommended_product.slice(0, 90) : null,
      propensity: isFinite(prop) ? Math.max(0, Math.min(1, Math.round(prop * 100) / 100)) : null,
      rationale: typeof p.rationale === "string" ? p.rationale.slice(0, 400) : null,
      lifestyle_image_prompt: typeof p.lifestyle_image_prompt === "string" ? p.lifestyle_image_prompt.slice(0, 600) : null,
    };
  } catch { return null; }
}

// Generate a lifestyle image (image OUTPUT). Optionally conditioned on the shopper's photo (image IN →
// image OUT). Returns a data URI or null. Cloud Run egress → Gemini image model.
async function generateLifestyleImage({ prompt, inputImageDataUri }) {
  if (!GEMINI_API_KEY || !prompt) return null;
  const parts = [{ text: `${prompt}\nPhotorealistic, editorial product-lifestyle photography. No text, no logos, no watermark.` }];
  if (inputImageDataUri) {
    const m = inputImageDataUri.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 90000);
  let resp;
  try {
    resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      signal: ctrl.signal, body: JSON.stringify({ contents: [{ parts }] }),
    });
  } catch (e) { clearTimeout(t); console.error("image gen error", String(e).slice(0, 200)); return null; }
  clearTimeout(t);
  if (!resp.ok) { console.error("image gen http", resp.status); return null; }
  const d = await resp.json().catch(() => ({}));
  for (const cand of d.candidates || []) {
    for (const p of ((cand.content || {}).parts) || []) {
      const inl = p.inlineData || p.inline_data;
      if (inl && inl.data) return `data:${inl.mimeType || inl.mime_type || "image/jpeg"};base64,${inl.data}`;
    }
  }
  return null;
}

// Orchestrate the multimodal leg: image → Claude vision analysis → product resolve → lifestyle image →
// persist (mosaic_vision_reco) + activate Bloomreach. `email` may be null (anonymous device_id path).
async function visionEnrich({ email, device_id, image, location, generateImage = true }) {
  if (!VISION_READY) return { ok: false, reason: "vision not configured" };
  if (!email && !device_id) return { ok: false, reason: "identity required (email via server-resolved id, or device_id)" };
  if (email && !EMAIL_RE.test(email)) return { ok: false, reason: "invalid identity" };
  const img = parseImage(image && image.data, image && image.mime);
  if (!img) return { ok: false, reason: "a valid image is required (png/jpeg/webp, <=7MB)" };

  const context = email ? await getCustomerContext(email) : {};
  const loc = (typeof location === "string" && location.trim()) || context.favorite_location || context.preferred_location || null;
  const weather = loc ? await getWeatherForLocation(loc) : null;
  const catalog = await getCatalog();
  if (!catalog.length) return { ok: false, reason: "catalog unavailable" };

  const analysis = await analyzeImageWithClaude({ imageDataUri: img.dataUri, context, weather, catalog });
  if (!analysis || !analysis.recommended_product) return { ok: false, reason: "vision analysis failed" };
  const product = matchProduct(analysis.recommended_product, catalog);

  let lifestyle = null;
  if (generateImage && analysis.lifestyle_image_prompt) {
    const p = `${analysis.lifestyle_image_prompt} Featured product: ${(product && product.title) || analysis.recommended_product}.`;
    lifestyle = await generateLifestyleImage({ prompt: p, inputImageDataUri: img.dataUri });
  }

  // Store the generated image INTO Databricks (Unity Catalog Volume) — Cloud Run carries the bytes in.
  const dbxImage = lifestyle ? await saveImageToDatabricks(lifestyle, email || device_id) : null;

  // Persist to Databricks (keyed on email when known, else device_id).
  await dbxExec(
    `INSERT INTO ${DBX_VISION_TABLE} (email,device_id,visual_analysis,recommended_product,matched_sku,matched_product,propensity,rationale,weather_summary,image_generated,image_path,model,created_at) VALUES (` +
    `${sqlLit(email)},${sqlLit(device_id)},${sqlLit(analysis.visual_analysis)},${sqlLit(analysis.recommended_product)},${sqlLit(product && String(product.id))},${sqlLit(product && product.title)},${sqlNum(analysis.propensity)},${sqlLit(analysis.rationale)},${sqlLit(weather && weather.summary)},${sqlBool(!!lifestyle)},${sqlLit(dbxImage && dbxImage.path)},${sqlLit(DBX_VISION_ENDPOINT + " (vision, Databricks Model Serving)")},current_timestamp())`
  );

  // Activate onto the Bloomreach profile (attrs allowlisted/validated — LLM output is untrusted).
  let activated = false;
  if (BR_READY && (email || device_id)) {
    const rec = { recommended_product: (product && product.title) || analysis.recommended_product, propensity: analysis.propensity, rationale: analysis.rationale };
    const props = activationProps({ rec, weather });
    const va = typeof analysis.visual_analysis === "string" ? analysis.visual_analysis.trim().slice(0, 250) : "";
    if (va && !/[<>{}$\u0000-\u001f]/.test(va)) props.vision_analysis = va;
    props.recommendation_source = "mosaic-vision-agent";
    const ids = brCustomerIds({ email, device_id });
    const { ok } = await brTrack(ids, props);
    activated = ok;
  }

  return {
    ok: true, identity: email ? "email_id" : "cookie", location: loc, weather,
    analysis, product,
    recommendation: { product: (product && product.title) || analysis.recommended_product, price: product && product.price, image: product && product.image, url: product && product.url, propensity: analysis.propensity, rationale: analysis.rationale },
    lifestyle_image: lifestyle, activated,
    databricks_image: dbxImage,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }
  const u = new URL(req.url || "/", "http://localhost");
  const path = u.pathname.replace(/\/+$/, "") || "/";
  if (req.method === "GET") return json(res, 200, { ok: true, model: GEMINI_MODEL, image_model: GEMINI_IMAGE_MODEL, bloomreach: BR_READY, databricks: DBX_READY, vision: VISION_READY, vision_endpoint: DBX_VISION_ENDPOINT, public_vision: PUBLIC_VISION, app_proxy: Boolean(APP_PROXY_SECRET), require_app_proxy: REQUIRE_APP_PROXY });
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });

  // Verify the Shopify App Proxy signature (present when the request came through /apps/<subpath>/*).
  // A valid signature yields a SERVER-SET logged_in_customer_id we can trust as the shopper's identity.
  const proxy = verifyAppProxy(u.searchParams);

  // Rate-limit key: use the LAST X-Forwarded-For hop (appended by Cloud Run's front end). Earlier XFF
  // values are client-supplied and spoofable, so never key off XFF[0]. Fall back to the socket address.
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ip = xff.length ? xff[xff.length - 1] : (req.socket.remoteAddress || "unknown");
  if (rateLimited(ip)) return json(res, 429, { error: "rate limited" });

  let body;
  try { body = await readBody(req); }
  catch { return json(res, 400, { error: "invalid request body" }); }

  // Trusted customer id: from the verified app proxy (logged_in_customer_id) when present. With
  // REQUIRE_APP_PROXY on, that is the ONLY accepted source (the client cannot assert an identity);
  // otherwise fall back to the pre-proxy, client-supplied body.customer_id during rollout.
  const trustedCustomerId = proxy.valid ? proxy.logged_in_customer_id : (REQUIRE_APP_PROXY ? null : body.customer_id);

  // Anonymous→known merge: stitch a device_id (cookie) into an email_id profile. Identity resolved
  // server-side from the trusted customer id only; uniform response (no enumeration oracle).
  if (path === "/merge") {
    try {
      const out = await mergeBloomreach({ device_id: body.device_id, customer_id: trustedCustomerId });
      return json(res, 200, out);
    } catch (e) { console.error("merge error", String(e).slice(0, 300)); return json(res, 500, { error: "server error" }); }
  }

  // Enrichment (Phase 1): weather → ai_query reasoning → Databricks + Bloomreach activation. This is the
  // always-on replacement for the manual mosaic_agent.py. /enrich accepts an optional location; /agent/run
  // reads it from the shopper's stored context. Internal/agent route — in production put it behind auth.
  // Identity: trusted customer id (proxy) → resolve email; else customer_id → resolve; else a direct email.
  if (path === "/enrich" || path === "/agent/run") {
    // Internal/agent route — require the shared secret (fail closed) OR a verified app-proxy request.
    const provided = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "") || String(req.headers["x-enrich-key"] || "");
    const keyOk = !!ENRICH_API_KEY && provided.length === ENRICH_API_KEY.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(ENRICH_API_KEY));
    if (!keyOk && !proxy.valid) return json(res, 401, { error: "unauthorized" });
    try {
      // Identity: verified proxy id first; a trusted caller (has the key) may also name the customer/email.
      let email = null;
      if (trustedCustomerId) { try { email = await resolveEmail(trustedCustomerId); } catch {} }
      if (!email && keyOk && body.customer_id) { try { email = await resolveEmail(body.customer_id); } catch {} }
      if (!email && keyOk && typeof body.email === "string" && body.email) email = body.email;
      const out = await enrich({ email, device_id: body.device_id, location: body.location });
      return json(res, out.ok ? 200 : 400, out);
    } catch (e) { console.error("enrich error", String(e).slice(0, 300)); return json(res, 500, { error: "enrich error" }); }
  }

  // Vision enrichment (Phase 2): image IN → Databricks Claude vision analysis → real product → lifestyle
  // image OUT → Databricks + Bloomreach activation. Same auth as /enrich (shared key OR verified app
  // proxy — fail closed). Identity resolved server-side; a client-asserted email is only honored for a
  // trusted key-holder (batch/proof), never from the public path.
  if (path === "/vision-enrich") {
    const provided = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "") || String(req.headers["x-enrich-key"] || "");
    const keyOk = !!ENRICH_API_KEY && provided.length === ENRICH_API_KEY.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(ENRICH_API_KEY));
    if (!keyOk && !proxy.valid) return json(res, 401, { error: "unauthorized" });
    try {
      let email = null;
      if (trustedCustomerId) { try { email = await resolveEmail(trustedCustomerId); } catch {} }
      if (!email && keyOk && body.customer_id) { try { email = await resolveEmail(body.customer_id); } catch {} }
      if (!email && keyOk && typeof body.email === "string" && body.email) email = body.email;
      const image = typeof body.image === "string" ? { data: body.image } : body.image;
      const out = await visionEnrich({ email, device_id: body.device_id, image, location: body.location, generateImage: body.generate_image !== false });
      return json(res, out.ok ? 200 : 400, out);
    } catch (e) { console.error("vision-enrich error", String(e).slice(0, 300)); return json(res, 500, { error: "vision error" }); }
  }

  // Public storefront vision (Phase 2): a shopper uploads a photo from the chat widget. Anonymous
  // shoppers are identified by their device_id (cookie profile); a verified app proxy yields a known
  // profile. Feature-flagged (PUBLIC_VISION) + its own strict rate limit. A client-asserted email is
  // NEVER trusted here — only server-resolved (proxy) identity or the anonymous device_id.
  if (path === "/vision-chat") {
    if (!PUBLIC_VISION && !proxy.valid) return json(res, 401, { error: "unauthorized" });
    if (visionRateLimited(ip)) return json(res, 429, { error: "rate limited" });
    try {
      let email = null;
      if (trustedCustomerId) { try { email = await resolveEmail(trustedCustomerId); } catch {} }
      if (!email && !body.device_id) return json(res, 400, { error: "device_id required" });
      const image = typeof body.image === "string" ? { data: body.image } : body.image;
      const out = await visionEnrich({ email, device_id: body.device_id, image, location: body.location, generateImage: body.generate_image !== false });
      return json(res, out.ok ? 200 : 400, out);
    } catch (e) { console.error("vision-chat error", String(e).slice(0, 300)); return json(res, 500, { error: "vision error" }); }
  }

  // Chat (default; also serves /chat and /).
  try {
    const { message, device_id, history } = body;
    if (!message || !String(message).trim()) return json(res, 400, { error: "message required" });
    if (!GEMINI_API_KEY) return json(res, 500, { error: "server missing GEMINI_API_KEY" });

    const { reply, attributes } = await askGemini({ message, history });

    // Identity comes ONLY from the trusted customer id (verified app proxy, or the pre-proxy fallback).
    // A client-asserted email/customer_id in the body is NEVER trusted for a known-profile write.
    let idEmail = null;
    if (trustedCustomerId) { try { idEmail = await resolveEmail(trustedCustomerId); } catch {} }

    // Text-to-image: if the shopper asks to generate/create/draw an image, make one with Gemini and
    // store it IN Databricks (Cloud Run carries the bytes in). Returned inline so the widget renders it.
    let genImage = null, genImageDbx = null, finalReply = reply;
    const wantsImage = /\b(image|picture|photo|pic|visual|render|mockup|drawing)\b/i.test(message) &&
                       /\b(generate|create|make|draw|show|imagine|render|design|see|visuali[sz]e)\b/i.test(message);
    if (wantsImage && GEMINI_API_KEY) {
      // Build the scene from the WHOLE session (prior user turns + this message), not just the last line.
      const priorUser = Array.isArray(history) ? history.filter((h) => h && h.role === "user" && h.text).map((h) => String(h.text)) : [];
      const sessionText = [...priorUser, String(message)].join(". ").slice(0, 600);
      const scene = sessionText.replace(/\b(please|can you|could you|generate|create|make|draw|show me|an?|image|picture|photo|of)\b/gi, " ").replace(/\s+/g, " ").trim() || String(message);
      genImage = await generateLifestyleImage({ prompt: scene, inputImageDataUri: null });
      if (genImage) {
        genImageDbx = await saveImageToDatabricks(genImage, idEmail || device_id || "chat");
        finalReply = "Here's what I imagined for you ✨ — want me to find the closest real match in the store?";
        // Queue the saved image for the Databricks vision job: record user <-> image_path (+ session scene).
        if (genImageDbx && genImageDbx.path && (idEmail || device_id)) {
          try {
            await dbxExec(
              `INSERT INTO ${DBX_VISION_TABLE} (email,device_id,visual_analysis,recommended_product,image_generated,image_path,model,created_at) VALUES (` +
              `${sqlLit(idEmail)},${sqlLit(device_id)},${sqlLit("chat image-gen: " + scene)},NULL,true,${sqlLit(genImageDbx.path)},${sqlLit("chat-image-gen (gemini)")},current_timestamp())`
            );
          } catch (e) { console.error("queue row error", String(e).slice(0, 200)); }
        }
      }
    }

    let wrote = { wrote: false };
    let dbx = { dbx: false };
    if (idEmail || device_id) {
      // Known (email_id) or anonymous (cookie=device_id); passing both ids also stitches the profiles.
      try { wrote = await writeBloomreach({ email: idEmail, customer_id: trustedCustomerId, device_id, attributes }); }
      catch (e) { console.error("bloomreach write error", String(e).slice(0, 300)); wrote = { wrote: false }; }
    }
    if (idEmail) {
      // Databricks signals table is keyed on email; anonymous (device-only) signals are Bloomreach-only
      // for Phase 0 (Phase 1: add a device_id column so anonymous signals mirror to Databricks too).
      try { dbx = await writeDatabricks({ email: idEmail, attributes, message }); }
      catch (e) { console.error("databricks write error", String(e).slice(0, 300)); dbx = { dbx: false }; }
    }
    return json(res, 200, { reply: finalReply, extracted: attributes, image: genImage, image_databricks: genImageDbx, ...wrote, ...dbx });
  } catch (e) {
    console.error("assistant error", String(e).slice(0, 300));
    return json(res, 500, { error: "assistant error" });
  }
});

// ── Preference poller ───────────────────────────────────────────────────────────────────────────────
// Databricks has NO outbound internet, so it can't push to Bloomreach. This poller (in Cloud Run, which
// does have egress) periodically pulls freshly-extracted preferences from Databricks and activates them
// onto the Bloomreach profile, then marks them pushed. This is the "trigger" that moves a Databricks-
// derived preference out to Bloomreach.
async function pushPreferencesToBloomreach() {
  if (!DBX_READY || !BR_READY) return;
  try {
    const q = await dbxExec(
      "SELECT email, device_id, image_generation, image_file FROM workspace.default.mosaic_user_preferences WHERE pushed_to_br = false ORDER BY analyzed_at DESC LIMIT 20"
    );
    if (!q.ok || !q.rows.length) return;
    for (const r of q.rows) {
      const email = r[0], device_id = r[1], image_file = r[3];
      // Sanitize the model-derived value (untrusted): no markup/template/control chars, capped.
      let val = typeof r[2] === "string" ? r[2].trim().toLowerCase().slice(0, 80) : "";
      if (!val || /[<>{}$\u0000-\u001f]/.test(val)) continue;
      const ids = brCustomerIds({ email, device_id });
      if (Object.keys(ids).length === 0) continue;
      const { ok } = await brTrack(ids, { image_generation: val, image_generation_source: "databricks-vision-job" });
      if (ok) await dbxExec(`UPDATE workspace.default.mosaic_user_preferences SET pushed_to_br = true WHERE image_file = ${sqlLit(image_file)}`);
    }
  } catch (e) { console.error("pref poller error", String(e).slice(0, 200)); }
}
if (DBX_READY && BR_READY) setInterval(pushPreferencesToBloomreach, 25000);

server.listen(PORT, () => console.log(`chat backend on :${PORT} (model ${GEMINI_MODEL}, bloomreach ${BR_READY ? "on" : "off"})`));
