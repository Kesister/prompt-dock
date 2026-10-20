const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("slash", {
  onState: fn => ipcRenderer.on("slash:view", (_, value) => fn(value)),
  onKey: fn => ipcRenderer.on("slash:key", (_, value) => fn(value)),
  onFocus: fn => ipcRenderer.on("slash:focus", () => fn()),
  onPreview: fn => ipcRenderer.on("slash:preview", (_, value) => fn(value)),
  onHidden: fn => ipcRenderer.on("slash:hidden", () => fn()),
  action: value => ipcRenderer.send("slash:action", value),
  ready: options => ipcRenderer.send("slash:ready", options)
});
