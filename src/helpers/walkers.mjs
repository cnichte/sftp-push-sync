/**
 * walkers.mjs
 * 
 * @author Carsten Nichte, 2025 / https://carsten-nichte.de/
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
 */
export async function walkRemote(
  sftp,
  remoteRoot,
  {
    filterFn,
    progress = null,
    scanChunk = 100,
    log = null,
  } = {}
) {
  const result = new Map();
  let scanned = 0;

  async function recurse(remoteDir, prefix) {
    const items = await sftp.list(remoteDir);

    for (const item of items) {
      if (!item.name || item.name === "." || item.name === "..") continue;

      const full = path.posix.join(remoteDir, item.name);
      const rel = prefix ? `${prefix}/${item.name}` : item.name;

      if (filterFn && !filterFn(rel)) continue;

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
    }
  }

  await recurse(remoteRoot, "");

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

  return result;
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