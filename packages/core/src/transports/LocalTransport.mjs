import { createReadStream, createWriteStream, constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export function validateRelativePath(rel) {
  if (typeof rel !== "string" || !rel || /[\\:\0]/.test(rel) ||
      rel.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe relative path: ${rel}`);
  }
}

export function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function fingerprint(stat) {
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, dev: stat.dev, ino: stat.ino };
}

export class LocalTransport {
  constructor(root, { signal, onEvent = () => {} } = {}) {
    if (typeof root !== "string" || !root) throw new Error("A local root is required.");
    this.requestedRoot = path.resolve(root);
    this.signal = signal;
    this.onEvent = onEvent;
  }

  async open() {
    this.signal?.throwIfAborted();
    const stat = await fs.lstat(this.requestedRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Root must be a directory, not a symbolic link: ${this.requestedRoot}`);
    }
    const root = await fs.realpath(this.requestedRoot);
    if (this.root && (root !== this.root || stat.dev !== this.identity.dev || stat.ino !== this.identity.ino)) {
      throw new Error(`Root changed: ${this.requestedRoot}`);
    }
    this.root = root;
    this.identity = { root, dev: stat.dev, ino: stat.ino };
    return this.identity;
  }

  async checkedPath(rel) {
    validateRelativePath(rel);
    await this.open();
    const parts = rel.split("/");
    let current = this.root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let stat;
      try {
        stat = await fs.lstat(current);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return path.join(this.root, ...parts);
      }
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${rel}`);
      if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`Not a directory: ${rel}`);
    }
    return current;
  }

  async entry(rel) {
    this.signal?.throwIfAborted();
    const full = await this.checkedPath(rel);
    let stat;
    try {
      stat = await fs.lstat(full);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (stat.isDirectory()) return { rel, type: "directory" };
    if (!stat.isFile()) throw new Error(`Unsupported file type: ${rel}`);
    const hash = createHash("sha256");
    const stream = createReadStream(full, { flags: constants.O_RDONLY | constants.O_NOFOLLOW, signal: this.signal });
    for await (const chunk of stream) hash.update(chunk);
    const after = await fs.lstat(full);
    if (JSON.stringify(fingerprint(stat)) !== JSON.stringify(fingerprint(after))) {
      throw new Error(`File changed while reading: ${rel}`);
    }
    return { rel, type: "file", ...fingerprint(stat), sha256: hash.digest("hex") };
  }

  async inventory() {
    await this.open();
    const entries = [];
    const names = new Set();
    const walk = async (directory, prefix) => {
      this.signal?.throwIfAborted();
      const before = await fs.stat(directory);
      const children = await fs.readdir(directory, { withFileTypes: true });
      children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const child of children) {
        const rel = prefix ? `${prefix}/${child.name}` : child.name;
        validateRelativePath(rel);
        const normalized = rel.normalize("NFC").toLowerCase();
        if (names.has(normalized)) throw new Error(`Case/Unicode path collision: ${rel}`);
        names.add(normalized);
        const entry = await this.entry(rel);
        if (!entry) throw new Error(`Entry disappeared during inventory: ${rel}`);
        entries.push(entry);
        this.onEvent({ type: "scan-progress", root: this.root, path: rel, current: entries.length });
        if (entry.type === "directory") await walk(path.join(directory, child.name), rel);
      }
      const after = await fs.stat(directory);
      if (before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
        throw new Error(`Directory changed while scanning: ${directory}`);
      }
    };
    await walk(this.root, "");
    return { identity: this.identity, entries };
  }

  async ensureDirectory(rel) {
    validateRelativePath(rel);
    let prefix = "";
    for (const part of rel.split("/")) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const full = await this.checkedPath(prefix);
      try {
        await fs.mkdir(full, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST" || !(await fs.lstat(full)).isDirectory()) throw error;
      }
    }
  }

  async verify(rel, expected) {
    const current = await this.entry(rel);
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error(`Target changed before operation: ${rel}`);
    }
  }

  async copyFrom(source, { rel, sourceEntry, targetEntry }) {
    this.signal?.throwIfAborted();
    const parent = path.posix.dirname(rel);
    if (parent !== ".") await this.ensureDirectory(parent);
    const sourcePath = await source.checkedPath(rel);
    const temporaryRel = `${parent === "." ? "" : `${parent}/`}.push-sync-${randomUUID()}.tmp`;
    const temporaryPath = await this.checkedPath(temporaryRel);
    const targetPath = await this.checkedPath(rel);
    const hash = createHash("sha256");
    let received = 0;
    let lastProgress = 0;
    let temporaryCreated = false;
    try {
      const output = createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
      output.on("open", () => { temporaryCreated = true; });
      await pipeline(
        createReadStream(sourcePath, { flags: constants.O_RDONLY | constants.O_NOFOLLOW, signal: this.signal }),
        new Transform({
          transform: (chunk, encoding, callback) => {
            hash.update(chunk);
            received += chunk.length;
            const now = Date.now();
            if (!lastProgress || now - lastProgress >= 100 || received >= sourceEntry.size) {
              lastProgress = now;
              this.onEvent({ type: "copy-progress", path: rel, receivedBytes: received, totalBytes: sourceEntry.size });
            }
            callback(null, chunk);
          },
        }),
        output,
        { signal: this.signal },
      );
      if (hash.digest("hex") !== sourceEntry.sha256) throw new Error(`Source changed while copying: ${rel}`);
      const temporary = await fs.open(temporaryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await temporary.sync(); } finally { await temporary.close(); }
      const original = await source.entry(rel);
      if (JSON.stringify(original) !== JSON.stringify(sourceEntry)) throw new Error(`Source changed: ${rel}`);
      await this.verify(rel, targetEntry);
      this.signal?.throwIfAborted();
      await fs.rename(temporaryPath, targetPath);
      temporaryCreated = false;
      const written = await this.entry(rel);
      if (written.sha256 !== sourceEntry.sha256) throw new Error(`Copy verification failed: ${rel}`);
    } finally {
      if (temporaryCreated) await fs.unlink(temporaryPath);
    }
  }

  async remove({ rel, targetEntry }) {
    this.signal?.throwIfAborted();
    await this.verify(rel, targetEntry);
    await fs.unlink(await this.checkedPath(rel));
  }

  async removeDirectory(rel) {
    this.signal?.throwIfAborted();
    const full = await this.checkedPath(rel);
    await fs.rmdir(full);
  }
}
