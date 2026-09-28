# Team Mosaic: composable AI shopping agent (Hackathon T6)

Our entry for the Composable AI Hackathon 2026, Track T6. One shopping assistant runs across four
platforms and closes a real loop. A shopper talks or shares a photo on the Shopify store, Gemini
handles the language and makes images, Databricks does the reasoning (reads images, extracts
preferences, answers data questions), and Bloomreach receives the updated profile and sends a
personalized email.

One rule shapes the whole design: the Databricks workspace here has no outbound internet. So Cloud Run
does everything that touches the outside world (weather, Gemini, Shopify, Bloomreach) and carries data
*into* Databricks. Databricks only reads and writes its own tables and files.

## What it does

We turn an ordinary conversation into **structured customer intent**, then let the composable stack
act on it (Databricks · Google/Gemini · Bloomreach · Shopify).

- **Store agent.** The Shopify storefront chatbot turns a shopper's chat (and photos) into structured
  profile attributes — `favorite_activity`, `favorite_location`, `summer_interest`, `prior_purchase`, …
- **MES — Mosaic Enrichment Service** (Gemini · GCP Cloud Run). One service, four jobs: **extract**
  attributes (Gemini structured output), **identify + merge** the shopper (hard `email_id`, soft
  `cookie`/`device_id`), **enrich** (weather via Open-Meteo, next-best-product + propensity, vision),
  and **write** to the Bloomreach profile plus Databricks Delta tables (`mosaic_chat_signals`,
  `mosaic_recommendations`, `mosaic_vision_reco`).
- **MAIS — Mosaic AI Scenario** (Databricks Agent Bricks). Describe a campaign in plain language and
  the agent assembles a Bloomreach scenario — **segment → predict → activate** — from Agent Bricks
  scores, Bloomreach auto-segmentation, and an AutoML purchase-likelihood prediction.
- **Gateway integration.** A Shopify storefront chatbot and a Slack bot both feed the loop, updating
  Bloomreach and Databricks.

## Use cases

1. **Storefront recommendations.** A shopper chats with the Shopify bot and gets product
   recommendations; the chat session is logged as a user-intent event with custom attributes.
2. **Scenario activation.** A Bloomreach scenario activates and emails the shopper the recommended
   product.
3. **Image → deeper attributes.** When an image is generated, Agent Bricks runs further analysis to
   extract additional attributes (favorite, interest, location, …).
4. **Slack scenario builder.** A backend Slack bot lets a Bloomreach admin chat and generate scenarios
   dynamically via the Loomi MCP.

## Architecture

[![Team Mosaic architecture](docs/mosaic-architecture.svg)](https://hocokahu.github.io/hackathon/mosaic-architecture.html)

▶ **[Open the interactive diagram](https://hocokahu.github.io/hackathon/mosaic-architecture.html)** — pan, zoom, trace, light/dark, and export.

## Repo layout

| Path | What's in it |
|---|---|
| `chat-backend/` | The Cloud Run service (`server.js`). All endpoints, all egress, the Bloomreach poller. |
| `widget/` | The storefront chat bubble (`okahu-chat.js`), a preview page, and the theme embed snippet. |
| `databricks/` | The Agent Framework version of the vision brain (`agent.py`) and its deploy script. |
| `data/` | Sample personas and seed SQL. |
| `shopify-chat-app/` | Shopify app scaffold (app proxy / theme extension). |
| `docs/` | Notes and references. |
| `.env.example`, `.mcp.json.example` | Templates. Copy them, fill in your own values. |

## Setup

1. **Secrets.** Copy `.env.example` to `.env` and fill it in (Shopify Admin token, Gemini key,
   Bloomreach tokens, GCP project). The Databricks token goes in `.claude/settings.local.json`;
   `.mcp.json` reads secrets as `${NAME}`. Nothing secret is committed.
2. **MCP servers.** Copy `.mcp.json.example` to `.mcp.json`, then restart Claude Code to approve them
   (Bloomreach Loomi, Shopify docs, Databricks Genie).
3. **Run the backend locally.** `cd chat-backend && npm install && node server.js` (it reads config
   from the environment).
4. **Deploy the backend.** `gcloud run deploy mosaic-chat --source chat-backend --region us-east1`
   with your own GCP project and account.
5. **Ship the widget.** It loads from jsDelivr `@main`. Push to `main`, then purge the CDN:
   `curl https://purge.jsdelivr.net/gh/<owner>/<repo>@main/widget/okahu-chat.js`. Browsers cache it
   too, so hard-refresh to see a change.

## Backend (`chat-backend/server.js`)

One Node file, no framework. Config comes from environment variables (see `.env.example`).

| Endpoint | Does |
|---|---|
| `POST /chat` | Text chat with Gemini; extracts profile attributes; generates an image when asked (prompt built from the whole session) and stores it in Databricks. |
| `POST /vision-chat` | Public. Shopper photo goes to Databricks vision, back with a real product and a Gemini lifestyle image. |
| `POST /vision-enrich`, `/enrich`, `/agent/run` | Gated variants plus the weather → reasoning → activation path. |
| `POST /merge` | Links an anonymous device to a known email in Bloomreach. |
| `GET /health` | Shows the live models and flags. |

A background poller (every 25s) reads new rows from the Databricks preferences table and writes them to
Bloomreach. This is how a Databricks-derived value reaches Bloomreach, since Databricks can't call out.

## Models

- **Text chat:** Gemini `gemini-3.8-flash` (Google, called from Cloud Run).
- **Image generation:** Gemini `gemini-3-pro-image-preview` (Google, called from Cloud Run). Databricks
  does not generate images.
- **Image analysis and reasoning:** `databricks-claude-sonnet-4-5` on Databricks Model Serving.

## Databricks

Host, warehouse id, and token live in `.claude/settings.local.json` and `.env`, never in the repo.

- **Tables** (`workspace.default`): `mosaic_chat_signals`, `mosaic_weather`, `mosaic_recommendations`,
  `mosaic_vision_reco`, `mosaic_user_preferences`.
- **Volume** `mosaic_images`: the generated image files.
- **Functions:** `get_customer_context(email)`, `get_weather_forecast(location)`.
- **Genie Agent** ("Customer Preferences and Recommendations"): answers plain-English questions over
  the five tables. Built and run through the managed Agent Bricks UI, no admin rights needed.
- **Job** `mosaic-analyze-images`: a file-arrival trigger on the image volume runs vision on each new
  image and writes the extracted preference to `mosaic_user_preferences`.
- `databricks/agent.py` is the committable Agent Framework version of the vision brain (Claude plus the
  two functions plus optional Genie).

## Bloomreach

- The project slug and API tokens are in `.env`. Push attributes with the tracking API. The hard id is
  `email_id`; the soft id is `cookie` (the device id).
- One email campaign ("Summer hiking cross-sell") recommends a product with a per-recipient cart link
  and the recipient's real forecast. Email goes out through Mailgun, which on this account only delivers
  to the connected test inbox.

## Shopify

- Store domain and Admin token are in `.env` (`SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_API_TOKEN`). Use
  the Admin API for catalog and orders; use Loomi for personalized product search.
- The chat widget installs as a theme app embed and calls the Cloud Run backend.
- Cart links (`/cart/{variant}:{qty}`) drop a shopper into checkout. They can't get past the dev-store
  password page, so demo in a browser that's already unlocked the store.

## Limits worth knowing

- Databricks serverless has no outbound internet, and we aren't workspace admins. So a model gets
  *called* from Cloud Run instead of deployed as its own endpoint.
- The dev store keeps a password page that this plan won't let us turn off.
- Mailgun only delivers to the connected test inbox on this account.
