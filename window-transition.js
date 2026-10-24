const path = require('node:path');
const { randomUUID } = require('node:crypto');

class WindowTransition {
  constructor({ window, BrowserWindow, ipcMain, duration = 320 }) {
    Object.assign(this, { window, BrowserWindow, ipcMain, duration });
    this.proxy = null;
    this.active = null;
    this.pending = null;
    this.onAck = (event, token, phase) => {
      const pending = this.pending;
      if (pending && event.sender === pending.sender && token === pending.token && phase === pending.phase) {
        clearTimeout(pending.timer);
        this.pending = null;
        pending.resolve();
      }
    };
    ipcMain.on('window:transition-ack', this.onAck);
    this.onHide = () => this.cancel();
    this.onClosed = () => this.dispose();
    window.on('hide', this.onHide);
    window.on('closed', this.onClosed);
  }

  async ensureProxy() {
    if (this.proxy && !this.proxy.isDestroyed()) { await this.proxyReady; return this.proxy; }
    const proxy = new this.BrowserWindow({
      frame: false, transparent: true, backgroundColor: '#00000000', show: false,
      focusable: false, skipTaskbar: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, hasShadow: false, parent: this.window,
      webPreferences: { preload: path.join(__dirname, 'window-transition-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    this.proxy = proxy;
    proxy.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    proxy.webContents.on('will-navigate', event => event.preventDefault());
    proxy.on('closed', () => { if (this.proxy === proxy) { this.proxy = null; this.cancel(); } });
    this.proxyReady = proxy.loadFile(path.join(__dirname, 'window-transition.html'));
    await this.proxyReady;
    return proxy;
  }

  waitFor(sender, token, phase, send) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending = null; reject(new Error('Window transition timed out: ' + phase)); }, 2500);
      this.pending = { sender, token, phase, resolve, reject, timer };
      send();
    });
  }

  async prepare(target) {
    if (this.active) throw new Error('Window transition already active');
    const start = this.window.getBounds();
    const margin = 18;
    const union = {
      x: Math.min(start.x, target.x) - margin,
      y: Math.min(start.y, target.y) - margin,
      width: Math.max(start.x + start.width, target.x + target.width) - Math.min(start.x, target.x) + margin * 2,
      height: Math.max(start.y + start.height, target.y + target.height) - Math.min(start.y, target.y) + margin * 2
    };
    const token = randomUUID();
    const scene = { token, start, target, union, opacity: this.window.getOpacity(),
      throttling: this.window.webContents.getBackgroundThrottling() };
    this.active = scene;
    this.presentation = scene;
    this.window.webContents.setBackgroundThrottling(false);
    scene.timer = setTimeout(() => this.cancel(), 6000);
    try {
      const image = await this.window.webContents.capturePage();
      const proxy = await this.ensureProxy();
      if (this.active !== scene) throw new Error('Window transition cancelled');
      proxy.setBounds(union, false);
      proxy.setAlwaysOnTop(this.window.isAlwaysOnTop(), 'floating');
      await this.waitFor(proxy.webContents, token, 'prepared', () => proxy.webContents.send('window:transition-prepare', {
        token, source: image.toDataURL(), start: { ...start, x: start.x - union.x, y: start.y - union.y }
      }));
      proxy.showInactive();
      await this.waitFor(proxy.webContents, token, 'presented', () => proxy.webContents.send('window:transition-present', token));
      if (this.active !== scene) throw new Error('Window transition cancelled');
      this.window.setOpacity(0);
      return token;
    } catch {
      this.cancel();
      return null;
    }
  }

  async run(token, resize) {
    const scene = this.active;
    if (!scene || scene.token !== token) throw new Error('Window transition expired');
    let result;
    let resized = false;
    try {
      result = await resize();
      resized = true;
      const proxy = this.proxy;
      proxy.setBounds(scene.union, false);
      await this.waitFor(this.window.webContents, token, 'layout', () => this.window.webContents.send('window:transition-layout', token));
      const image = await this.window.webContents.capturePage();
      const target = this.window.getBounds();
      await this.waitFor(proxy.webContents, token, 'complete', () => proxy.webContents.send('window:transition-play', {
        token, target: { ...target, x: target.x - scene.union.x, y: target.y - scene.union.y },
        destination: image.toDataURL(), duration: this.duration
      }));
      return result;
    } catch (error) {
      if (resized) return result;
      throw error;
    } finally {
      this.cancel();
    }
  }

  cancel() {
    const scene = this.active;
    this.active = null;
    if (scene) clearTimeout(scene.timer);
    const presentation = this.presentation;
    this.presentation = null;
    if (presentation && !this.window.isDestroyed()) {
      this.window.setOpacity(presentation.opacity);
      this.window.webContents.setBackgroundThrottling(presentation.throttling);
    }
    if (this.proxy && !this.proxy.isDestroyed()) {
      this.proxy.hide();
      this.proxy.webContents.send('window:transition-clear');
    }
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(new Error('Window transition cancelled'));
    }
  }

  dispose() {
    this.cancel();
    const proxy = this.proxy;
    this.proxy = null;
    if (proxy && !proxy.isDestroyed()) proxy.destroy();
    this.ipcMain.removeListener('window:transition-ack', this.onAck);
    this.window.removeListener('hide', this.onHide);
    this.window.removeListener('closed', this.onClosed);
  }
}

module.exports = { WindowTransition };
