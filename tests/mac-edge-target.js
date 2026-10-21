// Real Edge receiver with a disposable browser profile and a loopback-only page.
// No remote debugging, personal tabs, form submission or user profile access.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const output = process.argv[2];
const mode = process.argv[3] || 'normal';
const token = randomUUID();
let browser;
const kind = mode.includes('rich') ? 'rich' : mode.includes('textarea') ? 'textarea' : mode.includes('password') ? 'password' : mode.includes('read-only') ? 'readonly' : 'text';
const html = `<!doctype html><meta charset="utf-8"><title>Prompt Dock — Edge 粘贴验证</title>
<style>body{font:20px system-ui;padding:32px}input,textarea,[contenteditable]{display:block;border:1px solid #888;padding:12px;width:90%;min-height:40px;margin:14px 0}</style>
<h1>Prompt Dock — Edge 粘贴验证</h1><p>此页仅接收测试文字，不会提交搜索。</p>
<input id="text" aria-label="Search"><textarea id="textarea" aria-label="Message"></textarea><div id="rich" role="textbox" contenteditable="true" aria-label="Rich message"></div><input id="password" type="password"><textarea id="readonly" readonly></textarea>
<script>
const field = document.getElementById(${JSON.stringify(kind)});
field.focus();
if (${JSON.stringify(mode.includes('selection'))}) {
  if (field.isContentEditable) {
    field.textContent = 'Replace this selected text';
    const range = document.createRange(); range.selectNodeContents(field);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  } else { field.value = 'Replace this selected text'; field.select(); }
}
const report = (name, text) => fetch('/${token}/' + name, {method:'POST', body:text});
field.addEventListener('input', () => report('input', field.isContentEditable ? field.textContent : field.value));
const focusState = () => ({focused:document.hasFocus(), element:document.activeElement?.id, selection:[field.selectionStart,field.selectionEnd]});
window.addEventListener('focus', () => report('focus', JSON.stringify(focusState())));
window.addEventListener('blur', () => report('focus', JSON.stringify(focusState())));
setTimeout(() => {
  const ready = setInterval(() => {
    if (!document.hasFocus()) return;
    field.focus();
    report('ready', JSON.stringify({ready:true, ...focusState()})); clearInterval(ready);
  }, 50);
}, 400);
</script>`;
const server = http.createServer((request, response) => {
  if (request.url === `/${token}/` && request.method === 'GET') {
    response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); response.end(html); return;
  }
  const name = ['ready', 'input', 'focus'].find(name => request.url === `/${token}/${name}`);
  if (request.method !== 'POST' || !name) { response.writeHead(404); response.end(); return; }
  let body = '';
  request.on('data', data => { body += data; if (body.length > 100000) request.destroy(); });
  request.on('end', () => {
    if (name === 'focus') fs.appendFileSync(output + '.focus', body + '\n');
    else fs.writeFileSync(output + (name === 'ready' ? '.ready' : ''), body);
    response.end('ok');
  });
});
server.listen(0, '127.0.0.1', () => {
  browser = spawn('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', [
    '--user-data-dir=' + path.join(path.dirname(output), 'edge-profile'),
    '--guest', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--new-window',
    `http://127.0.0.1:${server.address().port}/${token}/`
  ], {detached:true, stdio:'ignore'});
  fs.writeFileSync(output + '.pid', String(browser.pid));
});
function stop() {
  if (browser?.pid) { try { process.kill(-browser.pid, 'SIGTERM'); } catch {} }
  server.close(); process.exit();
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
setTimeout(stop, 45000).unref();
