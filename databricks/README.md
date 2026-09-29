# Mosaic Vision Stylist — Databricks agent

The reasoning brain behind Phase 2: a multimodal agent that looks at a **shopper's own photo** and
recommends a real product. This is the analysis a behavioral engine (Bloomreach) cannot do — it has
no way to *see* the customer's image.

## Files in this folder

- `schema.sql` — the Unity Catalog tables, the `mosaic_images` volume, and the two UC function tools
  (`get_customer_context`, `get_weather_forecast`). Run this first to recreate the Databricks side.
- `mosaic_analyze_images.py` — the **live** vision job (a notebook). On file arrival in the volume it
  reads each new image, runs `databricks-claude-sonnet-4-5` vision to name the product/activity in a
  few words, and writes it to `mosaic_user_preferences.image_generation`.
- `job.json` — the Job definition for that notebook (file-arrival trigger on the volume, unpaused).
  Set `notebook_path` to where you imported the notebook, then create it with
  `databricks jobs create --json @databricks/job.json`.
- `agent.py` / `deploy_agent.py` — the Agent Framework version of the vision brain (see below). Not
  the path currently running; the live demo calls the model endpoint directly.

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

## Tools and tables (defined in `schema.sql`)

- `workspace.default.get_customer_context(email)` — latest cross-platform signals from `mosaic_chat_signals`.
- `workspace.default.get_weather_forecast(location)` — latest forecast from `mosaic_weather` (Cloud Run fills it).
- Tables: `mosaic_chat_signals`, `mosaic_recommendations`, `mosaic_weather`, `mosaic_vision_reco`
  (image queue, has `image_path`), `mosaic_user_preferences` (vision output). Plus the `mosaic_images` volume.
- *(optional)* a **Genie Space** over these tables, usable as an agent tool — set `MOSAIC_GENIE_SPACE_ID`.

## Recreate the Databricks side from scratch

1. **Schema.** Run `schema.sql` in a SQL editor (serverless warehouse): creates the tables, the volume, and the two UC functions.
2. **Real-time vision job.** Import `mosaic_analyze_images.py` as a notebook, then create the Job from
   `job.json` (`databricks jobs create --json @databricks/job.json` — first set `notebook_path` to your
   import location). It has a **file-arrival trigger** on `/Volumes/workspace/default/mosaic_images/`
   and needs no internet — it calls the governed model via `mlflow-skinny` + `get_deploy_client("databricks")`.
3. **(optional) Agent Framework agent.** In a notebook:
   ```python
   %pip install -U -qqqq mlflow databricks-langchain databricks-agents langgraph
   dbutils.library.restartPython()
   %run ./deploy_agent
   ```
   `deploy_agent.py` logs the agent with MLflow, registers it to `workspace.default.mosaic_vision_agent`,
   and attempts `agents.deploy`. If deploy is blocked by serving-endpoint permissions, the model is still
   registered in UC and the live demo continues via the direct endpoint.

> Not committed (workspace/UI-managed): the Genie space and the Agent Bricks Supervisor agent are built
> in the Databricks UI, so they live in the workspace, not in this repo.

## Proof

A live end-to-end run (input photo → visual analysis → real product + generated lifestyle image →
Bloomreach activation) is captured in `tmp/usecase-vision.html` (local, gitignored).
