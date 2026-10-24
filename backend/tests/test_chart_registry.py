"""Ensure agents can discover and execute the actual chart renderer."""
import asyncio
import base64
from types import SimpleNamespace

import pytest

from app.services.tools.registry import ToolRegistry


@pytest.mark.parametrize('categories', [
    ['browser', 'shell', 'filesystem', 'media', 'plugins', 'prospecting'],
    ['charts'], ['visualization'], [],
])
def test_chart_discovery_and_real_execution(categories, monkeypatch):
    import app.services.computer as computer

    approvals = []

    async def approve(name, arguments, bot_id, replay_safe):
        approvals.append((name, bot_id, replay_safe))
        return True

    monkeypatch.setattr(computer, 'approve_tool', approve)
    registry = ToolRegistry()
    registry.register_default_tools()
    tools = registry.get_tools_for_bot(SimpleNamespace(tools_enabled=categories))
    chart = next(tool['function'] for tool in tools if tool['function']['name'] == 'create_chart')
    assert {'chart_type', 'labels', 'series', 'data_origin'} <= set(chart['parameters']['properties'])
    result = asyncio.run(registry.execute_tool('create_chart', {
        'title': 'Requested quarterly revenue', 'chart_type': 'bar',
        'labels': ['Q1', 'Q2'], 'series': [{'name': 'Revenue', 'values': [10, 15]}],
        'data_origin': 'user_provided',
    }, 'chart-agent'))
    assert result['success'] is True
    assert approvals == [('create_chart', 'chart-agent', True)]
    files = {item['mime']: base64.b64decode(item['data']) for item in result['_attachments']}
    assert files['image/png'].startswith(b'\x89PNG\r\n\x1a\n')
    assert b'<svg' in files['image/svg+xml']
    assert b'Revenue' in files['text/csv']


def test_unrelated_category_does_not_expose_chart():
    registry = ToolRegistry()
    registry.register_default_tools()
    tools = registry.get_tools_for_bot(SimpleNamespace(tools_enabled=['prospecting']))
    assert 'create_chart' not in {tool['function']['name'] for tool in tools}
