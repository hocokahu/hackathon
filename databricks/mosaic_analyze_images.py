# Databricks notebook source
%pip install -q mlflow-skinny
dbutils.library.restartPython()

# COMMAND ----------
import base64
from mlflow.deployments import get_deploy_client
spark.sql("CREATE TABLE IF NOT EXISTS workspace.default.mosaic_user_preferences (email STRING, device_id STRING, image_file STRING, image_generation STRING, analyzed_at TIMESTAMP, pushed_to_br BOOLEAN)")
rows=spark.sql("SELECT email, device_id, image_path FROM workspace.default.mosaic_vision_reco WHERE image_path IS NOT NULL AND image_path NOT IN (SELECT image_file FROM workspace.default.mosaic_user_preferences)").collect()
client=get_deploy_client("databricks")
n=0
for row in rows:
    path=row["image_path"]
    try:
        with open(path,"rb") as fh: b64=base64.b64encode(fh.read()).decode()
    except Exception:
        continue
    try:
        resp=client.predict(endpoint="databricks-claude-sonnet-4-5",inputs={"messages":[{"role":"user","content":[{"type":"text","text":"Look at this shopper generated image. In 2-4 words name the product/activity they are interested in (e.g. hiking shoes). Reply with ONLY the phrase."},{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,"+b64}}]}],"max_tokens":30})
        pref=resp["choices"][0]["message"]["content"].strip().strip(".").strip(chr(34))[:80]
    except Exception as e:
        pref=None
    if not pref: continue
    e="'"+row["email"].replace("'","''")+"'" if row["email"] else "NULL"
    d="'"+row["device_id"].replace("'","''")+"'" if row["device_id"] else "NULL"
    p="'"+path.replace("'","''")+"'"; g="'"+pref.replace("'","''")+"'"
    spark.sql(f"INSERT INTO workspace.default.mosaic_user_preferences VALUES ({e},{d},{p},{g},current_timestamp(),false)")
    n+=1
dbutils.notebook.exit(str(n))
