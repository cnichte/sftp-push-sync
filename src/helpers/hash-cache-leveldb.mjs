/**
 * hash-cache-leveldb.mjs
 *
 * LevelDB-based hash cache for efficient storage of large file sets.
 * Unlike the JSON-based cache, this scales to 100k+ files without memory issues.
 *
 * @author Carsten Nichte, 2025 / https://carsten-nichte.de/
 */
import { Level } from "level";
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
 * Creates a LevelDB-based hash cache.
 *
 * Database structure:
 *   local:<namespace>:<relPath>  → JSON { size, mtimeMs, hash }
 *   remote:<namespace>:<relPath> → JSON { size, modifyTime, hash }
 *
 * @param {Object} options
 * @param {string} options.cachePath - Path to the LevelDB directory (e.g., ".sync-cache-prod")
 * @param {string} options.namespace - Namespace for keys (e.g., "prod")
 */
export async function createHashCacheLevelDB({ cachePath, namespace }) {
  const ns = namespace || "default";

  // Open or create the LevelDB database
  const db = new Level(cachePath, { valueEncoding: "json" });
  await db.open();

  function localKey(relPath) {
    return `local:${ns}:${relPath}`;
  }

  function remoteKey(relPath) {
    return `remote:${ns}:${relPath}`;
  }

  /**
   * Get cached local hash or compute and store it
   */
  async function getLocalHash(rel, meta) {
    const key = localKey(rel);

    try {
      const cached = await db.get(key);

      // Cache hit: check if still valid (same size + mtime)
      if (
        cached &&
        cached.size === meta.size &&
        cached.mtimeMs === meta.mtimeMs &&
        cached.hash
      ) {
        return cached.hash;
      }
    } catch (err) {
      // Key not found - that's fine, we'll compute the hash
      if (err.code !== "LEVEL_NOT_FOUND") {
        throw err;
      }
    }

    // Compute hash and store
    const hash = await hashLocalFile(meta.localPath);
    await db.put(key, {
      size: meta.size,
      mtimeMs: meta.mtimeMs,
      hash,
    });

    return hash;
  }

  /**
   * Get cached remote hash or compute and store it
   */
  async function getRemoteHash(rel, meta, sftp) {
    const key = remoteKey(rel);

    try {
      const cached = await db.get(key);

      // Cache hit: check if still valid (same size + modifyTime)
      if (
        cached &&
        cached.size === meta.size &&
        cached.modifyTime === meta.modifyTime &&
        cached.hash
      ) {
        return cached.hash;
      }
    } catch (err) {
      // Key not found - compute the hash
      if (err.code !== "LEVEL_NOT_FOUND") {
        throw err;
      }
    }

    // Compute hash (downloads file content for hashing)
    const hash = await hashRemoteFile(sftp, meta.remotePath);
    await db.put(key, {
      size: meta.size,
      modifyTime: meta.modifyTime,
      hash,
    });

    return hash;
  }

  /**
   * Explicitly save (flush) - LevelDB auto-persists, but this ensures sync
   */
  async function save() {
    // LevelDB auto-persists, nothing to do
  }

  /**
   * Close the database connection
   */
  async function close() {
    await db.close();
  }

  /**
   * Get statistics about cache contents
   */
  async function getStats() {
    let localCount = 0;
    let remoteCount = 0;

    for await (const key of db.keys()) {
      if (key.startsWith(`local:${ns}:`)) {
        localCount++;
      } else if (key.startsWith(`remote:${ns}:`)) {
        remoteCount++;
      }
    }

    return { localCount, remoteCount };
  }

  /**
   * Clean up stale entries (entries for files that no longer exist)
   * @param {Set<string>} validLocalPaths - Set of currently existing local file paths
   * @param {Set<string>} validRemotePaths - Set of currently existing remote file paths
   */
  async function cleanup(validLocalPaths, validRemotePaths) {
    const batch = db.batch();
    let deletedCount = 0;

    for await (const key of db.keys()) {
      if (key.startsWith(`local:${ns}:`)) {
        const relPath = key.slice(`local:${ns}:`.length);
        if (!validLocalPaths.has(relPath)) {
          batch.del(key);
          deletedCount++;
        }
      } else if (key.startsWith(`remote:${ns}:`)) {
        const relPath = key.slice(`remote:${ns}:`.length);
        if (!validRemotePaths.has(relPath)) {
          batch.del(key);
          deletedCount++;
        }
      }
    }

    await batch.write();
    return deletedCount;
  }

  return {
    getLocalHash,
    getRemoteHash,
    save,
    close,
    getStats,
    cleanup,
    db, // Expose for advanced usage
  };
}

/**
 * Migrate from old JSON cache to LevelDB
 * @param {string} jsonCachePath - Path to old .sync-cache.json file
 * @param {string} levelDbPath - Path to new LevelDB directory
 * @param {string} namespace - Namespace for keys
 */
export async function migrateFromJsonCache(jsonCachePath, levelDbPath, namespace) {
  const ns = namespace || "default";

  // Check if JSON cache exists
  try {
    await fsp.access(jsonCachePath);
  } catch {
    return { migrated: false, reason: "No JSON cache found" };
  }

  // Check if LevelDB already has data (don't re-migrate)
  const db = new Level(levelDbPath, { valueEncoding: "json" });
  await db.open();

  let hasData = false;
  for await (const _ of db.keys({ limit: 1 })) {
    hasData = true;
    break;
  }

  if (hasData) {
    await db.close();
    return { migrated: false, reason: "LevelDB already has data" };
  }

  // Read and parse JSON cache
  let jsonCache;
  try {
    const raw = await fsp.readFile(jsonCachePath, "utf8");
    jsonCache = JSON.parse(raw);
  } catch (parseErr) {
    await db.close();
    // Rename corrupt file so it doesn't block future runs
    try {
      await fsp.rename(jsonCachePath, jsonCachePath + ".corrupt");
    } catch {
      // Ignore rename errors
    }
    return { migrated: false, reason: `JSON cache corrupt: ${parseErr.message}` };
  }

  // Migrate entries
  const batch = db.batch();
  let localCount = 0;
  let remoteCount = 0;

  if (jsonCache.local) {
    for (const [key, value] of Object.entries(jsonCache.local)) {
      // Keys in JSON were like "namespace:relPath"
      const relPath = key.startsWith(`${ns}:`) ? key.slice(ns.length + 1) : key;
      batch.put(`local:${ns}:${relPath}`, value);
      localCount++;
    }
  }

  if (jsonCache.remote) {
    for (const [key, value] of Object.entries(jsonCache.remote)) {
      const relPath = key.startsWith(`${ns}:`) ? key.slice(ns.length + 1) : key;
      batch.put(`remote:${ns}:${relPath}`, value);
      remoteCount++;
    }
  }

  await batch.write();
  await db.close();

  // Optionally rename old cache to .bak
  try {
    await fsp.rename(jsonCachePath, jsonCachePath + ".bak");
  } catch {
    // Ignore rename errors
  }

  return {
    migrated: true,
    localCount,
    remoteCount,
  };
}
