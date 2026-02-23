const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("flashApi", {
  getConfig: () => ipcRenderer.invoke("app:get-config"),
  estimate: (payload) => ipcRenderer.invoke("tx:estimate", payload),
  send: (payload) => ipcRenderer.invoke("tx:send", payload),
  history: () => ipcRenderer.invoke("tx:history")
});
