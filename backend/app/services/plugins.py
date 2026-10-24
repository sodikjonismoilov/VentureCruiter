"""Remote MCP connections, with encrypted credentials and public HTTPS endpoints."""
import asyncio
import base64
import hashlib
import json
import ipaddress
import socket
from contextlib import asynccontextmanager
from datetime import timedelta
from urllib.parse import urlsplit
import httpx
from cryptography.fernet import Fernet, InvalidToken
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from app.config import settings

def is_read_only(url, tool):
    if tool.get('read_only'): return True
    # Reviewed public documentation operations also predate annotation support.
    known = {
        'mcp.deepwiki.com': {'read_wiki_structure', 'read_wiki_contents', 'ask_question'},
        'learn.microsoft.com': {'microsoft_docs_search', 'microsoft_docs_fetch', 'microsoft_code_sample_search'},
        'docs.mcp.cloudflare.com': {'search_cloudflare_documentation', 'get_cloudflare_documentation'},
    }
    return tool.get('name') in known.get(urlsplit(url).hostname, set())


def transient_failure(error):
    children = getattr(error, 'exceptions', None)
    if children: return all(transient_failure(item) for item in children)
    status = getattr(error, 'status_code', None)
    if status is None: status = getattr(getattr(error, 'response', None), 'status_code', None)
    return status in {408, 429, 500, 502, 503, 504} or isinstance(error, (TimeoutError, httpx.TransportError))


def authentication_failure(error):
    from app.services.plugin_auth import SignInRequired
    if isinstance(error, (SignInRequired, InvalidToken)): return True
    if type(error).__name__ in {'UserAuthorizationRequiredError','InvalidGrantError','NoValidTokenError','AuthorizationExpiredError'}:return True
    if getattr(getattr(error, 'response', None), 'status_code', None) in {401,403}: return True
    return any(authentication_failure(child) for child in getattr(error, 'exceptions', []))


def tool_result(result, name):
    parts = []
    attachments = []
    for item in result.content:
        if item.type == 'text': parts.append(item.text)
        elif item.type == 'resource' and hasattr(item.resource, 'text'): parts.append(item.resource.text)
        elif item.type in {'image','audio'} and len(attachments)<3:
            formats={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','audio/mpeg':'mp3','audio/wav':'wav','audio/ogg':'ogg'}
            mime=getattr(item,'mimeType','')
            try:
                if mime in formats and len(item.data)<4*1024*1024 and len(base64.b64decode(item.data,validate=True))<=3*1024*1024:
                    attachments.append({'name':f'plugin-output-{len(attachments)+1}.{formats[mime]}','mime':mime,'data':item.data})
            except (ValueError,TypeError):pass
    structured = getattr(result, 'structuredContent', None)
    if structured is not None and not parts: parts.append(json.dumps(structured, default=str))
    output = {'success': not result.isError, 'content': '\n'.join(parts)[:20000], 'plugin': name}
    if result.isError and output['content'].lstrip().lower().startswith('output validation error:'):
        output['code']='invalid_provider_output'
    if structured is not None:
        encoded = json.dumps(structured, default=str)
        if len(encoded) <= 20000: output['structured_content'] = structured
        else: output['structured_content_truncated'] = True
    other_types = sorted({item.type for item in result.content if item.type not in ('text', 'resource')})
    if other_types: output['content_types'] = other_types
    if attachments: output['_attachments'] = attachments
    if not output['content']: output['content'] = 'The plugin returned '+(', '.join(other_types)+' content.' if other_types else 'an empty result.')
    return output

async def validate_endpoint(url):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.port not in (None, 443):
        raise ValueError('Use a public HTTPS MCP URL without a token or query string. Put a bearer token in the token field.')
    addresses = await asyncio.to_thread(socket.getaddrinfo, parsed.hostname, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError('Plugins must use a public server address.')


async def validate_public_web_url(url):
    """Reject private-network destinations before cloud browser requests."""
    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
        port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    except (TypeError, ValueError):
        raise ValueError('Use a valid public HTTP or HTTPS website URL.')
    if parsed.scheme not in {'http', 'https'} or not hostname or parsed.username or parsed.password:
        raise ValueError('Cloud browsing is limited to public HTTP or HTTPS websites.')
    try:
        addresses = await asyncio.wait_for(
            asyncio.to_thread(socket.getaddrinfo, hostname, port, type=socket.SOCK_STREAM),
            timeout=5,
        )
    except (OSError, asyncio.TimeoutError):
        raise ValueError('This website could not be resolved as a public address.')
    if not addresses or any(not ipaddress.ip_address(address[4][0].split('%', 1)[0]).is_global for address in addresses):
        raise ValueError('Cloud browsing is limited to public network addresses.')

def cipher():
    secret = settings.BACKEND_API_TOKEN or settings.SECRET_KEY
    if not secret or secret == "local-only-change-before-exposure" or len(secret) < 32:
        raise ValueError("Configure a random BACKEND_API_TOKEN or SECRET_KEY of at least 32 characters before storing MCP credentials.")
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest()))

def seal(token): return cipher().encrypt(token.encode()).decode() if token else None

def reveal(token): return cipher().decrypt(token.encode()).decode() if token else None

def is_google_workspace(plugin):
    # One damaged or outdated saved credential must not prevent discovery of
    # every other connection. Invocation still authenticates and fails closed.
    try:
        return reveal(plugin.credential) == 'grokbot-google-workspace'
    except (InvalidToken, ValueError):
        return False

def http_client(headers=None, timeout=None, auth=None):
    async def guard(request):
        parsed = urlsplit(str(request.url))
        await validate_endpoint(parsed._replace(query='',fragment='').geturl())
    return httpx.AsyncClient(headers=headers, timeout=timeout or 20, auth=auth, follow_redirects=False, event_hooks={'request':[guard]})

def credential_headers(token):
    if not token: return {}
    if token.startswith('{'):
        headers=json.loads(token)
        if not isinstance(headers,dict) or len(headers)!=1:raise ValueError('Invalid saved credential.')
        import re
        if any(not re.fullmatch(r'[A-Za-z][A-Za-z0-9-]{0,63}',name) or name.lower() in {'host','cookie','content-length','transfer-encoding','connection','proxy-authorization'} or not isinstance(value,str) or '\r' in value or '\n' in value for name,value in headers.items()):
            raise ValueError('Invalid authentication header.')
        return headers
    return {'Authorization':'Bearer '+token}

@asynccontextmanager
async def session(url, token=None, auth=None):
    await validate_endpoint(url)
    headers = credential_headers(token)
    async with streamablehttp_client(url, headers=headers, timeout=15, sse_read_timeout=25, httpx_client_factory=http_client, auth=auth) as streams:
        async with ClientSession(streams[0], streams[1], read_timeout_seconds=timedelta(seconds=60)) as client:
            await client.initialize()
            yield client

async def discover(url, token=None, auth=None):
    # Initialization and tools/list are read-only. A transient network failure
    # should not turn a working saved connection into an unavailable catalog
    # entry; never retry provider sign-in or permanent protocol errors.
    for attempt in range(2):
        try:
            return await _discover_once(url,token,auth)
        except Exception as error:
            if attempt or authentication_failure(error) or not transient_failure(error):raise
            await asyncio.sleep(1)


async def _discover_once(url, token=None, auth=None):
    async with asyncio.timeout(25):
        async with session(url, token, auth) as client:
            tools = []
            cursor = None
            seen = set()
            while True:
                result = await client.list_tools(cursor=cursor)
                tools.extend({'name': t.name, 'description': (t.description or '')[:2000], 'schema': t.inputSchema, 'read_only': is_read_only(url, {'name':t.name, 'read_only':bool(getattr(t, 'annotations', None) and t.annotations.readOnlyHint)})} for t in result.tools)
                cursor = result.nextCursor
                if not cursor:
                    return tools
                if cursor in seen or len(tools)>5000:
                    raise ValueError('The server returned an invalid or excessive tool catalog.')
                seen.add(cursor)


async def invoke(plugin_id, tool_name, arguments):
    from app.db.session import AsyncSessionLocal
    from app.models.plugin import Plugin
    async with AsyncSessionLocal() as db:
        plugin = await db.get(Plugin, plugin_id)
        if not plugin or not plugin.enabled or tool_name not in {t['name'] for t in plugin.tools if t.get('enabled',True)}:
            return {'success':False, 'error': 'Plugin or tool is disabled.', 'code':'disabled'}
        tool = next(t for t in plugin.tools if t['name'] == tool_name)
        from app.services import google_workspace
        if is_google_workspace(plugin):
            try:return await google_workspace.invoke(db,tool_name,arguments)
            except Exception as error:return {'success':False,'error':str(getattr(error,'detail','Google did not complete this operation.')),'code':'google_unavailable'}
        from jsonschema import Draft202012Validator, ValidationError, SchemaError
        try:
            Draft202012Validator(tool['schema']).validate(arguments)
        except (ValidationError, SchemaError):
            return {'success':False, 'error':'Arguments do not match this plugin tool. Search its current schema and correct the parameters.', 'code':'invalid_arguments'}
        async with asyncio.timeout(90):
            for attempt in range(3 if is_read_only(plugin.url, tool) else 1):
                try:
                    token,auth=await connection_auth(db,plugin)
                    async with session(plugin.url, token, auth) as client:
                        result = await client.call_tool(tool_name, arguments)
                        return tool_result(result, plugin.name)
                except Exception as error:
                    if attempt < 2 and is_read_only(plugin.url, tool) and transient_failure(error):
                        await asyncio.sleep(2 ** attempt)
                        continue
                    # Do not leak raw transport/OAuth responses into agent context.
                    if authentication_failure(error):
                        return {'success':False, 'error':'This plugin needs sign-in again. Reconnect it in Plugins.', 'code':'sign_in_required'}
                    return {'success':False, 'error':'The plugin call failed. Check its connection and service permissions; no successful result was returned.', 'code':'unavailable'}


async def connection_auth(db,plugin):
    from app.services import managed_connections
    managed,token=await managed_connections.credentials(plugin)
    if managed:return token,None
    from app.services.plugin_auth import provider_for_plugin
    return token,await provider_for_plugin(db,plugin.id)
