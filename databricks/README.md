# Mosaic Vision Stylist — Databricks agent

The reasoning brain behind Phase 2: a multimodal agent that looks at a **shopper's own photo** and
recommends a real product. This is the analysis a behavioral engine (Bloomreach) cannot do — it has
no way to *see* the customer's image.

## Two paths (same brain)

| | What runs | Where | Status |
|---|---|---|---|
| **Live demo** | Cloud Run calls the **governed serving endpoint** `databricks-claude-sonnet-4-5` (vision) directly with the image + profile + weather | `chat-backend/server.js` → `POST /vision-enrich` | ✅ working, proven live |
| **Production** | The committable **Agent Framework** agent (Claude + UC tools + Genie), deployed as its own serving endpoint | `agent.py` + `deploy_agent.py` | ✅ code + registers to UC; `agents.deploy` needs workspace-admin on the shared lab |

Both call the same Claude Sonnet 4.5 model, so the live demo is honest. `agent.py` is the real,
deployable form: once it has its own endpoint, point the service at it with
`DATABRICKS_VISION_ENDPOINT=<endpoint_name>` — nothing else changes.

## The hard constraint

Databricks serverless here has **no outbound internet**. So:

- **Cloud Run** does all egress — it passes the image *inline* (data URI) in the request body, fetches
  live weather (Open-Meteo), looks up the real product (Shopify Admin), generates the lifestyle image
  (Gemini), and activates Bloomreach.
- **Databricks** only ever *receives* the call and *reads its own Unity Catalog data*. The agent's
  tools read tables Cloud Run fills; the agent never dials out.

## Tools (Unity Catalog functions, already created)

- `workspace.default.get_customer_context(email)` — reads the shopper's latest cross-platform signals
  from `workspace.default.mosaic_chat_signals`.
- `workspace.default.get_weather_forecast(location)` — reads the forecast Cloud Run wrote to
  `workspace.default.mosaic_weather`.
- *(optional)* a **Genie Space** as a tool — set `MOSAIC_GENIE_SPACE_ID` to let the agent ask
  ad-hoc questions over the store's data.

## Tables written by the loop

- `workspace.default.mosaic_vision_reco` — one row per vision recommendation
  (`visual_analysis, recommended_product, matched_product, propensity, rationale, image_generated, …`).
- `workspace.default.mosaic_weather`, `workspace.default.mosaic_recommendations` — shared with Phase 1.

## Deploy (inside a Databricks notebook)

```python
%pip install -U -qqqq mlflow databricks-langchain databricks-agents langgraph
dbutils.library.restartPython()
%run ./deploy_agent
```

`deploy_agent.py` logs the agent with MLflow, registers it to `workspace.default.mosaic_vision_agent`,
and attempts `agents.deploy`. If deploy is blocked by serving-endpoint permissions, the model is still
registered in Unity Catalog and the live demo continues via the direct endpoint.

## Proof

A live end-to-end run (input photo → visual analysis → real product + generated lifestyle image →
Bloomreach activation) is captured in `tmp/usecase-vision.html` (local, gitignored).
