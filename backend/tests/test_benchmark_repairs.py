"""Regressions found by controlled production task runs, not model-quality mocks."""
import asyncio
import base64
import json
import subprocess
import sys
from contextlib import suppress
from uuid import uuid4
from types import SimpleNamespace
import pytest
from litellm import ModelResponse
from app.models.message import Message
from app.services import context, orchestrator, worker
from app.services.tools import artifacts
from app.services.tools.registry import ToolRegistry, rank_plugin_tools
from app.services.response_constraints import word_limit,word_count,steer_limit
from .test_workspace_workflows import workspace, room

A={'x-grokbot-user-id':'benchmark-owner'}
B={'x-grokbot-user-id':'benchmark-other'}


def export(root, path, limit=artifacts.MAX_FILE_BYTES):
    script=artifacts.EXPORT_SCRIPT.replace("pathlib.Path('/workspace')",f'pathlib.Path({str(root)!r})')
    result=subprocess.run([sys.executable,'-c',script,str(path),str(limit)],capture_output=True,text=True,check=True)
    return json.loads(result.stdout)


def test_export_preserves_large_binary_and_rejects_escape_directory_and_oversize(tmp_path):
    root=tmp_path/'workspace';root.mkdir()
    content=bytes(range(256))*300
    path=root/'deliverable.bin';path.write_bytes(content)
    assert base64.b64decode(export(root,path)['data'])==content
    assert 'error' in export(root,root)
    outside=tmp_path/'outside';outside.write_text('private outside file')
    (root/'escape').symlink_to(outside)
    assert 'error' in export(root,root/'escape')
    assert 'error' in export(root,path,limit=10)
    assert 'error' in export(root,root/'missing')


@pytest.mark.asyncio
async def test_publish_attachment_is_durable_download_with_owner_auth(workspace,monkeypatch):
    client,sessions=workspace
    cid=await room(client,'benchmark-owner')
    bid=(await client.get('/api/bots',headers=A)).json()[0]['id']
    assert (await client.put('/api/bots/'+bid,headers=A,json={'tools_enabled':['filesystem']})).status_code==200
    payload=b'<html>controlled deliverable</html>'
    def read(bot,script,path,limit):
        assert bot==bid and path=='/workspace/report.html'
        return {'exit_code':0,'output':json.dumps({'name':'report.html','data':base64.b64encode(payload).decode()})}
    monkeypatch.setattr(artifacts.SandboxManager,'read_artifact',read)
    seen=[]
    async def complete(**kw):
        if kw['messages'][-1]['role']=='tool':
            result=json.loads(kw['messages'][-1]['content']);seen.append(result)
            assert result['success'] and 'data' not in json.dumps(result)
            assert result['files'][0]['url'].startswith('/api/conversations/'+cid+'/attachments/')
            message={'role':'assistant','content':'Finished: '+result['files'][0]['url']}
        else:
            assert 'publish_file' in {t['function']['name'] for t in kw['tools']}
            message={'role':'assistant','tool_calls':[{'id':'publish','type':'function','function':{'name':'publish_file','arguments':json.dumps({'path':'/workspace/report.html'})}}]}
        return ModelResponse(choices=[{'message':message}])
    monkeypatch.setattr(orchestrator.LLMGateway,'complete',complete)
    accepted=await client.post('/api/conversations/'+cid+'/messages',headers=A,json={'sender_type':'user','content':'Create my report file'})
    runner=asyncio.create_task(worker.run_worker())
    try:
        for _ in range(200):
            jobs=(await client.get('/api/conversations/'+cid+'/tasks',headers=A)).json()
            if jobs[0]['status'] in {'completed','failed'}:break
            await asyncio.sleep(.02)
        assert jobs[0]['status']=='completed' and len(seen)==1
        messages=(await client.get('/api/conversations/'+cid+'/messages',headers=A)).json()
        generated=next(m for m in messages if m['content']=='Files ready')
        attachment=generated['metadata_json']['attachments'][0]
        assert 'data' not in attachment
        result=await client.get(attachment['url'],headers=A)
        assert result.content==payload
        assert result.headers['content-disposition'].startswith('attachment;')
        assert result.headers['x-content-type-options']=='nosniff'
        assert (await client.get(attachment['url'],headers=B)).status_code==404
        # The delivered snapshot does not need a live sandbox to be downloaded.
        def gone(*a):raise AssertionError('Attachment download touched sandbox')
        monkeypatch.setattr(artifacts.SandboxManager,'read_artifact',gone)
        assert (await client.get(attachment['url'],headers=A)).content==payload
    finally:
        runner.cancel()
        with suppress(asyncio.CancelledError):await runner


@pytest.mark.asyncio
async def test_export_error_never_claims_download(monkeypatch):
    def fail(*a):return {'exit_code':0,'output':json.dumps({'error':'File missing'})}
    monkeypatch.setattr(artifacts.SandboxManager,'read_artifact',fail)
    for path in ['/etc/passwd','relative.txt','/workspace/missing']:
        result=await artifacts.publish_file({'path':path},'agent')
        assert result['success'] is False and '_attachments' not in result


@pytest.mark.asyncio
async def test_bot_memory_survives_new_chat_and_is_not_visible_to_other_agents(workspace):
    from app.db.tenancy import current_tenant_id
    from app.services.workspace import knowledge_prompt
    client,sessions=workspace
    cid=await room(client,'benchmark-owner')
    bid=(await client.get('/api/bots',headers=A)).json()[0]['id']
    await room(client,'benchmark-other')
    foreign=(await client.get('/api/bots',headers=B)).json()[0]['id']
    registry=ToolRegistry();registry.register_default_tools()
    await context.register_context_tools(registry,cid,sessions)
    remember=registry._tools['remember_context']['handler']
    token=current_tenant_id.set('benchmark-owner')
    try:
        result=await remember({'name':'release preference','kind':'preference','content':'Cobalt Finch; three bullets Outcome, Evidence, Next','scope':'bot'},bid)
        assert result['saved'] and result['scope']=='bot' and result['available_in_new_chats']
        async with sessions() as db:
            assert 'Cobalt Finch' in await knowledge_prompt(db,bid)
            assert 'Cobalt Finch' not in await knowledge_prompt(db,'other-agent')
            assert await context.context_prompt(db,cid)==''
        assert 'error' in await remember({'name':'bad','kind':'preference','content':'private','scope':'bot'},foreign)
        assert 'error' in await remember({'name':'bad','kind':'preference','content':'password=privatevalue','scope':'bot'},bid)
        result=await remember({'name':'old behavior','kind':'fact','content':'Only in this conversation'},bid)
        assert not result['available_in_new_chats']
    finally:current_tenant_id.reset(token)
    other=current_tenant_id.set('benchmark-other')
    try:
        async with sessions() as db:assert 'Cobalt Finch' not in await knowledge_prompt(db,bid)
    finally:current_tenant_id.reset(other)
    fresh=(await client.post('/api/conversations',headers=A,json={'title':'Fresh memory check','bot_ids':[bid]})).json()['id']
    assert fresh!=cid
    notes=(await client.get('/api/workspace/knowledge',headers=A)).json()
    assert notes[0]['scope']=='bot:'+bid and 'Cobalt Finch' in notes[0]['content']


@pytest.mark.asyncio
async def test_forgetting_removes_only_requested_saved_records_and_survives_new_chat(workspace):
    from app.db.tenancy import current_tenant_id
    from app.services.workspace import knowledge_prompt
    client,sessions=workspace
    cid=await room(client,'benchmark-owner')
    bid=(await client.get('/api/bots',headers=A)).json()[0]['id']
    peer=(await client.post('/api/bots',headers=A,json={'name':'Peer agent','role':'Assistant','system_prompt':'Help the user.','llm_provider':'openai','llm_model':'gpt-6-luna','tools_enabled':[]})).json()['id']
    other_cid=(await client.post('/api/conversations',headers=A,json={'title':'Peer chat','bot_ids':[peer]})).json()['id']
    await room(client,'benchmark-other')
    foreign=(await client.get('/api/bots',headers=B)).json()[0]['id']
    registry=ToolRegistry();registry.register_default_tools()
    await context.register_context_tools(registry,cid,sessions)
    remember=registry._tools['remember_context']['handler']
    listing=registry._tools['list_context']['handler']
    forget=registry._tools['forget_context']['handler']
    token=current_tenant_id.set('benchmark-owner')
    try:
        pref=await remember({'name':'Travel and diet','kind':'preference','content':'Aisle seats; no pork','scope':'bot'},bid)
        keep=await remember({'name':'Tone','kind':'preference','content':'Concise answers','scope':'bot'},bid)
        shared=await remember({'name':'Shared','kind':'fact','content':'Team launch is Friday','scope':'workspace'},bid)
        peer_note=await remember({'name':'Peer','kind':'fact','content':'Private to peer','scope':'bot'},peer)
        local=await remember({'name':'This chat','kind':'fact','content':'Local only'},bid)
        assert len((await listing({},bid))['notes'])==2
        assert [n['id'] for n in (await listing({'query':'pork'},bid))['notes']]==[pref['note_id']]
        result=await forget({'note_ids':[pref['note_id'],peer_note['note_id'],shared['note_id']]},bid)
        assert result['deleted_count']==1 and result['chat_history_retained']
        assert set(result['absent_from_selected_scope'])=={peer_note['note_id'],shared['note_id']}
        assert (await forget({'note_ids':[pref['note_id']]},bid))['deleted_count']==0
        assert (await listing({},peer))['notes'][0]['id']==peer_note['note_id']
        assert (await listing({'scope':'workspace'},bid))['notes'][0]['id']==shared['note_id']
        async with sessions() as db:
            text=await knowledge_prompt(db,bid)
            assert 'pork' not in text and 'Aisle' not in text and 'Concise answers' in text
            assert 'Local only' in await context.context_prompt(db,cid)
        assert 'error' in await listing({},foreign)
        assert 'error' in await forget({'note_ids':[keep['note_id']]},foreign)
        assert 'error' in await forget({'scope':'conversation','note_ids':[local['note_id']]},peer)
        assert 'error' in await forget({'scope':'bot','note_ids':[]},bid)
        assert (await forget({'scope':'conversation','note_ids':[local['note_id']]},bid))['deleted_count']==1
        assert (await listing({'scope':'conversation'},bid))['notes']==[]
    finally:current_tenant_id.reset(token)
    # A new conversation cannot restore a deleted saved note.
    fresh=(await client.post('/api/conversations',headers=A,json={'title':'After forget','bot_ids':[bid]})).json()['id']
    assert fresh not in {cid,other_cid}
    token=current_tenant_id.set('benchmark-owner')
    try:
        async with sessions() as db:assert 'pork' not in await knowledge_prompt(db,bid)
    finally:current_tenant_id.reset(token)
    records=(await client.get('/api/workspace/knowledge',headers=A)).json()
    assert pref['note_id'] not in {r['id'] for r in records}
    assert {keep['note_id'],peer_note['note_id'],shared['note_id']} <= {r['id'] for r in records}


@pytest.mark.asyncio
async def test_memory_deletion_cannot_cross_tenants_even_with_exact_ids(workspace):
    from app.db.tenancy import current_tenant_id
    client,sessions=workspace
    cid_a=await room(client,'benchmark-owner')
    cid_b=await room(client,'benchmark-other')
    bid_a=(await client.get('/api/bots',headers=A)).json()[0]['id']
    bid_b=(await client.get('/api/bots',headers=B)).json()[0]['id']
    registry=ToolRegistry();await context.register_context_tools(registry,cid_a,sessions)
    token=current_tenant_id.set('benchmark-owner')
    try:
        note=await registry._tools['remember_context']['handler']({'name':'Private','kind':'fact','content':'Owner private preference','scope':'bot'},bid_a)
    finally:current_tenant_id.reset(token)
    other=ToolRegistry();await context.register_context_tools(other,cid_b,sessions)
    token=current_tenant_id.set('benchmark-other')
    try:
        result=await other._tools['forget_context']['handler']({'note_ids':[note['note_id']]},bid_b)
        assert result['deleted_count']==0
        assert 'error' in await other._tools['forget_context']['handler']({'note_ids':[note['note_id']]},bid_a)
    finally:current_tenant_id.reset(token)
    assert any(r['id']==note['note_id'] for r in (await client.get('/api/workspace/knowledge',headers=A)).json())


@pytest.mark.asyncio
async def test_memory_deletion_honors_write_approval_even_though_replay_is_idempotent(workspace):
    from app.db.tenancy import current_tenant_id
    from app.models.task import Task
    from app.services import usage
    client,sessions=workspace
    cid=await room(client,'benchmark-owner')
    bid=(await client.get('/api/bots',headers=A)).json()[0]['id']
    registry=ToolRegistry();await context.register_context_tools(registry,cid,sessions)
    tenant=current_tenant_id.set('benchmark-owner')
    try:note=await registry._tools['remember_context']['handler']({'name':'Preference','kind':'preference','content':'Prefer aisle seats','scope':'bot'},bid)
    finally:current_tenant_id.reset(tenant)
    task_id=(await client.post('/api/conversations/'+cid+'/messages',headers=A,json={'sender_type':'user','content':'Delete my saved seating preference'})).json()['task_id']
    await client.patch('/api/workspace/settings',headers=A,json={'tool_approval':'writes'})
    async with sessions() as db:
        task=await db.get(Task,task_id);task.status='running';await db.commit()
    tenant=current_tenant_id.set('benchmark-owner');active=usage.active.set((task_id,sessions))
    try:
        assert registry.replay_safe('forget_context',{'note_ids':[note['note_id']]})
        execution=asyncio.create_task(registry.execute_tool('forget_context',{'note_ids':[note['note_id']]},bid))
        for _ in range(100):
            pending=(await client.get('/api/computer/approvals/pending',headers=A)).json()
            if pending:break
            await asyncio.sleep(.01)
        assert len(pending)==1 and not execution.done()
        assert any(r['id']==note['note_id'] for r in (await client.get('/api/workspace/knowledge',headers=A)).json())
        assert (await client.post('/api/computer/approvals/'+pending[0]['id'],headers=B,json={'approved':True})).status_code==404
        assert (await client.post('/api/computer/approvals/'+pending[0]['id'],headers=A,json={'approved':True})).status_code==200
        assert (await asyncio.wait_for(execution,4))['deleted_count']==1
        assert not any(r['id']==note['note_id'] for r in (await client.get('/api/workspace/knowledge',headers=A)).json())
    finally:usage.active.reset(active);current_tenant_id.reset(tenant)


def test_plugin_search_keeps_service_and_exact_operation_in_scope():
    manifest=[{'service':'Linear','name':'list_projects','description':'list projects and deployments '*100},
              {'service':'Vercel','name':'search_vercel_documentation','description':'Search docs for projects and deployments'},
              {'service':'Vercel','name':'list_projects','description':'List projects'},
              {'service':'Vercel','name':'get_deployment','description':'Get a deployment'}]
    assert rank_plugin_tools(manifest,'Vercel list_projects')[0]['name']=='list_projects'
    assert all(t['service']=='Vercel' for t in rank_plugin_tools(manifest,'Vercel list_projects'))
    assert rank_plugin_tools(manifest,'get_deployment',service='Vercel')[0]['name']=='get_deployment'
    assert rank_plugin_tools(manifest,'list_projects',service='missing')==[]
    assert rank_plugin_tools(manifest,'list_projects')[0]['name']=='list_projects'


def test_plugin_brand_search_finds_account_variants_and_ranks_read_operations_first():
    manifest=[{'service':'GitHub · Hive','name':'create_branch','description':'Create a branch'},
              {'service':'GitHub · Hive','name':'list_branches','description':'List repository branches'},
              {'service':'GitHub · Atlas','name':'list_branches','description':'List repository branches'},
              {'service':'Supabase','name':'github_repo_shape','description':'GitHub branch repository '*100}]
    result=rank_plugin_tools(manifest,'get_branch',service='GitHub')
    assert result[0]['name']=='list_branches'
    assert {t['service'] for t in result}=={'GitHub · Hive','GitHub · Atlas'}
    assert all(t['service'].startswith('GitHub') for t in rank_plugin_tools(manifest,'GitHub'))
    assert {t['service'] for t in rank_plugin_tools(manifest,'list_branches',service='GitHub · Hive')}=={'GitHub · Hive'}
    assert {t['service'] for t in rank_plugin_tools(manifest,'GitHub Hive list_branches')}=={'GitHub · Hive'}

def test_plugin_account_labels_without_middle_dot_preserve_brand_discovery():
    manifest=[{'service':'Windsor.ai existing accounts','name':'get_connectors','description':'List connected accounts'},
              {'service':'Windsor.ai existing accounts','name':'execute_action','description':'Write to an account'},
              {'service':'Another service','name':'get_connectors','description':'Windsor account connector '*100}]
    result=rank_plugin_tools(manifest,'get_connectors',service='Windsor.ai')
    assert result[0]['name']=='get_connectors'
    assert all(t['service']=='Windsor.ai existing accounts' for t in result)
    assert rank_plugin_tools(manifest,'get_connectors',service='Windsor.ai missing account')==[]

def test_public_brand_connection_does_not_hide_existing_account_variants():
    manifest=[{'service':name,'name':'list_branches'} for name in ('GitHub','GitHub · Hive','GitHub · Atlas','Unrelated')]
    for query,service in [('list_branches','GitHub'),('GitHub list_branches',None)]:
        assert {t['service'] for t in rank_plugin_tools(manifest,query,service)}=={'GitHub','GitHub · Hive','GitHub · Atlas'}
    assert {t['service'] for t in rank_plugin_tools(manifest,'GitHub Hive list_branches')}=={'GitHub · Hive'}


@pytest.mark.asyncio
async def test_existing_plugin_discovery_scopes_by_connection_and_normalizes_vercel_hostname(workspace,monkeypatch):
    from app.db.tenancy import current_tenant_id
    from app.models.plugin import Plugin, PluginAuthorization
    from app.services import plugins
    client,sessions=workspace;cid=await room(client,'benchmark-owner')
    bid=(await client.get('/api/bots',headers=A)).json()[0]['id'];seen=[]
    async def invoke(pid,name,args):seen.append((pid,name,args));return {'success':True}
    monkeypatch.setattr(plugins,'invoke',invoke)
    token=current_tenant_id.set('benchmark-owner')
    try:
        async with sessions() as db:
            schema={'type':'object','properties':{}}
            github=Plugin(name='GitHub · Hive',url='https://github.example.test/mcp',credential=plugins.seal('test-connection-grant'),tools=[{'name':'list_branches','schema':schema,'description':'List repository branches'}])
            vercel=Plugin(name='Vercel',url='https://mcp.vercel.com',credential=plugins.seal('test-connection-grant'),tools=[{'name':'get_deployment','schema':schema,'description':'Get a deployment'}])
            public=Plugin(name='A public docs service',url='https://docs.example.test/mcp',tools=[{'name':'search_docs','schema':schema,'description':'Search docs'}])
            oauth=Plugin(name='Windsor.ai existing accounts',url='https://mcp.windsor.ai/',tools=[{'name':'get_connectors','schema':schema,'description':'Read connected accounts'}])
            db.add_all([public,github,vercel,oauth]);await db.flush()
            db.add(PluginAuthorization(name=oauth.name,url=oauth.url,plugin_id=oauth.id,status='connected',created_at=1.0,payload='encrypted-test-oauth-grant'))
            await db.commit()
            registry=ToolRegistry();await registry.load_plugins(db,SimpleNamespace(tools_enabled=['plugins']))
            search=registry._tools['plugin_search']['handler'];call=registry._tools['plugin_call']['handler']
            inventory=await search({'query':''},bid)
            assert inventory['services'][0]['authenticated'] and inventory['services'][-1]['service']==public.name
            assert next(x for x in inventory['services'] if x['plugin_id']==oauth.id)['authenticated']
            assert inventory['tools']==[]
            result=await search({'query':'get_branch','service':'GitHub'},bid)
            assert result['tools'][0]['plugin_id']==github.id
            result=await search({'query':'list_branches','plugin_id':github.id},bid)
            assert {t['plugin_id'] for t in result['tools']}=={github.id}
            result=await search({'query':'list_branches','plugin_id':github.id,'service':'A stale display label'},bid)
            assert {t['plugin_id'] for t in result['tools']}=={github.id}
            assert (await search({'query':'list_branches','plugin_id':'unknown'},bid))['tools']==[]
            result=await search({'query':'get_connectors','service':'Windsor.ai','plugin_id':oauth.id},bid)
            assert result['tools'][0]['plugin_id']==oauth.id and result['tools'][0]['name']=='get_connectors'
            assert (await call({'plugin_id':vercel.id,'tool_name':'get_deployment','arguments':{'idOrUrl':'https://example.vercel.app/path?x=1'}},bid))['success']
            assert seen[-1][2]['idOrUrl']=='example.vercel.app'
            before=len(seen)
            assert 'error' in await call({'plugin_id':vercel.id,'tool_name':'get_deployment','arguments':{'idOrUrl':'https://user:password@example.vercel.app'}},bid)
            assert len(seen)==before
    finally:current_tenant_id.reset(token)


@pytest.mark.asyncio
async def test_browser_extraction_preserves_full_titles_after_long_menu(monkeypatch):
    from app.services.tools.browser import BrowserTool
    browser=BrowserTool()
    async def save(*a):pass
    monkeypatch.setattr(browser,'_save_state',save)
    monkeypatch.setattr(browser,'_load_state',lambda *a: asyncio.sleep(0,result=None))
    try:
        page=await browser._get_page('extraction-test')
        await page.set_content('<div class="page_inner"><nav>'+''.join(f'<a href="https://example.test/{n}">Menu {n}</a>' for n in range(120))+'</nav><main><article><a href="https://example.test/book" title="The full untruncated book title">The full...</a></article></main></div>')
        result=await browser.extract_content('Get the first book','extraction-test')
        assert result['success']
        assert result['links'][0]['title']=='The full untruncated book title'
        assert result['links'][0]['href']=='https://example.test/book'
        assert len(result['links'])<=100
    finally:await browser.close()


@pytest.mark.asyncio
async def test_browser_controls_disambiguate_identical_labels_without_clicking_twice(monkeypatch):
    from app.services.tools.browser import BrowserTool
    browser=BrowserTool()
    async def save(*a):pass
    monkeypatch.setattr(browser,'_save_state',save)
    monkeypatch.setattr(browser,'_load_state',lambda *a: asyncio.sleep(0,result=None))
    try:
        page=await browser._get_page('controls-test')
        await page.set_content('<button onclick="document.body.dataset.clicked=\'first\'">Book Now</button><button onclick="document.body.dataset.clicked=\'second\'">Book Now</button>')
        result=await browser.click('Book Now','controls-test')
        assert not result['success'] and result['matches']==2
        assert await page.evaluate('document.body.dataset.clicked') is None
        second=result['controls'][1]['selector']
        result=await browser.click(second,'controls-test')
        assert result['success']
        assert await page.evaluate('document.body.dataset.clicked')=='second'
        # A dispatched click failure must not trigger the fallback click.
        class Target:
            async def count(self):return 1
            async def click(self,**kw):raise RuntimeError('post-dispatch failure')
        class BrokenPage:
            def locator(self,*a):return Target()
            def get_by_text(self,*a,**kw):raise AssertionError('Retried dispatched click')
        monkeypatch.setattr(browser,'_get_page',lambda *a: asyncio.sleep(0,result=BrokenPage()))
        result=await browser.click('button','controls-test')
        assert not result['success'] and 'post-dispatch' in result['error']
    finally:await browser.close()


@pytest.mark.asyncio
async def test_navigation_waits_for_render_and_never_calls_blank_202_an_empty_result(monkeypatch):
    from app.services.tools.browser import BrowserTool
    from app.services import plugins
    resolve = plugins.socket.getaddrinfo
    def public_fixture(host, port, *args, **kwargs):
        if host == 'render.example.test':
            return [(plugins.socket.AF_INET, plugins.socket.SOCK_STREAM, 6, '', ('93.184.216.34', port))]
        return resolve(host, port, *args, **kwargs)
    monkeypatch.setattr(plugins.socket, 'getaddrinfo', public_fixture)
    browser=BrowserTool()
    async def save(*a):pass
    monkeypatch.setattr(browser,'_save_state',save)
    monkeypatch.setattr(browser,'_load_state',lambda *a: asyncio.sleep(0,result=None))
    try:
        page=await browser._get_page('render-test')
        async def route(req):
            if req.request.url.endswith('/delayed'):
                await req.fulfill(status=200,content_type='text/html',body='<body><script>setTimeout(()=>{document.body.innerHTML="<h1>Rooms available</h1><button>Choose room</button>"},100)</script></body>')
            elif req.request.url.endswith('/missing'):
                await req.fulfill(status=404,content_type='text/html',body='<h1>Not found</h1>')
            else:await req.fulfill(status=202,content_type='text/html',body='<body></body>')
        await page.route('https://render.example.test/**',route)
        result=await browser.navigate_to('https://render.example.test/delayed','render-test')
        assert result['success'] and 'Rooms available' in result['text_content']
        assert result['controls'][0]['label']=='Choose room'
        result=await browser.navigate_to('https://render.example.test/blank','render-test')
        assert not result['success'] and result['render_pending'] and result['status']==202
        result=await browser.navigate_to('https://render.example.test/missing','render-test')
        assert not result['success'] and result['status']==404 and 'not found' in result['error']
    finally:await browser.close()


@pytest.mark.asyncio
async def test_result_cards_and_booking_controls_survive_long_filter_sidebar(monkeypatch):
    from app.services.tools.browser import BrowserTool
    browser=BrowserTool()
    async def save(*a):pass
    monkeypatch.setattr(browser,'_save_state',save)
    monkeypatch.setattr(browser,'_load_state',lambda *a: asyncio.sleep(0,result=None))
    try:
        page=await browser._get_page('cards-test')
        filters=''.join(f'<label>Filter {i}<input type="checkbox" name="filter{i}" '+('checked' if i==0 else '')+'></label>' for i in range(150))
        cards=''.join(f'<div data-testid="result-card"><h3>Hotel {i}</h3><p>${180+i} including fees; free cancellation</p><button>Choose room {i}</button></div>' for i in range(25))
        await page.set_content('<nav><a href="https://example.test">Menu</a></nav><main><div>'+filters+'</div>'+cards+'</main>')
        result=await browser.extract_content('Compare available hotel options','cards-test')
        assert result['success']
        assert len(result['content_sections'])==20
        assert result['content_sections'][0]['heading']=='Hotel 0'
        assert '$180 including fees; free cancellation' in result['content_sections'][0]['text']
        assert result['controls'][0]['label']=='Choose room 0'
        assert sum(c['label'].startswith('Choose room') for c in result['controls'])==25
        fields=await browser.extract_content('Show filter fields','cards-test')
        assert fields['controls'][0]['name']=='filter0'
        assert fields['controls'][0]['label']=='Filter 0' and fields['controls'][0]['checked'] is True
        assert fields['controls'][1]['label']=='Filter 1' and fields['controls'][1]['checked'] is False
        assert fields['forms'][0]['label']=='Filter 0' and fields['forms'][0]['checked'] is True
        await browser.click(fields['controls'][1]['selector'],'cards-test')
        checked=await browser.extract_content('Show filter fields','cards-test')
        assert checked['controls'][1]['checked'] is True
        assert len(fields['controls'])<=100
    finally:await browser.close()


def test_auto_routes_booking_workflows_to_planning_without_hijacking_writing_or_manual_models():
    from app.services.model_profiles import task_specialty
    assert task_specialty('Book me a hotel in Chicago for Friday, under $250 with free cancellation')=='planning'
    assert task_specialty('Reserve a table for four at the restaurant')=='planning'
    assert task_specialty('Check me in for my flight')=='planning'
    assert task_specialty('Write a book about hotel reservations')=='writing'
    assert task_specialty('What does a hotel reservation mean?')=='general'


@pytest.mark.asyncio
async def test_agent_native_dropdown_selection_uses_observed_values_and_fires_change_without_submission(monkeypatch):
    from app.services.tools import registry as registry_module
    from app.services.tools.browser import BrowserTool
    browser=BrowserTool()
    async def save(*a):pass
    monkeypatch.setattr(browser,'_save_state',save)
    monkeypatch.setattr(browser,'_load_state',lambda *a: asyncio.sleep(0,result=None))
    monkeypatch.setattr(registry_module,'_browser_tool',browser)
    try:
        page=await browser._get_page('dropdown-test')
        await page.set_content('<form onsubmit="document.body.dataset.submitted=\'yes\';return false"><label>Rooms<select id="rooms" onchange="document.body.dataset.rooms=this.value"><option value="0">No rooms</option><option value="1">One room, $438</option><option disabled value="2">Two rooms</option><option value="3">Duplicate</option><option value="4">Duplicate</option></select></label><button>Reserve</button></form>')
        tools=ToolRegistry();tools.register_default_tools()
        controls=(await browser.extract_content('Show form fields','dropdown-test'))['controls']
        field=next(c for c in controls if c['tag']=='select')
        assert field['label'].startswith('Rooms') and field['options'][1]['value']=='1'
        assert not field['options_truncated']
        handler=tools._tools['browser_type']['handler']
        result=await handler({'selector':field['selector'],'text':'One room, $438'},'dropdown-test')
        assert result['success'] and result['selected_options']==['One room, $438']
        assert await page.evaluate('document.body.dataset.rooms')=='1'
        for text in ['Two rooms','Duplicate','invented']:
            assert not (await handler({'selector':field['selector'],'text':text},'dropdown-test'))['success']
        assert await page.locator('#rooms').input_value()=='1'
        assert await page.evaluate('document.body.dataset.submitted') is None
    finally:await browser.close()


@pytest.mark.asyncio
async def test_agent_screenshot_tool_can_capture_totals_below_viewport(monkeypatch):
    from app.services.tools import registry as registry_module
    from app.services.tools.browser import BrowserTool
    browser=BrowserTool()
    async def save(*a):pass
    monkeypatch.setattr(browser,'_save_state',save)
    monkeypatch.setattr(browser,'_load_state',lambda *a: asyncio.sleep(0,result=None))
    monkeypatch.setattr(registry_module,'_browser_tool',browser)
    try:
        page=await browser._get_page('screenshot-test')
        await page.set_content('<body style="margin:0;height:1200px"><h1>Checkout review</h1><p style="position:absolute;top:1000px">Total: $43.18</p></body>')
        tools=ToolRegistry();tools.register_default_tools()
        capture=tools._tools['browser_screenshot']['handler']
        result=await capture({},'screenshot-test')
        png=base64.b64decode(result['screenshot_base64'])
        assert result['success'] and result['full_page']
        assert int.from_bytes(png[20:24],'big')==1200
        result=await capture({'full_page':False},'screenshot-test')
        assert int.from_bytes(base64.b64decode(result['screenshot_base64'])[20:24],'big')==720
        result=await capture({'full_page':True},'screenshot-test')
        assert result['full_page']
    finally:await browser.close()


def test_explicit_word_budgets_count_visible_prose_and_follow_owner_steering():
    assert word_limit('Keep it under 180 words.')==179
    assert word_limit('At most 20 words')==20
    assert word_limit('Please analyze this') is None
    assert word_count('See [official Python sources](https://example.test/a-long-link).')==4
    assert steer_limit(179,'Make it longer and more detailed') is None
    assert steer_limit(179,'Use at most 40 words instead')==40
    assert steer_limit(179,'Also include the date')==179


@pytest.mark.asyncio
@pytest.mark.parametrize('requests_extra_tool',[False,True])
async def test_last_action_has_bounded_response_turn_without_extending_tool_budget(workspace,monkeypatch,requests_extra_tool):
    client,sessions=workspace;cid=await room(client,'benchmark-owner');calls=[];actions=[]
    bid=(await client.get('/api/bots',headers=A)).json()[0]['id']
    await client.put('/api/bots/'+bid,headers=A,json={'tools_enabled':['browser']})
    async def execute(self,name,args,bot_id):
        actions.append(name);return {'success':True,'verified_total':'$43.18','remaining':'Do not press Finish'}
    monkeypatch.setattr(ToolRegistry,'execute_tool',execute)
    async def complete(**kw):
        calls.append(kw)
        if len(calls)==1 or requests_extra_tool:
            if len(calls)>1:
                assert not kw.get('tools')
                assert 'execution budget is exhausted' in kw['messages'][-1]['content']
            message={'role':'assistant','tool_calls':[{'id':'read'+str(len(calls)),'type':'function','function':{'name':'browser_extract','arguments':'{"instruction":"Read checkout"}'}}]}
        else:
            assert not kw.get('tools')
            assert 'State precisely what remains incomplete' in kw['messages'][-1]['content']
            assert any('$43.18' in str(m.get('content')) for m in kw['messages'] if m['role']=='tool')
            message={'role':'assistant','content':'Verified total: $43.18. Finish was not pressed.'}
        return ModelResponse(choices=[{'message':message}])
    monkeypatch.setattr(orchestrator.LLMGateway,'complete',complete)
    await client.post('/api/conversations/'+cid+'/messages',headers=A,json={'sender_type':'user','content':'Verify the checkout total and stop before Finish.','options':{'max_iterations':1}})
    runner=asyncio.create_task(worker.run_worker())
    try:
        for _ in range(200):
            jobs=(await client.get('/api/conversations/'+cid+'/tasks',headers=A)).json()
            if jobs[0]['status'] in {'completed','failed'}:break
            await asyncio.sleep(.02)
        assert jobs[0]['status']==('failed' if requests_extra_tool else 'completed')
        assert len(calls)==2 and actions==['browser_extract']
        messages=(await client.get('/api/conversations/'+cid+'/messages',headers=A)).json()
        assert any(m['sender_type']=='bot' and m['message_type']=='text' and '$43.18' in m['content'] for m in messages)==(not requests_extra_tool)
    finally:
        runner.cancel()
        with suppress(asyncio.CancelledError):await runner


@pytest.mark.asyncio
@pytest.mark.parametrize('always_long,iterations,expected',[(False,4,'completed'),(True,4,'failed'),(True,1,'failed')])
async def test_word_limit_revisions_are_bounded_and_only_publish_checked_reply(workspace,monkeypatch,always_long,iterations,expected):
    client,sessions=workspace;cid=await room(client,'benchmark-owner');calls=[]
    async def complete(**kw):
        calls.append(kw)
        if len(calls)>1:
            assert not kw.get('tools')
            assert 'Final-answer format check' in kw['messages'][-1]['content']
        text='one two three four five six seven eight nine ten eleven twelve' if always_long or len(calls)==1 else 'Verified [source](https://example.test/verified).'
        return ModelResponse(choices=[{'message':{'role':'assistant','content':text}}])
    monkeypatch.setattr(orchestrator.LLMGateway,'complete',complete)
    await client.post('/api/conversations/'+cid+'/messages',headers=A,json={'sender_type':'user','content':'Answer in at most 10 words.','options':{'max_iterations':iterations}})
    runner=asyncio.create_task(worker.run_worker())
    try:
        for _ in range(200):
            jobs=(await client.get('/api/conversations/'+cid+'/tasks',headers=A)).json()
            if jobs[0]['status'] in {'completed','failed'}:break
            await asyncio.sleep(.02)
        assert jobs[0]['status']==expected
        assert len(calls)<=(3 if iterations>1 else 1)
        messages=(await client.get('/api/conversations/'+cid+'/messages',headers=A)).json()
        assert not any('eleven twelve' in m['content'] for m in messages)
        if expected=='completed':assert any('https://example.test/verified' in m['content'] for m in messages)
    finally:
        runner.cancel()
        with suppress(asyncio.CancelledError):await runner
