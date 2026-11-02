const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const filename = path.join(__dirname, '..', 'slash-controller.js');
const localRequire = createRequire(filename);

function fixture(options = {}) {
  const registered = new Map(), attempts = [], spawned = [], windows = [], commands = [], copies = [];
  const state = { prompts: [{ id: 'sample', title: 'Sample', content: 'BODY', variants: [] }] };
  const ipcMain = new EventEmitter();
  let blocked = false, reads = 0;
  const globalShortcut = {
    register(key, callback) { attempts.push(key); if (blocked || registered.has(key)) return false; registered.set(key, callback); return true; },
    unregister: key => registered.delete(key), isRegistered: key => registered.has(key)
  };
  class FakeWindow extends EventEmitter {
    constructor(settings) {
      super(); windows.push(this); this.settings = settings; this.visible = false; this.focused = false; this.destroyed = false;
      this.focusable = settings.focusable; this.messages = [];
      this.webContents = new EventEmitter();
      this.webContents.send = (channel, value) => this.messages.push({ channel, value });
      this.webContents.focus = () => {};
      this.webContents.setWindowOpenHandler = () => {};
    }
    setMenuBarVisibility() {} loadFile(file) { this.file = file; return Promise.resolve(); }
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isFocused() { return this.focused; }
    isFocusable() { return this.focusable; } setFocusable(value) { this.focusable = value; }
    setBounds(value) { this.bounds = value; }
    show() { this.visible = true; } showInactive() { this.visible = true; }
    focus() { this.focused = true; } hide() { this.visible = this.focused = false; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const spawn = (executable, args, settings) => {
    const child = new EventEmitter();
    child.pid=1000+spawned.length;child.executable=executable;child.args=args;child.settings=settings;
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stdin = new EventEmitter(); child.stdin.writable = true;
    child.stdin.write = text => commands.push(JSON.parse(text));
    child.kill = () => child.emit('exit', 0);
    spawned.push(child);
    if(executable.endsWith('PromptDock.FocusGrant.exe')&&options.focusGrant!=='manual')setImmediate(()=>{
      child.stdout.emit('data',options.focusGrant==='denied'?'DENIED':'OK');child.emit('close',options.focusGrant==='denied'?3:0);
    });
    return child;
  };
  const screen = { screenToDipPoint: p => p, dipToScreenPoint: p => p, getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }) };
  const module = { exports: {} };
  const requireFake = name => {
    if (name === 'electron') return { globalShortcut, ipcMain, BrowserWindow: FakeWindow, screen, clipboard: { writeText: text => copies.push(text) } };
    if (name === 'child_process') return { spawn };
    return localRequire(name);
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: requireFake, __dirname: path.dirname(filename),
    process: { platform: 'win32', pid: 123 }, setTimeout, clearTimeout }, { filename });
  const controller = new module.exports.SlashController({
    readState: () => { reads++; return options.readState ? options.readState() : state; },
    onStatus: () => {}, recordUse: () => {}
  });
  return { controller, registered, attempts, spawned, windows, commands, copies, state, get reads() { return reads; },
    block: value => { blocked = value; },
    ready() { ipcMain.emit('slash:ready', { sender: controller.window.webContents }, { previewEnabled: true }); },
    rendered(value = controller.window.messages.filter(x => x.channel === 'slash:view').at(-1).value) {
      ipcMain.emit('slash:rendered', { sender: controller.window.webContents }, { session: value.session, revision: value.revision });
    }
  };
}
module.exports = { fixture };
