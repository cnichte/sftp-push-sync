// packages/gui/electron/settingsStore.mjs
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

// Persistiert App-weite GUI-Einstellungen (aktuell: registrierte
// sync.config.json-Pfade) in app.getPath("userData") — getrennt von der
// eigentlichen Sync-Konfiguration, die weiterhin pro Projekt liegt.
let settingsPath = null;
let cache = null;

export function initSettingsStore(userDataDir) {
  settingsPath = path.join(userDataDir, "gui-settings.json");
}

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fsp.readFile(settingsPath, "utf8"));
  } catch {
    cache = { configPaths: [], jobHistory: {} };
  }
  if (!Array.isArray(cache.configPaths)) cache.configPaths = [];
  if (!cache.jobHistory || typeof cache.jobHistory !== "object") cache.jobHistory = {};
  return cache;
}

async function persist() {
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsp.writeFile(settingsPath, JSON.stringify(cache, null, 2), "utf8");
}

export async function getConfigPaths() {
  const settings = await load();
  return [...settings.configPaths];
}

export async function addConfigPath(configPath) {
  const settings = await load();
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File does not exist: ${resolved}`);
  }
  if (!settings.configPaths.includes(resolved)) {
    settings.configPaths.push(resolved);
    await persist();
  }
  return [...settings.configPaths];
}

export async function removeConfigPath(configPath) {
  const settings = await load();
  const resolved = path.resolve(configPath);
  settings.configPaths = settings.configPaths.filter((p) => p !== resolved);
  await persist();
  return [...settings.configPaths];
}

export async function saveJobHistory(connection, summary) {
  const settings = await load();
  settings.jobHistory[connection.id] = {
    connectionId: connection.id,
    configPath: connection.configPath,
    name: connection.name,
    projectName: connection.projectName,
    completedAt: new Date().toISOString(),
    ...summary,
  };
  await persist();
  return settings.jobHistory[connection.id];
}

export async function getJobHistory(connectionId) {
  const settings = await load();
  return settings.jobHistory[connectionId] || null;
}

export async function getProjectJobHistory(configPath) {
  const settings = await load();
  return Object.values(settings.jobHistory)
    .filter((entry) => entry.configPath === configPath)
    .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)));
}
