const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sugentCompanion", {
  resize: (width, height) => ipcRenderer.send("companion:resize", { width, height }),
  moveBy: (dx, dy) => ipcRenderer.send("companion:move-by", { dx, dy }),
  dragEnd: () => ipcRenderer.send("companion:drag-end"),
  openMain: (hash) => ipcRenderer.send("companion:open-main", String(hash || "")),
  hide: () => ipcRenderer.send("companion:hide"),
  onToggleQuickBar: (fn) => {
    const handler = () => fn();
    ipcRenderer.on("companion:toggle-quick-bar", handler);
    return () => ipcRenderer.removeListener("companion:toggle-quick-bar", handler);
  },
  onContext: (fn) => {
    const handler = (_e, data) => fn(data);
    ipcRenderer.on("companion:context", handler);
    return () => ipcRenderer.removeListener("companion:context", handler);
  },
  onPointer: (fn) => {
    const handler = (_e, data) => fn(data);
    ipcRenderer.on("companion:pointer", handler);
    return () => ipcRenderer.removeListener("companion:pointer", handler);
  },
  onSignal: (fn) => {
    const handler = (_e, data) => fn(data);
    ipcRenderer.on("companion:signal", handler);
    return () => ipcRenderer.removeListener("companion:signal", handler);
  },
  showContextMenu: (opts) => ipcRenderer.send("companion:show-context-menu", opts || {}),
  handoffToMain: (payload) => ipcRenderer.send("companion:handoff", payload || {}),
  setDockMode: (mode) => ipcRenderer.send("companion:set-dock-mode", String(mode || "screen")),
});
