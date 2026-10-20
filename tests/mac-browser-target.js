// Isolated Chromium receiver. Records test input events, never submits a form.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const output = process.argv[1];
const mode = process.argv[2] || 'normal';
app.setPath('userData', path.join(path.dirname(output), 'browser-profile'));
app.commandLine.appendSwitch('force-renderer-accessibility');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 700, height: 450, title: 'Prompt Dock isolated Chromium receiver', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const kind = mode.includes('rich') ? 'rich' : mode.includes('textarea') ? 'textarea' : mode === 'password' ? 'password' : mode === 'read-only' ? 'readonly' : 'text';
  const html = '<!doctype html><meta charset="utf-8"><style>body{font:18px system-ui;padding:30px}input,textarea,[contenteditable]{display:block;border:1px solid #888;padding:14px;width:90%;min-height:40px}</style><h1>Prompt Dock Chromium test</h1>'
    + '<input id="text" aria-label="Search"><textarea id="textarea" aria-label="Message"></textarea><div id="rich" contenteditable="true" role="textbox" aria-label="Rich message"></div><input id="password" type="password" aria-label="Password"><textarea id="readonly" readonly aria-label="Read only"></textarea>';
  window.webContents.on('console-message', (_event, _level, message) => {
    if (message.startsWith('PD_INPUT:')) fs.writeFileSync(output, JSON.parse(message.slice(9)));
  });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  window.show(); app.focus({ steal: true }); window.focus(); window.webContents.focus();
  await window.webContents.executeJavaScript(`(() => { const field = document.getElementById(${JSON.stringify(kind)}); field.focus(); field.addEventListener('input', () => console.log('PD_INPUT:' + JSON.stringify(field.isContentEditable ? field.textContent : field.value))); })()`);
  setTimeout(() => fs.writeFileSync(output + '.ready', JSON.stringify({ ready: true })), 400);
});
