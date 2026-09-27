"""
Deploy the Mosaic Vision Stylist agent (databricks/agent.py) as a governed serving endpoint.

Run this INSIDE a Databricks notebook (it needs the workspace runtime + creds). It logs the agent
with MLflow, registers it to Unity Catalog, and deploys it with the Agent Framework.

    %pip install -U -qqqq mlflow databricks-langchain databricks-agents langgraph
    dbutils.library.restartPython()

Then run the cells below (or `%run ./deploy_agent`).

Note on permissions (hackathon lab): UC model *registration* is available to us (verified), but
`agents.deploy` needs `serving-endpoint-create`, which requires workspace-admin on this shared lab.
If deploy is blocked, the logged+registered model is still a real artifact, and the live demo keeps
using the governed `databricks-claude-sonnet-4-5` endpoint directly (chat-backend /vision-enrich).
"""
import mlflow
from mlflow.models.resources import DatabricksServingEndpoint, DatabricksFunction, DatabricksGenieSpace
from pkg_resources import get_distribution

import agent as agent_mod  # databricks/agent.py in the same folder

CATALOG = "workspace"
SCHEMA = "default"
MODEL_NAME = "mosaic_vision_agent"
UC_MODEL = f"{CATALOG}.{SCHEMA}.{MODEL_NAME}"

# Declare the resources the agent needs at serving time so automatic auth passthrough is provisioned.
resources = [
    DatabricksServingEndpoint(endpoint_name=agent_mod.LLM_ENDPOINT),
    *[DatabricksFunction(function_name=fn) for fn in agent_mod.UC_TOOLS],
]
if agent_mod.GENIE_SPACE_ID:
    resources.append(DatabricksGenieSpace(genie_space_id=agent_mod.GENIE_SPACE_ID))

# A multimodal example so the logged signature accepts an image part alongside text.
input_example = {
    "messages": [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Here's my last trip. What should I buy next? email: hoc+iris@okahu.ai, location: Denver"},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,<BASE64_IMAGE>"}},
            ],
        }
    ]
}

with mlflow.start_run():
    logged = mlflow.pyfunc.log_model(
        name="agent",
        python_model="agent.py",
        input_example=input_example,
        resources=resources,
        pip_requirements=[
            f"mlflow=={get_distribution('mlflow').version}",
            f"databricks-langchain=={get_distribution('databricks-langchain').version}",
            f"langgraph=={get_distribution('langgraph').version}",
        ],
    )

# Register to Unity Catalog.
mlflow.set_registry_uri("databricks-uc")
uc_model = mlflow.register_model(model_uri=logged.model_uri, name=UC_MODEL)
print("Registered:", UC_MODEL, "version", uc_model.version)

# Deploy as a serving endpoint (needs serving-endpoint-create — may be blocked on the shared lab).
try:
    from databricks import agents
    deployment = agents.deploy(UC_MODEL, uc_model.version, scale_to_zero=True)
    print("Deployed serving endpoint:", getattr(deployment, "endpoint_name", deployment))
    print("Point chat-backend at it:  DATABRICKS_VISION_ENDPOINT=<endpoint_name>")
except Exception as e:  # noqa: BLE001 — surface the reason, don't fail the notebook
    print("agents.deploy blocked (likely serving-endpoint-create perms on this lab):", repr(e))
    print("The model is registered in UC. Live demo continues via databricks-claude-sonnet-4-5 directly.")
