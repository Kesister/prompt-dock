const { test } = require('node:test');
const assert = require('node:assert/strict');
const shortcut = 'Control+Alt+Space';
const { fixture: createFixture } = require('./palette-test-fixture');
const fixture = () => createFixture({ readState: () => { throw new Error('This test must never read a prompt library.'); } });

test('startup conflict retains the enabled preference and reports pending registration', async t => {
  const f = fixture();
  t.after(() => f.controller.dispose());
  f.block(true);
  const result = await f.controller.configure({ enabled: true, shortcut }, [], { restore: true });
  assert.equal(result.ok, false);
  assert.equal(f.controller.status().enabled, true);
  assert.equal(f.controller.status().shortcut, shortcut);
  assert.equal(f.controller.status().shortcutRegistered, false);
  assert.equal(f.controller.status().retrying, true);
  assert.match(f.controller.status().message, /自动重试/);
});

test('saving the unchanged shortcut repairs a missing registration', async t => {
  const f = fixture();
  t.after(() => f.controller.dispose());
  assert.equal((await f.controller.configure({ enabled: true, shortcut })).ok, true);
  f.registered.clear();
  assert.equal((await f.controller.configure({ enabled: true, shortcut })).ok, true);
  assert.equal(f.attempts.length, 2);
  assert.equal(f.registered.has(shortcut), true);
});

test('a rejected settings edit leaves the working shortcut and configuration intact', async t => {
  const f = fixture();
  t.after(() => f.controller.dispose());
  await f.controller.configure({ enabled: true, shortcut });
  f.block(true);
  const result = await f.controller.configure({ enabled: true, shortcut: 'Control+Alt+F8' });
  assert.equal(result.ok, false);
  assert.equal(f.controller.config.shortcut, shortcut);
  assert.equal(f.registered.has(shortcut), true);
});

test('disabling a failed startup registration stops recovery without enabling the helper', async () => {
  const f = fixture();
  f.block(true);
  await f.controller.configure({ enabled: true, shortcut }, [], { restore: true });
  await f.controller.configure({ enabled: false, shortcut });
  f.block(false);
  f.controller.recoverShortcut();
  assert.equal(f.controller.status().enabled, false);
  assert.equal(f.controller.status().retrying, false);
  assert.equal(f.registered.size, 0);
  assert.equal(f.controller.helper, null);
  f.controller.dispose();
});

test('registration recovery preserves a deliberate pause and never opens a palette', async t => {
  const f = fixture();
  t.after(() => f.controller.dispose());
  await f.controller.configure({ enabled: true, shortcut });
  f.controller.pause();
  f.registered.clear();
  f.controller.recoverShortcut();
  assert.equal(f.controller.status().paused, true);
  assert.equal(f.controller.helper, null);
  assert.equal(f.controller.window.isVisible(), false);
  assert.equal(f.registered.has(shortcut), true);
});
