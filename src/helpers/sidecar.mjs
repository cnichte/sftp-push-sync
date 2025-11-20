/**
 * sidecar.mjs
 * 
 * @author Carsten Nichte, 2025 / https://carsten-nichte.de/
 * 
 */ 
// src/helpers/sidecar.mjs
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { walkLocalPlain, walkRemotePlain } from "./walkers.mjs";

/** minimales Pattern-Matching à la minimatch (einfach: exakte Strings oder simple "*" am Ende) */
function matchesAny(patterns, relPath) {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => {
    if (!pattern) return false;
    if (pattern === relPath) return true;
    // primitive *-Unterstützung, falls du willst → sonst weglassen
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      return relPath.startsWith(prefix);
    }
    return false;
  });
}

/**
 * Upload-Targets für Sidecar sammeln
 */
export async function collectUploadTargets({
  sidecarLocalRoot,
  sidecarRemoteRoot,
  uploadList,
}) {
  const all = await walkLocalPlain(sidecarLocalRoot);
  const results = [];

  for (const [rel, meta] of all.entries()) {
    if (matchesAny(uploadList, rel)) {
      const remotePath = path.posix.join(sidecarRemoteRoot, rel);
      results.push({
        rel,
        localPath: meta.localPath,
        remotePath,
      });
    }
  }

  return results;
}

/**
 * Download-Targets für Sidecar sammeln
 */
export async function collectDownloadTargets({
  sftp,
  sidecarLocalRoot,
  sidecarRemoteRoot,
  downloadList,
}) {
  const all = await walkRemotePlain(sftp, sidecarRemoteRoot);
  const results = [];

  for (const [rel, meta] of all.entries()) {
    if (matchesAny(downloadList, rel)) {
      const localPath = path.join(sidecarLocalRoot, rel);
      results.push({
        rel,
        remotePath: meta.remotePath,
        localPath,
      });
    }
  }

  return results;
}

/**
 * Führt den Bypass-Modus aus (sidecar-upload / sidecar-download)
 *
 * Erwartete Parameter:
 *  - sftp: ssh2-sftp-client
 *  - connection: { sidecarLocalRoot, sidecarRemoteRoot, workers }
 *  - uploadList, downloadList: String-Arrays
 *  - options: { dryRun, runUploadList, runDownloadList }
 *  - runTasks: Workerpool-Funktion (items, workerCount, handler, label)
 *  - log, vlog, elog: Logging-Funktionen
 *  - symbols: { ADD, CHA, tab_a } → damit du deine bestehenden Symbole weiter nutzen kannst
 */
export async function performBypassOnly({
  sftp,
  connection,
  uploadList,
  downloadList,
  options,
  runTasks,
  log,
  vlog,
  elog,
  symbols,
}) {
  const { dryRun, runUploadList, runDownloadList } = options;
  const { sidecarLocalRoot, sidecarRemoteRoot, workers } = connection;
  const { ADD, CHA, tab_a } = symbols;

  log("");
  log("🚀 Bypass-Only Mode (skip-sync)");
  log(`${tab_a}Sidecar Local: ${sidecarLocalRoot}`);
  log(`${tab_a}Sidecar Remote: ${sidecarRemoteRoot}`);

  if (runUploadList && !fs.existsSync(sidecarLocalRoot)) {
    const msg = `Sidecar local root does not exist: ${sidecarLocalRoot}`;
    elog(`❌ ${msg}`);
    throw new Error(msg);
  }

  // Upload-Bereich
  if (runUploadList) {
    log("");
    log("⬆️  Upload-Bypass (sidecar-upload) …");
    const targets = await collectUploadTargets({
      sidecarLocalRoot,
      sidecarRemoteRoot,
      uploadList,
    });
    log(`${tab_a}→ ${targets.length} files from uploadList`);

    if (!dryRun) {
      await runTasks(
        targets,
        workers,
        async ({ localPath, remotePath, rel }) => {
          const remoteDir = path.posix.dirname(remotePath);
          try {
            await sftp.mkdir(remoteDir, true);
          } catch {
            // Directory may already exist
          }
          await sftp.put(localPath, remotePath);
          vlog && vlog(`${tab_a}${ADD} Uploaded (bypass): ${rel}`);
        },
        "Bypass Uploads"
      );
    } else {
      for (const t of targets) {
        log(`${tab_a}${ADD} (DRY-RUN) Upload: ${t.rel}`);
      }
    }
  }

  // Download-Bereich
  if (runDownloadList) {
    log("");
    log("⬇️  Download-Bypass (sidecar-download) …");
    const targets = await collectDownloadTargets({
      sftp,
      sidecarLocalRoot,
      sidecarRemoteRoot,
      downloadList,
    });
    log(`${tab_a}→ ${targets.length} files from downloadList`);

    if (!dryRun) {
      await runTasks(
        targets,
        workers,
        async ({ remotePath, localPath, rel }) => {
          const localDir = path.dirname(localPath);
          await fsp.mkdir(localDir, { recursive: true });
          await sftp.get(remotePath, localPath);
          vlog && vlog(`${tab_a}${CHA} Downloaded (bypass): ${rel}`);
        },
        "Bypass Downloads"
      );
    } else {
      for (const t of targets) {
        log(`${tab_a}${CHA} (DRY-RUN) Download: ${t.rel}`);
      }
    }
  }

  log("");
  log("✅ Bypass-only run finished.");
}