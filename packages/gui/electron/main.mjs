// packages/gui/electron/main.mjs
import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import fs from "fs/promises";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import winston from "winston";
import SftpClient from "ssh2-sftp-client";
import { startJob, abortJob, resizeJob } from "./jobManager.mjs";
import { initSettingsStore, getConfigPaths, addConfigPath, removeConfigPath, saveJobHistory, getJobHistory, getProjectJobHistory, getHistorySettings, updateHistoryLimit, clearHistoryExceptLatest } from "./settingsStore.mjs";
import { initUpdater, checkForUpdates, downloadUpdate, quitAndInstall } from "./updater.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const DEFAULT_MEDIA_EXTENSIONS = [
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".tif", ".tiff",
  ".mp4", ".mov", ".m4v", ".mp3", ".wav", ".flac",
];

function historyLogIsRelevant(log) {
  const clean = String(log?.line || "").replace(/^\s*\[[^\]]+\]\s*/, "");
  if (/^\s*(?:dir ok:|directory ok:)/i.test(clean)) return false;
  return /^\s*[+~-](?:\s|$)/.test(clean)
    || /\b(?:error|failed|failure|exception|warning|could not|aborted)\b/i.test(clean)
    || /(?:^|\b)(?:summary|total|performance|metrics?)\s*:/i.test(clean);
}

// Fallback, solange der Nutzer noch keine sync.config.json registriert hat
// (siehe DEBUG-LOG-UI.md: Config-Dateien liegen projektweise verstreut).
function getDefaultConfigPath() {
  return path.resolve(process.cwd(), "sync.config.json");
}

async function getFileInfo(filePath) {
  try {
    const info = await fs.stat(filePath);
    return { path: filePath, exists: true, size: info.size, modifiedAt: info.mtime.toISOString() };
  } catch (error) {
    if (error?.code === "ENOENT") return { path: filePath, exists: false };
    throw error;
  }
}

async function renameConnectionFiles({ configPath, config, connection, oldName, newName }) {
  const projectDir = path.dirname(configPath);
  const logPattern = config.logFile || ".sync.{target}.log";
  const oldLegacyCache = connection.syncCache || `.sync-cache.${oldName}.json`;
  const newLegacyCache = oldLegacyCache.includes(oldName)
    ? oldLegacyCache.replaceAll(oldName, newName)
    : oldLegacyCache;
  const candidates = [
    [logPattern.replace("{target}", oldName), logPattern.replace("{target}", newName)],
    [`.sync-cache.${oldName}.ndjson`, `.sync-cache.${newName}.ndjson`],
    [`.sync-recovery.${oldName}.json`, `.sync-recovery.${newName}.json`],
    [oldLegacyCache, newLegacyCache],
    [`${oldLegacyCache}.bak`, `${newLegacyCache}.bak`],
    [`${oldLegacyCache}.migrated`, `${newLegacyCache}.migrated`],
    [`${oldLegacyCache}.corrupt`, `${newLegacyCache}.corrupt`],
  ].map(([from, to]) => [path.resolve(projectDir, from), path.resolve(projectDir, to)])
    .filter(([from, to]) => from !== to);

  for (const [from, to] of candidates) {
    try {
      await fs.access(from);
    } catch {
      continue;
    }
    try {
      await fs.access(to);
      throw new Error(`Zieldatei existiert bereits: ${to}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const renamed = [];
  try {
    for (const [from, to] of candidates) {
      try {
        await fs.rename(from, to);
        renamed.push([from, to]);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  } catch (error) {
    await Promise.allSettled(renamed.reverse().map(([from, to]) => fs.rename(to, from)));
    throw error;
  }

  if (connection.syncCache?.includes(oldName)) {
    connection.syncCache = newLegacyCache;
  }
}

function isLocalNetworkHost(host) {
  return host && (!host.includes(".") || host.endsWith(".local") || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host));
}

async function requestLocalNetworkAccess() {
  if (process.platform !== "darwin") return;

  const registered = await getConfigPaths();
  const candidates = registered.length > 0 ? registered : [getDefaultConfigPath()];

  for (const configPath of candidates) {
    try {
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      const connection = Object.values(config.connections || {})
        .map((entry) => entry.sync ?? entry)
        .find((entry) => isLocalNetworkHost(entry.host));
      if (!connection) continue;

      const socket = net.connect({ host: connection.host, port: connection.port ?? 22 });
      socket.setTimeout(1_500);
      socket.once("connect", () => socket.destroy());
      socket.once("timeout", () => socket.destroy());
      socket.once("error", () => socket.destroy());
      socket.unref();
      return;
    } catch (error) {
      logger.debug(`Local network access check skipped: ${error?.message || error}`);
    }
  }
}

// App-weites Logging (Main-Prozess). Pro-Job-Logs kommen später über die
// Child-Prozesse selbst (siehe TODO-GUI.md P4).
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({
      filename: path.join(app.getPath("userData"), "gui.log"),
    }),
  ],
});
if (!app.isPackaged) {
  logger.add(new winston.transports.Console({ format: winston.format.simple() }));
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: `${pkg.build?.productName || pkg.name} v${app.getVersion()}`,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (!app.isPackaged) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  logger.info("Main window created");
}

app.whenReady().then(() => {
  initSettingsStore(app.getPath("userData"));
  createWindow();
  requestLocalNetworkAccess();

  initUpdater({
    logger,
    onEvent: (payload) => mainWindow?.webContents.send("update-event", payload),
  });
  // Im Dev-Modus gibt es keinen signierten Build/Feed — nur in der gepackten
  // App nach Updates suchen (siehe TODO-GUI.md P7).
  if (app.isPackaged) {
    checkForUpdates().catch((err) => logger.warn(`checkForUpdates failed: ${err?.message || err}`));
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Liest Connections aus allen registrierten sync.config.json-Dateien
// (mehrere Projekte, siehe DEBUG-LOG-UI.md). Solange nichts registriert ist,
// fällt es auf die cwd-relative Datei zurück (Kompatibilität zum bisherigen
// Verhalten / CLI-Default). Jede Connection bekommt eine über die Config-Datei
// eindeutige `id`, da Namen projektübergreifend kollidieren können.
ipcMain.handle("list-connections", async () => {
  const registered = await getConfigPaths();
  const candidates = registered.length > 0 ? registered : [getDefaultConfigPath()];
  const connections = [];
  const errors = [];

  for (const cfgPath of candidates) {
    try {
      const raw = JSON.parse(await fs.readFile(cfgPath, "utf8"));
      const projectName = raw.projectName || path.basename(path.dirname(cfgPath));
      for (const [name, cfg] of Object.entries(raw.connections || {})) {
        const sync = cfg.sync ?? cfg;
        const sidecar = cfg.sidecar ?? {};
        connections.push({
          id: `${cfgPath}::${name}`,
          name,
          configPath: cfgPath,
          projectName,
          host: cfg.host,
          port: cfg.port ?? 22,
          user: cfg.user ?? "",
          password: cfg.password ?? "",
          description: cfg.description ?? "",
          workerUpload: cfg.workerUpload ?? cfg.worker ?? 2,
          workerList: cfg.workerList ?? 5,
          localRoot: sync.localRoot ?? "",
          remoteRoot: sync.remoteRoot ?? "",
          // Für den Overlap-Check (jobManager.findConflict): relative
          // localRoot-Werte (z.B. "public") müssen gegen das jeweilige
          // Projektverzeichnis aufgelöst werden, nicht gegen das cwd des
          // Electron-Prozesses — sonst kollidieren gleichnamige relative
          // Ordner aus verschiedenen Projekten fälschlich miteinander.
          localRootAbs: path.resolve(path.dirname(cfgPath), sync.localRoot ?? ""),
          sidecarLocalRoot: sidecar.localRoot ?? "",
          sidecarRemoteRoot: sidecar.remoteRoot ?? "",
          sidecarUploadList: sidecar.uploadList ?? [],
          sidecarDownloadList: sidecar.downloadList ?? [],
        });
      }
    } catch (err) {
      logger.warn(`Could not read ${cfgPath}: ${err?.message || err}`);
      errors.push({ configPath: cfgPath, error: err?.message || String(err) });
    }
  }

  return { ok: errors.length === 0, connections, errors, configPaths: candidates };
});

ipcMain.handle("get-project-settings", async (_event, configPath) => {
  try {
    const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
    return {
      ok: true,
      settings: {
        projectName: raw.projectName || path.basename(path.dirname(configPath)),
        hasCustomProjectName: Boolean(raw.projectName),
        parallelScan: raw.parallelScan ?? true,
        cleanupEmptyDirs: raw.cleanupEmptyDirs ?? true,
        include: raw.include ?? [],
        exclude: raw.exclude ?? [],
        textExtensions: raw.textExtensions ?? [],
        mediaExtensions: raw.mediaExtensions ?? DEFAULT_MEDIA_EXTENSIONS,
        scanChunk: raw.progress?.scanChunk ?? 10,
        analyzeChunk: raw.progress?.analyzeChunk ?? 1,
        logLevel: raw.logLevel ?? "normal",
        logTimestamps: raw.logTimestamps ?? false,
        logFile: raw.logFile ?? ".sftp-push-sync.{target}.log",
      },
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle("test-connection", async (_event, connection) => {
  const sftp = new SftpClient();
  try {
    await sftp.connect({
      host: connection.host,
      port: Number(connection.port) || 22,
      username: connection.user,
      password: connection.password,
    });
    const remotePath = await sftp.cwd();
    return { ok: true, remotePath };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  } finally {
    await sftp.end().catch(() => {});
  }
});

ipcMain.handle("update-project-settings", async (_event, { configPath, settings }) => {
  try {
    const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
    const projectName = settings.projectName.trim();
    if (!projectName) return { ok: false, error: "Project name must not be empty" };
    if (settings.resetProjectName) delete raw.projectName;
    else raw.projectName = projectName;
    raw.parallelScan = Boolean(settings.parallelScan);
    raw.cleanupEmptyDirs = Boolean(settings.cleanupEmptyDirs);
    raw.include = settings.include;
    raw.exclude = settings.exclude;
    raw.textExtensions = settings.textExtensions;
    raw.mediaExtensions = settings.mediaExtensions;
    raw.progress = {
      ...(raw.progress || {}),
      scanChunk: Number(settings.scanChunk) || 1,
      analyzeChunk: Number(settings.analyzeChunk) || 1,
    };
    raw.logLevel = settings.logLevel;
    raw.logTimestamps = Boolean(settings.logTimestamps);
    raw.logFile = settings.logFile;
    await fs.writeFile(configPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle("get-job-files", async (_event, { configPath, name }) => {
  try {
    const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
    if (!raw.connections?.[name]) return { ok: false, error: `Connection '${name}' not found in ${configPath}` };
    const projectDir = path.dirname(configPath);
    const logPattern = raw.logFile || ".sync.{target}.log";
    const logPath = path.resolve(projectDir, logPattern.replace("{target}", name));
    const cachePath = path.resolve(projectDir, `.sync-cache.${name}.ndjson`);
    return { ok: true, log: await getFileInfo(logPath), cache: await getFileInfo(cachePath) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle("show-job-file", async (_event, filePath) => {
  shell.showItemInFolder(filePath);
  return { ok: true };
});

ipcMain.handle("open-job-file", async (_event, filePath) => {
  const error = await shell.openPath(filePath);
  return error ? { ok: false, error } : { ok: true };
});

ipcMain.handle("open-external", async (_event, url) => {
  if (!/^https?:\/\//i.test(String(url))) return { ok: false, error: "Only HTTP(S) URLs are allowed." };
  await shell.openExternal(String(url));
  return { ok: true };
});

ipcMain.handle("delete-job-cache", async (_event, filePath) => {
  try {
    await fs.unlink(filePath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

// Schreibt bearbeitete Properties zurück in die jeweilige sync.config.json.
// Nur die Connection mit `name` wird angefasst, der Rest der Datei (andere
// Connections, globale Settings) bleibt unverändert.
ipcMain.handle("update-connection", async (_event, { configPath, name, updates }) => {
  try {
    const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
    const cfg = raw.connections?.[name];
    if (!cfg) {
      return { ok: false, error: `Connection '${name}' not found in ${configPath}` };
    }

    // Der Connection-Name ist der JSON-Key selbst — bei Umbenennung den Key
    // im `connections`-Objekt ersetzen statt nur ein Feld zu schreiben.
    const newName = (updates.name || name).trim();
    if (!newName) {
      return { ok: false, error: "Connection name must not be empty" };
    }
    if (newName !== name) {
      if (raw.connections[newName]) {
        return { ok: false, error: `Connection '${newName}' already exists in ${configPath}` };
      }
      await renameConnectionFiles({ configPath, config: raw, connection: cfg, oldName: name, newName });
      delete raw.connections[name];
      raw.connections[newName] = cfg;
    }

    cfg.host = updates.host;
    cfg.port = Number(updates.port) || 22;
    cfg.user = updates.user;
    cfg.password = updates.password;
    cfg.description = updates.description;
    cfg.workerUpload = Number(updates.workerUpload) || 1;
    cfg.workerList = Number(updates.workerList) || 1;

    const sync = cfg.sync ?? (cfg.sync = {});
    sync.localRoot = updates.localRoot;
    sync.remoteRoot = updates.remoteRoot;

    const sidecar = cfg.sidecar ?? (cfg.sidecar = {});
    sidecar.localRoot = updates.sidecarLocalRoot;
    sidecar.remoteRoot = updates.sidecarRemoteRoot;
    sidecar.uploadList = updates.sidecarUploadList;
    sidecar.downloadList = updates.sidecarDownloadList;

    await fs.writeFile(configPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
    return { ok: true, id: `${configPath}::${newName}` };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// "Ordner im Finder/Explorer anzeigen" für den Pfad der sync.config.json.
ipcMain.on("reveal-in-folder", (_event, configPath) => {
  shell.showItemInFolder(configPath);
});

// Für "Neuer Job": Speicherort für eine neue sync.config.json wählen
// (Datei selbst wird erst von create-connection angelegt, siehe unten).
ipcMain.handle("pick-new-config-location", async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "New sync.config.json location",
    defaultPath: "sync.config.json",
    filters: [{ name: "sync.config.json", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return { ok: false };
  return { ok: true, configPath: result.filePath };
});

// Legt eine neue Connection an — entweder in einer bereits registrierten
// sync.config.json oder (falls die Datei noch nicht existiert) in einer neu
// angelegten Skeleton-Datei an dem zuvor gewählten Speicherort.
ipcMain.handle("create-connection", async (_event, { configPath, name }) => {
  try {
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(configPath, "utf8"));
    } catch {
      raw = { connections: {} };
    }
    raw.connections ??= {};
    if (raw.connections[name]) {
      return { ok: false, error: `Connection '${name}' already exists in ${configPath}` };
    }

    raw.connections[name] = {
      host: "",
      port: 22,
      user: "",
      password: "",
      description: "",
      workerUpload: 2,
      workerList: 5,
      sync: { localRoot: "", remoteRoot: "" },
    };

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
    await addConfigPath(configPath);
    return { ok: true, id: `${configPath}::${name}` };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// Registriert eine weitere sync.config.json (Drag&Drop liefert den Pfad direkt;
// ohne Pfad öffnet sich ein natives Dateiauswahl-Fenster als Fallback).
ipcMain.handle("add-config-path", async (_event, providedPath) => {
  let target = providedPath;
  if (!target) {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Add sync.config.json",
      properties: ["openFile"],
      filters: [{ name: "sync.config.json", extensions: ["json"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false };
    target = result.filePaths[0];
  }
  try {
    await addConfigPath(target);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle("remove-config-path", async (_event, targetPath) => {
  await removeConfigPath(targetPath);
  return { ok: true };
});

// Startet einen Sync-Job mit strukturierten Core-Events und einem separaten
// Protokollstrom für die technische Detailansicht.
ipcMain.handle("start-job", async (event, { connection, flags, cols, rows }) => {
  const abortOnRendererReset = () => {
    if (abortJob(connection.id)) {
      logger.info(`abort-job ${connection.id}: renderer reset`);
    }
  };
  const removeRendererLifecycleHandlers = () => {
    event.sender.removeListener("destroyed", abortOnRendererReset);
  };
  const result = startJob({
    connection,
    flags: flags || [],
    cols,
    rows,
    onData: (log) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("job-data", { connectionId: connection.id, log });
      }
    },
    onEvent: (jobEvent) => {
      if (jobEvent.type === "complete") {
        saveJobHistory(connection, {
          ...jobEvent,
          logs: (jobEvent.logs || []).filter(historyLogIsRelevant),
        }).catch((error) => {
          logger.warn(`Could not save job history for ${connection.id}: ${error?.message || error}`);
        });
      }
      if (!event.sender.isDestroyed()) {
        event.sender.send("job-event", { connectionId: connection.id, event: jobEvent });
      }
    },
    onExit: (code, signal) => {
      removeRendererLifecycleHandlers();
      if (!event.sender.isDestroyed()) {
        event.sender.send("job-exit", { connectionId: connection.id, code, signal });
      }
    },
  });
  if (result.ok) {
    event.sender.once("destroyed", abortOnRendererReset);
  }
  logger.info(`start-job ${connection.id}: ${result.ok ? "started" : "rejected"}`);
  return result;
});

ipcMain.handle("abort-job", async (_event, { id }) => {
  return { ok: abortJob(id) };
});

ipcMain.handle("get-job-history", async (_event, connectionId) => ({
  ok: true,
  history: await getJobHistory(connectionId),
}));

ipcMain.handle("get-project-job-history", async (_event, configPath) => ({
  ok: true,
  history: await getProjectJobHistory(configPath),
}));

ipcMain.handle("get-history-settings", async () => getHistorySettings());
ipcMain.handle("update-history-limit", async (_event, limit) => updateHistoryLimit(limit));
ipcMain.handle("clear-history-except-latest", async () => clearHistoryExceptLatest());

ipcMain.on("resize-job", (_event, { id, cols, rows }) => {
  resizeJob(id, cols, rows);
});

// App-Info für den About-Dialog (Name, Version, Autor, Homepage aus package.json).
ipcMain.handle("get-app-info", () => ({
  name: pkg.productName || pkg.build?.productName || pkg.name,
  version: app.getVersion(),
  author: typeof pkg.author === "string" ? pkg.author : pkg.author?.name,
  homepage: pkg.homepage,
  electron: process.versions.electron,
  node: process.versions.node,
}));

// Auto-Update (siehe updater.mjs). Downloads werden nur auf Nutzeraktion
// gestartet (autoDownload=false) — der Nutzer entscheidet über den
// Update-Bereich im Settings-Fenster, wann heruntergeladen/installiert wird.
ipcMain.handle("check-for-updates", async () => {
  try {
    await checkForUpdates();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle("start-update-download", async () => {
  try {
    await downloadUpdate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle("quit-and-install", () => {
  quitAndInstall();
});
