# Team Mosaic — storefront chat backend

One small HTTPS service the storefront chat widget calls. It:

1. Answers the shopper with **Gemini** (the API key stays server-side) via the **Interactions API** (`gemini-3.8-flash`; classic `generateContent` is retired for new keys).
2. Extracts durable preferences from the message (`favorite_color`, `preferred_location`, `style_preference`, `budget_band`) via Gemini structured output.
3. If the shopper is a **logged-in customer** (email arrives from the widget), writes those preferences onto their **Bloomreach Engagement** profile (new properties auto-create).

No dependencies — Node 20 built-ins only. All config via env vars (no secrets in code; this repo is public).

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `GEMINI_API_KEY` | yes | AI Studio key (from `.env`) |
| `GEMINI_MODEL` | no | default `gemini-3.8-flash` (Interactions API) |
| `ALLOWED_ORIGIN` | no | set to `https://okahu-hackathon.myshopify.com` (default `*`) |
| `BLOOMREACH_API_BASE` | for writes | e.g. `https://api.<instance>.exponea.com` (from Engagement → Project settings → API) |
| `BLOOMREACH_PROJECT_TOKEN` | for writes | Engagement project token |
| `BLOOMREACH_API_KEY_ID` | for writes | API access key id |
| `BLOOMREACH_API_SECRET` | for writes | API access key secret |

If the Bloomreach vars are unset, chat still works — attribute writes are simply skipped.

## Run locally

```bash
GEMINI_API_KEY=... node server.js
curl -s localhost:8080/chat -X POST -H 'content-type: application/json' \
  -d '{"message":"I love sage green and I am in Portland","email":"persona+ava@example.com"}'
```

## Deploy to Cloud Run (source deploy — no Docker build needed locally)

```bash
gcloud run deploy mosaic-chat \
  --source . \
  --project "$GCP_PROJECT_ID" \
  --region us-east1 \
  --allow-unauthenticated \
  --set-env-vars "GEMINI_API_KEY=...,ALLOWED_ORIGIN=https://okahu-hackathon.myshopify.com,GEMINI_MODEL=gemini-3.8-flash"
# add BLOOMREACH_* to --set-env-vars once the API key exists
```

The deploy prints an HTTPS URL like `https://mosaic-chat-xxxx.a.run.app`. Point the widget at `<that URL>/chat`.

## Wire the widget (in the theme, before the widget script)

```liquid
<script>
  window.OKAHU_CUSTOMER = {% if customer %}{{ customer | json }}{% else %}null{% endif %};
  window.OKAHU_CHAT = { endpoint: "https://mosaic-chat-xxxx.a.run.app/chat" };
</script>
<script src="https://cdn.jsdelivr.net/gh/hocokahu/hackathon@main/widget/okahu-chat.js" defer></script>
```

`window.OKAHU_CUSTOMER` gives the widget the logged-in shopper's email (identity spine); `endpoint`
tells it to call this backend instead of the demo stub.

## Response shape

```json
{ "reply": "Love sage green! ...", "extracted": { "favorite_color": "sage green", "preferred_location": "Portland, OR" }, "wrote": true }
```
