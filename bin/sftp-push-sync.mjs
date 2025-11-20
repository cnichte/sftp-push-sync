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
import pc from "picocolors";
import { SftpPushSyncApp } from "../src/core/SftpPushSyncApp.mjs";

// ---------------------------------------------------------------------------
// CLI-Arguments
// ---------------------------------------------------------------------------
//
// Call examples:
//
//   sftp-push-sync staging --dry-run
//   sftp-push-sync live --sidecar-upload --skip-sync
//   sftp-push-sync live --config ./config/sync.live.json
//
// Die Struktur:
//   [0] = target
//   [1..] = Flags
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);

// Help?
if (
  rawArgs.length === 0 ||
  rawArgs.includes("--help") ||
  rawArgs.includes("-h")
) {
  printUsage();
  process.exit(rawArgs.length === 0 ? 1 : 0);
}

const TARGET = rawArgs[0];

// If someone only passes flags but no target name
if (!TARGET || TARGET.startsWith("-")) {
  console.error(pc.red("❌ Please specify a connection profile.\n"));
  printUsage();
  process.exit(1);
}

// Evaluate flags from position 1 onwards
let DRY_RUN = false;
let RUN_UPLOAD_LIST = false;
let RUN_DOWNLOAD_LIST = false;
let SKIP_SYNC = false;
let cliLogLevel = null;
let configPath = undefined;

const rest = rawArgs.slice(1);

for (let i = 0; i < rest.length; i += 1) {
  const a = rest[i];

  switch (a) {
    case "--dry-run":
      DRY_RUN = true;
      break;
    case "--sidecar-upload":
      RUN_UPLOAD_LIST = true;
      break;
    case "--sidecar-download":
      RUN_DOWNLOAD_LIST = true;
      break;
    case "--skip-sync":
      SKIP_SYNC = true;
      break;
    case "--verbose":
      cliLogLevel = "verbose";
      break;
    case "--laconic":
      cliLogLevel = "laconic";
      break;
    case "--config":
    case "-c": {
      const next = rest[i + 1];
      if (!next || next.startsWith("-")) {
        console.error(
          pc.red("❌ --config expects a path argument (e.g. --config sync.config.json)")
        );
        process.exit(1);
      }
      configPath = next;
      i += 1; // Pfad überspringen
      break;
    }
    default:
      console.error(pc.yellow(`⚠️ Unknown argument ignored: ${a}`));
      break;
  }
}

// --skip-sync without lists → error
if (SKIP_SYNC && !RUN_UPLOAD_LIST && !RUN_DOWNLOAD_LIST) {
  console.error(
    pc.red(
      "❌ --skip-sync requires at least --sidecar-upload or --sidecar-download."
    )
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage() {
  /* eslint-disable no-console */
  console.log("");
  console.log(pc.bold("Usage:"));
  console.log("  sftp-push-sync <target> [options]");
  console.log("");
  console.log(pc.bold("Examples:"));
  console.log("  sftp-push-sync staging --dry-run");
  console.log("  sftp-push-sync live --sidecar-upload --skip-sync");
  console.log("  sftp-push-sync live --config ./sync.config.live.json");
  console.log("");
  console.log(pc.bold("Options:"));
  console.log("  --dry-run            Do not change anything, just simulate");
  console.log(
    "  --sidecar-upload    Run sidecar upload list (from sync.config.json)"
  );
  console.log(
    "  --sidecar-download  Run sidecar download list (from sync.config.json)"
  );
  console.log(
    "  --skip-sync         Skip normal sync, only run sidecar upload/download"
  );
  console.log("  --verbose           Enable verbose logging");
  console.log("  --laconic           Minimal logging (overrides verbose)");
  console.log(
    "  --config, -c <file> Use custom config file (default: ./sync.config.json)"
  );
  console.log("  --help, -h          Show this help");
  console.log("");
  /* eslint-enable no-console */
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  const app = new SftpPushSyncApp({
    target: TARGET,
    dryRun: DRY_RUN,
    runUploadList: RUN_UPLOAD_LIST,
    runDownloadList: RUN_DOWNLOAD_LIST,
    skipSync: SKIP_SYNC,
    cliLogLevel,
    configPath,
  });

  await app.run();
}

main().catch((err) => {
  console.error(pc.red("❌ Unhandled error in sftp-push-sync:"), err?.message || err);
  if (process.env.DEBUG) {
    console.error(err);
  }
  process.exit(1);
});