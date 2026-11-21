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
});
