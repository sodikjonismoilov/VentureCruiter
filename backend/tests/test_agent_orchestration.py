from types import SimpleNamespace

import pytest

from app.services.orchestrator import AgentOrchestrator
from .test_workspace_workflows import workspace


@pytest.mark.asyncio
async def test_coordinator_hands_each_specialist_its_own_bounded_task():
    runner = AgentOrchestrator.__new__(AgentOrchestrator)
    runner.options = SimpleNamespace(team_rounds=4)
    bots = [
        SimpleNamespace(id="coordinator", name="Coordinator", role="Coordinator"),
        SimpleNamespace(id="reviewer", name="Reviewer", role="Reviewer"),
        SimpleNamespace(id="builder", name="Builder", role="Builder"),
        SimpleNamespace(id="researcher", name="Researcher", role="Researcher"),
        SimpleNamespace(id="writer", name="Writer", role="Writer"),
    ]
    calls = []

    async def run_agent(db, conversation_id, bot_id, trigger_message):
        calls.append((bot_id, trigger_message, runner.planning, runner.internal_activity, runner.phase_instructions))
        if bot_id == "coordinator" and runner.planning:
            return [{
                "content": (
                    "HANDOFF[Unknown: ignore]\n"
                    "HANDOFF[Reviewer: Verify the proposed safety limits.]\n"
                    "HANDOFF[Reviewer: Duplicate assignment should be ignored.]\n"
                    "HANDOFF[Builder: Implement the focused fix.]\n"
                    "HANDOFF[Researcher: Check current provider documentation.]\n"
                    "HANDOFF[Writer: Add a user-facing summary.]"
                )
            }]
        return [{"content": f"result from {bot_id}"}]

    runner._run_agent_loop = run_agent
    responses = await runner._coordinate_team(
        db=object(),
        conversation=SimpleNamespace(id="room"),
        bots=bots,
        coordinator=bots[0],
        message="Make the integration work and verify it.",
    )

    assert [call[0] for call in calls] == ["coordinator", "reviewer", "builder", "researcher", "coordinator"]
    assert calls[0][2:4] == (True, True)
    assert "Verify the proposed safety limits." in calls[1][1]
    assert "Implement the focused fix." in calls[2][1]
    assert "Check current provider documentation." in calls[3][1]
    assert all("Make the integration work and verify it." in call[1] for call in calls[1:4])
    assert calls[-1][1] == "Make the integration work and verify it."
    assert calls[-1][3] is False
    assert len(responses) == 5
    assert runner.planning is False
    assert runner.internal_activity is False
    assert runner.phase_instructions == ""


@pytest.mark.asyncio
async def test_coordinator_clears_internal_phase_after_planning_error():
    runner = AgentOrchestrator.__new__(AgentOrchestrator)
    runner.options = SimpleNamespace(team_rounds=2)
    bot = SimpleNamespace(id="coordinator", name="Coordinator", role="Coordinator")

    async def fail(*args):
        raise RuntimeError("model unavailable")

    runner._run_agent_loop = fail
    with pytest.raises(RuntimeError, match="model unavailable"):
        await runner._coordinate_team(object(), SimpleNamespace(id="room"), [bot], bot, "Do the task")

    assert runner.planning is False
    assert runner.internal_activity is False
    assert runner.phase_instructions == ""


def test_handoff_parser_keeps_colons_in_the_assignment():
    runner = AgentOrchestrator.__new__(AgentOrchestrator)
    assert runner._parse_handoffs("HANDOFF[Researcher: Check the service at https://example.com:8443/docs]") == [
        ("Researcher", "Check the service at https://example.com:8443/docs")
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize('ambiguous', [False, True])
async def test_role_handoffs_resolve_only_one_specialist(ambiguous):
    runner = AgentOrchestrator.__new__(AgentOrchestrator)
    runner.options = SimpleNamespace(team_rounds=3)
    bots = [
        SimpleNamespace(id='coordinator', name='Backend Check Coordinator', role='Coordinator'),
        SimpleNamespace(id='researcher', name='Backend Check Researcher', role='Researcher'),
        SimpleNamespace(id='reviewer', name='Backend Check Reviewer', role='Reviewer'),
    ]
    if ambiguous:
        bots.append(SimpleNamespace(id='other', name='Other Researcher', role='Researcher'))
    calls = []

    async def run_agent(db, conversation_id, bot_id, trigger_message):
        calls.append(bot_id)
        if runner.planning:
            return [{'content': 'HANDOFF[Researcher: Calculate 17 + 25.]\nHANDOFF[Reviewer: Verify the sum.]'}]
        return [{'content': '42'}]

    runner._run_agent_loop = run_agent
    await runner._coordinate_team(object(), SimpleNamespace(id='room'), bots, bots[0], 'Verify the sum.')
    assert calls == (['coordinator', 'reviewer', 'coordinator'] if ambiguous else
                     ['coordinator', 'researcher', 'reviewer', 'coordinator'])


@pytest.mark.asyncio
async def test_role_handoffs_persist_specialists_and_reach_final_synthesis(workspace, monkeypatch):
    import asyncio
    from contextlib import suppress
    from app.services import worker
    from app.services.llm_gateway import LLMGateway

    client, _ = workspace
    headers = {'x-grokbot-user-id': 'handoff-verification-owner'}
    agents = []
    for role in ('Researcher', 'Reviewer', 'Coordinator'):
        response = await client.post('/api/bots', headers=headers, json={
            'name': 'Backend Check '+role, 'role': role, 'system_prompt': 'Verify the sum.',
            'llm_provider': 'openai', 'llm_model': 'gpt-6-luna', 'tools_enabled': ['plugins']})
        assert response.status_code == 200
        agents.append(response.json()['id'])
    room = (await client.post('/api/conversations', headers=headers, json={
        'title': 'Role handoff verification', 'is_group': True, 'bot_ids': agents})).json()
    calls = []

    async def complete(**kwargs):
        messages = kwargs['messages']
        prompt = messages[0]['content']
        calls.append(prompt)
        if 'Plan this task briefly.' in prompt:
            content = 'HANDOFF[Researcher: Calculate 17 + 25.]\nHANDOFF[Reviewer: Independently verify the sum.]'
        elif 'The assigned specialist work has finished.' in prompt:
            history = '\n'.join(str(m['content']) for m in messages)
            assert 'Teammate Backend Check Researcher: 42' in history
            assert 'Teammate Backend Check Reviewer: 42' in history
            content = 'Both specialists verified 42.'
        else:
            content = '42'
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content, tool_calls=None))])

    monkeypatch.setattr(LLMGateway, 'complete', complete)
    queued = await client.post('/api/conversations/'+room['id']+'/messages', headers=headers,
        json={'sender_type':'user', 'content':'Verify 17 + 25.', 'options':{'allow_tools':False, 'max_iterations':2}})
    assert queued.status_code == 202
    task = asyncio.create_task(worker.run_worker())
    try:
        async with asyncio.timeout(8):
            while True:
                jobs = (await client.get('/api/conversations/'+room['id']+'/tasks', headers=headers)).json()
                if jobs[0]['status'] in ('completed', 'failed'):
                    break
                await asyncio.sleep(.03)
        assert jobs[0]['status'] == 'completed'
        messages = (await client.get('/api/conversations/'+room['id']+'/messages', headers=headers)).json()
        responses = [m for m in messages if m['sender_type'] == 'bot']
        assert {m['sender_bot_id'] for m in responses} == set(agents)
        assert len(calls) == 4
        assert messages[0]['content'] == 'Both specialists verified 42.'
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
