const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const filename = path.join(__dirname, '..', 'slash-controller.js');
const localRequire = createRequire(filename);
const shortcut = 'Control+Alt+Space';

function fixture() {
  const registered = new Map();
  const attempts = [];
  let blocked = false;
  const globalShortcut = {
    register(key, callback) {
      attempts.push(key);
      if (blocked || registered.has(key)) return false;
      registered.set(key, callback);
      return true;
    },
    unregister: key => registered.delete(key),
    isRegistered: key => registered.has(key)
  };
  const spawned = [];
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stdin = new EventEmitter();
    child.stdin.writable = true;
    child.stdin.write = () => {};
    child.kill = () => child.emit('exit', 0);
    spawned.push(child);
    return child;
  };
  const module = { exports: {} };
  const fakeRequire = name => {
    if (name === 'electron') return { globalShortcut, ipcMain: new EventEmitter() };
    if (name === 'child_process') return { spawn: fakeSpawn };
    return localRequire(name);
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, require: fakeRequire, __dirname: path.dirname(filename),
    process: { platform: 'win32', pid: 123 }, setTimeout, clearTimeout
  }, { filename });
  const controller = new module.exports.SlashController({
    readState: () => { throw new Error('This test must never read a prompt library.'); },
    onStatus: () => {}, recordUse: () => {}
  });
  return { controller, registered, attempts, spawned, block: value => { blocked = value; } };
}

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
  assert.equal(f.controller.window, null);
  assert.equal(f.registered.has(shortcut), true);
});
