# Brainstorm — how Agent Bricks fits our T6 stack

> Exploratory / not committed to a plan. Databricks **Agent Bricks** is Databricks' toolkit for
> building, optimizing, serving and evaluating production AI agents *next to the data* (Genie
> spaces, Vector Search, Model Serving, MLflow eval, Unity Catalog function tools). We already
> have Genie (`databricks-genie`) and UC functions (`databricks-uc-functions`) connected over MCP.

## The one-line thesis

Put the **data-heavy "brain" agent on Agent Bricks** (its center of gravity is the Databricks
data + models), and keep the **conversation-heavy surface** (the Gemini chat widget) wherever the
shopper is. Agent Bricks decides *what to do for whom*; Gemini + the widget handle *the
conversation*; Loomi + Shopify are the *hands*. This matches the kit's "pick ONE host by center of
gravity" guidance — data-heavy → AgentBricks, conversation-heavy → GCP.

## Where each Agent Bricks capability plugs in

| Agent Bricks capability | Use in our demo | Status |
|---|---|---|
| **Genie space** (NL→SQL over `00data`) | The agent asks "who is high-churn / high-LTV?", "what's this customer's persona?" in natural language | ✅ connected (Genie MCP) |
| **UC function tools** | Deterministic tools the agent calls: `score_customer(email)`, `next_best_category(email)`, `segment_of(email)` — wrapping `customer_360` / `customer_predictions` | ✅ MCP connected; functions to be authored |
| **Model Serving** | Real-time scoring endpoint for churn / propensity so the agent scores a live shopper mid-conversation (not just the batch table) | to build |
| **Vector Search** | Personalized product retrieval by embedding the catalog + the shopper's style persona — **fills the gap left by Loomi Discovery being disabled** | to build (candidate) |
| **Agent eval (MLflow)** | Score the recommender/churn agent's outputs (relevance, correctness) before/again after changes | to build |
| **Agent serving** | Deploy the orchestration agent as an endpoint the widget backend + Bloomreach webhooks call | to build |

## The composable loop, Agent-Bricks-centric

```
Shopper in chat (Gemini widget)                 Databricks Agent Bricks agent
        │  "recommend something"                        │
        ├──────────────► widget backend ───────────────►│  reads customer_360 (Genie / UC fn)
        │                                                │  scores churn / propensity (Model Serving)
        │                                                │  retrieves products (Vector Search)  ← replaces Loomi Discovery
        │◄──────── product cards + reason ──────────────┤
        │  (buys / abandons)                             │
Shopify order/cart event ──────────────────────────────►│  writes churn_risk / persona onto
                                                         │  the Bloomreach profile (Loomi tool)
                                                         │            │
                                                         ▼            ▼
                                          Bloomreach scenario P2 (daily churn scan) fires →
                                          retention SMS/email/offer  →  engagement events
                                                         │
                                          events flow back to Databricks → retrain (loop closes)
```

## How it powers the 5 scenarios

- **P2 (Retention, the Databricks-fed one):** Agent Bricks is literally the producer of the
  `churn_risk` attribute that P2's condition reads. AgentBricks scores → agent writes it to the
  Bloomreach profile → P2 enrolls. This is the clearest "Databricks intelligence → Bloomreach
  activation" demonstration.
- **P1 / P3 / P4:** AgentBricks supplies `predicted_next_category`, `purchase_propensity`, and
  price-sensitivity so each scenario's email/offer is personalized, not generic.
- **P5 (Win-Back):** AgentBricks confirms genuinely lapsed + still-valuable customers
  (`days_since_last_purchase`, LTV) so the incentive is spent on the right people.

## Why this scores well for T6

- Keeps **Databricks load-bearing** as the intelligence layer (not just a passive table) — the
  agent *reasons* over the data and *acts*.
- Gives a clean division of labor across all four platforms with no redundant hosting (don't add
  Cloud Run just to pad the platform count — if AgentBricks hosts the agent, Google stays Gemini).
- Vector Search is a credible way to keep personalized product retrieval alive despite Loomi
  Discovery being disabled on our account.

## Open questions / next steps

1. Confirm Agent Bricks is enabled in workspace `bloomreach-hackathon-workspace` and what compute
   it needs (serverless?).
2. Author the first UC function tool (`score_customer(email)`) over `customer_360` and expose it
   via the `databricks-uc-functions` MCP.
3. Decide catalog embeddings source for Vector Search (Shopify 17 products vs Databricks 40).
4. Decide the real-time vs batch split: batch churn table is enough for P2; live scoring only
   matters for in-chat personalization.
