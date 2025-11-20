/**
 * hashing.mjs
 * 
 * @author Carsten Nichte, 2025 / https://carsten-nichte.de/
 * 
 */ 
// src/helpers/hashing.mjs
import fs from "fs";
import fsp from "fs/promises";
import { createHash } from "crypto";
import { Writable } from "stream";

/**
 * Streaming-SHA256 für lokale Datei
 */
export function hashLocalFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Streaming-SHA256 für Remote-Datei via ssh2-sftp-client
 */
export async function hashRemoteFile(sftp, remotePath) {
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

/**
 * Kleiner Helper, der Hash-Cache + Persistenz kapselt.
 *
 * Erwartetes Cache-Format:
 * {
 *   version: 1,
 *   local:  { "<ns>:<rel>": { size, mtimeMs, hash } },
 *   remote: { "<ns>:<rel>": { size, modifyTime, hash } }
 * }
 */
export function createHashCache({
  cachePath,
  namespace,
  flushInterval = 50,
}) {
  const ns = namespace || "default";

  let cache = {
    version: 1,
    local: {},
    remote: {},
  };

  // Versuch: bestehenden Cache laden
  (async () => {
    try {
      const raw = await fsp.readFile(cachePath, "utf8");
      const parsed = JSON.parse(raw);
      cache.version = parsed.version ?? 1;
      cache.local = parsed.local ?? {};
      cache.remote = parsed.remote ?? {};
    } catch {
      // kein Cache oder defekt → einfach neu anfangen
    }
  })().catch(() => {});

  let dirty = false;
  let dirtyCount = 0;

  function cacheKey(relPath) {
    return `${ns}:${relPath}`;
  }

  async function save(force = false) {
    if (!dirty && !force) return;
    const data = JSON.stringify(cache, null, 2);
    await fsp.writeFile(cachePath, data, "utf8");
    dirty = false;
    dirtyCount = 0;
  }

  async function markDirty() {
    dirty = true;
    dirtyCount += 1;
    if (dirtyCount >= flushInterval) {
      await save();
    }
  }

  async function getLocalHash(rel, meta) {
    const key = cacheKey(rel);
    const cached = cache.local[key];

    if (
      cached &&
      cached.size === meta.size &&
      cached.mtimeMs === meta.mtimeMs &&
      cached.hash
    ) {
      return cached.hash;
    }

    const hash = await hashLocalFile(meta.localPath);
    cache.local[key] = {
      size: meta.size,
      mtimeMs: meta.mtimeMs,
      hash,
    };
    await markDirty();
    return hash;
  }

  async function getRemoteHash(rel, meta, sftp) {
    const key = cacheKey(rel);
    const cached = cache.remote[key];

    if (
      cached &&
      cached.size === meta.size &&
      cached.modifyTime === meta.modifyTime &&
      cached.hash
    ) {
      return cached.hash;
    }

    const hash = await hashRemoteFile(sftp, meta.remotePath);
    cache.remote[key] = {
      size: meta.size,
      modifyTime: meta.modifyTime,
      hash,
    };
    await markDirty();
    return hash;
  }

  return {
    cache,
    cacheKey,
    getLocalHash,
    getRemoteHash,
    save,
  };
}

export async function getLocalHash(rel, meta, cacheLocal, key, markDirty) {
  const cached = cacheLocal[key];
  if (
    cached &&
    cached.size === meta.size &&
    cached.mtimeMs === meta.mtimeMs &&
    cached.hash
  ) {
    return cached.hash;
  }

  const hash = await hashLocalFile(meta.localPath);
  cacheLocal[key] = {
    size: meta.size,
    mtimeMs: meta.mtimeMs,
    hash,
  };
  if (markDirty) {
    await markDirty();
  }
  return hash;
}

export async function getRemoteHash(rel, meta, cacheRemote, key, markDirty, sftp) {
  const cached = cacheRemote[key];
  if (
    cached &&
    cached.size === meta.size &&
    cached.modifyTime === meta.modifyTime &&
    cached.hash
  ) {
    return cached.hash;
  }

  const hash = await hashRemoteFile(sftp, meta.remotePath);
  cacheRemote[key] = {
    size: meta.size,
    modifyTime: meta.modifyTime,
    hash,
  };
  if (markDirty) {
    await markDirty();
  }
  return hash;
}