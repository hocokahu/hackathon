"""
Mosaic Vision Stylist — Mosaic AI Agent Framework agent (committable, deployable).

This is the PRODUCTION form of the reasoning brain the Cloud Run service calls. It is a real
tool-calling agent authored with the Databricks Agent Framework (LangGraph + MLflow ChatAgent),
built around:

  * LLM   : databricks-claude-sonnet-4-5  (Claude Sonnet 4.5 on Databricks Model Serving).
            Multimodal — it reads the shopper's photo (image passed inline in the message,
            so Databricks never has to dial out; all egress stays in Cloud Run).
  * Tools : Unity Catalog functions  workspace.default.get_customer_context(email)
                                     workspace.default.get_weather_forecast(location)
            + (optional) a Genie Space as a tool for ad-hoc data-grounded questions.

Why this file exists alongside the live Cloud Run path
------------------------------------------------------
The live hackathon demo (chat-backend/server.js  POST /vision-enrich) calls the *governed
serving endpoint* `databricks-claude-sonnet-4-5` directly with the image + context + weather.
That is the same model this agent fronts, so the demo is honest and fully working today.

Deploying THIS agent as its own serving endpoint (`agents.deploy`) needs workspace-admin
`serving-endpoint-create` rights, which we do not hold on the shared hackathon lab (UC model
*registration* IS available to us — verified). So this file is written to run inside a
Databricks notebook where those rights exist; see databricks/deploy_agent.py and README.md.

Run/author this inside a Databricks notebook (it needs the workspace runtime + creds).
Dependencies (install in the notebook):
    %pip install -U -qqqq mlflow databricks-langchain databricks-agents langgraph
"""
from typing import Any, Generator, Optional
import os

import mlflow
from databricks_langchain import ChatDatabricks, UCFunctionToolkit
from databricks_langchain.genie import GenieAgent
from langchain_core.runnables import RunnableConfig
from langgraph.prebuilt import create_react_agent
from mlflow.pyfunc import ChatAgent
from mlflow.types.agent import ChatAgentChunk, ChatAgentMessage, ChatAgentResponse, ChatContext

# ── Configuration (env-overridable so the same file deploys unchanged) ─────────────────────────────
LLM_ENDPOINT = os.environ.get("MOSAIC_LLM_ENDPOINT", "databricks-claude-sonnet-4-5")
UC_TOOLS = [
    "workspace.default.get_customer_context",
    "workspace.default.get_weather_forecast",
]
# Optional: set MOSAIC_GENIE_SPACE_ID to attach a Genie Space as a tool (agent -> Genie).
GENIE_SPACE_ID = os.environ.get("MOSAIC_GENIE_SPACE_ID", "").strip()

SYSTEM_PROMPT = (
    "You are Mosaic's visual merchandising analyst for an outdoor & snowboard store. "
    "When the shopper sends a PHOTO, study it for signals a behavioral engine cannot see: the "
    "setting/terrain, the season, the gear they already own and its condition/suitability, their "
    "activity, and weather cues. Use get_customer_context(email) for their cross-platform profile and "
    "get_weather_forecast(location) for the live forecast. Then recommend the single best next product "
    "to cross-sell, give a purchase propensity from 0 to 1, and a one-sentence rationale that explicitly "
    "references what you saw in the photo. Prefer real, in-stock products. Be concise and specific."
)


def _build_llm() -> ChatDatabricks:
    return ChatDatabricks(endpoint=LLM_ENDPOINT, temperature=0.2)


def _build_tools() -> list:
    """Unity Catalog function tools (+ optional Genie space tool)."""
    tools = list(UCFunctionToolkit(function_names=UC_TOOLS).tools)
    if GENIE_SPACE_ID:
        genie = GenieAgent(
            GENIE_SPACE_ID,
            "Genie",
            description=(
                "Ask natural-language questions over the store's Databricks data "
                "(customers, propensity scores, product performance)."
            ),
        )
        tools.append(genie.as_tool())  # agent -> Genie as a callable tool
    return tools


class MosaicVisionAgent(ChatAgent):
    """MLflow ChatAgent wrapping a LangGraph ReAct agent (tool-calling + multimodal)."""

    def __init__(self):
        self._agent = create_react_agent(
            _build_llm(), tools=_build_tools(), prompt=SYSTEM_PROMPT
        )

    @staticmethod
    def _to_lc(messages: list[ChatAgentMessage]) -> dict:
        # ChatAgentMessage content may be a string OR a list of parts (text + image_url) — pass through
        # unchanged so image parts reach the multimodal model.
        return {"messages": [m.model_dump_compat(exclude_none=True) for m in messages]}

    def predict(
        self,
        messages: list[ChatAgentMessage],
        context: Optional[ChatContext] = None,
        custom_inputs: Optional[dict[str, Any]] = None,
    ) -> ChatAgentResponse:
        out: list[ChatAgentMessage] = []
        for event in self._agent.stream(self._to_lc(messages), stream_mode="updates"):
            for node in event.values():
                for msg in node.get("messages", []):
                    out.append(ChatAgentMessage(**msg.model_dump(), id=getattr(msg, "id", None) or ""))
        return ChatAgentResponse(messages=out)

    def predict_stream(
        self,
        messages: list[ChatAgentMessage],
        context: Optional[ChatContext] = None,
        custom_inputs: Optional[dict[str, Any]] = None,
    ) -> Generator[ChatAgentChunk, None, None]:
        for event in self._agent.stream(self._to_lc(messages), stream_mode="updates"):
            for node in event.values():
                for msg in node.get("messages", []):
                    yield ChatAgentChunk(delta=ChatAgentMessage(**msg.model_dump(), id=getattr(msg, "id", None) or ""))


# Set the agent MLflow will log/serve.
mlflow.langchain.autolog()
AGENT = MosaicVisionAgent()
mlflow.models.set_model(AGENT)
