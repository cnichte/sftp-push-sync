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
 * Optimiert: Parallelisierte Analyse mit Concurrency-Limit.
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
 *  - concurrency: Max parallele Vergleiche (default: 8)
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
  concurrency = 5,
}) {
  const toAdd = [];
  const toUpdate = [];

  const localKeys = [...local.keys()];
  const totalToCheck = localKeys.length;
  let checked = 0;

  // Schneller Vorab-Check: Dateien nur lokal → direkt zu toAdd
  const keysToCompare = [];
  for (const rel of localKeys) {
    const r = remote.get(rel);
    const remotePath = path.posix.join(remoteRoot, rel);
    
    if (!r) {
      // Datei existiert nur lokal → New (kein SFTP-Call nötig)
      toAdd.push({ rel, local: local.get(rel), remotePath });
      checked++;
      if (updateProgress && checked % analyzeChunk === 0) {
        updateProgress("Analyse: ", checked, totalToCheck, rel);
      }
    } else {
      keysToCompare.push(rel);
    }
  }

  // Parallele Verarbeitung mit Semaphore
  let activeCount = 0;
  const waiting = [];

  async function acquireSemaphore() {
    if (activeCount < concurrency) {
      activeCount++;
      return;
    }
    await new Promise((resolve) => waiting.push(resolve));
    activeCount++;
  }

  function releaseSemaphore() {
    activeCount--;
    if (waiting.length > 0) {
      const next = waiting.shift();
      next();
    }
  }

  async function compareFile(rel) {
    await acquireSemaphore();
    try {
      const l = local.get(rel);
      const r = remote.get(rel);
      const remotePath = path.posix.join(remoteRoot, rel);

      // 1. Size-Vergleich (schnell, kein SFTP)
      if (l.size !== r.size) {
        toUpdate.push({ rel, local: l, remote: r, remotePath });
        return;
      }

      // 2. Content-Vergleich
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

        if (localStr !== remoteStr) {
          toUpdate.push({ rel, local: l, remote: r, remotePath });
        }
      } else {
        // Binary: Hash-Vergleich mit Cache
        if (!getLocalHash || !getRemoteHash) {
          toUpdate.push({ rel, local: l, remote: r, remotePath });
          return;
        }

        const [localHash, remoteHash] = await Promise.all([
          getLocalHash(rel, l),
          getRemoteHash(rel, r, sftp),
        ]);

        if (localHash !== remoteHash) {
          toUpdate.push({ rel, local: l, remote: r, remotePath });
        }
      }
    } finally {
      releaseSemaphore();
      checked++;
      if (
        updateProgress &&
        (checked === 1 || checked % analyzeChunk === 0 || checked === totalToCheck)
      ) {
        updateProgress("Analyse: ", checked, totalToCheck, rel);
      }
    }
  }

  // Starte alle Vergleiche parallel (mit Concurrency-Limit durch Semaphore)
  await Promise.all(keysToCompare.map(compareFile));

  return { toAdd, toUpdate };
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