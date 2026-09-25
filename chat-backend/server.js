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

const SYSTEM_PROMPT = [
  "You are the Team Mosaic Shopping Assistant on an online store.",
  "Be warm, concise (1-3 sentences), and genuinely helpful with product discovery and styling.",
  "As you chat, quietly capture any durable shopper preferences they reveal:",
  "favorite color, location/region, style preference, and budget band.",
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

async function writeBloomreach({ email, customer_id, attributes }) {
  // Model output is untrusted: allowlist keys, cap length, reject markup/template/url/control chars.
  const ALLOWED_ATTRS = { favorite_color: 60, preferred_location: 80, style_preference: 60, budget_band: 40 };
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
  if (!email) return { wrote: false, props, reason: "no email (email_id is the hard identifier)" };

  // Tracking Batch API, Public-group Token auth, hard id = email_id. shopify_id added as a soft id when present.
  const ids = { email_id: email };
  if (customer_id) ids.shopify_id = String(customer_id);
  const url = `${BR_API_BASE}/track/v2/projects/${BR_PROJECT_TOKEN}/batch`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Token ${BR_API_TOKEN}` },
    body: JSON.stringify({ commands: [{ name: "customers", data: { customer_ids: ids, properties: props } }] }),
  });
  const body = await resp.text().catch(() => "");
  let ok = false;
  try { const j = JSON.parse(body); ok = !!(j.success && j.results && j.results[0] && j.results[0].success); } catch {}
  return { wrote: ok, props, status: resp.status, detail: ok ? undefined : body.slice(0, 300) };
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
  if (req.method === "GET") return json(res, 200, { ok: true, model: GEMINI_MODEL, bloomreach: BR_READY });
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });

  try {
    const { message, email, customer_id, history } = await readBody(req);
    if (!message || !String(message).trim()) return json(res, 400, { error: "message required" });
    if (!GEMINI_API_KEY) return json(res, 500, { error: "server missing GEMINI_API_KEY" });

    const { reply, attributes } = await askGemini({ message, history });

    // Identity: prefer an email supplied by the theme; otherwise resolve it from the Shopify customerId.
    let idEmail = typeof email === "string" && email ? email : null;
    if (!idEmail && customer_id) { try { idEmail = await resolveEmail(customer_id); } catch {} }

    let wrote = { wrote: false };
    if (idEmail) {
      try { wrote = await writeBloomreach({ email: idEmail, customer_id, attributes }); }
      catch (e) { wrote = { wrote: false, error: String(e).slice(0, 200) }; }
    }
    return json(res, 200, { reply, extracted: attributes, ...wrote });
  } catch (e) {
    return json(res, 500, { error: "assistant error", detail: String(e).slice(0, 300) });
  }
});

server.listen(PORT, () => console.log(`chat backend on :${PORT} (model ${GEMINI_MODEL}, bloomreach ${BR_READY ? "on" : "off"})`));
