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
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

// Bloomreach Engagement REST (all optional — if unset, attribute writes are skipped, chat still works)
const BR_API_BASE = (process.env.BLOOMREACH_API_BASE || "").replace(/\/+$/, ""); // e.g. https://api.eu1.exponea.com
const BR_PROJECT_TOKEN = process.env.BLOOMREACH_PROJECT_TOKEN || "";
const BR_API_KEY_ID = process.env.BLOOMREACH_API_KEY_ID || "";
const BR_API_SECRET = process.env.BLOOMREACH_API_SECRET || "";
const BR_READY = BR_API_BASE && BR_PROJECT_TOKEN && BR_API_KEY_ID && BR_API_SECRET;

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
  const input = [{ type: "text", text: SYSTEM_PROMPT }];
  for (const h of (Array.isArray(history) ? history : []).slice(-10)) {
    if (!h || !h.text) continue;
    if (h.role === "model") input.push({ type: "model_output", content: [{ type: "text", text: String(h.text) }] });
    else input.push({ type: "user_input", content: String(h.text) });
  }
  input.push({ type: "user_input", content: String(message || "") });

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
  // keep only non-empty string attributes
  const props = {};
  for (const [k, v] of Object.entries(attributes || {})) {
    if (typeof v === "string" && v.trim()) props[k] = v.trim();
  }
  if (!BR_READY || Object.keys(props).length === 0) return { wrote: false, props };
  const ids = {};
  if (email) ids.registered = email;
  if (customer_id) ids.shopify_id = String(customer_id);
  if (Object.keys(ids).length === 0) return { wrote: false, props, reason: "no customer id" };

  const auth = "Basic " + Buffer.from(`${BR_API_KEY_ID}:${BR_API_SECRET}`).toString("base64");
  const url = `${BR_API_BASE}/track/v2/projects/${BR_PROJECT_TOKEN}/customers/properties`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ customer_ids: ids, properties: props }),
  });
  const ok = resp.ok;
  const body = await resp.text().catch(() => "");
  return { wrote: ok, props, status: resp.status, detail: ok ? undefined : body.slice(0, 300) };
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

    let wrote = { wrote: false };
    if (email || customer_id) {
      try { wrote = await writeBloomreach({ email, customer_id, attributes }); }
      catch (e) { wrote = { wrote: false, error: String(e).slice(0, 200) }; }
    }
    return json(res, 200, { reply, extracted: attributes, ...wrote });
  } catch (e) {
    return json(res, 500, { error: "assistant error", detail: String(e).slice(0, 300) });
  }
});

server.listen(PORT, () => console.log(`chat backend on :${PORT} (model ${GEMINI_MODEL}, bloomreach ${BR_READY ? "on" : "off"})`));
