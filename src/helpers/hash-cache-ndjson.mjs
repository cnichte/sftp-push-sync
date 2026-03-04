/**
 * hash-cache-ndjson.mjs
 *
 * NDJSON-based hash cache for efficient storage of large file sets.
 * Each line is a valid JSON object - human-readable and easy to debug.
 * Scales to 100k+ files through streaming reads/writes.
 *
 * File format:
 *   {"t":"l","p":"prod:path/file.js","s":1234,"m":1234567890,"h":"sha256..."}
 *   {"t":"r","p":"prod:path/file.js","s":1234,"m":"2025-01-01","h":"sha256..."}
 *
 * Where: t=type (l=local, r=remote), p=path, s=size, m=mtime, h=hash
 *
 * @author Carsten Nichte, 2025 / https://carsten-nichte.de/
 */
import fs from "fs";
import fsp from "fs/promises";
import { createHash } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { createInterface } from "readline";
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
 * Creates an NDJSON-based hash cache.
 *
 * Data is stored in Maps during runtime and persisted as NDJSON on save().
 * Auto-saves every 1000 changes to prevent data loss on crash/abort.
 *
 * @param {Object} options
 * @param {string} options.cachePath - Path to the NDJSON file (e.g., ".sync-cache.prod.ndjson")
 * @param {string} options.namespace - Namespace for keys (e.g., "prod")
 * @param {number} options.autoSaveInterval - Save after this many changes (default: 1000)
 */
export async function createHashCacheNDJSON({ cachePath, namespace, autoSaveInterval = 1000 }) {
  const ns = namespace || "default";

  // In-memory storage
  const localCache = new Map();
  const remoteCache = new Map();

  // Auto-save tracking
  let changesSinceLastSave = 0;
  let saveInProgress = false;

  // Load existing cache if present
  await loadCache();

  /**
   * Load cache from NDJSON file
   */
  async function loadCache() {
    try {
      await fsp.access(cachePath);
    } catch {
      // File doesn't exist - start fresh
      return;
    }

    const fileStream = createReadStream(cachePath, { encoding: "utf8" });
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    let lineNum = 0;
    for await (const line of rl) {
      lineNum++;
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line);
        const key = `${ns}:${entry.p}`;

        if (entry.t === "l") {
          localCache.set(key, {
            size: entry.s,
            mtimeMs: entry.m,
            hash: entry.h,
          });
        } else if (entry.t === "r") {
          remoteCache.set(key, {
            size: entry.s,
            modifyTime: entry.m,
            hash: entry.h,
          });
        }
      } catch (parseErr) {
        // Skip corrupt lines, log warning
        console.warn(`  ⚠ Skipping corrupt cache line ${lineNum}: ${parseErr.message}`);
      }
    }
  }

  function localKey(relPath) {
    return `${ns}:${relPath}`;
  }

  function remoteKey(relPath) {
    return `${ns}:${relPath}`;
  }

  /**
   * Check if auto-save is needed and perform it
   */
  async function checkAutoSave() {
    changesSinceLastSave++;
    if (changesSinceLastSave >= autoSaveInterval && !saveInProgress) {
      saveInProgress = true;
      try {
        await save();
        changesSinceLastSave = 0;
      } finally {
        saveInProgress = false;
      }
    }
  }

  /**
   * Get cached local hash or compute and store it
   */
  async function getLocalHash(rel, meta) {
    const key = localKey(rel);
    const cached = localCache.get(key);

    // Cache hit: check if still valid (same size + mtime)
    if (
      cached &&
      cached.size === meta.size &&
      Math.abs(cached.mtimeMs - meta.mtimeMs) < 1000
    ) {
      return cached.hash;
    }

    // Cache miss or stale: compute new hash
    const filePath = meta.fullPath || meta.localPath;
    const hash = await hashLocalFile(filePath);

    localCache.set(key, {
      size: meta.size,
      mtimeMs: meta.mtimeMs,
      hash,
    });

    // Auto-save periodically
    await checkAutoSave();

    return hash;
  }

  /**
   * Get cached remote hash or compute and store it
   */
  async function getRemoteHash(rel, meta, sftp) {
    const key = remoteKey(rel);
    const cached = remoteCache.get(key);

    // Cache hit: check if still valid (same size + modifyTime)
    if (
      cached &&
      cached.size === meta.size &&
      cached.modifyTime === meta.modifyTime
    ) {
      return cached.hash;
    }

    // Cache miss or stale: compute new hash
    const filePath = meta.fullPath || meta.remotePath;
    const hash = await hashRemoteFile(sftp, filePath);

    remoteCache.set(key, {
      size: meta.size,
      modifyTime: meta.modifyTime,
      hash,
    });

    // Auto-save periodically
    await checkAutoSave();

    return hash;
  }

  /**
   * Save cache to NDJSON file using streaming writes
   */
  async function save() {
    const tempPath = cachePath + ".tmp";
    const writeStream = createWriteStream(tempPath, { encoding: "utf8" });

    // Write local entries
    for (const [fullKey, value] of localCache) {
      // Extract relPath from "namespace:relPath"
      const relPath = fullKey.startsWith(`${ns}:`)
        ? fullKey.slice(ns.length + 1)
        : fullKey;

      const line = JSON.stringify({
        t: "l",
        p: relPath,
        s: value.size,
        m: value.mtimeMs,
        h: value.hash,
      });
      writeStream.write(line + "\n");
    }

    // Write remote entries
    for (const [fullKey, value] of remoteCache) {
      const relPath = fullKey.startsWith(`${ns}:`)
        ? fullKey.slice(ns.length + 1)
        : fullKey;

      const line = JSON.stringify({
        t: "r",
        p: relPath,
        s: value.size,
        m: value.modifyTime,
        h: value.hash,
      });
      writeStream.write(line + "\n");
    }

    // Wait for stream to finish
    await new Promise((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
      writeStream.end();
    });

    // Atomic rename
    await fsp.rename(tempPath, cachePath);
  }

  /**
   * Close the cache (no-op for NDJSON, but keeps API compatible)
   */
  async function close() {
    // Nothing to do - Maps are garbage collected
  }

  /**
   * Get cache statistics
   */
  function getStats() {
    return {
      localEntries: localCache.size,
      remoteEntries: remoteCache.size,
      totalEntries: localCache.size + remoteCache.size,
    };
  }

  /**
   * Remove entries for files that no longer exist
   * @param {Set<string>} currentLocalFiles - Set of current local relative paths
   * @param {Set<string>} currentRemoteFiles - Set of current remote relative paths
   */
  async function cleanup(currentLocalFiles, currentRemoteFiles) {
    let deletedCount = 0;

    // Clean local entries
    for (const key of localCache.keys()) {
      const relPath = key.startsWith(`${ns}:`) ? key.slice(ns.length + 1) : key;
      if (!currentLocalFiles.has(relPath)) {
        localCache.delete(key);
        deletedCount++;
      }
    }

    // Clean remote entries
    for (const key of remoteCache.keys()) {
      const relPath = key.startsWith(`${ns}:`) ? key.slice(ns.length + 1) : key;
      if (!currentRemoteFiles.has(relPath)) {
        remoteCache.delete(key);
        deletedCount++;
      }
    }

    return deletedCount;
  }

  return {
    getLocalHash,
    getRemoteHash,
    save,
    close,
    getStats,
    cleanup,
  };
}

/**
 * Migrate from old JSON cache to NDJSON
 * @param {string} jsonCachePath - Path to old .sync-cache.json file
 * @param {string} ndjsonPath - Path to new .ndjson file
 * @param {string} namespace - Namespace for keys
 */
export async function migrateFromJsonCache(jsonCachePath, ndjsonPath, namespace) {
  const ns = namespace || "default";

  // Check if JSON cache exists
  try {
    await fsp.access(jsonCachePath);
  } catch {
    return { migrated: false, reason: "No JSON cache found" };
  }

  // Check if NDJSON already exists (don't re-migrate)
  try {
    const stats = await fsp.stat(ndjsonPath);
    if (stats.size > 0) {
      return { migrated: false, reason: "NDJSON cache already exists" };
    }
  } catch {
    // File doesn't exist - proceed with migration
  }

  // Read and parse JSON cache
  let jsonCache;
  try {
    const raw = await fsp.readFile(jsonCachePath, "utf8");
    jsonCache = JSON.parse(raw);
  } catch (parseErr) {
    // Rename corrupt file
    try {
      await fsp.rename(jsonCachePath, jsonCachePath + ".corrupt");
    } catch {
      // Ignore rename errors
    }
    return { migrated: false, reason: `JSON cache corrupt: ${parseErr.message}` };
  }

  // Write to NDJSON
  const writeStream = createWriteStream(ndjsonPath, { encoding: "utf8" });
  let localCount = 0;
  let remoteCount = 0;

  if (jsonCache.local) {
    for (const [key, value] of Object.entries(jsonCache.local)) {
      // Keys in JSON were like "namespace:relPath"
      const relPath = key.startsWith(`${ns}:`) ? key.slice(ns.length + 1) : key;
      const line = JSON.stringify({
        t: "l",
        p: relPath,
        s: value.size,
        m: value.mtimeMs,
        h: value.hash,
      });
      writeStream.write(line + "\n");
      localCount++;
    }
  }

  if (jsonCache.remote) {
    for (const [key, value] of Object.entries(jsonCache.remote)) {
      const relPath = key.startsWith(`${ns}:`) ? key.slice(ns.length + 1) : key;
      const line = JSON.stringify({
        t: "r",
        p: relPath,
        s: value.size,
        m: value.modifyTime,
        h: value.hash,
      });
      writeStream.write(line + "\n");
      remoteCount++;
    }
  }

  await new Promise((resolve, reject) => {
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
    writeStream.end();
  });

  // Rename old cache to .bak
  try {
    await fsp.rename(jsonCachePath, jsonCachePath + ".migrated");
  } catch {
    // Ignore rename errors
  }

  return {
    migrated: true,
    localCount,
    remoteCount,
  };
}
