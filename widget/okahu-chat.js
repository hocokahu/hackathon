/* Okahu Composable Commerce Chat Widget — self-contained, no dependencies.
 * Bottom-right chat bubble for a Shopify storefront (like Shopify Inbox, but ours).
 * Backend is stubbed here (window.OKAHU_CHAT.onSend) — wire it to Gemini + Loomi + Shopify later.
 * Deploy options: (a) Shopify Theme App Extension app-embed block, (b) theme snippet, (c) script tag.
 */
(function () {
  "use strict";
  if (window.__okahuChatLoaded) return;
  window.__okahuChatLoaded = true;

  var BRAND = { name: "Team Mosaic Shopping Assistant", accent: "#0EA5A4", accentDark: "#0B7E7D", ink: "#0F172A", bubbleBg: "#0F172A" };

  var css = `
  .okc-btn{position:fixed;bottom:20px;right:20px;width:60px;height:60px;border-radius:50%;
    background:${BRAND.bubbleBg};color:#fff;border:none;cursor:pointer;z-index:2147483000;
    box-shadow:0 8px 24px rgba(15,23,42,.28);display:flex;align-items:center;justify-content:center;
    transition:transform .15s ease}
  .okc-btn:hover{transform:scale(1.06)}
  .okc-btn svg{width:26px;height:26px}
  .okc-panel{position:fixed;bottom:92px;right:20px;width:380px;max-width:calc(100vw - 32px);
    height:560px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;overflow:hidden;
    z-index:2147483000;box-shadow:0 24px 64px rgba(15,23,42,.28);display:none;flex-direction:column;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .okc-panel.okc-open{display:flex;animation:okc-in .18s ease}
  @keyframes okc-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  .okc-head{background:linear-gradient(135deg,${BRAND.accent},${BRAND.accentDark});color:#fff;padding:16px 18px}
  .okc-head h4{margin:0;font-size:16px;font-weight:650}
  .okc-head p{margin:2px 0 0;font-size:12px;opacity:.85}
  .okc-body{flex:1;overflow-y:auto;padding:16px;background:#F8FAFC}
  .okc-msg{max-width:82%;padding:10px 13px;border-radius:14px;margin-bottom:10px;font-size:14px;line-height:1.4}
  .okc-bot{background:#fff;color:${BRAND.ink};border:1px solid #E2E8F0;border-bottom-left-radius:4px}
  .okc-user{background:${BRAND.accent};color:#fff;margin-left:auto;border-bottom-right-radius:4px}
  .okc-chips{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 10px}
  .okc-chip{background:#fff;border:1px solid #CBD5E1;color:${BRAND.ink};border-radius:999px;
    padding:7px 12px;font-size:13px;cursor:pointer}
  .okc-chip:hover{border-color:${BRAND.accent};color:${BRAND.accentDark}}
  .okc-cards{display:flex;gap:10px;overflow-x:auto;padding:2px 0 8px;margin-bottom:6px}
  .okc-card{min-width:150px;max-width:150px;background:#fff;border:1px solid #E2E8F0;border-radius:12px;overflow:hidden}
  .okc-card img{width:100%;height:96px;object-fit:cover;background:#Eef2f6}
  .okc-card .okc-cbody{padding:8px 10px}
  .okc-card h5{margin:0;font-size:13px;font-weight:600;color:${BRAND.ink};line-height:1.25}
  .okc-card .okc-why{font-size:11px;color:${BRAND.accentDark};margin:3px 0}
  .okc-card .okc-price{font-size:13px;font-weight:700;color:${BRAND.ink}}
  .okc-add{margin-top:6px;width:100%;background:${BRAND.ink};color:#fff;border:none;border-radius:8px;
    padding:7px;font-size:12px;cursor:pointer}
  .okc-foot{border-top:1px solid #E2E8F0;padding:10px;display:flex;gap:8px;background:#fff}
  .okc-foot input{flex:1;border:1px solid #CBD5E1;border-radius:10px;padding:10px 12px;font-size:14px;outline:none}
  .okc-foot input:focus{border-color:${BRAND.accent}}
  .okc-send{background:${BRAND.accent};color:#fff;border:none;border-radius:10px;padding:0 14px;cursor:pointer;font-size:14px}
  .okc-tag{font-size:10px;color:#94A3B8;text-align:center;padding:0 0 8px;background:#fff}
  `;

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  // Escape any backend/user-supplied text before it touches innerHTML (product titles, chat input, etc.)
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  var style = el("style"); style.textContent = css; document.head.appendChild(style);

  var btn = el("button", "okc-btn");
  btn.setAttribute("aria-label", "Open chat");
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z"/></svg>';

  var panel = el("div", "okc-panel");
  panel.innerHTML =
    '<div class="okc-head"><h4>' + BRAND.name + '</h4><p>Personalized picks, powered by your profile</p></div>' +
    '<div class="okc-body" id="okc-body"></div>' +
    '<div class="okc-tag">Composable demo · Gemini + Loomi + Shopify (backend stub)</div>' +
    '<div class="okc-foot"><input id="okc-input" placeholder="Ask for a recommendation…" autocomplete="off"/>' +
    '<button class="okc-send" id="okc-send">Send</button></div>';

  document.body.appendChild(btn);
  document.body.appendChild(panel);
  var body = panel.querySelector("#okc-body");
  var input = panel.querySelector("#okc-input");

  function scroll() { body.scrollTop = body.scrollHeight; }
  function addMsg(text, who) { var m = el("div", "okc-msg " + (who === "user" ? "okc-user" : "okc-bot"), esc(text)); body.appendChild(m); scroll(); return m; }
  function addChips(items) {
    var wrap = el("div", "okc-chips");
    items.forEach(function (t) { var c = el("button", "okc-chip", t); c.onclick = function () { send(t); }; wrap.appendChild(c); });
    body.appendChild(wrap); scroll();
  }
  function addCards(cards) {
    var row = el("div", "okc-cards");
    cards.forEach(function (p) {
      var c = el("div", "okc-card");
      c.innerHTML = '<img src="' + encodeURI(p.image || "") + '" alt=""/>' +
        '<div class="okc-cbody"><h5>' + esc(p.title) + '</h5>' +
        (p.why ? '<div class="okc-why">' + esc(p.why) + '</div>' : '') +
        '<div class="okc-price">' + esc(p.price) + '</div>' +
        '<button class="okc-add">Add to cart</button></div>';
      c.querySelector(".okc-add").onclick = function () { addMsg("Added “" + p.title + "” to your cart ✓", "bot"); };
      row.appendChild(c);
    });
    body.appendChild(row); scroll();
  }

  // Backend hook. Priority: custom onSend  >  configured HTTPS endpoint (Gemini orchestrator)  >  demo stub.
  var history = [];
  function respond(text) {
    var cfg = window.OKAHU_CHAT || {};
    if (typeof cfg.onSend === "function") {
      cfg.onSend(text, { addMsg: addMsg, addCards: addCards, addChips: addChips });
      return;
    }
    if (cfg.endpoint) {
      var typing = addMsg("…", "bot");
      fetch(cfg.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          email: (window.OKAHU_CUSTOMER && window.OKAHU_CUSTOMER.email) || null,
          customer_id: (window.OKAHU_CUSTOMER && window.OKAHU_CUSTOMER.id) || null,
          history: history.slice(-10)
        })
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (typing) typing.remove();
        var reply = (d && d.reply) || "Sorry — I couldn't reach the assistant just now.";
        addMsg(reply, "bot");
        if (d && d.cards && d.cards.length) addCards(d.cards);
        if (d && d.chips && d.chips.length) addChips(d.chips);
        history.push({ role: "user", text: text }, { role: "model", text: reply });
      }).catch(function () {
        if (typing) typing.remove();
        addMsg("Hmm, I had trouble connecting. Please try again.", "bot");
      });
      return;
    }
    // Demo stub (no backend configured)
    addMsg("Because you're a Platinum member who loves minimalist styles, here are 3 picks I think you'll love:", "bot");
    addCards([
      { title: "Aperture Rain Jacket", price: "$189", why: "Matches your style persona", image: "https://placehold.co/150x96/0EA5A4/fff?text=Jacket" },
      { title: "Northstar Headphones", price: "$149", why: "Top pick for your next category", image: "https://placehold.co/150x96/0F172A/fff?text=Audio" },
      { title: "Trailhead Daypack", price: "$92", why: "Frequently bought together", image: "https://placehold.co/150x96/64748B/fff?text=Bag" }
    ]);
    addMsg("Want me to apply your loyalty offer and check out here in the chat?", "bot");
  }

  function send(text) {
    text = (text || input.value || "").trim(); if (!text) return;
    addMsg(text, "user"); input.value = "";
    respond(text);
  }

  panel.querySelector("#okc-send").onclick = function () { send(); };
  input.addEventListener("keydown", function (e) { if (e.key === "Enter") send(); });

  var opened = false;
  function greet() {
    if (opened) return; opened = true;
    var cfg = (window.OKAHU_CHAT && window.OKAHU_CHAT.config) || {};
    addMsg(cfg.greeting || "Hi 👋 I'm your shopping assistant. I already know your style and what's in your cart.", "bot");
    addChips(["Recommend something for me", "What's new?", "Track my order"]);
  }
  btn.onclick = function () { panel.classList.toggle("okc-open"); if (panel.classList.contains("okc-open")) greet(); };
})();
