import {test} from 'node:test';
import assert from 'node:assert/strict';
import {environment, renderer, load, find, textOf} from './support/component-harness.mjs';

function fixture(accountEmail) {
  const env = environment(), view = renderer(env);
  let setupCalls = 0;
  const {AccountMenu} = load('../src/components/AccountMenu.tsx', {'./AccountMenu.module.css': {}}, {React: view.react.default});
  view.mount(() => AccountMenu({accountEmail, onSetup: () => setupCalls++}));
  return {view, get setupCalls() {return setupCalls;}};
}
test('guest has a direct sign-in link and retains workspace settings', () => {
  const app = fixture();
  const signIn = find(app.view.tree, node => node.type === 'a' && textOf(node).includes('Sign in'));
  assert.equal(signIn.props.href, '/login');
  assert.equal(find(app.view.tree, node => node.props?.href === '/api/auth/logout'), undefined);
  find(app.view.tree, node => node.type === 'button').props.onClick();
  assert.equal(app.setupCalls, 1);
});
test('signed-in account can switch accounts through logout and open settings without changing session', () => {
  const app = fixture('person@example.test');
  const action = label => find(app.view.tree, node => node.type === 'a' && textOf(node) === label);
  assert.equal(action('Switch account').props.href, '/api/auth/logout');
  assert.equal(action('Sign out').props.href, '/api/auth/logout');
  assert.ok(textOf(app.view.tree).includes('person@example.test'));
  let closed = false;
  find(app.view.tree, node => node.type === 'button').props.onClick({currentTarget: {closest: () => ({removeAttribute: name => {assert.equal(name, 'open'); closed = true;}})}});
  assert.equal(app.setupCalls, 1);
  assert.equal(closed, true);
});
test('Escape closes account disclosure and restores keyboard focus', () => {
  const app = fixture('person@example.test');
  let focused = false, prevented = false;
  const details = {open: true, querySelector: selector => {assert.equal(selector, 'summary'); return {focus: () => focused = true};}};
  app.view.tree.props.onKeyDown({key: 'Escape', preventDefault: () => prevented = true, currentTarget: details});
  assert.equal(details.open, false);
  assert.equal(prevented, true);
  assert.equal(focused, true);
});
