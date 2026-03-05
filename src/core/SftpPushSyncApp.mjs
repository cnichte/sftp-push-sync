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
import { createHashCacheNDJSON, migrateFromJsonCache } from "../helpers/hash-cache-ndjson.mjs";
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
  // SFTP Connection Helpers
  // ---------------------------------------------------------

  /**
   * Check if SFTP connection is still alive
   */
  async _isConnected(sftp) {
    try {
      // Try a minimal operation to check connection
      await sftp.cwd();
      return true;
    } catch (e) {
      if (this.isVerbose) {
        this.vlog(`${TAB_A}${pc.dim(`Connection check failed: ${e?.message || e}`)}`);
      }
      return false;
    }
  }

  /**
   * Reconnect to SFTP server with retry logic
   */
  async _reconnect(sftp, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        try {
          await sftp.end();
        } catch (e) {
          // Ignore errors when closing dead connection
          if (this.isVerbose) {
            this.vlog(`${TAB_A}${pc.dim(`Closing old connection failed (expected): ${e?.message || e}`)}`);
          }
        }

        // Wait before reconnecting (exponential backoff)
        if (attempt > 1) {
          const waitTime = 1000 * Math.pow(2, attempt - 1); // 2s, 4s, 8s
          this.log(`${TAB_A}${pc.yellow(`⏳ Waiting ${waitTime/1000}s before retry ${attempt}/${maxRetries}…`)}`);
          await new Promise(r => setTimeout(r, waitTime));
        }

        await sftp.connect({
          host: this.connection.host,
          port: this.connection.port,
          username: this.connection.user,
          password: this.connection.password,
          keepaliveInterval: 5000,     // More frequent keepalive (5s instead of 10s)
          keepaliveCountMax: 6,        // Disconnect after 30s of no response
          readyTimeout: 60000,         // 60s timeout for initial connection
          retries: 2,                  // Internal retries
          retry_factor: 2,
          retry_minTimeout: 2000,
        });

        if (sftp.client) {
          sftp.client.setMaxListeners(50);
        }

        this.log(`${TAB_A}${pc.green("✔ Reconnected to SFTP.")}`);
        return; // Success
      } catch (err) {
        const msg = err?.message || String(err);
        if (attempt === maxRetries) {
          this.elog(pc.red(`❌ Failed to reconnect after ${maxRetries} attempts: ${msg}`));
          throw err;
        }
        this.wlog(pc.yellow(`⚠ Reconnect attempt ${attempt} failed: ${msg}`));
      }
    }
  }

  /**
   * Upload a file with progress reporting for large files.
   * Uses fastPut for files > threshold, with automatic fallback to put on failure.
   */
  async _uploadFile(sftp, localPath, remotePath, rel, size) {
    const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024; // 5MB
    const sizeMB = (size / (1024 * 1024)).toFixed(1);
    
    // For small files, just use put
    if (size < LARGE_FILE_THRESHOLD) {
      await sftp.put(localPath, remotePath);
      return;
    }

    // For large files, try fastPut with progress
    let lastReportedPercent = 0;
    const shortRel = rel.length > 50 ? '...' + rel.slice(-47) : rel;

    try {
      await sftp.fastPut(localPath, remotePath, {
        step: (transferred, chunk, total) => {
          const percent = Math.floor((transferred / total) * 100);
          // Only log at 25%, 50%, 75%, 100%
          if (percent >= lastReportedPercent + 25) {
            lastReportedPercent = Math.floor(percent / 25) * 25;
            this.log(`${TAB_A}${pc.dim(`  ↑ ${sizeMB}MB ${percent}%: ${shortRel}`)}`);
          }
        }
      });
    } catch (fastPutErr) {
      // fastPut not supported by server, fall back to regular put
      if (this.isVerbose) {
        this.vlog(`${TAB_A}${pc.dim(`  fastPut failed, using put: ${fastPutErr?.message}`)}`);
      }
      this.log(`${TAB_A}${pc.dim(`  Uploading ${sizeMB}MB: ${shortRel}`)}`);
      await sftp.put(localPath, remotePath);
    }
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
  // Worker-Pool with auto-reconnect
  // ---------------------------------------------------------

  async runTasks(items, workerCount, handler, label = "Tasks", sftp = null) {
    if (!items || items.length === 0) return;

    const total = items.length;
    let done = 0;
    let index = 0;
    let failedCount = 0;
    const workers = [];
    const actualWorkers = Math.max(1, Math.min(workerCount, total));

    // Mutex for reconnection (only one worker reconnects at a time)
    let reconnecting = false;
    let reconnectWaiters = 0;

    const worker = async () => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const i = index;
        if (i >= total) break;
        index += 1;
        const item = items[i];

        let retries = 0;
        const maxRetries = 5; // Increased from 2 to 5 for unstable servers

        while (retries <= maxRetries) {
          try {
            await handler(item);
            break; // Success, exit retry loop
          } catch (err) {
            const msg = err?.message || String(err);
            const isConnectionError =
              msg.includes("No SFTP connection") ||
              msg.includes("ECONNRESET") ||
              msg.includes("ETIMEDOUT") ||
              msg.includes("ECONNREFUSED") ||
              msg.includes("connection") ||
              msg.includes("Channel open failure") ||
              msg.includes("socket") ||
              msg.includes("SSH");

            if (isConnectionError && sftp && retries < maxRetries) {
              // Wait if another worker is already reconnecting
              let waitCount = 0;
              reconnectWaiters++;
              if (reconnecting && this.isVerbose) {
                this.log(`${TAB_A}${pc.dim(`Worker waiting for reconnect (${reconnectWaiters} waiting)…`)}`);
              }
              while (reconnecting && waitCount < 120) { // Max 60 seconds wait
                await new Promise(r => setTimeout(r, 500));
                waitCount++;
                // Log every 10 seconds while waiting
                if (waitCount % 20 === 0 && this.isVerbose) {
                  this.log(`${TAB_A}${pc.dim(`Still waiting for reconnect… (${waitCount / 2}s)`)}`);
                }
              }
              reconnectWaiters--;

              // Check if reconnection is still needed
              if (!await this._isConnected(sftp)) {
                reconnecting = true;
                this.log(`${TAB_A}${pc.yellow("⚠ Connection lost during " + label + ", reconnecting…")}`);
                try {
                  await this._reconnect(sftp);
                  this.log(`${TAB_A}${pc.green("✔ Reconnected, resuming " + label + "…")}`);
                } catch (reconnectErr) {
                  this.elog(pc.red(`${TAB_A}❌ Reconnect failed: ${reconnectErr?.message || reconnectErr}`));
                  reconnecting = false;
                  // Re-throw to trigger retry
                  throw reconnectErr;
                } finally {
                  reconnecting = false;
                }
              }

              retries++;
              const retryDelay = 500 * retries;
              if (this.isVerbose) {
                this.log(`${TAB_A}${pc.dim(`Retry ${retries}/${maxRetries} for: ${item.rel || ''} (waiting ${retryDelay}ms)`)}`);
              }
              // Brief pause before retry
              await new Promise(r => setTimeout(r, retryDelay));
              // Retry the same item
              continue;
            }

            // Log error and move on
            this.elog(
              pc.red(`${TAB_A}⚠️ Error in ${label} (attempt ${retries + 1}/${maxRetries + 1}):`),
              msg
            );

            if (retries >= maxRetries) {
              failedCount++;
              this.elog(pc.red(`${TAB_A}❌ Failed after ${maxRetries + 1} attempts: ${item.rel || item.remotePath || ''}`));
            }
            break; // Exit retry loop
          }
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

    // Return statistics
    return { total, done, failed: failedCount };
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
    let failedDirs = 0;

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

      let retries = 0;
      const maxRetries = 3;
      let success = false;

      while (retries <= maxRetries && !success) {
        try {
          const exists = await sftp.exists(remoteDir);
          if (!exists) {
            await sftp.mkdir(remoteDir, true);
            this.dirStats.createdDirs += 1;
            this.vlog(`${TAB_A}${pc.dim("dir created:")} ${remoteDir}`);
          } else {
            this.vlog(`${TAB_A}${pc.dim("dir ok:")} ${remoteDir}`);
          }
          success = true;
        } catch (e) {
          const msg = e?.message || String(e);
          const isConnectionError =
            msg.includes("No SFTP connection") ||
            msg.includes("ECONNRESET") ||
            msg.includes("ETIMEDOUT") ||
            msg.includes("connection") ||
            msg.includes("Channel open failure") ||
            msg.includes("socket") ||
            msg.includes("SSH");

          if (isConnectionError && retries < maxRetries) {
            this.log(`${TAB_A}${pc.yellow("⚠ Connection lost during directory preparation, reconnecting…")}`);
            try {
              await this._reconnect(sftp);
              retries++;
              await new Promise(r => setTimeout(r, 500 * retries));
              continue; // Retry this directory
            } catch (reconnectErr) {
              this.elog(pc.red(`${TAB_A}❌ Reconnect failed: ${reconnectErr?.message || reconnectErr}`));
            }
          }

          this.wlog(
            pc.yellow("⚠️  Could not ensure directory:"),
            remoteDir,
            msg
          );
          failedDirs++;
          break; // Move to next directory
        }
      }
    }

    if (failedDirs > 0) {
      this.wlog(pc.yellow(`⚠️  ${failedDirs} directories could not be created`));
    }

    this.updateProgress2("Prepare dirs: ", total, total, "done", "Folders");
    process.stdout.write("\n");
    this.progressActive = false;
  }

  // ---------------------------------------------------------
  // Cleanup: leere Verzeichnisse löschen
  // ---------------------------------------------------------

  async cleanupEmptyDirs(sftp, rootDir, dryRun) {
    // Track reconnect state at cleanup level
    let reconnectNeeded = false;

    const attemptReconnect = async () => {
      if (reconnectNeeded) return false; // Already tried
      reconnectNeeded = true;
      this.log(`${TAB_A}${pc.yellow("⚠ Connection lost during cleanup, reconnecting…")}`);
      try {
        await this._reconnect(sftp);
        reconnectNeeded = false;
        return true;
      } catch (err) {
        this.elog(pc.red(`${TAB_A}❌ Reconnect during cleanup failed: ${err?.message || err}`));
        return false;
      }
    };

    const recurse = async (dir, depth = 0) => {
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

      // Try to list directory with reconnect on failure
      let retries = 0;
      while (retries <= 2) {
        try {
          items = await sftp.list(dir);
          break;
        } catch (e) {
          const msg = e?.message || String(e);
          const isConnectionError = msg.includes("No SFTP connection") ||
            msg.includes("ECONNRESET") || msg.includes("connection");

          if (isConnectionError && retries < 2) {
            const reconnected = await attemptReconnect();
            if (reconnected) {
              retries++;
              await new Promise(r => setTimeout(r, 500));
              continue;
            }
          }

          this.wlog(
            pc.yellow("⚠️  Could not list directory during cleanup:"),
            dir,
            msg
          );
          return false;
        }
      }

      if (!items) return false;

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
        const subEmpty = await recurse(full, depth + 1);
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
          let deleteRetries = 0;
          while (deleteRetries <= 2) {
            try {
              await sftp.rmdir(dir, false);
              this.log(`${TAB_A}${DEL} Removed empty directory: ${rel}`);
              this.dirStats.cleanupDeleted += 1;
              break;
            } catch (e) {
              const msg = e?.message || String(e);
              const isConnectionError = msg.includes("No SFTP connection") ||
                msg.includes("ECONNRESET") || msg.includes("connection");

              if (isConnectionError && deleteRetries < 2) {
                const reconnected = await attemptReconnect();
                if (reconnected) {
                  deleteRetries++;
                  await new Promise(r => setTimeout(r, 500));
                  continue;
                }
              }

              this.wlog(
                pc.yellow("⚠️  Could not remove directory:"),
                dir,
                msg
              );
              return false;
            }
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

  /**
   * Format duration in human-readable format (mm:ss or hh:mm:ss)
   */
  _formatDuration(seconds) {
    const totalSec = Math.floor(seconds);
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  async run() {
    const start = Date.now();

    // Global error handlers to catch unexpected errors
    const handleFatalError = (type, error) => {
      const msg = error?.message || String(error);
      const logMsg = `❌ FATAL ${type}: ${msg}`;
      console.error(pc.red(logMsg));
      if (this.logger) {
        this.logger.writeLine(logMsg);
        this.logger.writeLine(error?.stack || "No stack trace available");
        this.logger.close();
      }
      process.exitCode = 1;
    };

    process.on('unhandledRejection', (reason) => {
      handleFatalError('Unhandled Promise Rejection', reason);
    });
    process.on('uncaughtException', (error) => {
      handleFatalError('Uncaught Exception', error);
    });

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

    // Timestamps in Logfile
    this.logTimestamps = configRaw.logTimestamps ?? false;

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

    // Hash-Cache (NDJSON - human-readable, scales to 100k+ files)
    const oldJsonCacheName = targetConfig.syncCache || `.sync-cache.${target}.json`;
    const oldJsonCachePath = path.resolve(oldJsonCacheName);
    const ndjsonCachePath = path.resolve(`.sync-cache.${target}.ndjson`);

    // Migrate from old JSON cache if exists
    const migration = await migrateFromJsonCache(oldJsonCachePath, ndjsonCachePath, target);
    if (migration.migrated) {
      console.log(pc.green(`   ✔ Migrated ${migration.localCount + migration.remoteCount} cache entries from JSON to NDJSON`));
    }

    this.hashCache = await createHashCacheNDJSON({
      cachePath: ndjsonCachePath,
      namespace: target,
      vlog: this.isVerbose ? (...m) => console.log(...m) : null,
    });

    // Logger
    const DEFAULT_LOG_FILE = `.sync.${target}.log`;
    const rawLogFilePattern = configRaw.logFile || DEFAULT_LOG_FILE;
    const logFile = path.resolve(
      rawLogFilePattern.replace("{target}", target)
    );
    this.logger = new SyncLogger(logFile, { enableTimestamps: this.logTimestamps });
    await this.logger.init();

    // Header
    this.log("\n" + hr2());
    this.log(
      pc.bold(
        `🔐 SFTP Push-Synchronisation: sftp-push-sync  v${pkg.version}`
      )
    );
    this.log(`${TAB_A}LogLevel: ${this.logLevel}${this.logTimestamps ? " (timestamps enabled)" : ""}`);
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
        // Keep-Alive to prevent server disconnection during long operations
        keepaliveInterval: 5000,   // Send keepalive every 5 seconds (more frequent for unstable servers)
        keepaliveCountMax: 6,      // Allow up to 6 missed keepalives (30s total) before disconnect
        readyTimeout: 60000,       // 60s timeout for initial connection
        retries: 2,                // Internal retries
        retry_factor: 2,
        retry_minTimeout: 2000,
      });
      connected = true;

      // Increase max listeners for parallel operations
      if (sftp.client) {
        sftp.client.setMaxListeners(50);
      }

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

        const durationSec = (Date.now() - start) / 1000;
        const durationFormatted = this._formatDuration(durationSec);
        this.log("");
        this.log(pc.bold(pc.cyan("📊 Summary (bypass only):")));
        this.log(`${TAB_A}Duration: ${pc.green(durationFormatted)} (${durationSec.toFixed(1)}s)`);
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
      this.log(pc.bold(pc.cyan("🔎 Phase 3: Compare & Decide …")));

      const { getLocalHash, getRemoteHash } = this.hashCache;

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
        log: this.isVerbose ? (...m) => this.log(...m) : null,
      });

      toAdd = diffResult.toAdd;
      toUpdate = diffResult.toUpdate;

      // Report large files that skipped hash comparison
      if (diffResult.largeFilesSkipped && diffResult.largeFilesSkipped.length > 0 && this.isVerbose) {
        const totalSizeMB = diffResult.largeFilesSkipped.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);
        this.log(`   ℹ ${diffResult.largeFilesSkipped.length} large files (${totalSizeMB.toFixed(0)}MB total) skipped hash compare (same size/date)`);
      }

      // Report compare errors if any
      if (diffResult.compareErrors && diffResult.compareErrors.length > 0) {
        this.log("");
        this.wlog(pc.yellow(`⚠ ${diffResult.compareErrors.length} files had compare errors (will be re-uploaded):`));
        if (this.isVerbose) {
          for (const { rel, error } of diffResult.compareErrors) {
            this.wlog(pc.yellow(`   - ${rel}: ${error}`));
          }
        }
      }

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

      // Reconnect if connection was lost during analysis
      if (!await this._isConnected(sftp)) {
        this.log(`${TAB_A}${pc.yellow("⚠ Connection lost, reconnecting…")}`);
        await this._reconnect(sftp);
      }

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

        // Ensure connection before directory operations
        if (!await this._isConnected(sftp)) {
          this.log(`${TAB_A}${pc.yellow("⚠ Connection lost, reconnecting…")}`);
          await this._reconnect(sftp);
        }

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

        // Ensure fresh connection before uploads
        if (!await this._isConnected(sftp)) {
          this.log(`${TAB_A}${pc.yellow("⚠ Connection lost, reconnecting…")}`);
          await this._reconnect(sftp);
        }

        // Upload new files
        await this.runTasks(
          toAdd,
          this.connection.workers,
          async ({ local: l, remotePath, rel }) => {
            const remoteDir = path.posix.dirname(remotePath);
            try {
              await sftp.mkdir(remoteDir, true);
            } catch {
              // Directory may already exist
            }
            await this._uploadFile(sftp, l.localPath, remotePath, rel, l.size);
          },
          "Uploads (new)",
          sftp
        );

        // Updates
        await this.runTasks(
          toUpdate,
          this.connection.workers,
          async ({ local: l, remotePath, rel }) => {
            const remoteDir = path.posix.dirname(remotePath);
            try {
              await sftp.mkdir(remoteDir, true);
            } catch {
              // Directory may already exist
            }
            await this._uploadFile(sftp, l.localPath, remotePath, rel, l.size);
          },
          "Uploads (update)",
          sftp
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
          "Deletes",
          sftp
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

        // Ensure connection before cleanup
        if (!await this._isConnected(sftp)) {
          this.log(`${TAB_A}${pc.yellow("⚠ Connection lost, reconnecting…")}`);
          await this._reconnect(sftp);
        }

        await this.cleanupEmptyDirs(sftp, this.connection.remoteRoot, dryRun);
      }

      const durationSec = (Date.now() - start) / 1000;
      const durationFormatted = this._formatDuration(durationSec);

      // Save cache and close
      await this.hashCache.save();
      await this.hashCache.close();

      // Summary
      this.log(hr1());
      this.log("");
      this.log(pc.bold(pc.cyan("📊 Summary:")));
      this.log(`${TAB_A}Duration: ${pc.green(durationFormatted)} (${durationSec.toFixed(1)}s)`);
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
        // falls hashCache existiert, Cache schließen
        if (this.hashCache?.close) {
          await this.hashCache.close();
        }
      } catch (e) {
        // Cache close failed during error cleanup
        if (this.isVerbose) {
          this.vlog(`${TAB_A}${pc.dim(`Cache close during cleanup failed: ${e?.message || e}`)}`)
        }
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
