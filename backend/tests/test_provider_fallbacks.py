import json
from contextlib import asynccontextmanager
from types import SimpleNamespace

import httpx
import pytest
from mcp.types import CallToolResult, TextContent

from app.db.tenancy import current_tenant_id
from app.models.plugin import Plugin
from app.services import plugins, provider_fallbacks
from .test_workspace_workflows import workspace


def page(offers=None):
    data = {'@type':'Product', 'name':'Jobherder job search', 'offers': offers if offers is not None else [
        {'@type':'Offer', 'name':'One search', 'price':'9.99', 'priceCurrency':'EUR'}]}
    return '<html><script>throw new Error("never execute page scripts")</script><script type="application/ld+json">'+json.dumps(data)+'</script></html>'


@pytest.mark.parametrize('offers', [[], [{'@type':'Offer', 'name':'bad', 'price':'NaN', 'priceCurrency':'EUR'}],
                                  [{'@type':'Offer', 'name':'bad', 'price':'-1', 'priceCurrency':'EUR'}],
                                  [{'@type':'Offer', 'name':'bad', 'price':'10', 'priceCurrency':'javascript:'}]])
def test_website_pricing_never_invents_missing_or_invalid_offers(offers):
    with pytest.raises(ValueError, match='usable offers'):
        provider_fallbacks.public_offers(page(offers))


@pytest.mark.asyncio
async def test_website_fallback_fetches_only_public_source_without_saved_credentials(monkeypatch):
    calls = []
    def respond(request):
        calls.append(request)
        assert str(request.url) == provider_fallbacks.JOBHERDER_PRICING_URL
        assert request.method == 'GET'
        assert 'authorization' not in request.headers and 'cookie' not in request.headers
        return httpx.Response(200, headers={'content-type':'text/html'}, text=page())
    monkeypatch.setattr(provider_fallbacks, 'http_client', lambda **kwargs: httpx.AsyncClient(transport=httpx.MockTransport(respond)))
    result = await provider_fallbacks.jobherder_website_pricing('Jobherder')
    assert len(calls) == 1 and result['success']
    assert result['verification_mode'] == 'public_website_fallback'
    assert result['provider_warning']['code'] == 'invalid_provider_output'
    assert result['structured_content']['offers'] == [{'name':'One search', 'price':'9.99', 'currency':'EUR'}]
    assert result['source_url'] == provider_fallbacks.JOBHERDER_PRICING_URL


@pytest.mark.asyncio
@pytest.mark.parametrize('status,body,headers', [(302,'',{'location':'https://other.example'}),
                                               (200,'not offers',{'content-type':'text/html'}),
                                               (200,page(),{'content-type':'application/json'})])
async def test_website_fallback_fails_closed_on_redirects_or_unusable_content(monkeypatch,status,body,headers):
    monkeypatch.setattr(provider_fallbacks, 'http_client', lambda **kwargs: httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(status, headers=headers, text=body))))
    with pytest.raises((ValueError,httpx.HTTPStatusError)):
        await provider_fallbacks.jobherder_website_pricing('Jobherder')


@pytest.mark.asyncio
@pytest.mark.parametrize('tool_name', ['get_pricing', 'register_agent'])
async def test_jobherder_mcp_fallback_is_scoped_to_read_only_pricing(workspace,monkeypatch,tool_name):
    from app.db import session as database
    _, sessions = workspace
    monkeypatch.setattr(database, 'AsyncSessionLocal', sessions)
    invoked, fetched = [], []
    async def auth(*args): return 'saved-private-token', None
    monkeypatch.setattr(plugins, 'connection_auth', auth)
    @asynccontextmanager
    async def mcp_session(*args):
        async def call(name,arguments):
            invoked.append(name)
            return CallToolResult(isError=True,content=[TextContent(type='text',text='Output validation error: Invalid structured content for tool get_pricing: x402.prices: Invalid input')])
        yield SimpleNamespace(call_tool=call)
    monkeypatch.setattr(plugins, 'session', mcp_session)
    def website(request):
        fetched.append(request)
        assert 'authorization' not in request.headers
        return httpx.Response(200,headers={'content-type':'text/html'},text=page())
    monkeypatch.setattr(provider_fallbacks, 'http_client', lambda **kwargs: httpx.AsyncClient(transport=httpx.MockTransport(website)))
    owner=current_tenant_id.set('provider-fallback-owner')
    try:
        async with sessions() as db:
            row=Plugin(name='Jobherder',url='https://jobherder.com/mcp',enabled=True,tools=[{
                'name':tool_name,'description':'Test operation','schema':{'type':'object','properties':{}}}])
            db.add(row);await db.commit()
            result=await plugins.invoke(row.id,tool_name,{})
        assert invoked == [tool_name]
        assert bool(fetched) == (tool_name == 'get_pricing')
        assert result['success'] == (tool_name == 'get_pricing')
        assert 'saved-private-token' not in json.dumps(result)
    finally:
        current_tenant_id.reset(owner)


def test_nested_provider_status_does_not_include_response_body():
    response=httpx.Response(503,request=httpx.Request('POST','https://provider.example/mcp'),text='private diagnostic')
    error=ExceptionGroup('transport',[httpx.HTTPStatusError('private diagnostic',request=response.request,response=response)])
    assert plugins.provider_status(error) == 503
    assert plugins.provider_status(ValueError('unrelated')) is None


@pytest.mark.asyncio
async def test_arc_paused_deployment_returns_retryable_outage_without_changing_saved_url(workspace,monkeypatch):
    from app.db import session as database
    _, sessions = workspace
    monkeypatch.setattr(database, 'AsyncSessionLocal', sessions)
    async def auth(*args): return None, None
    monkeypatch.setattr(plugins, 'connection_auth', auth)
    calls=[]
    @asynccontextmanager
    async def paused(*args):
        calls.append(args[0])
        request=httpx.Request('POST',args[0])
        response=httpx.Response(503,request=request,text='private diagnostic DEPLOYMENT_PAUSED')
        raise ExceptionGroup('transport',[httpx.HTTPStatusError('private diagnostic',request=request,response=response)])
        yield
    async def no_delay(*args): pass
    monkeypatch.setattr(plugins,'session',paused)
    monkeypatch.setattr(plugins.asyncio,'sleep',no_delay)
    owner=current_tenant_id.set('arc-provider-owner')
    try:
        async with sessions() as db:
            row=Plugin(name='ARC',url='https://www.arcreport.ai/api/ask',enabled=True,tools=[{
                'name':'dataset_info','description':'Read saved data metadata','schema':{'type':'object'},'read_only':True}])
            db.add(row);await db.commit()
            result=await plugins.invoke(row.id,'dataset_info',{})
            assert result['success'] is False and result['code']=='provider_unavailable'
            assert result['provider_status']==503 and result['retryable'] is True
            assert 'private diagnostic' not in json.dumps(result)
            assert len(calls)==3
            await db.refresh(row)
            assert row.url=='https://www.arcreport.ai/api/ask' and row.enabled
    finally:
        current_tenant_id.reset(owner)
