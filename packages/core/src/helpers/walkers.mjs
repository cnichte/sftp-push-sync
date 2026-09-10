/**
 * walkers.mjs
 *
 * @author Carsten Nichte, 2025, https://carsten-nichte.de/
 *
 */
// src/helpers/walkers.mjs
import fsp from "fs/promises";
import path from "path";
import { toPosix } from "./directory.mjs";

/**
 * Allgemeiner Local-Walker mit Filter + Progress
 *
 * filterFn(rel) → true/false
 * options:
 *   - progress: ScanProgressController-ähnliches Objekt (updateChannel/done)
 *   - scanChunk: nach wievielen Dateien Progress aktualisieren
 *   - log: optionaler Fallback-Logger für non-TTY
 */
export async function walkLocal(
  root,
  {
    filterFn,
    classifyFn, // optional: (rel) => { isText, isMedia }
    progress = null,
    scanChunk = 100,
    log = null,
  } = {}
) {
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

        if (filterFn && !filterFn(rel)) continue;

        const stat = await fsp.stat(full);
        const baseMeta = {
          rel,
          localPath: full,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };

        const extra = classifyFn ? classifyFn(rel) : {};
        result.set(rel, { ...baseMeta, ...extra });

        scanned += 1;

        if (
          progress &&
          (scanned === 1 || scanned % scanChunk === 0)
        ) {
          progress.updateChannel("local", {
            label: "Scan local",
            current: scanned,
            total: 0,
            lastRel: full,
          });
        }
      }
    }
  }

  await recurse(root);

  if (progress) {
    progress.updateChannel("local", {
      label: "Scan local",
      current: scanned,
      total: result.size,
      lastRel: null,
    });
    progress.done("local");
  }

  if (!process.stdout.isTTY && scanned > 0 && log) {
    log(`   Scan local: ${scanned} Files`);
  }

  return result;
}

/**
 * Plain Local Walker – ohne Filter, ohne Klassifizierung
 */
export async function walkLocalPlain(root) {
  const result = new Map();

  async function recurse(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await recurse(full);
      } else if (entry.isFile()) {
        const rel = toPosix(path.relative(root, full));
        result.set(rel, { rel, localPath: full });
      }
    }
  }

  await recurse(root);
  return result;
}

/**
 * Remote-Walker mit INCLUDE/EXCLUDE über filterFn
 * Optimiert: feste Worker-Queue für parallele Verzeichnis-Listings
 */
export async function walkRemote(
  sftp,
  remoteRoot,
  {
    filterFn,
    progress = null,
    scanChunk = 100,
    log = null,
    concurrency = 5,  // Max parallel directory listings
  } = {}
) {
  const result = new Map();
  let scanned = 0;
  const workerCount = Math.max(1, Number(concurrency) || 1);

  // Verzeichnisbaum (rel -> { parent, fileCount }), damit spätere Cleanup-Läufe
  // die Leerheit von Verzeichnissen ohne erneutes sftp.list() bestimmen können.
  const dirIndex = new Map();
  dirIndex.set("", { parent: null, fileCount: 0 });

  function registerDir(rel, parentRel) {
    if (!dirIndex.has(rel)) {
      dirIndex.set(rel, { parent: parentRel, fileCount: 0 });
    }
  }

  const queue = [{ remoteDir: remoteRoot, prefix: "" }];
  let activeWorkers = 0;
  const wakeWorkers = [];

  function wakeNextWorker() {
    const wakeWorker = wakeWorkers.shift();
    if (wakeWorker) wakeWorker();
  }

  function enqueue(remoteDir, prefix) {
    queue.push({ remoteDir, prefix });
    wakeNextWorker();
  }

  async function takeNextDirectory() {
    while (queue.length === 0) {
      if (activeWorkers === 0) return null;
      await new Promise((resolve) => {
        wakeWorkers.push(resolve);
      });
    }

    activeWorkers += 1;
    return queue.shift();
  }

  function finishDirectory() {
    activeWorkers -= 1;
    if (activeWorkers === 0 && queue.length === 0) {
      while (wakeWorkers.length > 0) wakeNextWorker();
      return;
    }
    wakeNextWorker();
  }

  async function processDirectory(remoteDir, prefix, slotIndex) {
    const items = await sftp.list(remoteDir);
    let processedEntries = 0;
    progress?.updateSlot?.("remote", slotIndex, remoteDir, 0, items.length);

    for (const item of items) {
      if (!item.name || item.name === "." || item.name === "..") continue;

      processedEntries += 1;

      const full = path.posix.join(remoteDir, item.name);
      const rel = prefix ? `${prefix}/${item.name}` : item.name;

      if (filterFn && !filterFn(rel)) continue;

      if (item.type === "d") {
        registerDir(rel, prefix);
        enqueue(full, rel);
      } else {
        result.set(rel, {
          rel,
          remotePath: full,
          size: Number(item.size),
          modifyTime: item.modifyTime ?? 0,
        });

        const parentNode = dirIndex.get(prefix);
        if (parentNode) parentNode.fileCount += 1;

        scanned += 1;

        if (
          progress &&
          (scanned === 1 || scanned % scanChunk === 0)
        ) {
          progress.updateChannel("remote", {
            label: "Scan remote",
            current: scanned,
            total: 0,
            lastRel: full,
          });
        }
      }

      if (
        progress &&
        (processedEntries === 1 ||
          processedEntries % scanChunk === 0 ||
          processedEntries === items.length)
      ) {
        progress.updateSlot(
          "remote",
          slotIndex,
          remoteDir,
          processedEntries,
          items.length
        );
      }
    }
  }

  const runWorker = async (slotIndex) => {
    while (true) {
      const next = await takeNextDirectory();
      if (!next) {
        progress?.updateSlot?.("remote", slotIndex, null);
        return;
      }

      progress?.updateSlot?.("remote", slotIndex, next.remoteDir);

      try {
        await processDirectory(next.remoteDir, next.prefix, slotIndex);
      } finally {
        finishDirectory();
      }
    }
  };

  await Promise.all(
    Array.from({ length: workerCount }, (_, slotIndex) => runWorker(slotIndex))
  );

  if (progress) {
    progress.updateChannel("remote", {
      label: "Scan remote",
      current: scanned,
      total: result.size,
      lastRel: null,
    });
    progress.done("remote");
  }

  if (!process.stdout.isTTY && scanned > 0 && log) {
    log(`   Scan remote: ${scanned} Files`);
  }

  return { files: result, dirIndex };
}

/**
 * Plain Remote Walker – ohne Filter
 */
export async function walkRemotePlain(sftp, remoteRoot) {
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
