/**
 * compare.mjs
 *
 * @author Carsten Nichte, 2025 / https://carsten-nichte.de/
 *
 */
// src/helpers/compare.mjs
import fsp from "fs/promises";
import path from "path";

/**
 * Analysiert Unterschiede zwischen local- und remote-Maps.
 * Optimiert: Echtes Batch-Processing mit Concurrency-Limit.
 *
 * Erwartete Struktur:
 *  local:  Map<rel, { rel, localPath, size, mtimeMs, isText? }>
 *  remote: Map<rel, { rel, remotePath, size, modifyTime }>
 *
 * Optionen:
 *  - remoteRoot: Basis-Pfad auf dem Server
 *  - sftp: ssh2-sftp-client Instanz
 *  - getLocalHash / getRemoteHash: from createHashCache
 *  - analyzeChunk: Progress-Schrittgröße
 *  - updateProgress(prefix, current, total, rel): optional
 *  - concurrency: Max parallele Vergleiche (default: 5)
 *  - log: optional logging function for errors/warnings
 *  - maxSizeForHash: Files larger than this skip hash comparison (default: 50MB)
 */
export async function analyseDifferences({
  local,
  remote,
  remoteRoot,
  sftp,
  getLocalHash,
  getRemoteHash,
  analyzeChunk = 10,
  updateProgress,
  concurrency = 10,
  log,
  maxSizeForHash = 50 * 1024 * 1024, // 50MB default
}) {
  // Track errors for summary
  const compareErrors = [];
  // Track large files skipped
  const largeFilesSkipped = [];
  const toAdd = [];
  const toUpdate = [];

  const localKeys = [...local.keys()];
  const totalToCheck = localKeys.length;
  let checked = 0;

  // Phase 1: Schneller Vorab-Check ohne SFTP
  // - Dateien nur lokal → direkt zu toAdd
  // - Size-Vergleich für existierende Dateien
  // - Große Dateien: nur MTime-Vergleich (kein Hash-Download)
  const keysNeedContentCompare = [];

  for (const rel of localKeys) {
    const l = local.get(rel);
    const r = remote.get(rel);
    const remotePath = path.posix.join(remoteRoot, rel);

    if (!r) {
      // Datei existiert nur lokal → New (kein SFTP-Call nötig)
      toAdd.push({ rel, local: l, remotePath });
    } else if (l.size !== r.size) {
      // Size unterschiedlich → Changed (kein SFTP-Call nötig)
      toUpdate.push({ rel, local: l, remote: r, remotePath });
    // } else if (l.size > maxSizeForHash) {
    //   // Große Datei mit gleicher Size: nur MTime vergleichen
    //   // Remote modifyTime ist String wie "2026-03-05", local mtimeMs ist Timestamp
    //   const localDate = new Date(l.mtimeMs).toISOString().split('T')[0];
    //   const remoteDate = r.modifyTime ? r.modifyTime.split('T')[0] : '';
    //   
    //   if (localDate > remoteDate) {
    //     // Local ist neuer → Changed
    //     toUpdate.push({ rel, local: l, remote: r, remotePath });
    //     if (log) {
    //       const sizeMB = (l.size / (1024 * 1024)).toFixed(1);
    //       log(`   ℹ Large file (${sizeMB}MB) newer locally: ${rel}`);
    //     }
    //   } else {
    //     largeFilesSkipped.push({ rel, size: l.size });
    //   }
    } else {
      // Size gleich, normale Größe → Content-Vergleich nötig
      keysNeedContentCompare.push(rel);
    }

    checked++;
    if (updateProgress && checked % analyzeChunk === 0) {
      updateProgress("Analyse (quick): ", checked, totalToCheck, rel);
    }
  }

  // Final progress update for Phase 1
  if (updateProgress) {
    updateProgress("Analyse (quick): ", totalToCheck, totalToCheck, "done");
  }

  // Phase 2: Content-Vergleich in echten Batches
  // Nur für Dateien mit gleicher Size (und unter maxSizeForHash)
  const totalContentCompare = keysNeedContentCompare.length;

  if (totalContentCompare > 0 && log) {
    log(`   → ${totalContentCompare} files need content comparison`);
  }

  for (let i = 0; i < totalContentCompare; i += concurrency) {
    const batch = keysNeedContentCompare.slice(i, i + concurrency);

    const batchResults = await Promise.all(
      batch.map(async (rel) => {
        const l = local.get(rel);
        const r = remote.get(rel);
        const remotePath = path.posix.join(remoteRoot, rel);

        try {
          if (l.isText) {
            // Text-Datei: vollständiger inhaltlicher Vergleich
            const [localBuf, remoteBuf] = await Promise.all([
              fsp.readFile(l.localPath),
              sftp.get(r.remotePath),
            ]);

            const localStr = localBuf.toString("utf8");
            const remoteStr = (
              Buffer.isBuffer(remoteBuf) ? remoteBuf : Buffer.from(remoteBuf)
            ).toString("utf8");

            return localStr !== remoteStr
              ? { rel, local: l, remote: r, remotePath, changed: true }
              : null;
          } else {
            // Binary: Hash-Vergleich mit Cache
            if (!getLocalHash || !getRemoteHash) {
              return { rel, local: l, remote: r, remotePath, changed: true };
            }

            const [localHash, remoteHash] = await Promise.all([
              getLocalHash(rel, l),
              getRemoteHash(rel, r, sftp),
            ]);

            return localHash !== remoteHash
              ? { rel, local: l, remote: r, remotePath, changed: true }
              : null;
          }
        } catch (err) {
          // Log the error so user can see what's happening
          const errMsg = err?.message || String(err);
          compareErrors.push({ rel, error: errMsg });
          if (log) {
            log(`   ⚠ Compare error for ${rel}: ${errMsg}`);
          }
          // Mark as changed (sicherer) - file will be re-uploaded
          return { rel, local: l, remote: r, remotePath, changed: true, hadError: true };
        }
      })
    );

    // Ergebnisse sammeln
    for (const result of batchResults) {
      if (result && result.changed) {
        toUpdate.push({ rel: result.rel, local: result.local, remote: result.remote, remotePath: result.remotePath });
      }
    }

    // Progress update - show as separate progress (doesn't jump back)
    const progressCount = Math.min(i + batch.length, totalContentCompare);
    if (updateProgress) {
      updateProgress("Analyse (hash): ", progressCount, totalContentCompare, batch[batch.length - 1]);
    }
  }

  return { toAdd, toUpdate, compareErrors, largeFilesSkipped };
}

/**
 * Ermittelt zu löschende Dateien (remote-only).
 *
 * remote: Map<rel, { rel, remotePath }>
 */
export function computeRemoteDeletes({ local, remote }) {
  const toDelete = [];
  const localKeys = new Set(local.keys());

  for (const [rel, r] of remote.entries()) {
    if (!localKeys.has(rel)) {
      toDelete.push({ rel, remotePath: r.remotePath });
    }
  }

  return toDelete;
}
