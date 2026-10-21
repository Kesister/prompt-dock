// Isolated Chromium receiver. Records test input events, never submits a form.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const output = process.argv[1];
const mode = process.argv[2] || 'normal';
app.setPath('userData', path.join(path.dirname(output), 'browser-profile'));
app.on('accessibility-support-changed', (_event, enabled) => fs.appendFileSync(output + '.accessibility', JSON.stringify({ enabled, time: Date.now() }) + '\n'));
// Default to the same lazy accessibility tree as a normal Chromium app.
// Opt in only when explicitly comparing an already-enabled tree.
if (process.env.PROMPT_DOCK_BROWSER_FORCE_ACCESSIBILITY === '1') app.commandLine.appendSwitch('force-renderer-accessibility');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 700, height: 450, title: 'Prompt Dock isolated Chromium receiver', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const kind = mode.includes('rich') ? 'rich' : mode.includes('textarea') ? 'textarea' : mode.includes('password') ? 'password' : mode.includes('read-only') ? 'readonly' : 'text';
  const html = '<!doctype html><meta charset="utf-8"><style>body{font:18px system-ui;padding:30px}input,textarea,[contenteditable]{display:block;border:1px solid #888;padding:14px;width:90%;min-height:40px}</style><h1>Prompt Dock Chromium test</h1>'
    + '<input id="text" aria-label="Search"><textarea id="textarea" aria-label="Message"></textarea><div id="rich" contenteditable="true" role="textbox" aria-label="Rich message"></div><input id="password" type="password" aria-label="Password"><textarea id="readonly" readonly aria-label="Read only"></textarea>';
  window.webContents.on('console-message', (_event, _level, message) => {
    if (message.startsWith('PD_INPUT:')) fs.writeFileSync(output, JSON.parse(message.slice(9)));
  });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  window.show(); app.focus({ steal: true }); window.focus(); window.webContents.focus();
  await window.webContents.executeJavaScript(`(() => {
    const field = document.getElementById(${JSON.stringify(kind)});
    field.focus();
    if (${JSON.stringify(mode.includes('selection'))}) {
      if (field.isContentEditable) {
        field.textContent = 'Replace this selected text';
        const range = document.createRange(); range.selectNodeContents(field);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      } else { field.value = 'Replace this selected text'; field.select(); }
    }
    field.addEventListener('input', () => console.log('PD_INPUT:' + JSON.stringify(field.isContentEditable ? field.textContent : field.value)));
  })()`);
  setTimeout(() => {
    fs.writeFileSync(output + '.ready', JSON.stringify({ ready: true }));
    if (mode === 'bootstrap') app.quit();
  }, 400);
});
