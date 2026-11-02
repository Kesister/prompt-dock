const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WindowTransition } = require('../window-transition');

function fixture() {
  const ipcMain = new EventEmitter();
  const windows = [];
  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      this.bounds = { x: -900, y: 40, width: 1080, height: 700 };
      this.opacity = 1;
      this.visible = true;
      this.destroyed = false;
      this.sizes = [];
      this.messages = [];
      this.webContents = new EventEmitter();
      this.webContents.getBackgroundThrottling = () => true;
      this.webContents.setBackgroundThrottling = () => {};
      this.webContents.capturePage = async () => ({ toDataURL: () => 'data:image/png;base64,test' });
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (channel, value) => {
        this.messages.push({ channel, value });
        const phases = { 'window:transition-prepare': 'prepared', 'window:transition-present': 'presented',
          'window:transition-layout': 'layout', 'window:transition-play': 'complete' };
        const phase = phases[channel];
        if (phase) queueMicrotask(() => ipcMain.emit('window:transition-ack', { sender: this.webContents },
          typeof value === 'string' ? value : value.token, phase));
      };
    }
    getBounds() { return { ...this.bounds }; }
    setBounds(value) { this.bounds = { ...value }; this.sizes.push({ value, opacity: this.opacity }); }
    getOpacity() { return this.opacity; }
    setOpacity(value) { this.opacity = value; }
    isDestroyed() { return this.destroyed; }
    isAlwaysOnTop() { return false; }
    setAlwaysOnTop() {}
    showInactive() { this.visible = true; }
    hide() { this.visible = false; this.emit('hide'); }
    destroy() { this.destroyed = true; this.emit('closed'); }
    loadFile() { return Promise.resolve(); }
  }
  const window = new FakeWindow();
  class ProxyWindow extends FakeWindow { constructor() { super(); windows.push(this); } }
  const transition = new WindowTransition({ window, BrowserWindow: ProxyWindow, ipcMain });
  return { transition, window, ipcMain, windows, target: { x: -240, y: 40, width: 420, height: 520 } };
}

test('preparation paints a non-activating proxy before hiding the real window', async () => {
  const f = fixture();
  const token = await f.transition.prepare(f.target);
  assert.equal(typeof token, 'string');
  assert.equal(f.window.opacity, 0);
  assert.equal(f.window.sizes.length, 0);
  assert.equal(f.windows[0].visible, true);
  assert.equal(f.windows[0].messages[0].channel, 'window:transition-prepare');
  f.transition.dispose();
  assert.equal(f.window.opacity, 1);
});

test('resize occurs once under the proxy and reveals only the settled target layout', async () => {
  const f = fixture();
  const token = await f.transition.prepare(f.target);
  const result = await f.transition.run(token, () => { f.window.setBounds(f.target); return 'resized'; });
  assert.equal(result, 'resized');
  assert.equal(f.window.sizes.length, 1);
  assert.equal(f.window.sizes[0].opacity, 0);
  assert.equal(f.window.opacity, 1);
  assert.equal(f.windows[0].visible, false);
  assert.equal(f.transition.active, null);
  assert.equal(f.transition.pending, null);
  const play = f.windows[0].messages.find(message => message.channel === 'window:transition-play');
  assert.equal(play.value.duration, 320);
  assert.ok(play.value.target.x >= 0 && play.value.target.y >= 0);
  assert.equal(f.windows[0].messages.at(-1).channel, 'window:transition-clear');
  f.transition.dispose();
});

test('an expired or foreign token cannot resize the real window', async () => {
  const f = fixture();
  await f.transition.prepare(f.target);
  await assert.rejects(f.transition.run('foreign-token', () => f.window.setBounds(f.target)), /expired/);
  assert.equal(f.window.sizes.length, 0);
  f.transition.dispose();
});

test('native resize failure restores opacity and removes the temporary picture', async () => {
  const f = fixture();
  const token = await f.transition.prepare(f.target);
  await assert.rejects(f.transition.run(token, () => { throw new Error('resize failed'); }), /resize failed/);
  assert.equal(f.window.opacity, 1);
  assert.equal(f.windows[0].visible, false);
  assert.equal(f.transition.pending, null);
  f.transition.dispose();
});

test('hiding the owner cancels the picture without reopening the owner', async () => {
  const f = fixture();
  await f.transition.prepare(f.target);
  f.window.hide();
  assert.equal(f.window.visible, false);
  assert.equal(f.window.opacity, 1);
  assert.equal(f.windows[0].visible, false);
  assert.equal(f.transition.active, null);
  f.transition.dispose();
});

test('closing the owner destroys the proxy and releases IPC listeners', async () => {
  const f = fixture();
  await f.transition.prepare(f.target);
  f.window.destroy();
  assert.equal(f.windows[0].destroyed, true);
  assert.equal(f.ipcMain.listenerCount('window:transition-ack'), 0);
});

test('failed capture falls back without leaving the real window transparent', async () => {
  const f = fixture();
  f.window.opacity = 0.8;
  f.window.webContents.capturePage = async () => { throw new Error('capture failed'); };
  assert.equal(await f.transition.prepare(f.target), null);
  assert.equal(f.window.opacity, 0.8);
  assert.equal(f.transition.active, null);
  f.transition.dispose();
});

test('overlapping preparation is rejected and the existing scene remains recoverable', async () => {
  const f = fixture();
  const token = await f.transition.prepare(f.target);
  await assert.rejects(f.transition.prepare(f.target), /already active/);
  assert.equal(f.transition.active.token, token);
  f.transition.dispose();
});

test('a renderer acknowledgement must match the sender, token and phase', async () => {
  const f = fixture();
  const sender = {};
  const done = f.transition.waitFor(sender, 'known-token', 'complete', () => {});
  f.ipcMain.emit('window:transition-ack', { sender: {} }, 'known-token', 'complete');
  f.ipcMain.emit('window:transition-ack', { sender }, 'foreign-token', 'complete');
  f.ipcMain.emit('window:transition-ack', { sender }, 'known-token', 'prepared');
  assert.notEqual(f.transition.pending, null);
  f.ipcMain.emit('window:transition-ack', { sender }, 'known-token', 'complete');
  await done;
  assert.equal(f.transition.pending, null);
  f.transition.dispose();
});

test('repeated toggles reuse the proxy instead of creating new animation windows', async () => {
  const f = fixture();
  const first = await f.transition.prepare(f.target);
  await f.transition.run(first, () => f.window.setBounds(f.target));
  const second = await f.transition.prepare({ x: -900, y: 40, width: 1080, height: 700 });
  assert.notEqual(first, second);
  assert.equal(f.windows.length, 1);
  f.transition.dispose();
});

test('a failed visual handoff still reveals the resized window with the matching mode result', async () => {
  const f = fixture();
  const token = await f.transition.prepare(f.target);
  f.transition.waitFor = async () => { throw new Error('paint failed'); };
  const result = await f.transition.run(token, () => { f.window.setBounds(f.target); return 'compact'; });
  assert.equal(result, 'compact');
  assert.equal(f.window.opacity, 1);
  assert.equal(f.windows[0].visible, false);
  assert.deepEqual(f.window.bounds, f.target);
  f.transition.dispose();
});
