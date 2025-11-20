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
}) {
  const toAdd = [];
  const toUpdate = [];

  const localKeys = new Set(local.keys());
  const totalToCheck = localKeys.size;
  let checked = 0;

  for (const rel of localKeys) {
    checked += 1;

    if (
      updateProgress &&
      (checked === 1 || checked % analyzeChunk === 0 || checked === totalToCheck)
    ) {
      updateProgress("Analyse: ", checked, totalToCheck, rel);
    }

    const l = local.get(rel);
    const r = remote.get(rel);
    const remotePath = path.posix.join(remoteRoot, rel);

    // Datei existiert nur lokal → New
    if (!r) {
      toAdd.push({ rel, local: l, remotePath });
      continue;
    }

    // 1. Size-Vergleich
    if (l.size !== r.size) {
      toUpdate.push({ rel, local: l, remote: r, remotePath });
      continue;
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
        // Fallback: wenn kein Hash-Cache übergeben wurde, treat as changed
        toUpdate.push({ rel, local: l, remote: r, remotePath });
        continue;
      }

      const [localHash, remoteHash] = await Promise.all([
        getLocalHash(rel, l),
        getRemoteHash(rel, r, sftp),
      ]);

      if (localHash !== remoteHash) {
        toUpdate.push({ rel, local: l, remote: r, remotePath });
      }
    }
  }

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