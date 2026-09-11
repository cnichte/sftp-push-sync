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
    cache = { configPaths: [], jobHistory: {}, historyLimit: 10 };
  }
  if (!Array.isArray(cache.configPaths)) cache.configPaths = [];
  if (!cache.jobHistory || typeof cache.jobHistory !== "object") cache.jobHistory = {};
  cache.historyLimit = Math.max(1, Math.min(100, Number(cache.historyLimit) || 10));
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
  const entry = {
    connectionId: connection.id,
    configPath: connection.configPath,
    name: connection.name,
    projectName: connection.projectName,
    completedAt: new Date().toISOString(),
    ...summary,
  };
  const previous = Array.isArray(settings.jobHistory[connection.id])
    ? settings.jobHistory[connection.id]
    : settings.jobHistory[connection.id]
      ? [settings.jobHistory[connection.id]]
      : [];
  settings.jobHistory[connection.id] = [entry, ...previous].slice(0, settings.historyLimit);
  await persist();
  return entry;
}

export async function getJobHistory(connectionId) {
  const settings = await load();
  const history = settings.jobHistory[connectionId];
  return Array.isArray(history) ? history[0] || null : history || null;
}

export async function getProjectJobHistory(configPath) {
  const settings = await load();
  return Object.values(settings.jobHistory)
    .flatMap((entries) => Array.isArray(entries) ? entries : [entries])
    .filter((entry) => entry?.configPath === configPath)
    .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)));
}

export async function getHistorySettings() {
  const settings = await load();
  const entries = Object.values(settings.jobHistory).flatMap((history) => Array.isArray(history) ? history : [history]);
  const bytes = Buffer.byteLength(JSON.stringify(entries), "utf8");
  return { limit: settings.historyLimit, count: entries.length, bytes };
}

export async function updateHistoryLimit(limit) {
  const settings = await load();
  settings.historyLimit = Math.max(1, Math.min(100, Number(limit) || 10));
  for (const [connectionId, entries] of Object.entries(settings.jobHistory)) {
    const history = Array.isArray(entries) ? entries : [entries];
    settings.jobHistory[connectionId] = history.slice(0, settings.historyLimit);
  }
  await persist();
  return getHistorySettings();
}

export async function clearHistoryExceptLatest() {
  const settings = await load();
  for (const [connectionId, entries] of Object.entries(settings.jobHistory)) {
    const history = Array.isArray(entries) ? entries : [entries];
    settings.jobHistory[connectionId] = history.slice(0, 1);
  }
  await persist();
  return getHistorySettings();
}
