import base64
import json
from types import SimpleNamespace

import pytest

from app.db.tenancy import current_tenant_id
from app.services import attachments
from app.services.llm_gateway import LLMGateway
from app.services.orchestrator import AgentOrchestrator
from .test_workspace_workflows import workspace, room


@pytest.mark.asyncio
async def test_current_voice_transcript_is_the_final_user_request_once(workspace, monkeypatch):
    client, _ = workspace
    owner = 'voice-trigger-owner'
    cid = await room(client, owner)
    prompt = 'Voice message attached. Please respond directly to what I said in the recording.'
    phrase = 'Repeat the verification phrase silver maple.'
    calls = []

    async def transcribe(file):
        calls.append(file['name'])
        return phrase

    async def complete(**kwargs):
        final = json.dumps(kwargs['messages'][-1]['content'])
        assert phrase in final
        assert json.dumps(kwargs['messages']).count(phrase) == 1
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='silver maple', tool_calls=None))])

    monkeypatch.setattr(attachments, 'transcribe_audio', transcribe)
    monkeypatch.setattr(LLMGateway, 'complete', complete)
    incoming = await client.post('/api/conversations/'+cid+'/messages', headers={'x-grokbot-user-id':owner}, json={
        'sender_type':'user', 'content':prompt,
        'attachments':[{'name':'fixture.webm', 'mime':'audio/webm', 'data':base64.b64encode(b'synthetic-audio').decode()}]})
    assert incoming.status_code == 202
    tenant = current_tenant_id.set(owner)
    try:
        replies = await AgentOrchestrator().process_message(cid, prompt, incoming_message_id=incoming.json()['message_id'])
    finally:
        current_tenant_id.reset(tenant)
    assert calls == ['fixture.webm']
    assert replies[-1]['content'] == 'silver maple'
