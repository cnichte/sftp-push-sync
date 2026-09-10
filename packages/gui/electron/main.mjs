// packages/gui/electron/main.mjs
import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import winston from "winston";
import { startJob, abortJob, resizeJob } from "./jobManager.mjs";
import { initSettingsStore, getConfigPaths, addConfigPath, removeConfigPath } from "./settingsStore.mjs";
import { initUpdater, checkForUpdates, downloadUpdate, quitAndInstall } from "./updater.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require("../package.json");

// Fallback, solange der Nutzer noch keine sync.config.json registriert hat
// (siehe DEBUG-LOG-UI.md: Config-Dateien liegen projektweise verstreut).
function getDefaultConfigPath() {
  return path.resolve(process.cwd(), "sync.config.json");
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
      const projectName = path.basename(path.dirname(cfgPath));
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

// Startet einen Sync-Job in einem Pseudo-Terminal (siehe jobManager.mjs für
// die Connection-Lock- und Overlap-Regeln). Rohe Terminal-Bytes und der
// Exit-Status werden pro Connection-ID an den Renderer zurückgestreamt, wo
// xterm.js sie rendert (identische Darstellung wie im echten Terminal,
// inklusive Fortschrittsbalken).
ipcMain.handle("start-job", async (event, { connection, flags, cols, rows }) => {
  const result = startJob({
    connection,
    flags: flags || [],
    cols,
    rows,
    onData: (chunk) => {
      event.sender.send("job-data", { connectionId: connection.id, chunk });
    },
    onExit: (code, signal) => {
      event.sender.send("job-exit", { connectionId: connection.id, code, signal });
    },
  });
  logger.info(`start-job ${connection.id}: ${result.ok ? "started" : "rejected"}`);
  return result;
});

ipcMain.handle("abort-job", async (_event, { id }) => {
  return { ok: abortJob(id) };
});

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
