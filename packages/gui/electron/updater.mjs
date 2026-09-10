// packages/gui/electron/updater.mjs
// electron-updater ist ein CommonJS-Modul ohne benannte ESM-Exports —
// über den Default-Export destrukturieren statt `import { autoUpdater }`.
import pkg from "electron-updater";
const { autoUpdater } = pkg;

// electron-updater braucht eine gepackte App (Signatur/Feed-Metadaten) und
// funktioniert im Dev-Modus nicht sinnvoll — siehe TODO-GUI.md P7.
// Update-Feed-URL kommt aus package.json > build.publish (generic provider),
// electron-builder schreibt das beim Bauen in app-update.yml.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

export function initUpdater({ logger, onEvent }) {
  autoUpdater.logger = {
    info: (...args) => logger.info(args.join(" ")),
    warn: (...args) => logger.warn(args.join(" ")),
    error: (...args) => logger.error(args.join(" ")),
  };

  autoUpdater.on("checking-for-update", () => onEvent({ type: "checking" }));
  autoUpdater.on("update-available", (info) =>
    onEvent({ type: "available", version: info.version, releaseNotes: info.releaseNotes })
  );
  autoUpdater.on("update-not-available", () => onEvent({ type: "not-available" }));
  autoUpdater.on("download-progress", (progress) =>
    onEvent({ type: "progress", percent: progress.percent, bytesPerSecond: progress.bytesPerSecond })
  );
  autoUpdater.on("update-downloaded", (info) => onEvent({ type: "downloaded", version: info.version }));
  autoUpdater.on("error", (err) => onEvent({ type: "error", message: err?.message || String(err) }));
}

export function checkForUpdates() {
  return autoUpdater.checkForUpdates();
}

export function downloadUpdate() {
  return autoUpdater.downloadUpdate();
}

export function quitAndInstall() {
  autoUpdater.quitAndInstall();
}
