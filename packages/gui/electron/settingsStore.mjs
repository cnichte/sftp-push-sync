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
    cache = { configPaths: [] };
  }
  if (!Array.isArray(cache.configPaths)) cache.configPaths = [];
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
