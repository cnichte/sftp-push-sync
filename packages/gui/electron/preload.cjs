// packages/gui/electron/preload.cjs
// CommonJS on purpose: sandboxed Electron preload scripts do not reliably
// support ESM (`import`) — see /memories/repo/electron-gui-notes.md.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("sftpPushSync", {
  appVersion: process.env.npm_package_version || "0.0.0",
  listConnections: () => ipcRenderer.invoke("list-connections"),
  updateConnection: (configPath, name, updates) =>
    ipcRenderer.invoke("update-connection", { configPath, name, updates }),
  pickNewConfigLocation: () => ipcRenderer.invoke("pick-new-config-location"),
  createConnection: (configPath, name) => ipcRenderer.invoke("create-connection", { configPath, name }),
  revealInFolder: (configPath) => ipcRenderer.send("reveal-in-folder", configPath),
  addConfigPath: (configPath) => ipcRenderer.invoke("add-config-path", configPath),
  removeConfigPath: (configPath) => ipcRenderer.invoke("remove-config-path", configPath),
  // Dateien, die per OS-Drag&Drop reinkommen, haben unter contextIsolation
  // keinen nutzbaren `.path` mehr — webUtils.getPathForFile ist der offizielle
  // Ersatz dafür.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  startJob: (connection, flags, cols, rows) =>
    ipcRenderer.invoke("start-job", { connection, flags, cols, rows }),
  abortJob: (id) => ipcRenderer.invoke("abort-job", { id }),
  resizeJob: (id, cols, rows) => ipcRenderer.send("resize-job", { id, cols, rows }),
  onJobData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("job-data", listener);
    return () => ipcRenderer.removeListener("job-data", listener);
  },
  onJobExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("job-exit", listener);
    return () => ipcRenderer.removeListener("job-exit", listener);
  },
  getAppInfo: () => ipcRenderer.invoke("get-app-info"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  startUpdateDownload: () => ipcRenderer.invoke("start-update-download"),
  quitAndInstall: () => ipcRenderer.invoke("quit-and-install"),
  onUpdateEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("update-event", listener);
    return () => ipcRenderer.removeListener("update-event", listener);
  },
});
