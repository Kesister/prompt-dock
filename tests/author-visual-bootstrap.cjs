// Isolated visual-smoke entry point. Give the compositor time to paint a
// synthetic dialog close/reopen before capture; no production code changes.
process.env.PROMPT_DOCK_SMOKE_TEST = '1';
const { app } = require('electron');
app.setAppPath(require('node:path').resolve(__dirname, '..'));
app.on('browser-window-created', (_, window) => {
  const capture = window.webContents.capturePage.bind(window.webContents);
  window.webContents.capturePage = async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 220));
    return capture(...args);
  };
});
require('../main.js');
