#!/usr/bin/env node
/**
 ** sftp-push-sync.mjs - SFTP Syncronisations Tool
 *
 * @author Carsten Nichte, 2025 / https://carsten-nichte.de/
 *
 * SFTP push sync with dry run
 * 1. Upload new files
 * 2. Delete remote files that no longer exist locally
 * 3. Detect changes based on size or modified content and upload them
 * 4. Supports separate sidecar upload/download lists for special files
 *
 * Features:
 *  - multiple connections in sync.config.json
 *  - dry-run mode
 *  - mirrors local → remote
 *  - adds, updates, deletes files
 *  - text diff detection
 *  - Binary files (images, video, audio, PDF, etc.): SHA-256 hash comparison
 *  - Hashes are cached in .sync-cache.json to save space.
 *  - Parallel uploads/deletes via worker pool
 *  - include/exclude patterns
 *
 * Special cases:
 * - Files can be excluded from synchronisation.
 * - For example, log files or other special files.
 * - These files can be downloaded or uploaded separately.
 *
 * Folder handling:
 *  Delete Folders if
 *  - If, for example, a directory is empty because all files have been deleted from it.
 *  - Or if a directory no longer exists locally.
 * 
 * The file sftp-push-sync.mjs is pure JavaScript (ESM), not TypeScript.
 * Node.js can execute it directly as long as "type": "module" is specified in package.json
 * or the file has the extension .mjs.
 */
// bin/sftp-push-sync.mjs
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import SftpClient from "ssh2-sftp-client";
import { minimatch } from "minimatch";
import { diffWords } from "diff";
import { createHash } from "crypto";
import { Writable } from "stream";
import pc from "picocolors";

// get Versionsnummer
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pkg = require("../package.json");

// Colors for the State (works on dark + light background)
const ADD = pc.green("+"); // Added
const CHA = pc.yellow("~"); // Changed
const DEL = pc.red("-"); // Deleted
const EXC = pc.redBright("-"); // Excluded

const hr1 = () => "─".repeat(65); // horizontal line -
const hr2 = () => "=".repeat(65); // horizontal line =
const tab_a = () => " ".repeat(3); // indentation for formatting the terminal output.
const tab_b = () => " ".repeat(6);

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const TARGET = args[0];
const DRY_RUN = args.includes("--dry-run");
const RUN_UPLOAD_LIST = args.includes("--sidecar-upload");
const RUN_DOWNLOAD_LIST = args.includes("--sidecar-download");
const SKIP_SYNC = args.includes("--skip-sync");

// logLevel override via CLI (optional)
let cliLogLevel = null;
if (args.includes("--verbose")) cliLogLevel = "verbose";
if (args.includes("--laconic")) cliLogLevel = "laconic";

if (!TARGET) {
  console.error(pc.red("❌ Please specify a connection profile:"));
  console.error(pc.yellow(`${tab_a()}sftp-push-sync staging --dry-run`));
  process.exit(1);
}

// Wenn jemand --skip-sync ohne Listen benutzt → sinnlos, also abbrechen
if (SKIP_SYNC && !RUN_UPLOAD_LIST && !RUN_DOWNLOAD_LIST) {
  console.error(
    pc.red(
      "❌ --skip-sync requires at least --sidecar-upload or --sidecar-download."
    )
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load config file
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.resolve("sync.config.json");

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(pc.red(`❌ Configuration file missing: ${CONFIG_PATH}`));
  process.exit(1);
}

let CONFIG_RAW;
try {
  CONFIG_RAW = JSON.parse(await fsp.readFile(CONFIG_PATH, "utf8"));
} catch (err) {
  console.error(pc.red("❌ Error reading sync.config.json:"), err.message);
  process.exit(1);
}

if (!CONFIG_RAW.connections || typeof CONFIG_RAW.connections !== "object") {
  console.error(pc.red("❌ sync.config.json must have a 'connections' field."));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Logging helpers (Terminal + optional Logfile)
// ---------------------------------------------------------------------------

// Default: .sync.{TARGET}.log, kann via config.logFile überschrieben werden
const DEFAULT_LOG_FILE = `.sync.${TARGET}.log`;
const rawLogFilePattern = CONFIG_RAW.logFile || DEFAULT_LOG_FILE;
const LOG_FILE = path.resolve(rawLogFilePattern.replace("{target}", TARGET));
let LOG_STREAM = null;

/** einmalig Logfile-Stream öffnen */
function openLogFile() {
  if (!LOG_FILE) return;
  if (!LOG_STREAM) {
    LOG_STREAM = fs.createWriteStream(LOG_FILE, {
      flags: "w", // pro Lauf überschreiben
      encoding: "utf8",
    });
  }
}

/** eine fertige Zeile ins Logfile schreiben (ohne Einfluss auf Terminal) */
function writeLogLine(line) {
  if (!LOG_STREAM) return;
  // ANSI-Farbsequenzen aus der Log-Zeile entfernen
  const clean =
    typeof line === "string"
      ? line.replace(/\x1b\[[0-9;]*m/g, "")
      : String(line).replace(/\x1b\[[0-9;]*m/g, "");
  try {
    LOG_STREAM.write(clean + "\n");
  } catch {
    // falls Stream schon zu ist, einfach ignorieren – verhindert ERR_STREAM_WRITE_AFTER_END
  }
}

/** Konsole + Logfile (normal) */
function rawConsoleLog(...msg) {
  clearProgressLine();
  console.log(...msg);
  const line = msg
    .map((m) => (typeof m === "string" ? m : String(m)))
    .join(" ");
  writeLogLine(line);
}

function rawConsoleError(...msg) {
  clearProgressLine();
  console.error(...msg);
  const line = msg
    .map((m) => (typeof m === "string" ? m : String(m)))
    .join(" ");
  writeLogLine("[ERROR] " + line);
}

function rawConsoleWarn(...msg) {
  clearProgressLine();
  console.warn(...msg);
  const line = msg
    .map((m) => (typeof m === "string" ? m : String(m)))
    .join(" ");
  writeLogLine("[WARN] " + line);
}

// High-level Helfer
function log(...msg) {
  rawConsoleLog(...msg);
}

function vlog(...msg) {
  if (!IS_VERBOSE) return;
  rawConsoleLog(...msg);
}

function elog(...msg) {
  rawConsoleError(...msg);
}

function wlog(...msg) {
  rawConsoleWarn(...msg);
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const TARGET_CONFIG = CONFIG_RAW.connections[TARGET];
if (!TARGET_CONFIG) {
  console.error(
    pc.red(`❌ Connection '${TARGET}' not found in sync.config.json.`)
  );
  process.exit(1);
}

// Haupt-Sync-Config + Sidecar
const SYNC_CFG = TARGET_CONFIG.sync ?? TARGET_CONFIG;
const SIDECAR_CFG = TARGET_CONFIG.sidecar ?? {};

if (!SYNC_CFG.localRoot || !SYNC_CFG.remoteRoot) {
  console.error(
    pc.red(
      `❌ Connection '${TARGET}' is missing sync.localRoot or sync.remoteRoot.`
    )
  );
  process.exit(1);
}

const CONNECTION = {
  host: TARGET_CONFIG.host,
  port: TARGET_CONFIG.port ?? 22,
  user: TARGET_CONFIG.user,
  password: TARGET_CONFIG.password,
  // Main sync roots
  localRoot: path.resolve(SYNC_CFG.localRoot),
  remoteRoot: SYNC_CFG.remoteRoot,
  // Sidecar roots (für sidecar-upload / sidecar-download)
  sidecarLocalRoot: path.resolve(SIDECAR_CFG.localRoot ?? SYNC_CFG.localRoot),
  sidecarRemoteRoot: SIDECAR_CFG.remoteRoot ?? SYNC_CFG.remoteRoot,
  workers: TARGET_CONFIG.worker ?? 2,
};

// ---------------------------------------------------------------------------
// LogLevel + Progress aus Config
// ---------------------------------------------------------------------------

// logLevel: "verbose", "normal", "laconic"
let LOG_LEVEL = (CONFIG_RAW.logLevel ?? "normal").toLowerCase();

// Override config with CLI flags
if (cliLogLevel) {
  LOG_LEVEL = cliLogLevel;
}

const IS_VERBOSE = LOG_LEVEL === "verbose";
const IS_LACONIC = LOG_LEVEL === "laconic";

const PROGRESS = CONFIG_RAW.progress ?? {};
const SCAN_CHUNK = PROGRESS.scanChunk ?? (IS_VERBOSE ? 1 : 100);
const ANALYZE_CHUNK = PROGRESS.analyzeChunk ?? (IS_VERBOSE ? 1 : 10);
// For >100k files, rather 10–50, for debugging/troubleshooting 1.

// Leere Verzeichnisse nach dem Sync entfernen?
const CLEANUP_EMPTY_DIRS = CONFIG_RAW.cleanupEmptyDirs ?? true;
const CLEANUP_EMPTY_ROOTS = CONFIG_RAW.cleanupEmptyRoots ?? false;

// ---------------------------------------------------------------------------
// Shared config from JSON
// ---------------------------------------------------------------------------

const INCLUDE = CONFIG_RAW.include ?? [];
const BASE_EXCLUDE = CONFIG_RAW.exclude ?? [];

// textExtensions
const TEXT_EXT = CONFIG_RAW.textExtensions ?? [
  ".html",
  ".htm",
  ".xml",
  ".txt",
  ".json",
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".md",
  ".svg",
];

// mediaExtensions – aktuell nur Meta, aber schon konfigurierbar
const MEDIA_EXT = CONFIG_RAW.mediaExtensions ?? [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".avif",
  ".mp4",
  ".mov",
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".pdf",
];

// Special: Lists for targeted uploads/downloads (per-connection sidecar)
function normalizeList(list) {
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) =>
    typeof item === "string"
      ? item
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : []
  );
}

// Lists from sidecar config (relative to sidecar.localRoot / sidecar.remoteRoot)
const UPLOAD_LIST = normalizeList(SIDECAR_CFG.uploadList ?? []);
const DOWNLOAD_LIST = normalizeList(SIDECAR_CFG.downloadList ?? []);

// Effektive Exclude-Liste: explizites exclude + Upload/Download-Listen
// → diese Dateien werden im „normalen“ Sync nicht angerührt,
//   sondern nur über die Sidecar-Mechanik behandelt.
const EXCLUDE = [...BASE_EXCLUDE, ...UPLOAD_LIST, ...DOWNLOAD_LIST];

// List of ALL files that were ausgeschlossen durch uploadList/downloadList
const AUTO_EXCLUDED = new Set();

// Cache file name per connection
const syncCacheName = TARGET_CONFIG.syncCache || `.sync-cache.${TARGET}.json`;
const CACHE_PATH = path.resolve(syncCacheName);

// ---------------------------------------------------------------------------
// Load/initialise hash cache
// ---------------------------------------------------------------------------

let CACHE = {
  version: 1,
  local: {}, // key: "<TARGET>:<relPath>" -> { size, mtimeMs, hash }
  remote: {}, // key: "<TARGET>:<relPath>" -> { size, modifyTime, hash }
};

try {
  if (fs.existsSync(CACHE_PATH)) {
    const raw = JSON.parse(await fsp.readFile(CACHE_PATH, "utf8"));
    CACHE.version = raw.version ?? 1;
    CACHE.local = raw.local ?? {};
    CACHE.remote = raw.remote ?? {};
  }
} catch (err) {
  console.warn(
    pc.yellow("⚠️ Could not load cache, starting without:"),
    err.message
  );
}

function cacheKey(relPath) {
  return `${TARGET}:${relPath}`;
}

let cacheDirty = false;
let cacheDirtyCount = 0;
const CACHE_FLUSH_INTERVAL = 50; // Write cache to disk after 50 new hashes

async function saveCache(force = false) {
  if (!cacheDirty && !force) return;
  const data = JSON.stringify(CACHE, null, 2);
  await fsp.writeFile(CACHE_PATH, data, "utf8");
  cacheDirty = false;
  cacheDirtyCount = 0;
}

async function markCacheDirty() {
  cacheDirty = true;
  cacheDirtyCount += 1;
  if (cacheDirtyCount >= CACHE_FLUSH_INTERVAL) {
    await saveCache();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let progressActive = false;

// Spinner-Frames für Progress-Zeilen
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerIndex = 0;

function clearProgressLine() {
  if (!process.stdout.isTTY || !progressActive) return;

  // Zwei Progress-Zeilen ohne zusätzliche Newlines leeren:
  // Cursor steht nach updateProgress2() auf der ersten Zeile.
  process.stdout.write("\r"); // an Zeilenanfang
  process.stdout.write("\x1b[2K"); // erste Zeile löschen
  process.stdout.write("\x1b[1B"); // eine Zeile nach unten
  process.stdout.write("\x1b[2K"); // zweite Zeile löschen
  process.stdout.write("\x1b[1A"); // wieder nach oben

  progressActive = false;
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function matchesAny(patterns, relPath) {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => minimatch(relPath, pattern, { dot: true }));
}

function isIncluded(relPath) {
  // Include-Regeln
  if (INCLUDE.length > 0 && !matchesAny(INCLUDE, relPath)) return false;
  // Exclude-Regeln
  if (EXCLUDE.length > 0 && matchesAny(EXCLUDE, relPath)) {
    // Falls durch Sidecar-Listen → merken
    if (UPLOAD_LIST.includes(relPath) || DOWNLOAD_LIST.includes(relPath)) {
      AUTO_EXCLUDED.add(relPath);
    }
    return false;
  }
  return true;
}

function isTextFile(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  return TEXT_EXT.includes(ext);
}

function isMediaFile(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  return MEDIA_EXT.includes(ext);
}

function shortenPathForProgress(rel) {
  if (!rel) return "";
  const parts = rel.split("/");
  if (parts.length === 1) {
    return rel; // nur Dateiname
  }
  if (parts.length === 2) {
    return rel; // schon kurz genug
  }

  const last = parts[parts.length - 1];
  const prev = parts[parts.length - 2];

  // z.B. …/images/foo.jpg
  return `…/${prev}/${last}`;
}

// Two-line progress bar (for terminal) + 1-line log entry
function updateProgress2(prefix, current, total, rel = "", suffix="Files") {
  const short = rel ? shortenPathForProgress(rel) : "";

  // Log file: always as a single line with **full** rel path
  const base =
    total && total > 0
      ? `${prefix}${current}/${total} ${suffix}`
      : `${prefix}${current} ${suffix}`;
  writeLogLine(`[progress] ${base}${rel ? " – " + rel : ""}`);

  const frame = SPINNER_FRAMES[spinnerIndex];
  spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;

  if (!process.stdout.isTTY) {
    // Fallback-Terminal
    if (total && total > 0) {
      const percent = ((current / total) * 100).toFixed(1);
      console.log(
        `${tab_a()}${frame} ${prefix}${current}/${total} ${suffix} (${percent}%) – ${short}`
      );
    } else {
      console.log(`${tab_a()}${frame} ${prefix}${current} ${suffix} – ${short}`);
    }
    return;
  }

  const width = process.stdout.columns || 80;

  let line1;
  if (total && total > 0) {
    const percent = ((current / total) * 100).toFixed(1);
    line1 = `${tab_a()}${frame} ${prefix}${current}/${total} Files (${percent}%)`;
  } else {
    // „unknown total“ / Scanner-Modus
    line1 = `${tab_a()}${frame} ${prefix}${current} Files`;
  }

  let line2 = short;

  if (line1.length > width) line1 = line1.slice(0, width - 1);
  if (line2.length > width) line2 = line2.slice(0, width - 1);

  // zwei Zeilen überschreiben
  process.stdout.write("\r" + line1.padEnd(width) + "\n");
  process.stdout.write(line2.padEnd(width));

  // Cursor wieder nach oben (auf die Fortschrittszeile)
  process.stdout.write("\x1b[1A");

  progressActive = true;
}

// Simple worker pool for parallel tasks
async function runTasks(items, workerCount, handler, label = "Tasks") {
  if (!items || items.length === 0) return;

  const total = items.length;
  let done = 0;
  let index = 0;

  async function worker() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const i = index;
      if (i >= total) break;
      index += 1;
      const item = items[i];
      try {
        await handler(item);
      } catch (err) {
        elog(pc.red(`${tab_a()}⚠️ Error in ${label}:`), err.message || err);
      }
      done += 1;
      if (done === 1 || done % 10 === 0 || done === total) {
        updateProgress2(`${label}: `, done, total, item.rel ?? "");
      }
    }
  }

  const workers = [];
  const actualWorkers = Math.max(1, Math.min(workerCount, total));
  for (let i = 0; i < actualWorkers; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Directory-Statistiken (für Summary)
// ---------------------------------------------------------------------------

const DIR_STATS = {
  ensuredDirs: 0, // Verzeichnisse, die wir während "Preparing remote directories" geprüft haben
  createdDirs: 0, // Verzeichnisse, die wirklich neu angelegt wurden
  cleanupVisited: 0, // Verzeichnisse, die während Cleanup inspiziert wurden
  cleanupDeleted: 0, // Verzeichnisse, die gelöscht wurden
};

// ---------------------------------------------------------------------------
// Neue Helper: Verzeichnisse für Uploads/Updates vorbereiten
// ---------------------------------------------------------------------------

function collectDirsFromChanges(changes) {
  const dirs = new Set();

  for (const item of changes) {
    const rel = item.rel;
    if (!rel) continue;

    const parts = rel.split("/");
    if (parts.length <= 1) continue; // Dateien im Root

    let acc = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      dirs.add(acc);
    }
  }

  // flachere Pfade zuerst, damit Eltern vor Kindern angelegt werden
  return [...dirs].sort(
    (a, b) => a.split("/").length - b.split("/").length
  );
}

async function ensureAllRemoteDirsExist(sftp, remoteRoot, toAdd, toUpdate) {
  const dirs = collectDirsFromChanges([...toAdd, ...toUpdate]);
  const total = dirs.length;
  DIR_STATS.ensuredDirs += total;

  if (total === 0) return;

  let current = 0;

  for (const relDir of dirs) {
    current += 1;
    const remoteDir = path.posix.join(remoteRoot, relDir);

    // Fortschritt: in der zweiten Zeile den Pfad anzeigen
    updateProgress2("Prepare dirs: ", current, total, relDir);

    try {
      const exists = await sftp.exists(remoteDir);
      if (!exists) {
        await sftp.mkdir(remoteDir, true);
        DIR_STATS.createdDirs += 1;
        vlog(`${tab_a()}${pc.dim("dir created:")} ${remoteDir}`);
      } else {
        vlog(`${tab_a()}${pc.dim("dir ok:")} ${remoteDir}`);
      }
    } catch (e) {
      wlog(
        pc.yellow("⚠️  Could not ensure directory:"),
        remoteDir,
        e.message || e
      );
    }
  }

  // Zeile „fertig“ markieren und Progress-Flag zurücksetzen
  updateProgress2("Prepare dirs: ", total, total, "fertig");
  process.stdout.write("\n");
  progressActive = false;
}

// -----------------------------------------------------------
// Cleanup: remove *only truly empty* directories on remote
// -----------------------------------------------------------

async function cleanupEmptyDirs(sftp, rootDir) {
  // Rekursiv prüfen, ob ein Verzeichnis und seine Unterverzeichnisse
  // KEINE Dateien enthalten. Nur dann löschen wir es.
  async function recurse(dir, depth = 0) {
    DIR_STATS.cleanupVisited += 1;

    const relForProgress =
      toPosix(path.relative(rootDir, dir)) || ".";

    // Fortschritt: aktuelle Directory in zweiter Zeile anzeigen
    updateProgress2(
      "Cleanup dirs: ",
      DIR_STATS.cleanupVisited,
      0,
      relForProgress, 
      "Folders"
    );

    let hasFile = false;
    const subdirs = [];

    let items;
    try {
      items = await sftp.list(dir);
    } catch (e) {
      // Falls das Verzeichnis inzwischen weg ist o.ä., brechen wir hier ab.
      wlog(
        pc.yellow("⚠️  Could not list directory during cleanup:"),
        dir,
        e.message || e
      );
      return false;
    }

    for (const item of items) {
      if (!item.name || item.name === "." || item.name === "..") continue;

      if (item.type === "d") {
        subdirs.push(item);
      } else {
        // Jede Datei (egal ob sie nach INCLUDE/EXCLUDE
        // sonst ignoriert würde) verhindert das Löschen.
        hasFile = true;
      }
    }

    // Erst alle Unterverzeichnisse aufräumen (post-order)
    let allSubdirsEmpty = true;
    for (const sub of subdirs) {
      const full = path.posix.join(dir, sub.name);
      const subEmpty = await recurse(full, depth + 1);
      if (!subEmpty) {
        allSubdirsEmpty = false;
      }
    }

    const isRoot = dir === rootDir;
    const isEmpty = !hasFile && allSubdirsEmpty;

    // Root nur löschen, wenn explizit erlaubt
    if (isEmpty && (!isRoot || CLEANUP_EMPTY_ROOTS)) {
      const rel = relForProgress || ".";
      if (DRY_RUN) {
        log(`${tab_a()}${DEL} (DRY-RUN) Remove empty directory: ${rel}`);
        DIR_STATS.cleanupDeleted += 1;
      } else {
        try {
          // Nicht rekursiv: wir löschen nur, wenn unser eigener Check "leer" sagt.
          await sftp.rmdir(dir, false);
          log(`${tab_a()}${DEL} Removed empty directory: ${rel}`);
          DIR_STATS.cleanupDeleted += 1;
        } catch (e) {
          wlog(
            pc.yellow("⚠️  Could not remove directory:"),
            dir,
            e.message || e
          );
          // Falls rmdir scheitert, betrachten wir das Verzeichnis als "nicht leer"
          return false;
        }
      }
    }

    return isEmpty;
  }

  await recurse(rootDir, 0);

  if (DIR_STATS.cleanupVisited > 0) {
    updateProgress2(
      "Cleanup dirs: ",
      DIR_STATS.cleanupVisited,
      DIR_STATS.cleanupVisited,
      "fertig", "Folders"
    );
    process.stdout.write("\n");
    progressActive = false;
  }
}

// ---------------------------------------------------------------------------
// Local file walker (recursive, all subdirectories)
// ---------------------------------------------------------------------------

async function walkLocal(root) {
  const result = new Map();
  let scanned = 0;

  async function recurse(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await recurse(full);
      } else if (entry.isFile()) {
        const rel = toPosix(path.relative(root, full));

        if (!isIncluded(rel)) continue;

        const stat = await fsp.stat(full);
        result.set(rel, {
          rel,
          localPath: full,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          isText: isTextFile(rel),
          isMedia: isMediaFile(rel),
        });

        scanned += 1;
        const chunk = IS_VERBOSE ? 1 : SCAN_CHUNK;
        if (scanned === 1 || scanned % chunk === 0) {
          updateProgress2("Scan local: ", scanned, 0, rel);
        }
      }
    }
  }

  await recurse(root);

  if (scanned > 0) {
    updateProgress2("Scan local: ", scanned, 0, "fertig");
    process.stdout.write("\n");
    progressActive = false;
  }

  return result;
}

// Plain walker für Bypass (ignoriert INCLUDE/EXCLUDE)
async function walkLocalPlain(root) {
  const result = new Map();

  async function recurse(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await recurse(full);
      } else if (entry.isFile()) {
        const rel = toPosix(path.relative(root, full));
        result.set(rel, {
          rel,
          localPath: full,
        });
      }
    }
  }

  await recurse(root);
  return result;
}

// ---------------------------------------------------------------------------
// Remote walker (recursive, all subdirectories) – respects INCLUDE/EXCLUDE
// ---------------------------------------------------------------------------

async function walkRemote(sftp, remoteRoot) {
  const result = new Map();
  let scanned = 0;

  async function recurse(remoteDir, prefix) {
    const items = await sftp.list(remoteDir);

    for (const item of items) {
      if (!item.name || item.name === "." || item.name === "..") continue;

      const full = path.posix.join(remoteDir, item.name);
      const rel = prefix ? `${prefix}/${item.name}` : item.name;

      // Include/Exclude-Regeln auch auf Remote anwenden
      if (!isIncluded(rel)) continue;

      if (item.type === "d") {
        await recurse(full, rel);
      } else {
        result.set(rel, {
          rel,
          remotePath: full,
          size: Number(item.size),
          modifyTime: item.modifyTime ?? 0,
        });

        scanned += 1;
        const chunk = IS_VERBOSE ? 1 : SCAN_CHUNK;
        if (scanned === 1 || scanned % chunk === 0) {
          updateProgress2("Scan remote: ", scanned, 0, rel);
        }
      }
    }
  }

  await recurse(remoteRoot, "");

  if (scanned > 0) {
    updateProgress2("Scan remote: ", scanned, 0, "fertig");
    process.stdout.write("\n");
    progressActive = false;
  }

  return result;
}

// Plain walker für Bypass (ignoriert INCLUDE/EXCLUDE)
async function walkRemotePlain(sftp, remoteRoot) {
  const result = new Map();

  async function recurse(remoteDir, prefix) {
    const items = await sftp.list(remoteDir);

    for (const item of items) {
      if (!item.name || item.name === "." || item.name === "..") continue;

      const full = path.posix.join(remoteDir, item.name);
      const rel = prefix ? `${prefix}/${item.name}` : item.name;

      if (item.type === "d") {
        await recurse(full, rel);
      } else {
        result.set(rel, {
          rel,
          remotePath: full,
        });
      }
    }
  }

  await recurse(remoteRoot, "");
  return result;
}

// ---------------------------------------------------------------------------
// Hash helper for binaries (streaming, memory-efficient)
// ---------------------------------------------------------------------------

function hashLocalFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function hashRemoteFile(sftp, remotePath) {
  const hash = createHash("sha256");

  const writable = new Writable({
    write(chunk, enc, cb) {
      hash.update(chunk);
      cb();
    },
  });

  await sftp.get(remotePath, writable);
  return hash.digest("hex");
}

// Cache-aware Helpers
async function getLocalHash(rel, meta) {
  const key = cacheKey(rel);
  const cached = CACHE.local[key];
  if (
    cached &&
    cached.size === meta.size &&
    cached.mtimeMs === meta.mtimeMs &&
    cached.hash
  ) {
    return cached.hash;
  }

  const hash = await hashLocalFile(meta.localPath);
  CACHE.local[key] = {
    size: meta.size,
    mtimeMs: meta.mtimeMs,
    hash,
  };
  await markCacheDirty();
  return hash;
}

async function getRemoteHash(rel, meta, sftp) {
  const key = cacheKey(rel);
  const cached = CACHE.remote[key];
  if (
    cached &&
    cached.size === meta.size &&
    cached.modifyTime === meta.modifyTime &&
    cached.hash
  ) {
    return cached.hash;
  }

  const hash = await hashRemoteFile(sftp, meta.remotePath);
  CACHE.remote[key] = {
    size: meta.size,
    modifyTime: meta.modifyTime,
    hash,
  };
  await markCacheDirty();
  return hash;
}

// ---------------------------------------------------------------------------
// SFTP error explanation (for clearer messages)
// ---------------------------------------------------------------------------

function describeSftpError(err) {
  if (!err) return "";

  const code = err.code || err.errno || "";
  const msg = (err.message || "").toLowerCase();

  // Netzwerk / DNS
  if (code === "ENOTFOUND") {
    return "Host not found (ENOTFOUND) – Check hostname or DNS entry.";
  }
  if (code === "EHOSTUNREACH") {
    return "Host not reachable (EHOSTUNREACH) – Check network/firewall.";
  }
  if (code === "ECONNREFUSED") {
    return "Connection refused (ECONNREFUSED) – Check the port or SSH service.";
  }
  if (code === "ECONNRESET") {
    return "Connection was reset by the server (ECONNRESET).";
  }
  if (code === "ETIMEDOUT") {
    return "Connection timeout (ETIMEDOUT) – Server is not responding or is blocked.";
  }

  // Auth / Authorisations
  if (msg.includes("all configured authentication methods failed")) {
    return "Authentication failed – check your username/password or SSH keys.";
  }
  if (msg.includes("permission denied")) {
    return "Access denied – check permissions on the server.";
  }

  // Fallback
  return "";
}

// ---------------------------------------------------------------------------
// Bypass-only Mode (sidecar-upload / sidecar-download ohne normalen Sync)
// ---------------------------------------------------------------------------

async function collectUploadTargets() {
  const all = await walkLocalPlain(CONNECTION.sidecarLocalRoot);
  const results = [];

  for (const [rel, meta] of all.entries()) {
    if (matchesAny(UPLOAD_LIST, rel)) {
      const remotePath = path.posix.join(CONNECTION.sidecarRemoteRoot, rel);
      results.push({
        rel,
        localPath: meta.localPath,
        remotePath,
      });
    }
  }

  return results;
}

async function collectDownloadTargets(sftp) {
  const all = await walkRemotePlain(sftp, CONNECTION.sidecarRemoteRoot);
  const results = [];

  for (const [rel, meta] of all.entries()) {
    if (matchesAny(DOWNLOAD_LIST, rel)) {
      const localPath = path.join(CONNECTION.sidecarLocalRoot, rel);
      results.push({
        rel,
        remotePath: meta.remotePath,
        localPath,
      });
    }
  }

  return results;
}

async function performBypassOnly(sftp) {
  log("");
  log(pc.bold(pc.cyan("🚀 Bypass-Only Mode (skip-sync)")));
  log(`${tab_a()}Sidecar Local: ${pc.green(CONNECTION.sidecarLocalRoot)}`);
  log(`${tab_a()}Sidecar Remote: ${pc.green(CONNECTION.sidecarRemoteRoot)}`);

  if (RUN_UPLOAD_LIST && !fs.existsSync(CONNECTION.sidecarLocalRoot)) {
    elog(
      pc.red("❌ Sidecar local root does not exist:"),
      CONNECTION.sidecarLocalRoot
    );
    process.exit(1);
  }

  if (RUN_UPLOAD_LIST) {
    log("");
    log(pc.bold(pc.cyan("⬆️  Upload-Bypass (sidecar-upload) …")));
    const targets = await collectUploadTargets();
    log(`${tab_a()}→ ${targets.length} files from uploadList`);

    if (!DRY_RUN) {
      await runTasks(
        targets,
        CONNECTION.workers,
        async ({ localPath, remotePath, rel }) => {
          const remoteDir = path.posix.dirname(remotePath);
          try {
            await sftp.mkdir(remoteDir, true);
          } catch {
            // Directory may already exist
          }
          await sftp.put(localPath, remotePath);
          vlog(`${tab_a()}${ADD} Uploaded (bypass): ${rel}`);
        },
        "Bypass Uploads"
      );
    } else {
      for (const t of targets) {
        log(`${tab_a()}${ADD} (DRY-RUN) Upload: ${t.rel}`);
      }
    }
  }

  if (RUN_DOWNLOAD_LIST) {
    log("");
    log(pc.bold(pc.cyan("⬇️  Download-Bypass (sidecar-download) …")));
    const targets = await collectDownloadTargets(sftp);
    log(`${tab_a()}→ ${targets.length} files from downloadList`);

    if (!DRY_RUN) {
      await runTasks(
        targets,
        CONNECTION.workers,
        async ({ remotePath, localPath, rel }) => {
          const localDir = path.dirname(localPath);
          await fsp.mkdir(localDir, { recursive: true });
          await sftp.get(remotePath, localPath);
          vlog(`${tab_a()}${CHA} Downloaded (bypass): ${rel}`);
        },
        "Bypass Downloads"
      );
    } else {
      for (const t of targets) {
        log(`${tab_a()}${CHA} (DRY-RUN) Download: ${t.rel}`);
      }
    }
  }

  log("");
  log(pc.bold(pc.green("✅ Bypass-only run finished.")));
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function initLogFile() {
  if (!LOG_FILE) return;
  const dir = path.dirname(LOG_FILE);
  await fsp.mkdir(dir, { recursive: true });
  LOG_STREAM = fs.createWriteStream(LOG_FILE, {
    flags: "w",
    encoding: "utf8",
  });
}

async function main() {
  const start = Date.now();

  await initLogFile();

  // Header-Abstand wie gehabt: zwei Leerzeilen davor
  log("\n" + hr2());
  log(pc.bold(`🔐 SFTP Push-Synchronisation: sftp-push-sync  v${pkg.version}`));
  log(`${tab_a()}LogLevel: ${LOG_LEVEL}`);
  log(`${tab_a()}Connection: ${pc.cyan(TARGET)}`);
  log(`${tab_a()}Worker: ${CONNECTION.workers}`);
  log(
    `${tab_a()}Host: ${pc.green(CONNECTION.host)}:${pc.green(CONNECTION.port)}`
  );
  log(`${tab_a()}Local: ${pc.green(CONNECTION.localRoot)}`);
  log(`${tab_a()}Remote: ${pc.green(CONNECTION.remoteRoot)}`);
  if (RUN_UPLOAD_LIST || RUN_DOWNLOAD_LIST || SKIP_SYNC) {
    log(`${tab_a()}Sidecar Local: ${pc.green(CONNECTION.sidecarLocalRoot)}`);
    log(`${tab_a()}Sidecar Remote: ${pc.green(CONNECTION.sidecarRemoteRoot)}`);
  }
  if (DRY_RUN) log(pc.yellow(`${tab_a()}Mode: DRY-RUN (no changes)`));
  if (SKIP_SYNC) log(pc.yellow(`${tab_a()}Mode: SKIP-SYNC (bypass only)`));
  if (RUN_UPLOAD_LIST || RUN_DOWNLOAD_LIST) {
    log(
      pc.blue(
        `${tab_a()}Extra: ${
          RUN_UPLOAD_LIST ? "sidecar-upload " : ""
        }${RUN_DOWNLOAD_LIST ? "sidecar-download" : ""}`
      )
    );
  }
  if (CLEANUP_EMPTY_DIRS) {
    log(`${tab_a()}Cleanup empty dirs: ${pc.green("enabled")}`);
  }
  if (LOG_FILE) {
    log(`${tab_a()}LogFile: ${pc.cyan(LOG_FILE)}`);
  }
  log(hr1());

  const sftp = new SftpClient();
  let connected = false;

  const toAdd = [];
  const toUpdate = [];
  const toDelete = [];

  try {
    log("");
    log(pc.cyan("🔌 Connecting to SFTP server …"));
    await sftp.connect({
      host: CONNECTION.host,
      port: CONNECTION.port,
      username: CONNECTION.user,
      password: CONNECTION.password,
    });
    connected = true;
    log(pc.green(`${tab_a()}✔ Connected to SFTP.`));

    if (!SKIP_SYNC && !fs.existsSync(CONNECTION.localRoot)) {
      console.error(
        pc.red("❌ Local root does not exist:"),
        CONNECTION.localRoot
      );
      process.exit(1);
    }

    // -------------------------------------------------------------
    // SKIP-SYNC-Modus → nur Sidecar-Listen
    // -------------------------------------------------------------
    if (SKIP_SYNC) {
      await performBypassOnly(sftp);
      const duration = ((Date.now() - start) / 1000).toFixed(2);
      log("");
      log(pc.bold(pc.cyan("📊 Summary (bypass only):")));
      log(`${tab_a()}Duration: ${pc.green(duration + " s")}`);
      return;
    }

    // -------------------------------------------------------------
    // Normaler Sync (inkl. evtl. paralleler Sidecar-Excludes)
    // -------------------------------------------------------------

    // Phase 1 – mit exakt einer Leerzeile davor
    log("");
    log(pc.bold(pc.cyan("📥 Phase 1: Scan local files …")));
    const local = await walkLocal(CONNECTION.localRoot);
    log(`${tab_a()}→ ${local.size} local files`);

    if (AUTO_EXCLUDED.size > 0) {
      log("");
      log(pc.dim("   Auto-excluded (sidecar upload/download):"));
      [...AUTO_EXCLUDED].sort().forEach((file) => {
        log(pc.dim(`${tab_a()} - ${file}`));
      });
      log("");
    }

    // Phase 2 – auch mit einer Leerzeile davor
    log("");
    log(pc.bold(pc.cyan("📤 Phase 2: Scan remote files …")));
    const remote = await walkRemote(sftp, CONNECTION.remoteRoot);
    log(`${tab_a()}→ ${remote.size} remote files`);
    log("");

    const localKeys = new Set(local.keys());
    const remoteKeys = new Set(remote.keys());

    log(pc.bold(pc.cyan("🔎 Phase 3: Compare & decide …")));
    const totalToCheck = localKeys.size;
    let checkedCount = 0;

    // Analysis: just decide, don't upload/delete anything yet
    for (const rel of localKeys) {
      checkedCount += 1;

      const chunk = IS_VERBOSE ? 1 : ANALYZE_CHUNK;
      if (
        checkedCount === 1 || // immediate first issue
        checkedCount % chunk === 0 ||
        checkedCount === totalToCheck
      ) {
        updateProgress2("Analyse: ", checkedCount, totalToCheck, rel);
      }

      const l = local.get(rel);
      const r = remote.get(rel);
      const remotePath = path.posix.join(CONNECTION.remoteRoot, rel);

      if (!r) {
        toAdd.push({ rel, local: l, remotePath });
        if (!IS_LACONIC) {
          log(`${tab_a()}${ADD} ${pc.green("New:")} ${rel}`);
        }
        continue;
      }

      // 1. size comparison
      if (l.size !== r.size) {
        toUpdate.push({ rel, local: l, remote: r, remotePath });
        if (!IS_LACONIC) {
          log(`${tab_a()}${CHA} ${pc.yellow("Size changed:")} ${rel}`);
        }
        continue;
      }

      // 2. content comparison
      if (l.isText) {
        // Text file: Read & compare in full
        const [localBuf, remoteBuf] = await Promise.all([
          fsp.readFile(l.localPath),
          sftp.get(r.remotePath),
        ]);

        const localStr = localBuf.toString("utf8");
        const remoteStr = (
          Buffer.isBuffer(remoteBuf) ? remoteBuf : Buffer.from(remoteBuf)
        ).toString("utf8");

        if (localStr === remoteStr) {
          vlog(`${tab_a()}${pc.dim("✓ Unchanged (Text):")} ${rel}`);
          continue;
        }

        if (IS_VERBOSE) {
          const diff = diffWords(remoteStr, localStr);
          const blocks = diff.filter((d) => d.added || d.removed).length;
          vlog(`${tab_a()}${CHA} Text difference (${blocks} blocks) in ${rel}`);
        }

        toUpdate.push({ rel, local: l, remote: r, remotePath });
        if (!IS_LACONIC) {
          log(
            `${tab_a()}${CHA} ${pc.yellow("Content changed (Text):")} ${rel}`
          );
        }
      } else {
        // Binary: Hash comparison with cache
        const localMeta = l;
        const remoteMeta = r;

        const [localHash, remoteHash] = await Promise.all([
          getLocalHash(rel, localMeta),
          getRemoteHash(rel, remoteMeta, sftp),
        ]);

        if (localHash === remoteHash) {
          vlog(`${tab_a()}${pc.dim("✓ Unchanged (binary, hash):")} ${rel}`);
          continue;
        }

        if (IS_VERBOSE) {
          vlog(`${tab_a()}${CHA} Hash different (binary): ${rel}`);
          vlog(`${tab_b()}local:  ${localHash}`);
          vlog(`${tab_b()}remote: ${remoteHash}`);
        }

        toUpdate.push({ rel, local: l, remote: r, remotePath });
        if (!IS_LACONIC) {
          log(`${tab_a()}${CHA} ${pc.yellow("Content changed (Binary):")} ${rel}`);
        }
      }
    }

    // Wenn Phase 3 nichts gefunden hat, explizit sagen
    if (toAdd.length === 0 && toUpdate.length === 0) {
      log("");
      log(`${tab_a()}No differences found. Everything is up to date.`);
    }

    log("");
    log(pc.bold(pc.cyan("🧹 Phase 4: Removing orphaned remote files …")));
    for (const rel of remoteKeys) {
      if (!localKeys.has(rel)) {
        const r = remote.get(rel);
        toDelete.push({ rel, remotePath: r.remotePath });
        if (!IS_LACONIC) {
          log(`${tab_a()}${DEL} ${pc.red("Remove:")} ${rel}`);
        }
      }
    }

    // Auch für Phase 4 eine „nix zu tun“-Meldung
    if (toDelete.length === 0) {
      log(`${tab_a()}No orphaned remote files found.`);
    }

    // -------------------------------------------------------------------
    // Verzeichnisse vorab anlegen (damit Worker sich nicht ins Gehege kommen)
    // -------------------------------------------------------------------
    if (!DRY_RUN && (toAdd.length || toUpdate.length)) {
      log("");
      log(pc.bold(pc.cyan("📁 Preparing remote directories …")));
      await ensureAllRemoteDirsExist(
        sftp,
        CONNECTION.remoteRoot,
        toAdd,
        toUpdate
      );
    }

    // -------------------------------------------------------------------
    // Phase 5: Execute changes (parallel, worker-based)
    // -------------------------------------------------------------------

    if (!DRY_RUN) {
      log("");
      log(pc.bold(pc.cyan("🚚 Phase 5: Apply changes …")));

      // Upload new files
      await runTasks(
        toAdd,
        CONNECTION.workers,
        async ({ local: l, remotePath }) => {
          // Verzeichnisse sollten bereits existieren – mkdir hier nur als Fallback
          const remoteDir = path.posix.dirname(remotePath);
          try {
            await sftp.mkdir(remoteDir, true);
          } catch {
            // Directory may already exist.
          }
          await sftp.put(l.localPath, remotePath);
        },
        "Uploads (new)"
      );

      // Updates
      await runTasks(
        toUpdate,
        CONNECTION.workers,
        async ({ local: l, remotePath }) => {
          const remoteDir = path.posix.dirname(remotePath);
          try {
            await sftp.mkdir(remoteDir, true);
          } catch {
            // Directory may already exist.
          }
          await sftp.put(l.localPath, remotePath);
        },
        "Uploads (update)"
      );

      // Deletes
      await runTasks(
        toDelete,
        CONNECTION.workers,
        async ({ remotePath }) => {
          try {
            await sftp.delete(remotePath);
          } catch (e) {
            console.error(
              pc.red("   ⚠️ Error during deletion:"),
              remotePath,
              e.message || e
            );
          }
        },
        "Deletes"
      );
    } else {
      log("");
      log(
        pc.yellow(
          "💡 DRY-RUN: Connection tested, no files transferred or deleted."
        )
      );
    }

    // Optional: leere Verzeichnisse aufräumen
    if (!DRY_RUN && CLEANUP_EMPTY_DIRS) {
      log("");
      log(pc.bold(pc.cyan("🧹 Cleaning up empty remote directories …")));
      await cleanupEmptyDirs(sftp, CONNECTION.remoteRoot);
    }

    const duration = ((Date.now() - start) / 1000).toFixed(2);

    // Write cache safely at the end
    await saveCache(true);

    // Summary
    log(hr1());
    log("");
    log(pc.bold(pc.cyan("📊 Summary:")));
    log(`${tab_a()}Duration: ${pc.green(duration + " s")}`);
    log(`${tab_a()}${ADD} Added  : ${toAdd.length}`);
    log(`${tab_a()}${CHA} Changed: ${toUpdate.length}`);
    log(`${tab_a()}${DEL} Deleted: ${toDelete.length}`);
    if (AUTO_EXCLUDED.size > 0) {
      log(
        `${tab_a()}${EXC} Excluded via sidecar upload/download: ${
          AUTO_EXCLUDED.size
        }`
      );
    }

    // Directory-Statistik
    const dirsChecked = DIR_STATS.ensuredDirs + DIR_STATS.cleanupVisited;
    log("");
    log(pc.bold("Folders:"));
    log(`${tab_a()}Checked : ${dirsChecked}`);
    log(`${tab_a()}${ADD} Created: ${DIR_STATS.createdDirs}`);
    log(`${tab_a()}${DEL} Deleted: ${DIR_STATS.cleanupDeleted}`);

    if (toAdd.length || toUpdate.length || toDelete.length) {
      log("");
      log("📄 Changes:");
      [...toAdd.map((t) => t.rel)]
        .sort()
        .forEach((f) => console.log(`${tab_a()}${ADD} ${f}`));
      [...toUpdate.map((t) => t.rel)]
        .sort()
        .forEach((f) => console.log(`${tab_a()}${CHA} ${f}`));
      [...toDelete.map((t) => t.rel)]
        .sort()
        .forEach((f) => console.log(`${tab_a()}${DEL} ${f}`));
    } else {
      log("");
      log("No changes.");
    }

    log("");
    log(pc.bold(pc.green("✅ Sync complete.")));
  } catch (err) {
    const hint = describeSftpError(err);
    elog(pc.red("❌ Synchronisation error:"), err.message || err);
    if (hint) {
      wlog(pc.yellow(`${tab_a()}Mögliche Ursache:`), hint);
    }
    if (IS_VERBOSE) {
      // Vollständiges Error-Objekt nur in verbose anzeigen
      console.error(err);
    }
    process.exitCode = 1;
    try {
      await saveCache(true);
    } catch {
      // ignore
    }
  } finally {
    try {
      if (connected) {
        await sftp.end();
        log(pc.green(`${tab_a()}✔ Connection closed.`));
      }
    } catch (e) {
      wlog(
        pc.yellow("⚠️ Could not close SFTP connection cleanly:"),
        e.message || e
      );
    }

    // Abschlusslinie + Leerzeile **vor** dem Schließen des Logfiles
    log(hr2());
    log("");

    if (LOG_STREAM) {
      LOG_STREAM.end();
    }
  }
}

main();