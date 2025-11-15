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
const tab_a = () => " ".repeat(3); // indentation for formatting the output.

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const TARGET = args[0];
const DRY_RUN = args.includes("--dry-run");
const RUN_UPLOAD_LIST = args.includes("--upload-list");
const RUN_DOWNLOAD_LIST = args.includes("--download-list");

// logLevel override via CLI (optional)
let cliLogLevel = null;
if (args.includes("--verbose")) cliLogLevel = "verbose";
if (args.includes("--laconic")) cliLogLevel = "laconic";

if (!TARGET) {
  console.error(pc.red("❌ Please specify a connection profile:"));
  console.error(pc.yellow("   sftp-push-sync staging --dry-run"));
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

const TARGET_CONFIG = CONFIG_RAW.connections[TARGET];
if (!TARGET_CONFIG) {
  console.error(
    pc.red(`❌ Connection '${TARGET}' not found in sync.config.json.`)
  );
  process.exit(1);
}

const CONNECTION = {
  host: TARGET_CONFIG.host,
  port: TARGET_CONFIG.port ?? 22,
  user: TARGET_CONFIG.user,
  password: TARGET_CONFIG.password,
  localRoot: path.resolve(TARGET_CONFIG.localRoot),
  remoteRoot: TARGET_CONFIG.remoteRoot,
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

// ---------------------------------------------------------------------------
// Shared config from JSON
// ---------------------------------------------------------------------------

const INCLUDE = CONFIG_RAW.include ?? [];
const BASE_EXCLUDE = CONFIG_RAW.exclude ?? [];

// Special: Lists for targeted uploads/downloads
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

const UPLOAD_LIST = normalizeList(CONFIG_RAW.uploadList ?? []);
const DOWNLOAD_LIST = normalizeList(CONFIG_RAW.downloadList ?? []);

// Effektive Exclude-Liste: explizites exclude + Upload/Download-Listen
const EXCLUDE = [...BASE_EXCLUDE, ...UPLOAD_LIST, ...DOWNLOAD_LIST];

// List of ALL files that were excluded due to uploadList/downloadList
const AUTO_EXCLUDED = new Set();

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

function clearProgressLine() {
  if (!process.stdout.isTTY || !progressActive) return;
  const width = process.stdout.columns || 80;
  const blank = " ".repeat(width - 1);
  process.stdout.write("\r" + blank + "\r");
  progressActive = false;
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function log(...msg) {
  clearProgressLine();
  console.log(...msg);
}

function vlog(...msg) {
  if (!IS_VERBOSE) return;
  clearProgressLine();
  console.log(...msg);
}

function elog(...msg) {
  clearProgressLine();
  console.error(...msg);
}

function wlog(...msg) {
  clearProgressLine();
  console.warn(...msg);
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
    // Falls durch Upload/Download-Liste → merken
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

// Two-line progress bar
function updateProgress2(prefix, current, total, rel = "") {
  if (!process.stdout.isTTY) {
    // Fallback für Pipes / Logs
    if (total && total > 0) {
      const percent = ((current / total) * 100).toFixed(1);
      console.log(
        `${tab_a()}${prefix}${current}/${total} Files (${percent}%) – ${rel}`
      );
    } else {
      console.log(`${tab_a()}${prefix}${current} Files – ${rel}`);
    }
    return;
  }

  const width = process.stdout.columns || 80;

  let line1;
  if (total && total > 0) {
    const percent = ((current / total) * 100).toFixed(1);
    line1 = `${tab_a()}${prefix}${current}/${total} Files (${percent}%)`;
  } else {
    // „unknown total“ / Scanner-Modus
    line1 = `${tab_a()}${prefix}${current} Files`;
  }

  const short = rel ? shortenPathForProgress(rel) : "";
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
      if (done % 10 === 0 || done === total) {
        updateProgress2(`${tab_a()}${label}: `, done, total);
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
        });

        scanned += 1;
        const chunk = IS_VERBOSE ? 1 : SCAN_CHUNK;
        if (scanned === 1 || scanned % chunk === 0) {
          // totally unknown → totally = 0 → no automatic \n
          updateProgress2("   Scan local: ", scanned, 0, rel);
        }
      }
    }
  }

  await recurse(root);

  if (scanned > 0) {
    // last line + neat finish
    updateProgress2("   Scan local: ", scanned, 0, "fertig");
    process.stdout.write("\n");
    progressActive = false;
  }

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

      // Apply include/exclude rules also on remote side
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
          updateProgress2("   Scan remote: ", scanned, 0, rel);
        }
      }
    }
  }

  await recurse(remoteRoot);

  if (scanned > 0) {
    updateProgress2("   Scan remote: ", scanned, 0, "fertig");
    process.stdout.write("\n");
    progressActive = false;
  }

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
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  const start = Date.now();

  log(`\n\n${hr2()}`);
  log(
    pc.bold(
      `🔐 SFTP Push-Synchronisation: sftp-push-sync  v${pkg.version}  [logLevel=${LOG_LEVEL}]`
    )
  );
  log(`${tab_a()}Connection: ${pc.cyan(TARGET)}`);
  log(`Worker: ${CONNECTION.workers}`);
  log(`${tab_a()}Host:   ${pc.green(CONNECTION.host)}:${pc.green(CONNECTION.port)}`);
  log(`${tab_a()}Local:  ${pc.green(CONNECTION.localRoot)}`);
  log(`${tab_a()}Remote: ${pc.green(CONNECTION.remoteRoot)}`);
  if (DRY_RUN) log(pc.yellow("   Mode: DRY-RUN (no changes)"));
  if (RUN_UPLOAD_LIST || RUN_DOWNLOAD_LIST) {
    log(
      pc.blue(
        `${tab_a()}Extra: ${RUN_UPLOAD_LIST ? "uploadList " : ""}${
          RUN_DOWNLOAD_LIST ? "downloadList" : ""
        }`
      )
    );
  }
  log(`${hr1()}\n`);

  const sftp = new SftpClient();
  let connected = false;

  const toAdd = [];
  const toUpdate = [];
  const toDelete = [];

  try {
    log(pc.cyan("🔌 Connecting to SFTP server …"));
    await sftp.connect({
      host: CONNECTION.host,
      port: CONNECTION.port,
      username: CONNECTION.user,
      password: CONNECTION.password,
    });
    connected = true;
    log(pc.green(`${tab_a()}✔ Connected to SFTP.`));

    if (!fs.existsSync(CONNECTION.localRoot)) {
      console.error(
        pc.red("❌ Local root does not exist:"),
        CONNECTION.localRoot
      );
      process.exit(1);
    }

    log(pc.bold(pc.cyan("📥 Phase 1: Scan local files …")));
    const local = await walkLocal(CONNECTION.localRoot);
    log(`${tab_a()}→ ${local.size} local files`);

    if (AUTO_EXCLUDED.size > 0) {
      log("");
      log(pc.dim("   Auto-excluded (uploadList/downloadList):"));
      [...AUTO_EXCLUDED].sort().forEach((file) => {
        log(pc.dim(`${tab_a()} - ${file}`));
      });
      log("");
    }

    log(pc.bold(pc.cyan("📤 Phase 2: Scan remote files …")));
    const remote = await walkRemote(sftp, CONNECTION.remoteRoot);
    log(`${tab_a()}→ ${remote.size} remote files\n`);

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
        updateProgress2("   Analyse: ", checkedCount, totalToCheck, rel);
      }

      const l = local.get(rel);
      const r = remote.get(rel);
      const remotePath = path.posix.join(CONNECTION.remoteRoot, rel);

      if (!r) {
        toAdd.push({ rel, local: l, remotePath });
        if (!IS_LACONIC) {
          log(`${ADD} ${pc.green("New:")} ${rel}`);
        }
        continue;
      }

      // 1. size comparison
      if (l.size !== r.size) {
        toUpdate.push({ rel, local: l, remote: r, remotePath });
        if (!IS_LACONIC) {
          log(`${CHA} ${pc.yellow("Size changed:")} ${rel}`);
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
          log(`${tab_a()}${CHA} ${pc.yellow("Content changed (Text):")} ${rel}`);
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
          vlog(`${tab_a()}   local:  ${localHash}`);
          vlog(`${tab_a()}   remote: ${remoteHash}`);
        }

        toUpdate.push({ rel, local: l, remote: r, remotePath });
        if (!IS_LACONIC) {
          log(`${CHA} ${pc.yellow("Content changed (Binary):")} ${rel}`);
        }
      }
    }

    log(
      "\n" + pc.bold(pc.cyan("🧹 Phase 4: Removing orphaned remote files …"))
    );
    for (const rel of remoteKeys) {
      if (!localKeys.has(rel)) {
        const r = remote.get(rel);
        toDelete.push({ rel, remotePath: r.remotePath });
        if (!IS_LACONIC) {
          log(`${tab_a()}${DEL} ${pc.red("Remove:")} ${rel}`);
        }
      }
    }

    // -------------------------------------------------------------------
    // Phase 5: Execute changes (parallel, worker-based)
    // -------------------------------------------------------------------

    if (!DRY_RUN) {
      log("\n" + pc.bold(pc.cyan("🚚 Phase 5: Apply changes …")));

      // Upload new files
      await runTasks(
        toAdd,
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
      log(
        pc.yellow(
          "\n💡 DRY-RUN: Connection tested, no files transferred or deleted."
        )
      );
    }

    // -------------------------------------------------------------------
    // Phase 6: optional uploadList / downloadList
    // -------------------------------------------------------------------

    if (RUN_UPLOAD_LIST && UPLOAD_LIST.length > 0) {
      log(
        "\n" +
          pc.bold(pc.cyan("⬆️ Extra Phase: Upload-List (explicit files) …"))
      );

      const tasks = UPLOAD_LIST.map((rel) => ({
        rel,
        localPath: path.join(CONNECTION.localRoot, rel),
        remotePath: path.posix.join(CONNECTION.remoteRoot, toPosix(rel)),
      }));

      if (DRY_RUN) {
        for (const t of tasks) {
          log(`${tab_a()}${ADD} would upload (uploadList): ${t.rel}`);
        }
      } else {
        await runTasks(
          tasks,
          CONNECTION.workers,
          async ({ localPath, remotePath, rel }) => {
            const remoteDir = path.posix.dirname(remotePath);
            try {
              await sftp.mkdir(remoteDir, true);
            } catch {
              // ignore
            }
            await sftp.put(localPath, remotePath);
            log(`${tab_a()}${ADD} uploadList: ${rel}`);
          },
          "Upload-List"
        );
      }
    }

    if (RUN_DOWNLOAD_LIST && DOWNLOAD_LIST.length > 0) {
      log(
        "\n" +
          pc.bold(pc.cyan("⬇️ Extra Phase: Download-List (explicit files) …"))
      );

      const tasks = DOWNLOAD_LIST.map((rel) => ({
        rel,
        remotePath: path.posix.join(CONNECTION.remoteRoot, toPosix(rel)),
        localPath: path.join(CONNECTION.localRoot, rel),
      }));

      if (DRY_RUN) {
        for (const t of tasks) {
          log(`${tab_a()}${ADD} would download (downloadList): ${t.rel}`);
        }
      } else {
        await runTasks(
          tasks,
          CONNECTION.workers,
          async ({ remotePath, localPath, rel }) => {
            await fsp.mkdir(path.dirname(localPath), { recursive: true });
            await sftp.fastGet(remotePath, localPath);
            log(`${tab_a()}${ADD} downloadList: ${rel}`);
          },
          "Download-List"
        );
      }
    }

    const duration = ((Date.now() - start) / 1000).toFixed(2);

    // Write cache safely at the end
    await saveCache(true);

    // Summary
    log("\n" + pc.bold(pc.cyan("📊 Summary:")));
    log(`${tab_a()}Duration: ${pc.green(duration + " s")}`);
    log(`${tab_a()}${ADD} Added  : ${toAdd.length}`);
    log(`${tab_a()}${CHA} Changed: ${toUpdate.length}`);
    log(`${tab_a()}${DEL} Deleted: ${toDelete.length}`);
    if (AUTO_EXCLUDED.size > 0) {
      log(
        `${tab_a()}${EXC} Excluded via uploadList | downloadList: ${AUTO_EXCLUDED.size}`
      );
    }
    if (toAdd.length || toUpdate.length || toDelete.length) {
      log("\n📄 Changes:");
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
      log("\nNo changes.");
    }

    log("\n" + pc.bold(pc.green("✅ Sync complete.")));
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
  }
  log(`${hr2()}\n\n`);
}

main();
