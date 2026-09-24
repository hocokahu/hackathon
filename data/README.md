# Joint persona data — Composable AI Hackathon (T6)

5 personas that exist as the **same people across all three systems**, so the composable loop
(Databricks intelligence → Bloomreach activation → Shopify commerce) has real records to join.

## The identity spine = `email`

There is no shared customer ID across the platforms today (verified: Databricks uses `CUST-xxxx`,
Bloomreach's hard id is `email_id`, Shopify assigns its own id). So we join on **email**, using
plus-addressing (`hoc+<alias>@okahu.ai`) so every persona is a **real, deliverable inbox** (all land
in `owner@example.com`) — activation emails actually arrive and can be screenshotted.

| Persona | Email (spine) | Databricks id | Story / demo path |
|---|---|---|---|
| P1 Ava Chen | hoc+ava@okahu.ai | CUST-1001 | VIP loyalist — reward + upsell |
| P2 Marcus Bello | hoc+marcus@okahu.ai | CUST-1002 | **At-risk high-value — hero RETENTION scenario** |
| P3 Priya Nair | hoc+priya@okahu.ai | CUST-1003 | New — onboarding / grow |
| P4 Diego Santos | hoc+diego@okahu.ai | CUST-1004 | Deal-seeker — offer-driven recs |
| P5 Sophie Laurent | hoc+sophie@okahu.ai | CUST-1005 | Dormant — win-back |

## Field → platform mapping

- **`databricks`** → `databricks-hackathon.00data`. `customers` gets identity + segment/loyalty/opt-in
  (see `databricks_customers.sql`). The scores (`churn_probability`, `purchase_propensity_score`,
  `lifetime_value`, `favorite_category`, `predicted_next_category`, recency/spend, …) surface through
  the **`customer_360` view**, which joins `customers` + `customer_features` + `customer_predictions`
  — so to make the scores appear, rows must also be inserted into those two tables (SQL for them is
  not generated yet — needs their exact column list; ask and I'll produce it).
- **`bloomreach`** → project `gentle-gyroscope`. `email_id` = the spine; `cookie` links to the
  anonymous web profile; `enrichment.*` are the attributes the AGENT writes onto the profile from
  Databricks (churn_risk_band, style_persona, pltv_band, next_best_category) — this is the composable
  write-back. `shopify_id` is filled after the Shopify customer is created.
- **`shopify`** → store `okahu-hackathon`. Customer record + a couple of past orders per persona so
  order history is realistic.

## How to load (next step — not done yet)

1. **Shopify** — create the 5 customers (Admin API, token in `.env`), capture each new `shopify.id`.
2. **Bloomreach** — identify 5 customers by `email_id` + set consents + write the `enrichment` attrs
   (via a Loomi customer-update/import tool) and set `shopify_id` from step 1.
3. **Databricks** — run `databricks_customers.sql`, plus feature/prediction inserts (to be generated).

Loading writes to live systems, so it's gated on your go-ahead. Say the word and I'll run it.
