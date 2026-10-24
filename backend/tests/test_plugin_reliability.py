from contextlib import asynccontextmanager
from types import SimpleNamespace
import asyncio,json
import httpx,pytest
from sqlalchemy import select
from mcp.types import CallToolResult,TextContent,ImageContent
from app.models.plugin import Plugin
from app.db.tenancy import current_tenant_id
from app.services import plugins,plugin_sync
from .test_workspace_workflows import workspace

@pytest.mark.asyncio
async def test_unreadable_credential_keeps_other_tools_discoverable_and_fails_closed(workspace, monkeypatch):
    from app.db import session as database
    from app.services.tools.registry import ToolRegistry
    _, sessions = workspace
    monkeypatch.setattr(database, 'AsyncSessionLocal', sessions)
    owner = current_tenant_id.set('credential-recovery-owner')
    try:
        async with sessions() as db:
            schema = {'type': 'object', 'properties': {}}
            broken = Plugin(name='Expired connection', url='https://expired.example/mcp',
                            credential='unreadable-saved-credential', enabled=True,
                            tools=[{'name':'read_record', 'schema':schema}])
            working = Plugin(name='Public documentation', url='https://docs.example/mcp',
                             enabled=True, tools=[{'name':'search_docs', 'schema':schema}])
            db.add_all([broken, working])
            await db.commit()
            registry = ToolRegistry()
            await registry.load_plugins(db, SimpleNamespace(tools_enabled=['plugins']))
            found = await registry._tools['plugin_search']['handler'](
                {'query':'search_docs', 'plugin_id':working.id}, 'test-agent')
            assert found['tools'][0]['plugin_id'] == working.id
            result = await plugins.invoke(broken.id, 'read_record', {})
            assert result['success'] is False and result['code'] == 'sign_in_required'
            assert 'unreadable-saved-credential' not in json.dumps(result)
    finally:
        current_tenant_id.reset(owner)

def test_structured_and_media_results_are_not_lost_or_unbounded():
    result=plugins.tool_result(CallToolResult(content=[],structuredContent={'value':42}),'service')
    assert result['success'] and result['structured_content']=={'value':42} and '42' in result['content']
    result=plugins.tool_result(CallToolResult(content=[ImageContent(type='image',mimeType='image/png',data='eA==')]),'service')
    assert result['_attachments'][0]['data']=='eA=='
    result=plugins.tool_result(CallToolResult(content=[],structuredContent={'text':'x'*30000}),'service')
    assert result['structured_content_truncated'] and 'structured_content' not in result and len(result['content'])==20000

@pytest.mark.asyncio
@pytest.mark.parametrize('http_status,attempts',[(503,2),(401,1),(403,1)])
async def test_discovery_retries_temporary_failures_without_repeating_sign_in(monkeypatch,http_status,attempts):
    from mcp.types import Tool
    calls=[];delays=[]
    @asynccontextmanager
    async def session(*args):
        calls.append(args)
        class Client:
            async def list_tools(self,cursor=None):
                if len(calls)==1:
                    raise httpx.HTTPStatusError('Provider response',request=httpx.Request('POST','https://service.example/mcp'),response=httpx.Response(http_status))
                return SimpleNamespace(tools=[Tool(name='read',inputSchema={'type':'object'})],nextCursor=None)
        yield Client()
    async def sleep(seconds):delays.append(seconds)
    monkeypatch.setattr(plugins,'session',session)
    monkeypatch.setattr(plugins.asyncio,'sleep',sleep)
    if http_status==503:
        assert [x['name'] for x in await plugins.discover('https://service.example/mcp','existing-token')]==['read']
        assert delays==[1]
    else:
        with pytest.raises(httpx.HTTPStatusError):await plugins.discover('https://service.example/mcp','existing-token')
        assert not delays
    assert len(calls)==attempts
    assert all(call==('https://service.example/mcp','existing-token',None) for call in calls)

@pytest.mark.asyncio
async def test_reads_retry_but_writes_do_not_and_invalid_arguments_never_run(workspace,monkeypatch):
    _,sessions=workspace
    from app.db import session as dbmodule
    from app.services import plugin_auth
    monkeypatch.setattr(dbmodule,'AsyncSessionLocal',sessions)
    async def provider(*_):return None
    monkeypatch.setattr(plugin_auth,'provider_for_plugin',provider)
    @asynccontextmanager
    async def session(*_):
        class Client:
            async def call_tool(self,name,arguments):
                calls.append(name)
                if len(calls)<3:raise httpx.ConnectError('temporary')
                return CallToolResult(content=[],structuredContent={'ok':True})
        yield Client()
    monkeypatch.setattr(plugins,'session',session)
    # Avoid a real backoff in a deterministic retry test.
    async def sleep(_):pass
    monkeypatch.setattr(plugins.asyncio,'sleep',sleep)
    token=current_tenant_id.set('plugin-owner')
    try:
        async with sessions() as db:
            p=Plugin(name='test',url='https://example.com/mcp',tools=[{'name':'read','schema':{'type':'object','properties':{'query':{'type':'string'}},'required':['query']},'read_only':True},{'name':'write','schema':{'type':'object'}}])
            db.add(p);await db.commit()
        calls=[]
        assert (await plugins.invoke(p.id,'read',{'query':'test'}))['success'] and len(calls)==3
        calls=[]
        assert (await plugins.invoke(p.id,'write',{}))['code']=='unavailable' and calls==['write']
        calls=[]
        assert (await plugins.invoke(p.id,'read',{'query':7}))['code']=='invalid_arguments' and not calls
    finally:current_tenant_id.reset(token)

@pytest.mark.asyncio
async def test_catalog_job_persists_progress_and_is_tenant_isolated(workspace,monkeypatch):
    client,sessions=workspace
    from app.api import plugin_catalog
    entries=[{'id':str(i),'name':'Service '+str(i),'url':f'https://service{i}.example/mcp','auth':'auto'} for i in range(8)]
    monkeypatch.setattr(plugin_catalog,'catalog',lambda:entries)
    async def discover(url,token=None):return [{'name':'read','description':'Read','schema':{'type':'object'},'read_only':True}]
    monkeypatch.setattr(plugin_sync,'discover',discover)
    a={'x-grokbot-user-id':'catalog-owner'};b={'x-grokbot-user-id':'other-owner'}
    job=await client.post('/api/plugins/catalog/sync',headers=a,json={})
    assert job.status_code==202
    assert (await client.get('/api/plugins/catalog/sync',headers=b)).json() is None
    await plugin_sync.tick(sessions)
    progress=(await client.get('/api/plugins/catalog/sync',headers=a)).json()
    assert progress['checked']==6 and progress['status']=='running'
    # Another runner resumes the persisted job, independent of a browser poll.
    await plugin_sync.tick(sessions)
    final=(await client.get('/api/plugins/catalog/sync',headers=a)).json()
    assert final['checked']==8 and final['counts']=={'connected':8} and final['status']=='completed'
    assert len((await client.get('/api/plugins',headers=a)).json())==8
    assert (await client.get('/api/plugins',headers=b)).json()==[]

@pytest.mark.asyncio
async def test_catalog_batches_yield_to_other_workspaces(workspace,monkeypatch):
    client,sessions=workspace
    from app.api import plugin_catalog
    entries=[{'id':str(i),'name':'Service '+str(i),'url':f'https://service{i}.example/mcp','auth':'auto'} for i in range(8)]
    monkeypatch.setattr(plugin_catalog,'catalog',lambda:entries)
    async def discover(url,token=None,auth=None):return [{'name':'read','description':'Read','schema':{'type':'object'}}]
    monkeypatch.setattr(plugin_sync,'discover',discover)
    a={'x-grokbot-user-id':'first-sync-owner'};b={'x-grokbot-user-id':'next-sync-owner'}
    assert (await client.post('/api/plugins/catalog/sync',headers=a,json={})).status_code==202
    assert (await client.post('/api/plugins/catalog/sync',headers=b,json={})).status_code==202
    await plugin_sync.tick(sessions)
    assert (await client.get('/api/plugins/catalog/sync',headers=a)).json()['checked']==6
    await plugin_sync.tick(sessions)
    assert (await client.get('/api/plugins/catalog/sync',headers=b)).json()['checked']==6
    assert (await client.get('/api/plugins/catalog/sync',headers=a)).json()['checked']==6

def test_server_credentials_are_explicitly_endpoint_and_owner_bound(monkeypatch):
    monkeypatch.setenv('GROKBOT_PLUGIN_CREDENTIALS',json.dumps({'https://official.example/mcp':{'env':'SERVICE_TEST_KEY','header':'x-api-key'}}))
    monkeypatch.setenv('SERVICE_TEST_KEY','test-only-secret')
    assert plugin_sync.mapped_credential('https://official.example/mcp','another-owner') is None
    assert plugin_sync.mapped_credential('https://untrusted.example/mcp','legacy-owner') is None
    assert json.loads(plugin_sync.mapped_credential('https://official.example/mcp','legacy-owner'))=={'x-api-key':'test-only-secret'}

@pytest.mark.asyncio
async def test_catalog_rechecks_saved_auth_and_refreshes_tools_without_enabling_paused_tools(workspace,monkeypatch):
    _,sessions=workspace
    marker=object();calls=[]
    async def auth(db,plugin):return 'saved-token',marker
    async def discover(url,token=None,auth=None):
        calls.append((url,token,auth))
        return [{'name':name,'schema':{'type':'object'},'description':'Updated'} for name in ['read','write','new']]
    monkeypatch.setattr(plugins,'connection_auth',auth)
    monkeypatch.setattr(plugin_sync,'discover',discover)
    async with sessions() as db:
        p=Plugin(name='Saved service',url='https://saved.example/mcp',credential='encrypted-existing',tools=[{'name':'read'},{'name':'write','enabled':False}],enabled=True)
        db.add(p);await db.commit();pid=p.id
    result=await plugin_sync.connect_entry({'name':'Saved service','url':p.url,'auth':'auto'},sessions)
    assert calls==[(p.url,'saved-token',marker)] and result['status']=='connected'
    assert 'execution has not been tested' in result['message']
    async with sessions() as db:
        saved=await db.get(Plugin,pid)
        assert saved.credential=='encrypted-existing' and len(saved.tools)==3
        assert not next(t for t in saved.tools if t['name']=='write')['enabled']

@pytest.mark.asyncio
async def test_catalog_reports_saved_connection_failure_and_keeps_credentials_and_pause(workspace,monkeypatch):
    _,sessions=workspace
    async def auth(db,plugin):return 'saved-token',None
    async def discover(*args,**kwargs):raise httpx.ConnectError('provider unavailable')
    monkeypatch.setattr(plugins,'connection_auth',auth)
    monkeypatch.setattr(plugin_sync,'discover',discover)
    async with sessions() as db:
        p=Plugin(name='Saved',url='https://saved.example/mcp',credential='encrypted-existing',tools=[{'name':'read'}],enabled=True)
        paused=Plugin(name='Paused',url='https://paused.example/mcp',tools=[{'name':'read'}],enabled=False)
        db.add_all([p,paused]);await db.commit();pid=p.id
    result=await plugin_sync.connect_entry({'name':'Saved','url':p.url,'auth':'auto'},sessions)
    assert result['status']=='unavailable'
    assert (await plugin_sync.connect_entry({'name':'Paused','url':paused.url,'auth':'auto'},sessions))['status']=='paused'
    async with sessions() as db:
        saved=await db.get(Plugin,pid)
        assert saved.credential=='encrypted-existing' and saved.tools==[{'name':'read'}] and saved.enabled

@pytest.mark.asyncio
async def test_catalog_checks_every_saved_account_for_one_provider(workspace,monkeypatch):
    _,sessions=workspace;calls=[]
    async def auth(db,plugin):return plugin.name,None
    async def discover(url,token=None,auth=None):
        calls.append(token)
        if token=='Atlas account':
            raise httpx.HTTPStatusError('sign in',request=httpx.Request('GET',url),response=httpx.Response(401))
        return [{'name':'read','description':'Read','schema':{'type':'object'}}]
    monkeypatch.setattr(plugins,'connection_auth',auth)
    monkeypatch.setattr(plugin_sync,'discover',discover)
    async with sessions() as db:
        for name in ('Hive account','Atlas account'):
            db.add(Plugin(name=name,url='https://accounts.example/mcp/',credential='encrypted-'+name,tools=[{'name':'read'}],enabled=True))
        await db.commit()
    result=await plugin_sync.connect_entry({'name':'Accounts','url':'https://accounts.example/mcp','auth':'auto'},sessions)
    assert sorted(calls)==['Atlas account','Hive account']
    assert result['status']=='sign_in_required'
    assert sorted(r['status'] for r in result['connections'])==['connected','sign_in_required']
    async with sessions() as db:
        saved=(await db.execute(select(Plugin).where(Plugin.url=='https://accounts.example/mcp/'))).scalars().all()
        assert len(saved)==2 and all(p.credential=='encrypted-'+p.name and p.enabled for p in saved)

@pytest.mark.asyncio
async def test_key_setup_updates_discovered_connection_without_duplicates(workspace,monkeypatch):
    client,sessions=workspace
    from app.api import plugins as api
    calls=[]
    async def discover(url,token=None):calls.append(token);return [{'name':'read','description':'Read','schema':{'type':'object'}}]
    monkeypatch.setattr(api,'discover',discover)
    monkeypatch.setattr(plugin_sync,'discover',discover)
    token=current_tenant_id.set('key-owner')
    try:
        async with sessions() as db:
            plugin=Plugin(name='Key service',url='https://key.example/mcp',enabled=False,tools=[{'name':'read','description':'Read','enabled':False}]);db.add(plugin);await db.commit();pid=plugin.id
        result=await plugin_sync.connect_entry({'name':'Key service','url':'https://key.example/mcp','auth':'api_key'},sessions)
        assert result['status']=='key_required' and not calls
    finally:current_tenant_id.reset(token)
    result=await client.post('/api/plugins',headers={'x-grokbot-user-id':'key-owner'},json={'name':'Key service','url':'https://key.example/mcp','token':'test-key'})
    assert result.status_code==200 and result.json()['id']==pid and result.json()['authenticated']
    entries=(await client.get('/api/plugins',headers={'x-grokbot-user-id':'key-owner'})).json()
    assert len(entries)==1 and entries[0]['tools'][0]['enabled'] is False

@pytest.mark.asyncio
async def test_browser_cookies_are_not_accepted_as_plugin_api_keys(workspace):
    client,_=workspace
    result=await client.post('/api/plugins',headers={'x-grokbot-user-id':'cookie-owner'},json={
        'name':'Cookie service','url':'https://service.example/mcp',
        'token':'session=private-value','auth_header':'Cookie',
    })
    assert result.status_code==422
    assert 'Browser session cookies cannot be used as API keys' in result.json()['detail']

@pytest.mark.asyncio
async def test_windsor_smoke_test_reads_existing_accounts_without_write_actions(workspace,monkeypatch):
    client,sessions=workspace
    calls=[]
    async def invoke(plugin_id,name,arguments):
        calls.append((name,arguments))
        return {'success':True,'content':'Existing connected accounts returned.'}
    monkeypatch.setattr(plugins,'invoke',invoke)
    tenant=current_tenant_id.set('windsor-owner')
    try:
        async with sessions() as db:
            plugin=Plugin(name='Windsor',url='https://mcp.windsor.ai/',enabled=True,credential=plugins.seal('existing-saved-grant'),tools=[
                {'name':'get_connectors','description':'Read connected accounts'},
                {'name':'execute_action','description':'Write action','enabled':False},
            ])
            db.add(plugin);await db.commit();pid=plugin.id
    finally:current_tenant_id.reset(tenant)
    result=await client.post(f'/api/plugins/{pid}/test',headers={'x-grokbot-user-id':'windsor-owner'})
    assert result.status_code==200 and result.json()['status']=='passed'
    assert calls==[('get_connectors',{'include_actions':False,'include_options':False})]
    saved=(await client.get('/api/plugins',headers={'x-grokbot-user-id':'windsor-owner'})).json()[0]
    assert saved['authenticated'] and saved['tools'][1]['enabled'] is False
