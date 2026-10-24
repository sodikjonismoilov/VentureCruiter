"""Existing research agents must reach native VC workflows without plugin setup."""
import gzip
import json
from types import SimpleNamespace

import pytest

from app.db.tenancy import current_tenant_id
from app.models.investor_funnel import InvestorUniverseSnapshot
from app.services import investor_funnel
from app.services.orchestrator import AgentOrchestrator
from app.services.tools import investor_funnel as vc_tools
from app.services.tools.registry import ToolRegistry
from tests.test_prospecting import stack


VC_RESEARCH = {"search_vc_founders", "start_vc_investor_match", "get_vc_investor_match", "prepare_vc_outreach"}


def registry():
    result = ToolRegistry()
    result.register_default_tools()
    return result


def names(tools, bot):
    return {item["function"]["name"] for item in tools.get_tools_for_bot(bot)}


def test_legacy_research_agent_gets_native_vc_workflow_without_reconfiguration():
    bot = SimpleNamespace(tools_enabled=["browser", "shell", "filesystem", "media", "plugins"])
    original = list(bot.tools_enabled)
    available = names(registry(), bot)
    assert VC_RESEARCH <= available
    assert "label_vc_investor_match" not in available
    assert bot.tools_enabled == original


@pytest.mark.parametrize("categories", [["shell"], ["plugins"], ["filesystem"]])
def test_nonresearch_agents_do_not_gain_native_research(categories):
    assert not VC_RESEARCH & names(registry(), SimpleNamespace(tools_enabled=categories))


def test_explicit_prospecting_keeps_feedback_and_native_tools():
    assert VC_RESEARCH | {"label_vc_investor_match"} <= names(
        registry(), SimpleNamespace(tools_enabled=["prospecting"]))


def test_prompt_distinguishes_native_vc_tools_from_external_plugins():
    runner = AgentOrchestrator.__new__(AgentOrchestrator)
    prompt = runner._build_system_prompt(SimpleNamespace(
        system_prompt="Help with public research.", name="Researcher", role="Researcher", tools_enabled=["browser"]))
    assert "search_vc_founders" in prompt and "start_vc_investor_match" in prompt
    assert "not external plugins" in prompt
    assert "related persons" in prompt and "completed" in prompt


@pytest.mark.asyncio
async def test_legacy_agent_native_tool_queues_persists_and_reads_its_own_run(stack, monkeypatch):
    _, sessions = stack
    monkeypatch.setattr(vc_tools, "AsyncSessionLocal", sessions)
    async with sessions() as db:
        db.add(InvestorUniverseSnapshot(id="current", firm_count=0, quarters=[],
            payload=gzip.compress(json.dumps({"firms": [], "companies": []}).encode())))
        await db.commit()
    tools = registry()
    bot = SimpleNamespace(id="legacy-researcher", tools_enabled=["browser", "plugins"])
    assert VC_RESEARCH <= names(tools, bot)
    token = current_tenant_id.set("account-a")
    try:
        found = await tools.execute_tool("search_vc_founders", {"limit": 5}, bot.id)
        assert found["items"] == [] and found["database"]["records"] == 0
        queued = await tools.execute_tool("start_vc_investor_match", {
            "direction": "companies_for_thesis", "one_liner": "Healthcare software",
            "thesis": "Find seed stage healthcare software issuer filings.",
        }, bot.id)
        assert queued["status"] == "pending", queued
    finally:
        current_tenant_id.reset(token)
    for _ in range(3):
        await investor_funnel.tick(sessions)
    token = current_tenant_id.set("account-a")
    try:
        completed = await tools.execute_tool("get_vc_investor_match", {"run_id": queued["id"]}, bot.id)
        assert completed["status"] == "completed" and completed["results"] == []
    finally:
        current_tenant_id.reset(token)
    token = current_tenant_id.set("account-b")
    try:
        other = await tools.execute_tool("get_vc_investor_match", {"run_id": queued["id"]}, bot.id)
        assert "error" in other
    finally:
        current_tenant_id.reset(token)
