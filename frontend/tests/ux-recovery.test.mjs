import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { getEventListeners } from 'node:events';
import ts from 'typescript';

// Exercise actual component effects/handlers with deterministic hooks, clocks,
// storage, events and API boundaries. These are not browser/layout/auth tests.
function storage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return { getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)), removeItem: key => entries.delete(key) };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clock() {
  let now = 0, sequence = 0;
  const timers = new Map();
  return { get now() { return now; }, get pending() { return timers.size; },
    setTimeout(fn, delay = 0) { const id = ++sequence; timers.set(id, { fn, at: now + Math.max(0, delay) }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      for (let count = 0; count < 1000; count++) {
        const next = [...timers].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) { now = target; return; }
        timers.delete(next[0]); now = next[1].at; next[1].fn();
      }
      throw new Error('Unexpected timer loop in fixture');
    } };
}
function environment(session = storage()) {
  const time = clock();
  const nodes = new Map();
  const document = Object.assign(new EventTarget(), { hidden: false, body: {},
    documentElement: { dataset: {} }, getElementById: id => nodes.get(id) ?? null });
  const window = Object.assign(new EventTarget(), { matchMedia: () => Object.assign(new EventTarget(), { matches: false }) });
  class FixtureDate extends Date { constructor(...args) { super(...(args.length ? args : [time.now])); } static now() { return time.now; } }
  function element(props = {}) {
    return { open: false, style: {}, scrollHeight: 1000, scrollTop: 1000, clientHeight: 500,
      focus() {}, contains: () => false, querySelector: () => null, scrollIntoView() {},
      showModal() { this.open = true; }, close() { this.open = false; },
      scrollTo(options) { this.scrollTop = options.top; }, ...props };
  }
  return { time, nodes, document, window, element, globals: { document, window, Event, AbortController,
    sessionStorage: session, localStorage: storage(), Date: FixtureDate,
    IntersectionObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    HTMLElement: class {}, process: { env: {} } } };
}
function renderer(env) {
  const slots = [];
  let cursor = 0, dirty = true, mounted = true, component, tree, pendingEffects = [];
  let updatesAfterUnmount = 0;
  function slot(kind, initial) {
    const index = cursor++;
    if (!slots[index]) slots[index] = { kind, ...initial };
    assert.equal(slots[index].kind, kind, 'hook order is stable');
    return slots[index];
  }
  const react = {
    Fragment: 'fragment',
    createElement(type, props, ...children) {
      const node = { type, props: { ...props, children } };
      if (typeof type === 'string') {
        if (props?.ref && !props.ref.current) props.ref.current = env.element();
        if (props?.id) env.nodes.set(props.id, props.ref?.current || env.element());
      }
      return node;
    },
    useState(initial) {
      const current = slot('state', {});
      if (!('value' in current)) current.value = typeof initial === 'function' ? initial() : initial;
      return [current.value, next => {
        if (!mounted) { updatesAfterUnmount++; return; }
        const value = typeof next === 'function' ? next(current.value) : next;
        if (!Object.is(value, current.value)) { current.value = value; dirty = true; }
      }];
    },
    useRef(initial) { return slot('ref', { value: { current: initial } }).value; },
    useEffect(create, deps) {
      const current = slot('effect', {});
      if (!current.deps || !deps || deps.length !== current.deps.length || deps.some((value, i) => !Object.is(value, current.deps[i]))) {
        current.deps = deps; pendingEffects.push({ current, create });
      }
    },
  };
  function render() {
    for (let turn = 0; dirty && turn < 30; turn++) {
      dirty = false; cursor = 0; tree = component();
      const effects = pendingEffects; pendingEffects = [];
      for (const { current, create } of effects) { current.cleanup?.(); current.cleanup = create(); }
    }
    assert.equal(dirty, false, 'component effects settle');
    return tree;
  }
  return { react: { __esModule: true, default: react, ...react },
    mount(fn) { component = fn; return render(); }, render,
    rerender() { dirty = true; return render(); },
    async flush() { for (let i = 0; i < 12; i++) { await Promise.resolve(); if (mounted) render(); } return tree; },
    get tree() { return tree; }, get updatesAfterUnmount() { return updatesAfterUnmount; },
    unmount() { mounted = false; for (const current of slots) current.cleanup?.(); } };
}
function load(path, imports = {}, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  const exports = {};
  runInNewContext(compiled, { exports, Error, Map, ...globals,
    require: name => { if (!(name in imports)) throw new Error('Unexpected import: ' + name); return imports[name]; } });
  return exports;
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
  return predicate(node) ? node : find(node.props?.children, predicate);
}
function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
}
const button = (tree, label) => find(tree, node => node.type === 'button' && textOf(node) === label);
const field = (tree, id) => find(tree, node => node.props?.id === id);
const submit = tree => find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
const presets = load('../src/lib/presets.ts');
const taskKey = (scope = 'local') => `grokbot-task-draft-v1-${scope}`;
function quickStart(env, onStart, initialScope = 'local') {
  let draftScope = initialScope;
  const view = renderer(env);
  const { QuickStart } = load('../src/components/QuickStart.tsx', {
    react: view.react, '../lib/presets': presets, './GlassSelect': { GlassSelect: 'select' },
    './cipher/BinaryLens': { __esModule: true, default: 'binary-lens' },
    './cipher/BinaryLens': { __esModule: true, default: 'binary-lens' },
    './cipher/RecentWork': { RecentWork: 'recent-work' },
    '../lib/attachments': { readTaskAttachments: async files => files.map(file => ({ name: file.name, mime: 'text/plain', data: 'Zml4dHVyZQ==' })) },
  }, { ...env.globals, React: view.react.default });
  view.mount(() => QuickStart({ draftScope, options: { routing: 'auto', provider: 'openai', model: 'gpt-6.1-sol' },
    onStart, onOptions() {}, onCreateBot() {}, onCreateRoom() {}, onOpenLounge: async () => {} }));
  view.setDraftScope = value => { draftScope = value; view.rerender(); };
  return view;
}
const { ApiError } = load('../src/lib/api.ts', { './conversations': {} }, { process: { env: {} } });
const bot = { id: 'synthetic-agent', name: 'Coordinator', llmProvider: 'openai', llmModel: 'gpt-6.1-sol' };
const message = { id: 'source-message', content: 'Existing synthetic response', senderType: 'bot', messageType: 'text', createdAt: '2026-10-22T00:00:00Z' };
function chat(env, api) {
  const view = renderer(env);
  const stubs = { './LoadingState': { LoadingState: 'loading-state' }, './cipher/BinaryLens': { __esModule: true, default: 'binary-lens' }, '../lib/presets': presets, './ContextPanel': { ContextPanel: 'context-panel' },
    './WorkPanel': { WorkPanel: 'work-panel' }, './GlassSelect': { GlassSelect: 'select' },
    '../lib/types': { MessageType: { TEXT: 'text' } }, '../lib/api': { api, ApiError },
    './BotAvatar': { BotAvatar: 'bot-avatar' }, './MessageBubble': { MessageBubble: 'message-bubble' },
    '../lib/voice-playback': {},
    './cipher/CypherMark': { __esModule: true, default: 'cypher-mark' },
    './QuickStart': { QuickStart: 'quick-start' }, './RunControls': { RunControls: 'run-controls', DEFAULT_OPTIONS: {} },
    '../lib/modelPolicy': { modelPolicy: value => value }, '../lib/attachments': { readAttachment: async () => ({ name: 'fixture.txt', mime: 'text/plain', data: 'eA==' }) } };
  const { ChatPanel } = load('../src/components/ChatPanel.tsx', { react: view.react, ...stubs }, env.globals);
  view.mount(() => ChatPanel({ bot, room: null, bots: [bot], onCreateBot() {}, onCreateRoom() {},
    onQuickStart: async () => {}, onOpenLounge: async () => {} }));
  return view;
}

test('command search ignores composing and 229 Enter, but normal Enter chooses the command', async () => {
  const env = environment(), view = renderer(env); let chosen = 0, prevented = 0;
  const { CommandPalette } = load('../src/components/CommandPalette.tsx', {
    react: view.react, 'react-dom': { createPortal: node => node },
  }, { ...env.globals, React: view.react.default });
  view.mount(() => CommandPalette({ commands: [{ id: 'create', label: 'Create an agent', group: 'Action', run() { chosen++; } }] }));
  const input = find(view.tree, node => node.type === 'input');
  const event = { key: 'Enter', keyCode: 13, nativeEvent: { isComposing: false }, preventDefault() { prevented++; } };
  input.props.onKeyDown({ ...event, nativeEvent: { isComposing: true } });
  input.props.onKeyDown({ ...event, keyCode: 229 });
  assert.equal(chosen, 0); assert.equal(prevented, 0);
  input.props.onKeyDown(event);
  assert.equal(chosen, 1); assert.equal(prevented, 1);
  view.unmount();
});

test('home task effects restore and persist a tab draft across remounts', async () => {
  const session = storage({ [taskKey()]: 'Saved task before navigation' });
  const first = quickStart(environment(session), async () => {});
  assert.equal(field(first.tree, 'first-task').props.value, 'Saved task before navigation');
  field(first.tree, 'first-task').props.onChange({ target: { value: 'Updated synthetic task' } });
  await first.flush();
  assert.equal(session.getItem(taskKey()), 'Updated synthetic task');
  first.unmount();
  const reopened = quickStart(environment(session), async () => {});
  assert.equal(field(reopened.tree, 'first-task').props.value, 'Updated synthetic task');
  reopened.unmount();
});

test('home task stays saved during a pending or failed start and clears only after acceptance', async () => {
  const session = storage({ [taskKey()]: 'Do not lose this task' });
  const first = deferred(), second = deferred(); let starts = 0;
  const view = quickStart(environment(session), () => (++starts === 1 ? first.promise : second.promise));
  const failed = submit(view.tree); await view.flush();
  assert.equal(field(view.tree, 'first-task').props.disabled, true);
  assert.equal(session.getItem(taskKey()), 'Do not lose this task');
  first.reject(new Error('Synthetic offline')); await failed; await view.flush();
  assert.match(textOf(view.tree), /Synthetic offline.*Your task is still here/);
  assert.equal(field(view.tree, 'first-task').props.value, 'Do not lose this task');
  assert.equal(session.getItem(taskKey()), 'Do not lose this task');
  const accepted = submit(view.tree); await view.flush();
  assert.equal(session.getItem(taskKey()), 'Do not lose this task');
  second.resolve(); await accepted; await view.flush();
  assert.equal(field(view.tree, 'first-task').props.value, '');
  assert.equal(session.getItem(taskKey()), null);
  view.unmount();
});

test('an older accepted start must not erase a newer home instance draft', async () => {
  const session = storage({ [taskKey()]: 'Submitted task A' }), pending = deferred();
  const older = quickStart(environment(session), () => pending.promise);
  const accepted = submit(older.tree); older.unmount();
  const newer = quickStart(environment(session), async () => {});
  field(newer.tree, 'first-task').props.onChange({ target: { value: 'Newer task B' } }); await newer.flush();
  pending.resolve(); await accepted;
  assert.equal(session.getItem(taskKey()), 'Newer task B');
  assert.equal(field(newer.tree, 'first-task').props.value, 'Newer task B');
  newer.unmount();
});

test('account-scoped drafts restore independently and a prop switch cannot overwrite another account', async () => {
  const session = storage({ [taskKey('account-a')]: 'Account A draft', [taskKey('account-b')]: 'Account B draft' });
  const view = quickStart(environment(session), async () => {}, 'account-a');
  assert.equal(field(view.tree, 'first-task').props.value, 'Account A draft');
  field(view.tree, 'first-task').props.onChange({ target: { value: 'Account A edited draft' } }); await view.flush();
  view.setDraftScope('account-b'); await view.flush();
  assert.equal(field(view.tree, 'first-task').props.value, 'Account B draft');
  assert.equal(session.getItem(taskKey('account-a')), 'Account A edited draft');
  assert.equal(session.getItem(taskKey('account-b')), 'Account B draft');
  field(view.tree, 'first-task').props.onChange({ target: { value: 'Account B edited draft' } }); await view.flush();
  view.setDraftScope('account-a'); await view.flush();
  assert.equal(field(view.tree, 'first-task').props.value, 'Account A edited draft');
  assert.equal(session.getItem(taskKey('account-b')), 'Account B edited draft');
  view.unmount();
});

test('a stale accepted account A start cannot clear the new account B instance draft', async () => {
  const session = storage({ [taskKey('account-a')]: 'Submitted A', [taskKey('account-b')]: 'Saved B' }), pending = deferred();
  const older = quickStart(environment(session), () => pending.promise, 'account-a');
  const accepted = submit(older.tree); older.unmount();
  const newer = quickStart(environment(session), async () => {}, 'account-b');
  field(newer.tree, 'first-task').props.onChange({ target: { value: 'New B' } }); await newer.flush();
  pending.resolve(); await accepted;
  assert.equal(session.getItem(taskKey('account-a')), null);
  assert.equal(session.getItem(taskKey('account-b')), 'New B');
  assert.equal(field(newer.tree, 'first-task').props.value, 'New B');
  newer.unmount();
});

test('failed conversation opening reconnects once and preserves the draft through sync success', async () => {
  const env = environment(storage({ 'grokbot-draft-synthetic-agent': 'Keep my conversation draft' }));
  const opening = deferred(); let opens = 0, syncs = 0;
  const view = chat(env, { conversationForBot: () => ++opens === 1 ? Promise.reject(new ApiError('Synthetic unavailable', 503)) : opening.promise,
    syncConversation: async () => { syncs++; return { messages: [message], tasks: [] }; } });
  await view.flush();
  assert.equal(opens, 1); assert.equal(syncs, 0);
  assert.match(textOf(view.tree), /Synthetic unavailable/);
  assert.equal(field(view.tree, 'message').props.value, 'Keep my conversation draft');
  const reconnect = button(view.tree, 'Reconnect'); assert.ok(reconnect);
  reconnect.props.onClick(); reconnect.props.onClick(); await view.flush();
  assert.equal(opens, 2, 'two same-tick reconnects coalesce');
  assert.equal(field(view.tree, 'message').props.value, 'Keep my conversation draft');
  opening.resolve('synthetic-conversation'); await view.flush();
  assert.equal(syncs, 1);
  assert.equal(find(view.tree, node => node.type === 'message-bubble').props.message.content, message.content);
  assert.equal(field(view.tree, 'message').props.value, 'Keep my conversation draft');
  assert.equal(find(view.tree, node => node.props?.className === 'sync-status'), undefined);
  view.unmount();
});

test('online recovery after sync failure runs immediately and coalesces while a request is pending', async () => {
  const env = environment(), recovered = deferred(); let syncs = 0;
  const view = chat(env, { conversationForBot: async () => 'synthetic-conversation', syncConversation: () => {
    syncs++; return syncs === 1 ? Promise.resolve({ messages: [message], tasks: [] }) : syncs === 2 ? Promise.reject(new ApiError('Synthetic offline', 503)) : recovered.promise;
  } });
  await view.flush();
  field(view.tree, 'message').props.onChange({ target: { value: 'Retain draft on reconnect' }, currentTarget: { style: {}, scrollHeight: 24 } }); await view.flush();
  env.window.dispatchEvent(new Event('grokbot:refresh')); await view.flush();
  assert.equal(syncs, 2); assert.match(textOf(view.tree), /Couldn’t refresh this conversation/);
  env.window.dispatchEvent(new Event('online')); env.window.dispatchEvent(new Event('online')); await view.flush();
  assert.equal(syncs, 3); assert.equal(env.time.now, 0, 'recovery does not wait for the backoff timer');
  assert.equal(button(view.tree, 'Reconnecting…').props.disabled, true);
  assert.equal(field(view.tree, 'message').props.value, 'Retain draft on reconnect');
  assert.equal(find(view.tree, node => node.type === 'message-bubble').props.message.content, message.content);
  recovered.resolve({ messages: [], tasks: [] }); await view.flush();
  assert.equal(find(view.tree, node => node.props?.className === 'sync-status'), undefined);
  view.unmount();
});

test('Reconnect and online events respect server Retry-After before another sync', async () => {
  const env = environment(); const timestamps = [];
  const view = chat(env, { conversationForBot: async () => 'synthetic-conversation', syncConversation: async () => {
    timestamps.push(env.time.now); if (timestamps.length === 1) throw new ApiError('Synthetic limit', 429, undefined, 5);
    return { messages: [], tasks: [] };
  } });
  await view.flush();
  const waiting = button(view.tree, 'Waiting to retry…'); assert.equal(waiting.props.disabled, true);
  waiting.props.onClick(); env.window.dispatchEvent(new Event('online')); await view.flush();
  env.time.advance(4999); env.window.dispatchEvent(new Event('online')); await view.flush();
  assert.equal(timestamps.length, 1);
  env.time.advance(1); await view.flush();
  assert.equal(timestamps.length, 2); assert.equal(timestamps[1], 5000);
  view.unmount();
});

test('conversation cleanup aborts its pending fetch, removes recovery listeners and schedules no retry', async () => {
  const env = environment(), pending = deferred(); let signal, syncs = 0;
  const view = chat(env, { conversationForBot: async () => 'synthetic-conversation', syncConversation: (_id, _after, value) => { signal = value; syncs++; return pending.promise; } });
  await view.flush(); assert.equal(signal.aborted, false);
  assert.equal(getEventListeners(env.window, 'online').length, 1);
  view.unmount(); assert.equal(signal.aborted, true);
  assert.equal(getEventListeners(env.window, 'online').length, 0);
  assert.equal(getEventListeners(env.window, 'grokbot:refresh').length, 0);
  assert.equal(getEventListeners(env.document, 'visibilitychange').length, 0);
  env.window.dispatchEvent(new Event('online')); env.window.dispatchEvent(new Event('grokbot:refresh'));
  pending.reject(new Error('Synthetic aborted fetch')); await view.flush();
  assert.equal(syncs, 1); assert.equal(env.time.pending, 0); assert.equal(view.updatesAfterUnmount, 0);
});

test('opening quota details remain actionable while Reconnect honors Retry-After', async () => {
  const env = environment(storage({ 'grokbot-draft-synthetic-agent': 'Draft kept during provider pause' }));
  const quota = 'Database provider quota is exhausted. The owner must restore database service.';
  let opens = 0, syncs = 0;
  const view = chat(env, {
    conversationForBot: async () => { opens++; if (opens === 1) throw new ApiError(quota, 503, 'database_quota', 300); return 'synthetic-conversation'; },
    syncConversation: async () => { syncs++; return { messages: [], tasks: [] }; },
  });
  await view.flush();
  assert.ok(textOf(view.tree).includes(quota));
  assert.equal(field(view.tree, 'message').props.value, 'Draft kept during provider pause');
  const waiting = button(view.tree, 'Waiting to retry…'); assert.equal(waiting.props.disabled, true);
  waiting.props.onClick(); env.window.dispatchEvent(new Event('online')); await view.flush();
  env.time.advance(299999); await view.flush();
  assert.equal(opens, 1); assert.equal(syncs, 0);
  env.time.advance(1); await view.flush();
  const reconnect = button(view.tree, 'Reconnect'); assert.equal(reconnect.props.disabled, false);
  reconnect.props.onClick(); await view.flush();
  assert.equal(opens, 2); assert.equal(syncs, 1);
  assert.equal(field(view.tree, 'message').props.value, 'Draft kept during provider pause');
  view.unmount();
});

test('Jump to latest honors disabled app motion when OS motion is enabled', async () => {
  const env = environment(); env.document.documentElement.dataset.motion = 'false';
  const view = chat(env, { conversationForBot: async () => 'synthetic-conversation',
    syncConversation: async () => ({ messages: [message], tasks: [] }) });
  await view.flush();
  const stream = find(view.tree, node => node.props?.className === 'message-stream');
  const element = stream.props.ref.current;
  element.scrollTop = 0; element.scrollHeight = 1200; element.clientHeight = 500;
  const scrolls = []; element.scrollTo = options => scrolls.push(options);
  stream.props.onScroll(); await view.flush();
  button(view.tree, 'Jump to latest').props.onClick(); await view.flush();
  assert.equal(scrolls.length, 1); assert.equal(scrolls[0].top, 1200); assert.equal(scrolls[0].behavior, 'instant');
  assert.equal(button(view.tree, 'Jump to latest'), undefined);
  view.unmount();
});


test('a refresh during an idle sync schedules one immediate follow-up instead of waiting ten seconds', async () => {
  const env = environment(), pending = deferred(); let syncs = 0;
  const view = chat(env, { conversationForBot: async () => 'synthetic-conversation', syncConversation: () => {
    syncs++; return syncs === 1 ? pending.promise : Promise.resolve({ messages: [], tasks: [] });
  } });
  await view.flush();
  env.window.dispatchEvent(new Event('grokbot:refresh'));
  env.window.dispatchEvent(new Event('grokbot:refresh'));
  assert.equal(syncs, 1, 'never overlap requests');
  pending.resolve({ messages: [], tasks: [] }); await view.flush();
  env.time.advance(0); await view.flush();
  assert.equal(syncs, 2, 'coalesce refreshes into a zero-delay follow-up');
  assert.equal(env.time.now, 0);
  view.unmount();
});

test('a queued refresh preserves Retry-After when the in-flight sync fails', async () => {
  const env = environment(), pending = deferred(); let syncs = 0;
  const view = chat(env, { conversationForBot: async () => 'synthetic-conversation', syncConversation: () => {
    syncs++; return syncs === 1 ? pending.promise : Promise.resolve({ messages: [], tasks: [] });
  } });
  await view.flush(); env.window.dispatchEvent(new Event('grokbot:refresh'));
  pending.reject(new ApiError('Synthetic limit', 429, undefined, 5)); await view.flush();
  env.time.advance(4999); await view.flush(); assert.equal(syncs, 1);
  env.time.advance(1); await view.flush(); assert.equal(syncs, 2);
  view.unmount();
});
