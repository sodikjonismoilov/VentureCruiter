import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Drive the component's real selectors and submit handler with controlled
// React hooks. No network, provider, native dialog, or layout is simulated.
function hooks() {
  const values = [];
  let index = 0;
  const slot = initial => {
    const position = index++;
    if (position >= values.length) values.push(initial);
    return position;
  };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: initial => {
      const position = slot(initial);
      return [values[position], next => { values[position] = typeof next === 'function' ? next(values[position]) : next; }];
    },
    useRef: initial => values[slot({ current: initial })],
    useEffect: () => {},
  };
  return { react, render: fn => { index = 0; return fn(); } };
}

function load(path, imports = {}, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  runInNewContext(compiled, { exports, Error, ...globals,
    require: name => { if (!(name in imports)) throw new Error('Unexpected import: ' + name); return imports[name]; },
  });
  return exports;
}

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return undefined;
  if (Array.isArray(tree)) return tree.map(child => find(child, predicate)).find(Boolean);
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
}

const presets = load('../src/lib/presets.ts');
function quickStart(onStart, initialOptions = { routing: 'auto', provider: 'openai', model: 'gpt-6.1-sol' }) {
  const runtime = hooks();
  let options = initialOptions;
  const { QuickStart } = load('../src/components/QuickStart.tsx', {
    react: runtime.react, './GlassSelect': { GlassSelect: 'select' }, '../lib/presets': presets,
    './cipher/BinaryLens': { __esModule: true, default: 'binary-lens' },
    './cipher/CypherMark': { __esModule: true, default: 'cypher-mark' },
    './cipher/RecentWork': { RecentWork: 'recent-work' },
    '../lib/attachments': { readTaskAttachments: async files => files.map(file => ({ name: file.name, mime: 'text/plain', data: 'Zml4dHVyZQ==' })) },
  }, { React: runtime.react, localStorage: { setItem() {} } });
  return () => runtime.render(() => QuickStart({
    options, onOptions: next => { options = next; }, onStart,
    onCreateBot() {}, onCreateRoom() {},
  }));
}

const task = tree => find(tree, node => node.props?.id === 'first-task');
const manager = tree => find(tree, node => node.props?.['aria-label'] === 'Manager model');
const submit = tree => find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });

for (const choice of presets.MODEL_CHOICES) {
  test(`manual ${choice.label} sends its actual provider/model pair`, async () => {
    const calls = [];
    const render = quickStart(async (prompt, options) => { calls.push({ prompt, options }); });
    manager(render()).props.onChange({ target: { value: choice.model } });
    task(render()).props.onChange({ target: { value: 'Synthetic model selection check.' } });
    await submit(render());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].prompt, 'Synthetic model selection check.');
    assert.equal(calls[0].options.routing, 'manual');
    assert.equal(calls[0].options.provider, choice.provider);
    assert.equal(calls[0].options.model, choice.model);
  });
}

test('Auto retains automatic routing with a valid OpenAI Sol base pair', async () => {
  const calls = [];
  const render = quickStart(async (prompt, options) => { calls.push({ prompt, options }); }, {
    routing: 'manual', provider: 'gemini', model: 'gemini-3.8-flash',
  });
  manager(render()).props.onChange({ target: { value: 'auto' } });
  task(render()).props.onChange({ target: { value: 'Synthetic automatic task.' } });
  await submit(render());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.routing, 'auto');
  assert.equal(calls[0].options.provider, 'openai');
  assert.equal(calls[0].options.model, 'gpt-6.1-sol');
});

test('the calmer home keeps the task composer and model choice together', () => {
  const tree = quickStart(async () => {})();
  assert.ok(task(tree));
  assert.ok(manager(tree));
  assert.ok(find(tree, node => node.type === 'button' && node.props['aria-label'] === 'Start task'));
  assert.equal(find(tree, node => node.type === 'button' && node.props['aria-label'] === 'Connect models'), undefined);
});
test('same-tick double submission starts once and an interruption retains the task for retry', async () => {
  const calls = [];
  let rejectFirst;
  const render = quickStart((prompt, options) => {
    calls.push({ prompt, options });
    return calls.length === 1 ? new Promise((_, reject) => { rejectFirst = reject; }) : Promise.resolve();
  });
  task(render()).props.onChange({ target: { value: 'Keep this synthetic task after failure.' } });
  const tree = render();
  const first = submit(tree);
  await submit(tree);
  assert.equal(calls.length, 1);
  rejectFirst(new Error('Synthetic connection interruption.'));
  await first;
  const recovered = render();
  assert.equal(task(recovered).props.value, 'Keep this synthetic task after failure.');
  const error = find(recovered, node => node.props?.role === 'alert');
  assert.match(error.props.children.flat().join(''), /Synthetic connection interruption.*Your task is still here/);
  await submit(recovered);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].prompt, calls[1].prompt);
  assert.equal(JSON.stringify(calls[0].options), JSON.stringify(calls[1].options));
});

test('empty tasks never start; Enter submits while Shift+Enter and composition retain native input', async () => {
  let calls = 0;
  const render = quickStart(async () => { calls++; });
  await submit(render());
  assert.equal(calls, 0);
  const key = task(render()).props.onKeyDown;
  let prevented = 0, submitted = 0;
  const event = { key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false },
    preventDefault() { prevented++; }, currentTarget: { form: { requestSubmit() { submitted++; } } } };
  key(event);
  key({ ...event, shiftKey: true });
  key({ ...event, nativeEvent: { isComposing: true } });
  assert.equal(prevented, 1);
  assert.equal(submitted, 1);
});

// A pending backend start keeps keyboard submission from creating a duplicate task.
test('keyboard task submission stays blocked until the start request resolves', async () => {
  let started = 0, release;
  const render = quickStart(() => { started++; return new Promise(resolve => { release = resolve; }); });
  task(render()).props.onChange({ target: { value: 'Keep task while start is pending.' } });
  const first = submit(render());
  assert.equal(started, 1);
  assert.equal(task(render()).props.disabled, true);
  await submit(render());
  assert.equal(started, 1);
  release();
  await first;
  assert.equal(task(render()).props.disabled, false);
});
test('image output is included in the task sent to the backend', async () => {
  const calls = [];
  const render = quickStart(async (prompt, options) => { calls.push({ prompt, options }); });
  find(render(), node => node.props?.['aria-label'] === 'Task output').props.onChange({target:{value:'image'}});
  task(render()).props.onChange({target:{value:'A synthetic image request'}});
  await submit(render());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.output, 'image');
  assert.equal(calls[0].options.aspect_ratio, '16:9');
});


test('home file-only tasks forward attachments and retain them after a failed start', async () => {
  const calls=[];
  const render=quickStart(async (prompt, options, attachments)=>{
    calls.push({prompt,options,attachments});
    if(calls.length===1)throw Error('Temporary connection failure.');
  });
  find(render(),node=>node.type==='input'&&node.props.type==='file').props.onChange({target:{files:[{name:'brief.txt',size:7,type:'text/plain'}]}});
  await new Promise(setImmediate);
  await submit(render());
  assert.equal(calls.length,1);
  assert.equal(calls[0].attachments[0].name,'brief.txt');
  assert.equal(calls[0].attachments[0].data,'Zml4dHVyZQ==');
  assert.equal(calls[0].options.output,'text');
  assert.ok(find(render(),node=>node.props?.['aria-label']==='Remove brief.txt'));
  await submit(render());
  assert.equal(calls.length,2);
  assert.deepEqual(calls[1].attachments,calls[0].attachments);
});
