const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ShortcutRegistration } = require('../shortcut-registration');

const key = 'Control+Alt+Space';
function fixture() {
  const registered = new Map(), pending = new Map(), attempts = [], delays = [];
  const blocked = new Set();
  let nextTimer = 0;
  const callback = () => { calls.trigger++; };
  const calls = { trigger: 0, changes: 0, released: [] };
  const globalShortcut = {
    register(shortcut, handler) {
      attempts.push(shortcut);
      if (shortcut === 'InvalidKey') throw new Error('Invalid accelerator');
      if (blocked.has(shortcut) || registered.has(shortcut)) return false;
      registered.set(shortcut, handler);
      return true;
    },
    isRegistered: shortcut => registered.has(shortcut),
    unregister(shortcut) { calls.released.push(shortcut); registered.delete(shortcut); }
  };
  const binding = new ShortcutRegistration({ globalShortcut, callback,
    onChange: () => calls.changes++,
    setTimer(fn, delay) { const id = ++nextTimer; pending.set(id, fn); delays.push(delay); return id; },
    clearTimer: id => pending.delete(id)
  });
  return { binding, registered, pending, attempts, delays, blocked, calls,
    tick() {
      const entry = pending.entries().next().value;
      assert.ok(entry, 'Expected a pending recovery');
      pending.delete(entry[0]); entry[1]();
    }
  };
}

test('a temporary startup conflict clears automatically without another settings save', () => {
  const f = fixture();
  f.blocked.add(key);
  assert.equal(f.binding.restore(key).ok, false);
  assert.equal(f.binding.shortcut, key);
  assert.equal(f.binding.isRegistered(), false);
  assert.deepEqual(f.delays, [1000]);
  f.blocked.clear();
  f.tick();
  assert.equal(f.binding.isRegistered(), true);
  assert.equal(f.binding.error, '');
  assert.equal(f.pending.size, 0);
  assert.equal(f.calls.trigger, 0, 'Recovery must not open the app or palette');
  f.registered.get(key)();
  assert.equal(f.calls.trigger, 1, 'Recovered registration keeps its original callback');
});

test('continued conflicts back off to one attempt per minute with a single timer', () => {
  const f = fixture();
  f.blocked.add(key);
  f.binding.restore(key);
  for (let i = 0; i < 5; i++) { assert.equal(f.pending.size, 1); f.tick(); }
  assert.deepEqual(f.delays, [1000, 3000, 10000, 30000, 60000, 60000]);
  assert.equal(f.binding.shortcut, key);
  assert.equal(f.registered.size, 0);
});

test('saving a healthy unchanged key does not release or duplicate registration', () => {
  const f = fixture();
  f.binding.restore(key);
  assert.equal(f.binding.set(key).ok, true);
  assert.equal(f.attempts.length, 1);
  assert.deepEqual(f.calls.released, []);
});

test('a missing registration is restored even when the saved combination is unchanged', () => {
  const f = fixture();
  f.binding.restore(key);
  f.registered.clear();
  assert.equal(f.binding.set(key).ok, true);
  assert.equal(f.attempts.length, 2);
  assert.equal(f.binding.isRegistered(), true);
});

test('rejected edits keep the old key working and never retry the unsaved replacement', () => {
  const f = fixture(), replacement = 'Control+Alt+F8';
  f.binding.restore(key);
  f.blocked.add(replacement);
  assert.equal(f.binding.set(replacement).ok, false);
  assert.equal(f.binding.shortcut, key);
  assert.equal(f.binding.isRegistered(), true);
  assert.equal(f.pending.size, 0);
  assert.deepEqual(f.calls.released, []);
  f.blocked.clear();
  f.binding.recover();
  assert.equal(f.registered.has(replacement), false);
});

test('changing the key cancels an old startup retry and binds only the accepted key', () => {
  const f = fixture(), replacement = 'Control+Alt+F8';
  f.blocked.add(key);
  f.binding.restore(key);
  assert.equal(f.binding.set(replacement).ok, true);
  assert.equal(f.pending.size, 0);
  assert.equal(f.binding.shortcut, replacement);
  assert.equal(f.registered.has(replacement), true);
  assert.equal(f.registered.has(key), false);
});

test('disabling or disposing cancels retries and never registers again', () => {
  for (const operation of ['clear', 'dispose']) {
    const f = fixture();
    f.blocked.add(key);
    f.binding.restore(key);
    f.binding[operation]();
    assert.equal(f.pending.size, 0);
    f.blocked.clear();
    f.binding.recover();
    assert.equal(f.registered.size, 0);
  }
});

test('invalid saved syntax is reported without an endless retry loop', () => {
  const f = fixture();
  assert.equal(f.binding.restore('InvalidKey').ok, false);
  assert.equal(f.binding.error, 'invalid');
  assert.equal(f.pending.size, 0);
});

test('another owner in the same process is neither mistaken for ours nor unregistered', () => {
  const f = fixture();
  const otherCallback = () => {};
  f.registered.set(key, otherCallback);
  assert.equal(f.binding.restore(key).ok, false);
  assert.equal(f.binding.isRegistered(), false);
  f.binding.dispose();
  assert.equal(f.registered.get(key), otherCallback);
  assert.deepEqual(f.calls.released, []);
});
