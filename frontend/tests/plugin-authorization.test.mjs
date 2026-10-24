import {test} from 'node:test';
import assert from 'node:assert/strict';
import {environment,renderer,load,storage,deferred,find,textOf,button} from './support/component-harness.mjs';
const auth=load('../src/lib/pluginAuthorization.ts',{}, {URL,Date});
const id='e52dad3f-b0db-4cf8-a0f0-f9b88c16f230';
const item={id:'fixture',name:'Fixture Service',url:'https://provider.example/mcp',domains:['provider.example'],description:'Synthetic service',category:'Testing'};
const pending={id,name:item.name,url:'https://provider.example/allow?state=synthetic',startedAt:0};
function panel({saved={},popupBlocked=false,api:overrides={},embedded=false}={}){
  const session=storage(saved),env=environment(session),view=renderer(env);let opens=0,closed=0;
  const popup={closed:false,opener:{},document:{title:'',createElement:()=>({style:{}}),body:{appendChild(){}}},location:{replace(){}},focus(){},close(){this.closed=true;closed++;}};
  env.document.createElement=()=>({style:{}});
  env.window.open=()=>{opens++;return popupBlocked?null:popup;};
  env.window.location={hostname:'cypher-agent.vercel.app',href:'https://app.example/?workspace=1&conversation=fixture',search:'?workspace=1&conversation=fixture',assign(){throw Error('Must preserve the workspace');}};
  env.window.history={state:null,replaceState(){}};
  const api={getPluginCatalog:async()=>[item],getPlugins:async()=>[],deviceStatus:async()=>({enrolled:false}),getAvailableConnections:async()=>[],pluginSyncStatus:async()=>null,accountStatus:async()=>({}),authorizePlugin:async()=>({status:'awaiting_login',flow_id:id,authorization_url:pending.url,name:item.name}),pluginAuthStatus:async()=>({status:'awaiting_login',name:item.name}),cancelPluginAuth:async()=>({status:'cancelled'}),...overrides};
  const scopedAuth=load('../src/lib/pluginAuthorization.ts',{}, {URL,Date:env.globals.Date});
  const {PluginPanel}=load('../src/components/PluginPanel.tsx',{react:view.react,'./LoadingState':{LoadingState:'loading-state'},'../lib/api':{api},'../lib/canonical-app':load('../src/lib/canonical-app.ts',{}, {URL}),'../lib/device':{approveConnection:async()=>undefined,enrollDevice:async()=>{}},'../lib/pluginAuthorization':scopedAuth,'./McpDirectory':{McpDirectory:'mcp-directory'},'./cipher/CypherMark':{__esModule:true,default:'cypher-mark'},'./cipher/BinaryLens':{__esModule:true,default:'binary-lens'}},{...env.globals,URL,URLSearchParams,React:view.react.default,fetch:async()=>({json:async()=>({})})});
  view.mount(()=>PluginPanel({onClose(){},embedded}));
  return {env,view,api,session,popup,get opens(){return opens;},get closed(){return closed;}};
}
async function connect(p){await p.view.flush();button(p.view.tree,'Connect').props.onClick();await p.view.flush();await p.view.flush();}

test('embedded app management opens the saved connection without reauthorizing or claiming a tool test',async()=>{
  let authorizations=0;
  const p=panel({embedded:true,api:{getPlugins:async()=>[{id:'linked-account',name:item.name,url:item.url,enabled:true,authenticated:true,tools:[{name:'read_source',description:'Read a source',enabled:true}]}],authorizePlugin:async()=>{authorizations++;throw Error('Management must not start authorization');}}});
  await p.view.flush();
  assert.equal(p.view.tree.type,'section');
  assert.match(textOf(p.view.tree),/Not tested/);
  find(p.view.tree,n=>n.type==='button'&&n.props?.['aria-label']==='Manage Fixture Service').props.onClick();
  await p.view.flush();
  assert.equal(authorizations,0);
  assert.equal(p.opens,0);
  assert.match(textOf(p.view.tree),/Account or API access linked/);
  assert.match(textOf(p.view.tree),/Execution not tested/);
  assert.ok(find(p.view.tree,n=>n.type==='button'&&n.props?.['aria-label']==='Enable Fixture Service'));
  p.view.unmount();
});

test('blocked popup leaves a working provider link and the conversation in place',async()=>{
  const p=panel({popupBlocked:true});await connect(p);
  const link=find(p.view.tree,n=>n.type==='a'&&textOf(n)==='Continue to Fixture Service');
  assert.equal(link.props.href,pending.url);assert.equal(link.props.target,'_blank');
  assert.equal(p.opens,1);assert.ok(p.session.getItem(auth.PLUGIN_SIGN_IN_KEY));
  assert.match(textOf(p.view.tree),/Review the permissions and choose Allow or Authorize/);
  assert.ok(button(p.view.tree,'Check connection'));p.view.unmount();
});
test('Lovable opens its official MCP OAuth flow and waits for verified tools after Allow',async()=>{
  let request,status='awaiting_login';
  const p=panel({api:{authorizePlugin:async input=>{request=input;return {status:'awaiting_login',flow_id:id,authorization_url:'https://lovable.example/authorize?state=synthetic',name:'Lovable'};},pluginAuthStatus:async()=>({status,name:'Lovable'})}});
  await p.view.flush();find(p.view.tree,n=>n.type==='button'&&n.props?.['aria-label']==='Connect Lovable').props.onClick();await p.view.flush();await p.view.flush();
  assert.equal(request.url,'https://mcp.lovable.dev');assert.equal(request.name,'Lovable');
  assert.match(textOf(p.view.tree),/review the permissions Lovable lists and press Allow/i);
  assert.match(textOf(p.view.tree),/only (?:the )?tools Lovable authorizes/i);
  assert.ok(find(p.view.tree,n=>n.type==='a'&&textOf(n)==='Continue to Lovable'));
  assert.ok(p.session.getItem(auth.PLUGIN_SIGN_IN_KEY));
  status='connected';p.env.time.advance(4000);await p.view.flush();
  assert.match(textOf(p.view.tree),/Lovable connected/);assert.equal(p.session.getItem(auth.PLUGIN_SIGN_IN_KEY),null);p.view.unmount();
});
test('a closed provider window can be reopened through the real link',async()=>{
  const p=panel();await connect(p);p.popup.closed=true;let prevented=false;
  find(p.view.tree,n=>n.type==='a'&&textOf(n)==='Continue to Fixture Service').props.onClick({preventDefault(){prevented=true;}});
  assert.equal(prevented,false,'browser follows the link when the old window is closed');p.view.unmount();
});
test('transient status errors preserve sign-in and retry without a second authorization',async()=>{
  let polls=0,starts=0;
  const p=panel({api:{authorizePlugin:async()=>{starts++;return {status:'awaiting_login',flow_id:id,authorization_url:pending.url,name:item.name};},pluginAuthStatus:async()=>{if(++polls===1)throw Error('Synthetic offline');return {status:'connected',name:item.name};}}});
  await connect(p);assert.match(textOf(p.view.tree),/retry automatically/);assert.ok(p.session.getItem(auth.PLUGIN_SIGN_IN_KEY));
  p.env.time.advance(4000);await p.view.flush();assert.match(textOf(p.view.tree),/Fixture Service connected/);assert.equal(starts,1);assert.equal(p.session.getItem(auth.PLUGIN_SIGN_IN_KEY),null);p.view.unmount();
});
test('closing and reopening Plugins resumes a pending sign-in without closing its window',async()=>{
  const p=panel();await connect(p);const saved=p.session.getItem(auth.PLUGIN_SIGN_IN_KEY);p.view.unmount();assert.equal(p.closed,0);
  const resumed=panel({saved:{[auth.PLUGIN_SIGN_IN_KEY]:saved}});await resumed.view.flush();assert.equal(resumed.opens,0);assert.ok(button(resumed.view.tree,'Cancel sign-in'));resumed.view.unmount();
});
test('focus checks coalesce with an in-flight status request and recover after returning',async()=>{
  const wait=deferred();let polls=0;
  const p=panel({saved:{[auth.PLUGIN_SIGN_IN_KEY]:JSON.stringify(pending)},api:{pluginAuthStatus:()=>{polls++;return wait.promise;}}});
  await p.view.flush();p.env.window.dispatchEvent(new Event('focus'));p.env.window.dispatchEvent(new Event('online'));await p.view.flush();assert.equal(polls,1);
  wait.resolve({status:'connected',name:item.name});await p.view.flush();assert.match(textOf(p.view.tree),/Fixture Service connected/);p.view.unmount();assert.equal(p.env.time.pending,0);
});
test('rapid Connect clicks start only one approval and authorization',async()=>{
  const wait=deferred();let starts=0;const p=panel({api:{authorizePlugin:()=>{starts++;return wait.promise;}}});await p.view.flush();const connect=button(p.view.tree,'Connect');connect.props.onClick();connect.props.onClick();await p.view.flush();assert.equal(starts,1);
  wait.resolve({status:'connected',name:item.name});await p.view.flush();p.view.unmount();
});
test('failed cancellation keeps a resumable flow; successful cancellation clears it',async()=>{
  let calls=0;const p=panel({api:{cancelPluginAuth:async()=>{if(++calls===1)throw Error('Synthetic offline');return {status:'cancelled'};}}});await connect(p);
  button(p.view.tree,'Cancel sign-in').props.onClick();await p.view.flush();assert.ok(p.session.getItem(auth.PLUGIN_SIGN_IN_KEY));
  button(p.view.tree,'Cancel sign-in').props.onClick();await p.view.flush();assert.equal(p.session.getItem(auth.PLUGIN_SIGN_IN_KEY),null);assert.match(textOf(p.view.tree),/Sign-in cancelled/);p.view.unmount();
});
test('expired or unsafe stored links are never resumed',()=>{
  for(const change of [{url:'javascript:alert(1)'},{url:'https://user:secret@provider.example/allow'},{startedAt:-auth.PLUGIN_SIGN_IN_TTL},{id:'other'}]){const s=storage({[auth.PLUGIN_SIGN_IN_KEY]:JSON.stringify({...pending,...change})});assert.equal(auth.readPluginSignIn(s,0),null);assert.equal(s.getItem(auth.PLUGIN_SIGN_IN_KEY),null);}
});
test('provider return paths retain the conversation and reject external or API destinations',()=>{
  const origin='https://app.example';assert.equal(auth.pluginReturnPath(origin+'/?workspace=1&conversation=123&plugins=failed&state=secret',origin),'/?workspace=1&conversation=123');
  for(const value of ['https://outside.example/','//outside.example/','/api/plugin-oauth/callback?code=secret'])assert.equal(auth.pluginReturnPath(value,origin),'/?workspace=1');
});
test('restoring the callback conversation does not dismiss its plugin result panel',async()=>{
  const env=environment(),view=renderer(env);env.window.location={search:'?workspace=1&conversation=123&plugins=cancelled'};
  const components=['BotRoster','SidebarShell','ChatPanel','BotCreator','PluginPanel','GoalsPanel','ChannelsPanel','WorkspaceSetup','RoomCreator','CommandPalette','WorkspaceHub','ComputerPanel'];
  const imports=Object.fromEntries(components.map(name=>['../components/'+name,{[name]:name}]));imports['./CommandPalette']={CommandPalette:'CommandPalette'};imports['./WorkspaceHub']={WorkspaceHub:'WorkspaceHub'};imports['./ComputerPanel']={ComputerPanel:'ComputerPanel'};
  imports['../hooks/useBots']={useBots:()=>({bots:[],selectedBot:null,setSelectedBot(){},createBot(){},refreshBots(){}})};
  imports['../components/PreferencesPanel']={PreferencesPanel:'PreferencesPanel',restoreAppearance(){}};imports['../components/RunControls']={DEFAULT_OPTIONS:{}};imports['../lib/types']={};imports['../lib/api']={request:async()=>[],api:{getConversations:async()=>[{id:'123',title:'Fixture conversation',is_group:true}]}};
  for (const name of components) imports['./'+name] = { [name]: name };
  imports['./PanelBoundary']={PanelBoundary:'panel-boundary'};
  imports['./cipher/CypherEntrance']={__esModule:true,default:'CypherEntrance'};
  const {default:WorkspaceApp}=load('../src/components/WorkspaceApp.tsx',{react:{...view.react,lazy:loader=>{const component={};loader().then(module=>{component.resolved=module.default;});return component;}},...imports},{...env.globals,URLSearchParams,setInterval:()=>1,clearInterval(){}});
  view.mount(()=>WorkspaceApp({}));await view.flush();assert.ok(find(view.tree,n=>n.type?.resolved==='PluginPanel'),'callback result remains visible after conversation restoration');view.unmount();
});

test('provider registration errors open an actionable OAuth form without claiming connection',async()=>{
  let calls=0,input;
  const p=panel({api:{authorizePlugin:async data=>{input=data;if(++calls===1)throw Object.assign(Error('Registered client required'),{details:{code:'oauth_registration_required',callback_url:'https://app.example/api/plugin-oauth/callback'}});return {status:'awaiting_login',flow_id:id,authorization_url:pending.url,name:'Lovable'};}}});
  await p.view.flush();find(p.view.tree,n=>n.type==='button'&&n.props?.['aria-label']==='Connect Lovable').props.onClick();await p.view.flush();
  assert.match(textOf(p.view.tree),/Finish Lovable setup/);
  assert.equal(find(p.view.tree,n=>n.props?.role==='alert'),undefined);
  const field=label=>find(find(p.view.tree,n=>n.type==='label'&&textOf(n).startsWith(label)),n=>n.type==='input');
  field('Client ID').props.onChange({target:{value:'fixture-own-client'}});
  field('Client secret').props.onChange({target:{value:'fixture-private-secret'}});
  await p.view.flush();
  const section=find(p.view.tree,n=>n.props?.className==='plugin-registration');
  await find(section,n=>n.type==='form').props.onSubmit({preventDefault(){}});await p.view.flush();
  assert.equal(input.oauth_client.client_id,'fixture-own-client');
  assert.equal(input.oauth_client.client_secret,'fixture-private-secret');
  assert.ok(find(p.view.tree,n=>n.type==='a'&&textOf(n)==='Continue to Lovable'));
  assert.doesNotMatch(textOf(p.view.tree),/Lovable connected/);
  p.view.unmount();
});

test('connected tool descriptions are searchable and public tools have a separate view',async()=>{
  const connections=[{id:'account',name:'Account fixture',url:'https://account.example/mcp',authenticated:true,enabled:true,tools:[{name:'lookup',description:'Find invoices'}]},{id:'public',name:'Public fixture',url:'https://public.example/mcp',authenticated:false,enabled:true,tools:[{name:'public_read',description:'Public documentation'}]}];
  const p=panel({api:{getPlugins:async()=>connections}});await p.view.flush();
  button(p.view.tree,'Connected · 2').props.onClick();await p.view.flush();
  assert.match(textOf(p.view.tree),/Account fixture/);assert.doesNotMatch(textOf(p.view.tree),/Public fixture/);
  button(p.view.tree,'Public tools · 1').props.onClick();await p.view.flush();assert.match(textOf(p.view.tree),/Public fixture/);
  find(p.view.tree,n=>n.props?.['aria-label']==='Search connected plugins').props.onChange({target:{value:'invoices'}});await p.view.flush();
  assert.match(textOf(p.view.tree),/Account fixture/);assert.doesNotMatch(textOf(p.view.tree),/Public fixture/);
  p.view.unmount();
});

test('structured registration responses retain recovery fields and readable errors',async()=>{
  const fields={message:'Provider registration needed',code:'oauth_registration_required',callback_url:'https://app.example/api/plugin-oauth/callback'};
  const {request}=load('../src/lib/api.ts',{'./conversations':{}},{process:{env:{}},AbortSignal,fetch:async()=>({ok:false,status:422,headers:{get:()=>null},json:async()=>({detail:fields})})});
  await assert.rejects(()=>request('/plugins/authorize'),error=>error.message===fields.message&&error.code===fields.code&&error.details.callback_url===fields.callback_url);
});
