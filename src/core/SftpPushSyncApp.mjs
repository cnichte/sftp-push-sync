/**
 * SftpPushSyncApp.mjs
 *
 * @author Carsten Nichte, 2025 / https://carsten-nichte.de/
 *
 */
// src/core/SftpPushSyncApp.mjs
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import SftpClient from "ssh2-sftp-client";
import { minimatch } from "minimatch";
import pc from "picocolors";
import { createRequire } from "module";

import { SyncLogger } from "./SyncLogger.mjs";
import { ScanProgressController } from "./ScanProgressController.mjs";

import { toPosix, shortenPathForProgress } from "../helpers/directory.mjs";
import { createHashCache } from "../helpers/hashing.mjs";
import { walkLocal, walkRemote } from "../helpers/walkers.mjs";
import {
  analyseDifferences,
  computeRemoteDeletes,
} from "../helpers/compare.mjs";
import { performBypassOnly as performSidecarBypass } from "../helpers/sidecar.mjs";
import {
  hr1,
  hr2,
  TAB_A,
  TAB_B,
  SPINNER_FRAMES,
} from "../helpers/progress-constants.mjs";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json");

// Symbole & Format
const ADD = pc.green("+");
const CHA = pc.yellow("~");
const DEL = pc.red("-");
const EXC = pc.redBright("-");

// ---------------------------------------------------------------------------
// Fehlerhilfe SFTP
// ---------------------------------------------------------------------------
function describeSftpError(err) {
  if (!err) return "";

  const code = err.code || err.errno || "";
  const msg = (err.message || "").toLowerCase();

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

  if (msg.includes("all configured authentication methods failed")) {
    return "Authentication failed – check your username/password or SSH keys.";
  }
  if (msg.includes("permission denied")) {
    return "Access denied – check permissions on the server.";
  }

  return "";
}

// ---------------------------------------------------------------------------
// App-Klasse
// ---------------------------------------------------------------------------

export class SftpPushSyncApp {
  /**
   * options: {
   *   target,
   *   dryRun,
   *   runUploadList,
   *   runDownloadList,
   *   skipSync,
   *   cliLogLevel,
   *   configPath
   * }
   */
  constructor(options = {}) {
    this.options = options;

    // Konfiguration
    this.configRaw = null;
    this.targetConfig = null;
    this.connection = null;

    // Patterns
    this.includePatterns = [];
    this.baseExcludePatterns = [];
    this.uploadList = [];
    this.downloadList = [];
    this.excludePatterns = [];
    this.autoExcluded = new Set();

    // Dateitypen
    this.textExt = [];
    this.mediaExt = [];

    // Log / Level
    this.logLevel = "normal";
    this.isVerbose = false;
    this.isLaconic = false;
    this.logger = null;

    // Progress
    this.scanChunk = 100;
    this.analyzeChunk = 10;
    this.parallelScan = true;

    this.progressActive = false;
    this.spinnerIndex = 0;

    // Cleanup
    this.cleanupEmptyDirsEnabled = true;
    this.cleanupEmptyRoots = false;
    this.dirStats = {
      ensuredDirs: 0,
      createdDirs: 0,
      cleanupVisited: 0,
      cleanupDeleted: 0,
    };

    // Cache
    this.hashCache = null;
  }

  // ---------------------------------------------------------
  // Logging-Helfer (Console + Logfile)
  // ---------------------------------------------------------

  _writeLogFile(line) {
    if (this.logger) {
      this.logger.writeLine(line);
    }
  }

  _clearProgressLine() {
    if (!process.stdout.isTTY || !this.progressActive) return;

    process.stdout.write("\r");
    process.stdout.write("\x1b[2K");
    process.stdout.write("\x1b[1B");
    process.stdout.write("\x1b[2K");
    process.stdout.write("\x1b[1A");

    this.progressActive = false;
  }

  _consoleAndLog(prefixForFile, ...msg) {
    this._clearProgressLine();
    console.log(...msg);
    const line = msg
      .map((m) => (typeof m === "string" ? m : String(m)))
      .join(" ");
    this._writeLogFile(prefixForFile ? prefixForFile + line : line);
  }

  log(...msg) {
    this._consoleAndLog("", ...msg);
  }

  elog(...msg) {
    this._consoleAndLog("[ERROR] ", ...msg);
  }

  wlog(...msg) {
    this._consoleAndLog("[WARN] ", ...msg);
  }

  vlog(...msg) {
    if (!this.isVerbose) return;
    this._consoleAndLog("", ...msg);
  }

  // ---------------------------------------------------------
  // Pattern-Helper
  // ---------------------------------------------------------

  matchesAny(patterns, relPath) {
    if (!patterns || patterns.length === 0) return false;
    return patterns.some((pattern) =>
      minimatch(relPath, pattern, { dot: true })
    );
  }

  isIncluded(relPath) {
    if (
      this.includePatterns.length > 0 &&
      !this.matchesAny(this.includePatterns, relPath)
    ) {
      return false;
    }

    if (
      this.excludePatterns.length > 0 &&
      this.matchesAny(this.excludePatterns, relPath)
    ) {
      if (
        this.uploadList.includes(relPath) ||
        this.downloadList.includes(relPath)
      ) {
        this.autoExcluded.add(relPath);
      }
      return false;
    }

    return true;
  }

  isTextFile(relPath) {
    const ext = path.extname(relPath).toLowerCase();
    return this.textExt.includes(ext);
  }

  isMediaFile(relPath) {
    const ext = path.extname(relPath).toLowerCase();
    return this.mediaExt.includes(ext);
  }

  // ---------------------------------------------------------
  // Progress-Balken (Phase 3, Verzeichnisse, Cleanup)
  // ---------------------------------------------------------

  updateProgress2(prefix, current, total, rel = "", suffix = "Files") {
    const short = rel ? shortenPathForProgress(rel) : "";

    const base =
      total && total > 0
        ? `${prefix}${current}/${total} ${suffix}`
        : `${prefix}${current} ${suffix}`;

    this._writeLogFile(
      `[progress] ${base}${rel ? " – " + rel : ""}`
    );

    const frame = SPINNER_FRAMES[this.spinnerIndex];
    this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;

    if (!process.stdout.isTTY) {
      if (total && total > 0) {
        const percent = ((current / total) * 100).toFixed(1);
        console.log(
          `${TAB_A}${frame} ${prefix}${current}/${total} ${suffix} (${percent}%) – ${short}`
        );
      } else {
        console.log(
          `${TAB_A}${frame} ${prefix}${current} ${suffix} – ${short}`
        );
      }
      return;
    }

    const width = process.stdout.columns || 80;

    let line1;
    if (total && total > 0) {
      const percent = ((current / total) * 100).toFixed(1);
      line1 = `${TAB_A}${frame} ${prefix}${current}/${total} ${suffix} (${percent}%)`;
    } else {
      line1 = `${TAB_A}${frame} ${prefix}${current} ${suffix}`;
    }

    let line2 = short || "";

    if (line1.length > width) line1 = line1.slice(0, width - 1);
    if (line2.length > width) line2 = line2.slice(0, width - 1);

    process.stdout.write("\r" + line1.padEnd(width) + "\n");
    process.stdout.write(line2.padEnd(width));
    process.stdout.write("\x1b[1A");

    this.progressActive = true;
  }

  // ---------------------------------------------------------
  // Worker-Pool
  // ---------------------------------------------------------

  async runTasks(items, workerCount, handler, label = "Tasks") {
    if (!items || items.length === 0) return;

    const total = items.length;
    let done = 0;
    let index = 0;
    const workers = [];
    const actualWorkers = Math.max(1, Math.min(workerCount, total));

    const worker = async () => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const i = index;
        if (i >= total) break;
        index += 1;
        const item = items[i];

        try {
          await handler(item);
        } catch (err) {
          this.elog(
            pc.red(`${TAB_A}⚠️ Error in ${label}:`),
            err?.message || err
          );
        }

        done += 1;
        if (done === 1 || done % 10 === 0 || done === total) {
          this.updateProgress2(`${label}: `, done, total, item.rel ?? "");
        }
      }
    };

    for (let i = 0; i < actualWorkers; i += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);
  }

  // ---------------------------------------------------------
  // Helper: Verzeichnisse vorbereiten
  // ---------------------------------------------------------

  collectDirsFromChanges(changes) {
    const dirs = new Set();

    for (const item of changes) {
      const rel = item.rel;
      if (!rel) continue;

      const parts = rel.split("/");
      if (parts.length <= 1) continue;

      let acc = "";
      for (let i = 0; i < parts.length - 1; i += 1) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i];
        dirs.add(acc);
      }
    }

    return [...dirs].sort(
      (a, b) => a.split("/").length - b.split("/").length
    );
  }

  async ensureAllRemoteDirsExist(sftp, remoteRoot, toAdd, toUpdate) {
    const dirs = this.collectDirsFromChanges([...toAdd, ...toUpdate]);
    const total = dirs.length;
    this.dirStats.ensuredDirs += total;

    if (total === 0) return;

    let current = 0;

    for (const relDir of dirs) {
      current += 1;
      const remoteDir = path.posix.join(remoteRoot, relDir);

      this.updateProgress2(
        "Prepare dirs: ",
        current,
        total,
        relDir,
        "Folders"
      );

      try {
        const exists = await sftp.exists(remoteDir);
        if (!exists) {
          await sftp.mkdir(remoteDir, true);
          this.dirStats.createdDirs += 1;
          this.vlog(`${TAB_A}${pc.dim("dir created:")} ${remoteDir}`);
        } else {
          this.vlog(`${TAB_A}${pc.dim("dir ok:")} ${remoteDir}`);
        }
      } catch (e) {
        this.wlog(
          pc.yellow("⚠️  Could not ensure directory:"),
          remoteDir,
          e?.message || e
        );
      }
    }

    this.updateProgress2("Prepare dirs: ", total, total, "done", "Folders");
    process.stdout.write("\n");
    this.progressActive = false;
  }

  // ---------------------------------------------------------
  // Cleanup: leere Verzeichnisse löschen
  // ---------------------------------------------------------

  async cleanupEmptyDirs(sftp, rootDir, dryRun) {
    const recurse = async (dir) => {
      this.dirStats.cleanupVisited += 1;

      const relForProgress = toPosix(path.relative(rootDir, dir)) || ".";

      this.updateProgress2(
        "Cleanup dirs: ",
        this.dirStats.cleanupVisited,
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
        this.wlog(
          pc.yellow("⚠️  Could not list directory during cleanup:"),
          dir,
          e?.message || e
        );
        return false;
      }

      for (const item of items) {
        if (!item.name || item.name === "." || item.name === "..") continue;
        if (item.type === "d") {
          subdirs.push(item);
        } else {
          hasFile = true;
        }
      }

      let allSubdirsEmpty = true;
      for (const sub of subdirs) {
        const full = path.posix.join(dir, sub.name);
        const subEmpty = await recurse(full);
        if (!subEmpty) {
          allSubdirsEmpty = false;
        }
      }

      const isRoot = dir === rootDir;
      const isEmpty = !hasFile && allSubdirsEmpty;

      if (isEmpty && (!isRoot || this.cleanupEmptyRoots)) {
        const rel = relForProgress || ".";
        if (dryRun) {
          this.log(
            `${TAB_A}${DEL} (DRY-RUN) Remove empty directory: ${rel}`
          );
          this.dirStats.cleanupDeleted += 1;
        } else {
          try {
            await sftp.rmdir(dir, false);
            this.log(`${TAB_A}${DEL} Removed empty directory: ${rel}`);
            this.dirStats.cleanupDeleted += 1;
          } catch (e) {
            this.wlog(
              pc.yellow("⚠️  Could not remove directory:"),
              dir,
              e?.message || e
            );
            return false;
          }
        }
      }

      return isEmpty;
    };

    await recurse(rootDir);

    if (this.dirStats.cleanupVisited > 0) {
      this.updateProgress2(
        "Cleanup dirs: ",
        this.dirStats.cleanupVisited,
        this.dirStats.cleanupVisited,
        "done",
        "Folders"
      );
      process.stdout.write("\n");
      this.progressActive = false;
    }
  }

  // ---------------------------------------------------------
  // Hauptlauf
  // ---------------------------------------------------------

  async run() {
    const start = Date.now();
    const {
      target,
      dryRun = false,
      runUploadList = false,
      runDownloadList = false,
      skipSync = false,
      cliLogLevel = null,
      configPath,
    } = this.options;

    if (!target) {
      console.error(pc.red("❌ No target specified."));
      process.exit(1);
    }

    const cfgPath = path.resolve(configPath || "sync.config.json");
    if (!fs.existsSync(cfgPath)) {
      console.error(pc.red(`❌ Configuration file missing: ${cfgPath}`));
      process.exit(1);
    }

    // Config laden
    let configRaw;
    try {
      configRaw = JSON.parse(await fsp.readFile(cfgPath, "utf8"));
    } catch (err) {
      console.error(
        pc.red("❌ Error reading sync.config.json:"),
        err?.message || err
      );
      process.exit(1);
    }

    if (!configRaw.connections || typeof configRaw.connections !== "object") {
      console.error(
        pc.red("❌ sync.config.json must have a 'connections' field.")
      );
      process.exit(1);
    }

    const targetConfig = configRaw.connections[target];
    if (!targetConfig) {
      console.error(
        pc.red(`❌ Connection '${target}' not found in sync.config.json.`)
      );
      process.exit(1);
    }

    const syncCfg = targetConfig.sync ?? targetConfig;
    const sidecarCfg = targetConfig.sidecar ?? {};

    if (!syncCfg.localRoot || !syncCfg.remoteRoot) {
      console.error(
        pc.red(
          `❌ Connection '${target}' is missing sync.localRoot or sync.remoteRoot.`
        )
      );
      process.exit(1);
    }

    this.configRaw = configRaw;
    this.targetConfig = targetConfig;
    this.connection = {
      host: targetConfig.host,
      port: targetConfig.port ?? 22,
      user: targetConfig.user,
      password: targetConfig.password,
      localRoot: path.resolve(syncCfg.localRoot),
      remoteRoot: syncCfg.remoteRoot,
      sidecarLocalRoot: path.resolve(sidecarCfg.localRoot ?? syncCfg.localRoot),
      sidecarRemoteRoot: sidecarCfg.remoteRoot ?? syncCfg.remoteRoot,
      workers: targetConfig.worker ?? 2,
    };

    // LogLevel
    let logLevel = (configRaw.logLevel ?? "normal").toLowerCase();
    if (cliLogLevel) logLevel = cliLogLevel;
    this.logLevel = logLevel;
    this.isVerbose = logLevel === "verbose";
    this.isLaconic = logLevel === "laconic";

    // Progress-Konfig
    const PROGRESS = configRaw.progress ?? {};
    this.scanChunk = PROGRESS.scanChunk ?? (this.isVerbose ? 1 : 100);
    this.analyzeChunk = PROGRESS.analyzeChunk ?? (this.isVerbose ? 1 : 10);
    this.parallelScan = PROGRESS.parallelScan ?? true;

    this.cleanupEmptyDirsEnabled = configRaw.cleanupEmptyDirs ?? true;
    this.cleanupEmptyRoots = configRaw.cleanupEmptyRoots ?? false;

    // Patterns
    this.includePatterns = configRaw.include ?? [];
    this.baseExcludePatterns = configRaw.exclude ?? [];

    // Dateitypen
    this.textExt =
      configRaw.textExtensions ?? [
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

    this.mediaExt =
      configRaw.mediaExtensions ?? [
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

    const normalizeList = (list) => {
      if (!Array.isArray(list)) return [];
      return list.flatMap((item) =>
        typeof item === "string"
          ? item
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : []
      );
    };

    this.uploadList = normalizeList(sidecarCfg.uploadList ?? []);
    this.downloadList = normalizeList(sidecarCfg.downloadList ?? []);
    this.excludePatterns = [
      ...this.baseExcludePatterns,
      ...this.uploadList,
      ...this.downloadList,
    ];
    this.autoExcluded = new Set();

    // Hash-Cache
    const syncCacheName =
      targetConfig.syncCache || `.sync-cache.${target}.json`;
    const cachePath = path.resolve(syncCacheName);
    this.hashCache = createHashCache({
      cachePath,
      namespace: target,
      flushInterval: 50,
    });

    // Logger
    const DEFAULT_LOG_FILE = `.sync.${target}.log`;
    const rawLogFilePattern = configRaw.logFile || DEFAULT_LOG_FILE;
    const logFile = path.resolve(
      rawLogFilePattern.replace("{target}", target)
    );
    this.logger = new SyncLogger(logFile);
    await this.logger.init();

    // Header
    this.log("\n" + hr2());
    this.log(
      pc.bold(
        `🔐 SFTP Push-Synchronisation: sftp-push-sync  v${pkg.version}`
      )
    );
    this.log(`${TAB_A}LogLevel: ${this.logLevel}`);
    this.log(`${TAB_A}Connection: ${pc.cyan(target)}`);
    this.log(`${TAB_A}Worker: ${this.connection.workers}`);
    this.log(
      `${TAB_A}Host: ${pc.green(this.connection.host)}:${pc.green(
        this.connection.port
      )}`
    );
    this.log(`${TAB_A}Local: ${pc.green(this.connection.localRoot)}`);
    this.log(`${TAB_A}Remote: ${pc.green(this.connection.remoteRoot)}`);
    if (runUploadList || runDownloadList || skipSync) {
      this.log(
        `${TAB_A}Sidecar Local: ${pc.green(this.connection.sidecarLocalRoot)}`
      );
      this.log(
        `${TAB_A}Sidecar Remote: ${pc.green(
          this.connection.sidecarRemoteRoot
        )}`
      );
    }
    if (dryRun) this.log(pc.yellow(`${TAB_A}Mode: DRY-RUN (no changes)`));
    if (skipSync) this.log(pc.yellow(`${TAB_A}Mode: SKIP-SYNC (bypass only)`));
    if (runUploadList || runDownloadList) {
      this.log(
        pc.blue(
          `${TAB_A}Extra: ${
            runUploadList ? "sidecar-upload " : ""
          }${runDownloadList ? "sidecar-download" : ""}`
        )
      );
    }
    if (this.cleanupEmptyDirsEnabled) {
      this.log(`${TAB_A}Cleanup empty dirs: ${pc.green("enabled")}`);
    }
    if (logFile) {
      this.log(`${TAB_A}LogFile: ${pc.cyan(logFile)}`);
    }
    this.log(hr1());

    const sftp = new SftpClient();
    let connected = false;

    let toAdd = [];
    let toUpdate = [];
    let toDelete = [];

    try {
      this.log("");
      this.log(pc.cyan("🔌 Connecting to SFTP server …"));
      await sftp.connect({
        host: this.connection.host,
        port: this.connection.port,
        username: this.connection.user,
        password: this.connection.password,
      });
      connected = true;
      this.log(`${TAB_A}${pc.green("✔ Connected to SFTP.")}`);

      if (!skipSync && !fs.existsSync(this.connection.localRoot)) {
        this.elog(
          pc.red("❌ Local root does not exist:"),
          this.connection.localRoot
        );
        process.exit(1);
      }

      // Bypass-Only?
      if (skipSync) {
        await performSidecarBypass({
          sftp,
          connection: this.connection,
          uploadList: this.uploadList,
          downloadList: this.downloadList,
          options: { dryRun, runUploadList, runDownloadList },
          runTasks: (items, workers, handler, label) =>
            this.runTasks(items, workers, handler, label),
          log: (...m) => this.log(...m),
          vlog: this.isVerbose ? (...m) => this.vlog(...m) : null,
          elog: (...m) => this.elog(...m),
          symbols: { ADD, CHA, tab_a: TAB_A },
        });

        const duration = ((Date.now() - start) / 1000).toFixed(2);
        this.log("");
        this.log(pc.bold(pc.cyan("📊 Summary (bypass only):")));
        this.log(`${TAB_A}Duration: ${pc.green(duration + " s")}`);
        return;
      }

      // Phase 1 + 2 – Scan
      this.log("");
      this.log(
        pc.bold(
          pc.cyan(
            `📥 Phase 1 + 2: Scan local & remote files (${
              this.parallelScan ? "parallel" : "serial"
            }) …`
          )
        )
      );

      const scanProgress = new ScanProgressController({
        writeLogLine: (line) => this._writeLogFile(line),
      });

      let local;
      let remote;

      if (this.parallelScan) {
        [local, remote] = await Promise.all([
          walkLocal(this.connection.localRoot, {
            filterFn: (rel) => this.isIncluded(rel),
            classifyFn: (rel) => ({
              isText: this.isTextFile(rel),
              isMedia: this.isMediaFile(rel),
            }),
            progress: scanProgress,
            scanChunk: this.scanChunk,
            log: (msg) => this.log(msg),
          }),
          walkRemote(sftp, this.connection.remoteRoot, {
            filterFn: (rel) => this.isIncluded(rel),
            progress: scanProgress,
            scanChunk: this.scanChunk,
            log: (msg) => this.log(msg),
          }),
        ]);
      } else {
        local = await walkLocal(this.connection.localRoot, {
          filterFn: (rel) => this.isIncluded(rel),
          classifyFn: (rel) => ({
            isText: this.isTextFile(rel),
            isMedia: this.isMediaFile(rel),
          }),
          progress: scanProgress,
          scanChunk: this.scanChunk,
          log: (msg) => this.log(msg),
        });
        remote = await walkRemote(sftp, this.connection.remoteRoot, {
          filterFn: (rel) => this.isIncluded(rel),
          progress: scanProgress,
          scanChunk: this.scanChunk,
          log: (msg) => this.log(msg),
        });
      }

      scanProgress.stop();

      this.log(`${TAB_A}→ ${local.size} local files`);
      this.log(`${TAB_A}→ ${remote.size} remote files`);

      if (this.autoExcluded.size > 0) {
        this.log("");
        this.log(pc.dim("   Auto-excluded (sidecar upload/download):"));
        [...this.autoExcluded].sort().forEach((file) => {
          this.log(pc.dim(`${TAB_A} - ${file}`));
        });
      }

      this.log("");

      // Phase 3 – Analyse Differences (delegiert an Helper)
      this.log(pc.bold(pc.cyan("🔎 Phase 3: Compare & decide …")));

      const { getLocalHash, getRemoteHash, save: saveCache } = this.hashCache;

      const diffResult = await analyseDifferences({
        local,
        remote,
        remoteRoot: this.connection.remoteRoot,
        sftp,
        getLocalHash,
        getRemoteHash,
        analyzeChunk: this.analyzeChunk,
        updateProgress: (prefix, current, total, rel) =>
          this.updateProgress2(prefix, current, total, rel, "Files"),
      });

      toAdd = diffResult.toAdd;
      toUpdate = diffResult.toUpdate;

      if (toAdd.length === 0 && toUpdate.length === 0) {
        this.log("");
        this.log(`${TAB_A}No differences found. Everything is up to date.`);
      } else if (!this.isLaconic) {
        this.log("");
        this.log(pc.bold(pc.cyan("Changes (analysis):")));
        [...toAdd].forEach((t) =>
          this.log(`${TAB_A}${ADD} ${pc.green("New:")} ${t.rel}`)
        );
        [...toUpdate].forEach((t) =>
          this.log(`${TAB_A}${CHA} ${pc.yellow("Changed:")} ${t.rel}`)
        );
      }

      // Phase 4 – Remote deletes
      this.log("");
      this.log(pc.bold(pc.cyan("🧹 Phase 4: Removing orphaned remote files …")));

      toDelete = computeRemoteDeletes({ local, remote });

      if (toDelete.length === 0) {
        this.log(`${TAB_A}No orphaned remote files found.`);
      } else if (!this.isLaconic) {
        toDelete.forEach((t) =>
          this.log(`${TAB_A}${DEL} ${pc.red("Remove:")} ${t.rel}`)
        );
      }

      // Verzeichnisse vorbereiten
      if (!dryRun && (toAdd.length || toUpdate.length)) {
        this.log("");
        this.log(pc.bold(pc.cyan("📁 Preparing remote directories …")));
        await this.ensureAllRemoteDirsExist(
          sftp,
          this.connection.remoteRoot,
          toAdd,
          toUpdate
        );
      }

      // Phase 5 – Apply changes
      if (!dryRun) {
        this.log("");
        this.log(pc.bold(pc.cyan("🚚 Phase 5: Apply changes …")));

        // Upload new files
        await this.runTasks(
          toAdd,
          this.connection.workers,
          async ({ local: l, remotePath }) => {
            const remoteDir = path.posix.dirname(remotePath);
            try {
              await sftp.mkdir(remoteDir, true);
            } catch {
              // Directory may already exist
            }
            await sftp.put(l.localPath, remotePath);
          },
          "Uploads (new)"
        );

        // Updates
        await this.runTasks(
          toUpdate,
          this.connection.workers,
          async ({ local: l, remotePath }) => {
            const remoteDir = path.posix.dirname(remotePath);
            try {
              await sftp.mkdir(remoteDir, true);
            } catch {
              // Directory may already exist
            }
            await sftp.put(l.localPath, remotePath);
          },
          "Uploads (update)"
        );

        // Deletes
        await this.runTasks(
          toDelete,
          this.connection.workers,
          async ({ remotePath, rel }) => {
            try {
              await sftp.delete(remotePath);
            } catch (e) {
              this.elog(
                pc.red("   ⚠️ Error during deletion:"),
                rel || remotePath,
                e?.message || e
              );
            }
          },
          "Deletes"
        );
      } else {
        this.log("");
        this.log(
          pc.yellow(
            "💡 DRY-RUN: Connection tested, no files transferred or deleted."
          )
        );
      }

      // Optional: leere Verzeichnisse aufräumen
      if (!dryRun && this.cleanupEmptyDirsEnabled) {
        this.log("");
        this.log(
          pc.bold(pc.cyan("🧹 Cleaning up empty remote directories …"))
        );
        await this.cleanupEmptyDirs(sftp, this.connection.remoteRoot, dryRun);
      }

      const duration = ((Date.now() - start) / 1000).toFixed(2);

      // Cache am Ende sicher schreiben
      await saveCache(true);

      // Summary
      this.log(hr1());
      this.log("");
      this.log(pc.bold(pc.cyan("📊 Summary:")));
      this.log(`${TAB_A}Duration: ${pc.green(duration + " s")}`);
      this.log(`${TAB_A}${ADD} Added  : ${toAdd.length}`);
      this.log(`${TAB_A}${CHA} Changed: ${toUpdate.length}`);
      this.log(`${TAB_A}${DEL} Deleted: ${toDelete.length}`);
      if (this.autoExcluded.size > 0) {
        this.log(
          `${TAB_A}${EXC} Excluded via sidecar upload/download: ${
            this.autoExcluded.size
          }`
        );
      }

      // Directory-Statistik
      const dirsChecked =
        this.dirStats.ensuredDirs + this.dirStats.cleanupVisited;
      this.log("");
      this.log(pc.bold("Folders:"));
      this.log(`${TAB_A}Checked : ${dirsChecked}`);
      this.log(`${TAB_A}${ADD} Created: ${this.dirStats.createdDirs}`);
      this.log(`${TAB_A}${DEL} Deleted: ${this.dirStats.cleanupDeleted}`);

      if (toAdd.length || toUpdate.length || toDelete.length) {
        this.log("");
        this.log("📄 Changes:");
        [...toAdd.map((t) => t.rel)]
          .sort()
          .forEach((f) => console.log(`${TAB_A}${ADD} ${f}`));
        [...toUpdate.map((t) => t.rel)]
          .sort()
          .forEach((f) => console.log(`${TAB_A}${CHA} ${f}`));
        [...toDelete.map((t) => t.rel)]
          .sort()
          .forEach((f) => console.log(`${TAB_A}${DEL} ${f}`));
      } else {
        this.log("");
        this.log("No changes.");
      }

      this.log("");
      this.log(pc.bold(pc.green("✅ Sync complete.")));
    } catch (err) {
      const hint = describeSftpError(err);
      this.elog(pc.red("❌ Synchronisation error:"), err?.message || err);
      if (hint) {
        this.wlog(pc.yellow(`${TAB_A}Possible cause:`), hint);
      }
      if (this.isVerbose) {
        console.error(err);
      }
      process.exitCode = 1;
      try {
        // falls hashCache existiert, Cache noch flushen
        if (this.hashCache?.save) {
          await this.hashCache.save(true);
        }
      } catch {
        // ignore
      }
    } finally {
      try {
        if (connected) {
          await sftp.end();
          this.log(pc.green(`${TAB_A}✔ Connection closed.`));
        }
      } catch (e) {
        this.wlog(
          pc.yellow("⚠️ Could not close SFTP connection cleanly:"),
          e?.message || e
        );
      }

      this.log(hr2());
      this.log("");

      if (this.logger) {
        this.logger.close();
      }
    }
  }
}