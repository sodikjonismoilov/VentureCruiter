from types import SimpleNamespace

import pytest

from app.db.tenancy import current_tenant_id
from app.models.plugin import Plugin
from app.services import plugins
from app.services.tools.registry import ToolRegistry
from .test_workspace_workflows import workspace


@pytest.mark.asyncio
@pytest.mark.parametrize('with_connections', [True, False])
async def test_legacy_placeholders_preserve_settings_and_route_to_real_connections(workspace,monkeypatch,with_connections):
    _, sessions = workspace
    invoked=[]
    async def invoke(pid,name,args):
        invoked.append((pid,name,args))
        return {'success':True}
    monkeypatch.setattr(plugins,'invoke',invoke)
    owner=current_tenant_id.set('legacy-recovery-owner')
    try:
        async with sessions() as db:
            schema={'type':'object','properties':{}}
            gmail=Plugin(name='gmail.com',url='site-mcp://gmail.com',enabled=True,tools=[{'name':'send_fake_mail','description':'Legacy placeholder','schema':schema}])
            instagram=Plugin(name='Instagram',url='site-mcp://instagram.com',enabled=True,tools=[{'name':'fake_posts','description':'Legacy placeholder','schema':schema,'enabled':False}])
            google=Plugin(name='Google Workspace',url='https://cypher.example/api/google/mcp',enabled=True,credential=plugins.seal('grokbot-google-workspace'),tools=[{'name':'gmail_users_getProfile','description':'Read authorized profile','schema':schema,'read_only':True}])
            windsor=Plugin(name='Windsor.ai existing accounts',url='https://mcp.windsor.ai/',enabled=True,credential=plugins.seal('saved-account-reference'),tools=[{'name':'get_connectors','description':'Read connectors','schema':schema,'read_only':True}])
            db.add_all([gmail,instagram]+([google,windsor] if with_connections else []));await db.commit()
            registry=ToolRegistry();await registry.load_plugins(db,SimpleNamespace(tools_enabled=['plugins']))
            search=registry._tools['plugin_search']['handler'];call=registry._tools['plugin_call']['handler']
            inventory=await search({},'test-agent')
            legacy=next(x for x in inventory['services'] if x['plugin_id']==gmail.id)
            assert legacy['available'] is False and legacy['tool_count']==0
            recovery=await search({'plugin_id':gmail.id},'test-agent')
            assert recovery['code']=='unsupported_endpoint'
            assert recovery['recovery']['replacement_plugin_ids']==([google.id] if with_connections else [])
            recovery=await search({'service':'Instagram'},'test-agent')
            assert recovery['recovery']['replacement_plugin_ids']==([windsor.id] if with_connections else [])
            blocked=await call({'plugin_id':gmail.id,'tool_name':'send_fake_mail','arguments':{}},'test-agent')
            assert not blocked['success'] and not invoked
            if with_connections:
                actual=await search({'service':'Gmail','query':'getProfile'},'test-agent')
                assert actual['tools'][0]['plugin_id']==google.id
                assert (await call({'plugin_id':google.id,'tool_name':'gmail_users_getProfile','arguments':{}},'test-agent'))['success']
                assert invoked==[(google.id,'gmail_users_getProfile',{})]
            await db.refresh(gmail);await db.refresh(instagram)
            assert gmail.url=='site-mcp://gmail.com' and gmail.enabled
            assert instagram.tools[0]['enabled'] is False and instagram.enabled
    finally:
        current_tenant_id.reset(owner)
