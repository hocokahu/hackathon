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

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
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

// Databricks (optional) — mirror the chat signal into a Delta table so the Databricks agent can
// reason over it. Uses the SQL Statement Execution API against a serverless warehouse. If unset,
// the Databricks write is skipped and chat still works. Host/token/warehouse come from env.
const DBX_HOST = (process.env.DATABRICKS_HOST || "").replace(/\/+$/, "");
const DBX_TOKEN = process.env.DATABRICKS_TOKEN || "";
const DBX_WAREHOUSE = process.env.DATABRICKS_WAREHOUSE_ID || "";
const DBX_SIGNALS_TABLE = process.env.DATABRICKS_SIGNALS_TABLE || "workspace.default.mosaic_chat_signals";
const DBX_READY = Boolean(DBX_HOST && DBX_TOKEN && DBX_WAREHOUSE);

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error("payload too large")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
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
// Bloomreach stitches the anonymous profile into the known one. Email is resolved SERVER-SIDE from the
// Shopify customer_id when possible (trusted); a client-supplied email is accepted only as a fallback
// (spoofable — close the auth gap before trusting it in production).
async function mergeBloomreach({ device_id, email, customer_id }) {
  if (!BR_READY) return { merged: false, reason: "bloomreach not configured" };
  if (!device_id) return { merged: false, reason: "device_id required" };
  let idEmail = null, source = null;
  if (customer_id) { try { idEmail = await resolveEmail(customer_id); if (idEmail) source = "shopify"; } catch {} }
  if (!idEmail && typeof email === "string" && email) { idEmail = email; source = "client"; } // fallback: untrusted
  if (!idEmail) return { merged: false, reason: "no email (pass a Shopify customer_id or email)" };
  const { ok, status } = await brTrack(brCustomerIds({ email: idEmail, device_id }), {});
  return { merged: ok, status, identity_source: source };
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

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }
  const path = (req.url || "/").split("?")[0].replace(/\/+$/, "") || "/";
  if (req.method === "GET") return json(res, 200, { ok: true, model: GEMINI_MODEL, bloomreach: BR_READY, databricks: DBX_READY });
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });

  let body;
  try { body = await readBody(req); }
  catch { return json(res, 400, { error: "invalid request body" }); }

  // Anonymous→known merge (Phase 0): stitch a device_id (cookie) into an email_id profile.
  if (path === "/merge") {
    try {
      const out = await mergeBloomreach({ device_id: body.device_id, email: body.email, customer_id: body.customer_id });
      return json(res, out.merged ? 200 : 400, out);
    } catch (e) { console.error("merge error", String(e).slice(0, 300)); return json(res, 500, { error: "merge error" }); }
  }

  // Chat (default; also serves /chat and /).
  try {
    const { message, email, customer_id, device_id, history } = body;
    if (!message || !String(message).trim()) return json(res, 400, { error: "message required" });
    if (!GEMINI_API_KEY) return json(res, 500, { error: "server missing GEMINI_API_KEY" });

    const { reply, attributes } = await askGemini({ message, history });

    // Identity: prefer a theme-supplied email; else resolve from the Shopify customerId; else stay anonymous (device_id).
    let idEmail = typeof email === "string" && email ? email : null;
    if (!idEmail && customer_id) { try { idEmail = await resolveEmail(customer_id); } catch {} }

    let wrote = { wrote: false };
    let dbx = { dbx: false };
    if (idEmail || device_id) {
      // Known (email_id) or anonymous (cookie=device_id); passing both ids also stitches the profiles.
      try { wrote = await writeBloomreach({ email: idEmail, customer_id, device_id, attributes }); }
      catch (e) { console.error("bloomreach write error", String(e).slice(0, 300)); wrote = { wrote: false }; }
    }
    if (idEmail) {
      // Databricks signals table is keyed on email; anonymous (device-only) signals are Bloomreach-only
      // for Phase 0 (Phase 1: add a device_id column so anonymous signals mirror to Databricks too).
      try { dbx = await writeDatabricks({ email: idEmail, attributes, message }); }
      catch (e) { console.error("databricks write error", String(e).slice(0, 300)); dbx = { dbx: false }; }
    }
    return json(res, 200, { reply, extracted: attributes, ...wrote, ...dbx });
  } catch (e) {
    console.error("assistant error", String(e).slice(0, 300));
    return json(res, 500, { error: "assistant error" });
  }
});

server.listen(PORT, () => console.log(`chat backend on :${PORT} (model ${GEMINI_MODEL}, bloomreach ${BR_READY ? "on" : "off"})`));
