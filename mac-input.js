const { spawn } = require('node:child_process');

// One native process owns target snapshots for both the main window and palette.
class MacInput {
  constructor(executable, owner) {
    this.pending = new Map();
    this.sequence = 0;
    this.ready = new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 5000);
      this.markReady = value => { clearTimeout(timer); resolve(value); };
    });
    this.child = spawn(executable, [String(owner)], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const reply = JSON.parse(line);
          if (reply.type === 'ready') {
            this.markReady(true);
            // A delayed first launch may outlive the initial readiness timer.
            // Future hotkeys can recover, without sending an expired request.
            this.ready = Promise.resolve(true);
            continue;
          }
          this.pending.get(reply.request)?.(reply);
        } catch {}
      }
    });
    const stopped = () => {
      this.stopped = true;
      this.markReady(false);
      for (const resolve of this.pending.values()) resolve({ ok: false, reason: 'helper-unavailable' });
    };
    this.child.on('error', stopped);
    this.child.on('exit', stopped);
    this.child.stdin.on('error', stopped);
  }
  async request(type, payload = {}, timeoutMs = 2200) {
    // Keep the existing startup allowance for permission/paste operations.
    // Only hotkey capture must include readiness in its short deadline.
    if (type !== 'capture' && (!await this.ready || this.stopped)) return { ok: false, reason: 'helper-unavailable' };
    const request = ++this.sequence;
    return new Promise(resolve => {
      let done = false;
      const finish = result => { if (done) return; done = true; clearTimeout(timer); this.pending.delete(request); resolve(result); };
      // The deadline includes startup, so a silent helper cannot hold the popup.
      const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
      this.ready.then(ready => {
        if (done) return;
        if (!ready || this.stopped) { finish({ ok: false, reason: 'helper-unavailable' }); return; }
        this.pending.set(request, finish);
        this.child.stdin.write(JSON.stringify({ ...payload, type, request }) + '\n');
      });
    });
  }
  capture() { return this.request('capture', {}, 200); }
  permissionStatus() { return this.request('permission'); }
  paste(token) { return this.request('paste', { token }); }
  restore(token) { return this.request('restore', { token }); }
  dispose() { this.child.kill(); }
}

const reasons = {
  permission: '内容已复制。请在系统设置 → 隐私与安全性 → 辅助功能中允许 Prompt Dock，再重试；也可手动 ⌘V。',
  password: '识别到密码输入框，已跳过直接粘贴。内容已复制。',
  'read-only': '当前位置为只读区域，内容已复制，请手动粘贴。',
  'target-changed': '输入位置已改变，内容已复制，请手动 ⌘V。'
};
function pasteMessage(reason) {
  return reasons[reason] || '未能确认可编辑的输入位置，内容已复制，请回到输入框手动 ⌘V。';
}
module.exports = { MacInput, pasteMessage };
