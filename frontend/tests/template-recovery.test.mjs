import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environment, renderer, load, deferred, find, textOf, button } from './support/component-harness.mjs';

class FixtureApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const template = {
  format: 'grokbot-template-v1',
  bot: {
    name: 'Research helper',
    role: 'Research analyst',
    description: 'Summarizes public company information.',
    system_prompt: 'Use public sources and cite them.',
    llm_provider: 'openai',
    llm_model: 'gpt-6.1-sol',
    tools_enabled: ['search'],
  },
  notice: 'Credentials and conversations are not included.',
};

function pageFixture(request) {
  const env = environment();
  const view = renderer(env);
  view.react.use = value => value;
  const imports = {
    react: view.react,
    '../../../lib/api': { ApiError: FixtureApiError, request },
    '../../../lib/canonical-app': {
      safeInternalReturnTo: value => value.startsWith('/') && !value.startsWith('//') ? value : null,
    },
    '../../../components/cipher/CypherMark': { __esModule: true, default: 'cypher-mark' },
    './template.module.css': {},
  };
  const { default: TemplatePage } = load('../src/app/templates/[id]/page.tsx', imports, {
    ...env.globals,
    React: view.react.default,
  });
  view.mount(() => TemplatePage({ params: { id: 'fixture-id' } }));
  return view;
}

test('a missing shared template shows a safe explanation and retry loads it', async () => {
  const first = deferred();
  let calls = 0;
  const view = pageFixture(() => ++calls === 1 ? first.promise : Promise.resolve(template));
  assert.match(textOf(view.tree), /Loading shared template/);

  first.reject(new FixtureApiError('Synthetic internal detail that must stay hidden', 404));
  await view.flush();
  assert.match(textOf(view.tree), /This shared template is no longer available/);
  assert.doesNotMatch(textOf(view.tree), /Synthetic internal detail/);

  button(view.tree, 'Try again').props.onClick();
  await view.flush();
  assert.match(textOf(view.tree), /Research helper/);
  assert.equal(calls, 2);
  view.unmount();
});

test('an import sign-in error keeps the shared template as a safe return destination', async () => {
  const view = pageFixture(path => path.includes('/shared/')
    ? Promise.resolve(template)
    : Promise.reject(new FixtureApiError('Synthetic auth response', 401)));
  await view.flush();

  button(view.tree, 'Add to my workspace').props.onClick();
  await view.flush();
  const signIn = find(view.tree, node => node.type === 'a' && node.props.href?.startsWith('/login?returnTo='));
  assert.ok(signIn);
  assert.equal(signIn.props.href, '/login?returnTo=%2Ftemplates%2Ffixture-id');
  assert.match(textOf(view.tree), /Sign in to add this template/);
  assert.doesNotMatch(textOf(view.tree), /Synthetic auth response/);
  view.unmount();
});

test('a successful import confirms completion and opens the workspace', async () => {
  const view = pageFixture(path => path.includes('/shared/')
    ? Promise.resolve(template)
    : Promise.resolve({ id: 'imported-agent' }));
  await view.flush();

  button(view.tree, 'Add to my workspace').props.onClick();
  await view.flush();
  assert.match(textOf(view.tree), /Added to your workspace/);
  assert.match(textOf(view.tree), /Research helper is ready/);
  assert.ok(find(view.tree, node => node.type === 'a' && node.props.href === '/'));
  view.unmount();
});

test('leaving during template loading aborts the request without updating the page', async () => {
  const pending = deferred();
  const view = pageFixture(() => pending.promise);
  view.unmount();
  pending.reject(new Error('Network error'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.updatesAfterUnmount, 0);
});
