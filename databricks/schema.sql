-- Mosaic — Databricks schema (Unity Catalog: catalog `workspace`, schema `default`)
-- Recreates the tables, the UC volume, and the two UC function tools the agent calls.
-- Run in a Databricks SQL editor or notebook (%sql) on the serverless warehouse.
-- Pulled from the live workspace with SHOW CREATE TABLE / information_schema.routines;
-- the auto-managed Delta TBLPROPERTIES from SHOW CREATE are omitted (Databricks sets them).

-- ── Volume: chat-generated shopper images land here; the file-arrival job reads them ──────────────
CREATE VOLUME IF NOT EXISTS workspace.default.mosaic_images;

-- ── Tables ───────────────────────────────────────────────────────────────────────────────────────

-- Cross-platform chat signals the storefront assistant extracts (read by get_customer_context).
CREATE TABLE IF NOT EXISTS workspace.default.mosaic_chat_signals (
  email STRING,
  favorite_activity STRING,
  favorite_location STRING,
  summer_interest STRING,
  favorite_color STRING,
  style_preference STRING,
  budget_band STRING,
  raw_message STRING,
  source STRING,
  created_at TIMESTAMP
) USING delta;

-- Text-recommendation output (Phase 1 enrichment).
CREATE TABLE IF NOT EXISTS workspace.default.mosaic_recommendations (
  email STRING,
  recommended_product STRING,
  propensity DOUBLE,
  rationale STRING,
  weather_summary STRING,
  owns_snowboard BOOLEAN,
  model STRING,
  created_at TIMESTAMP
) USING delta;

-- Weather forecast cache (read by get_weather_forecast).
CREATE TABLE IF NOT EXISTS workspace.default.mosaic_weather (
  location STRING,
  lat DOUBLE,
  lon DOUBLE,
  week_start DATE,
  temp_high_f DOUBLE,
  temp_low_f DOUBLE,
  precip_prob_max INT,
  summary STRING,
  forecast_json STRING,
  fetched_at TIMESTAMP
) USING delta;

-- Vision recommendation / image queue. Cloud Run inserts a row (with image_path) per generated image;
-- the mosaic_analyze_images job reads unprocessed image_path values.
CREATE TABLE IF NOT EXISTS workspace.default.mosaic_vision_reco (
  email STRING,
  device_id STRING,
  visual_analysis STRING,
  recommended_product STRING,
  matched_sku STRING,
  matched_product STRING,
  propensity DOUBLE,
  rationale STRING,
  weather_summary STRING,
  image_generated BOOLEAN,
  model STRING,
  created_at TIMESTAMP,
  image_path STRING
) USING delta;

-- Vision-extracted preferences. The mosaic_analyze_images job writes image_generation here;
-- the Cloud Run poller pushes rows with pushed_to_br = false to Bloomreach, then flips the flag.
CREATE TABLE IF NOT EXISTS workspace.default.mosaic_user_preferences (
  email STRING,
  device_id STRING,
  image_file STRING,
  image_generation STRING,
  analyzed_at TIMESTAMP,
  pushed_to_br BOOLEAN
) USING delta;

-- ── UC function tools (called by the Agent Bricks Supervisor / Agent Framework agent) ─────────────

-- Latest cross-platform profile line for a shopper, by email.
CREATE OR REPLACE FUNCTION workspace.default.get_customer_context(email STRING)
RETURNS STRING
RETURN (
  SELECT concat('Shopper ', s.email, ': favorite_activity=', coalesce(s.favorite_activity,'unknown'),
                ', summer_interest=', coalesce(s.summer_interest,'unknown'),
                ', destination=', coalesce(s.favorite_location,'unknown'), '.')
  FROM workspace.default.mosaic_chat_signals s
  WHERE s.email = email
  ORDER BY s.created_at DESC LIMIT 1
);

-- Latest weather forecast line for a location (substring match), most recent fetch.
CREATE OR REPLACE FUNCTION workspace.default.get_weather_forecast(location STRING)
RETURNS STRING
RETURN (
  SELECT concat('Next week in ', w.location, ': ', w.summary,
                ' (high ', CAST(round(w.temp_high_f) AS STRING), 'F, low ', CAST(round(w.temp_low_f) AS STRING),
                'F, max rain chance ', CAST(w.precip_prob_max AS STRING), '%).')
  FROM workspace.default.mosaic_weather w
  WHERE lower(w.location) LIKE concat('%', lower(location), '%')
  ORDER BY w.fetched_at DESC LIMIT 1
);
