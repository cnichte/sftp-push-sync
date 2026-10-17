import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { LocalTransport, containsPath, validateRelativePath } from "../transports/LocalTransport.mjs";
import { SyncPlanner } from "./SyncPlanner.mjs";
import { SyncExecutor, SyncExecutionError } from "./SyncExecutor.mjs";
import { FileFilter } from "./FileFilter.mjs";
import { SyncControl, SyncPausedError } from "./SyncControl.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const files = (snapshot) => new Map(snapshot.entries.filter((entry) => entry.type === "file").map((entry) => [entry.rel, entry]));
const directories = (snapshot) => snapshot.entries.filter((entry) => entry.type === "directory").map((entry) => entry.rel);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const content = (entries) => entries.map(({ rel, type, sha256 }) => ({ rel, type, ...(sha256 ? { sha256 } : {}) }))
  .sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);

export class LocalSync {
  constructor({ sourceRoot, targetRoot, mode, owner, stateFile, signal, control = new SyncControl(), concurrency = 1, include, exclude, onEvent = () => {} }) {
    if (!["mirror", "managed"].includes(mode)) throw new Error("Explicit mode 'mirror' or 'managed' is required.");
    if (typeof owner !== "string" || !owner.trim()) throw new Error("A stable owner is required.");
    if (typeof stateFile !== "string" || !stateFile) throw new Error("A stateFile outside the content roots is required.");
    this.mode = mode;
    this.owner = owner;
    this.stateFile = path.resolve(stateFile);
    this.signal = signal;
    this.onEvent = onEvent;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("concurrency must be between 1 and 32.");
    this.concurrency = concurrency;
    this.control = control;
    this.filter = new FileFilter({ include, exclude });
    this.source = new LocalTransport(sourceRoot, { signal, onEvent, include, exclude });
    this.target = new LocalTransport(targetRoot, { signal, onEvent, include, exclude });
  }

  async roots() {
    await this.source.open();
    await this.target.open();
    if (containsPath(this.source.root, this.target.root) || containsPath(this.target.root, this.source.root)) {
      throw new Error("Source and target roots must not overlap.");
    }
    this.canonicalStateFile = path.join(await fs.realpath(path.dirname(this.stateFile)), path.basename(this.stateFile));
    if ([this.source.root, this.target.root].some((root) => containsPath(root, this.canonicalStateFile))) {
      throw new Error("stateFile must be outside both content roots.");
    }
    this.config = {
      mode: this.mode, owner: this.owner, sourceRoot: this.source.root,
      targetRoot: this.target.root, stateFile: this.canonicalStateFile,
      include: this.filter.include, exclude: this.filter.exclude,
    };
  }

  async readState() {
    let stat;
    try {
      stat = await fs.lstat(this.canonicalStateFile);
    } catch (error) {
      if (error.code === "ENOENT") return { hash: null, manifest: null };
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("State manifest must be a regular file.");
    const raw = await fs.readFile(this.canonicalStateFile, "utf8");
    const manifest = JSON.parse(raw);
    if (manifest.version !== 1 || !same(manifest.config, this.config) ||
        !["complete", "partial", "paused"].includes(manifest.status) ||
        !Array.isArray(manifest.files) || !Array.isArray(manifest.directories)) {
      throw new Error("State manifest does not match this sync configuration.");
    }
    if (!same(manifest.roots, { source: this.source.identity, target: this.target.identity })) {
      throw new Error("Root identity in state manifest changed; explicit source/target reassignment is required.");
    }
    const seen = new Set();
    for (const entry of manifest.files) {
      validateRelativePath(entry.rel);
      if (!/^[a-f0-9]{64}$/.test(entry.sha256) || seen.has(entry.rel)) throw new Error("Invalid state manifest entry.");
      seen.add(entry.rel);
    }
    for (const rel of manifest.directories) validateRelativePath(rel);
    return { hash: digest(raw), manifest };
  }

  async plan() {
    this.signal?.throwIfAborted();
    await this.roots();
    const state = await this.readState();
    this.onEvent({ type: "phase", name: "scan", label: "Scan source and target" });
    // Never substitute an empty inventory for an unreadable source.
    const source = await this.source.inventory();
    const target = await this.target.inventory();
    const sourceFiles = files(source);
    const targetFiles = files(target);
    const sourceDirs = directories(source);
    const targetDirs = directories(target);
    const targetNames = new Map(target.entries.map((entry) => [entry.rel.normalize("NFC").toLowerCase(), entry.rel]));
    for (const entry of source.entries) {
      const existing = targetNames.get(entry.rel.normalize("NFC").toLowerCase());
      if (existing && existing !== entry.rel) throw new Error(`Case/Unicode path collision between source and target: ${entry.rel}`);
    }
    for (const rel of sourceDirs) {
      if (targetFiles.has(rel)) throw new Error(`File/directory type conflict: ${rel}`);
    }
    for (const rel of sourceFiles.keys()) {
      if (targetDirs.includes(rel)) throw new Error(`File/directory type conflict: ${rel}`);
    }
    const owned = new Map((state.manifest?.files ?? []).map((entry) => [entry.rel, entry.sha256]));
    if (this.mode === "managed") {
      for (const [rel, sha256] of owned) {
        if (targetFiles.get(rel)?.sha256 !== sha256) throw new Error(`Owned target was modified or removed: ${rel}`);
      }
      for (const rel of sourceFiles.keys()) {
        if (targetFiles.has(rel) && !owned.has(rel)) throw new Error(`Target file is not owned by this job: ${rel}`);
      }
    }
    const partition = SyncPlanner.partition(sourceFiles, targetFiles);
    const update = [...partition.update, ...partition.compare.filter((rel) =>
      sourceFiles.get(rel).sha256 !== targetFiles.get(rel).sha256)];
    const ownedDirs = new Set(state.manifest?.directories ?? []);
    const remove = SyncPlanner.deletions(sourceFiles, targetFiles, { mode: this.mode, owned: new Set(owned.keys()) });
    const remaining = new Set(target.entries.map((entry) => entry.rel));
    for (const rel of remove) remaining.delete(rel);
    const removeDirectories = [];
    for (const rel of targetDirs.filter((directory) => !sourceDirs.includes(directory) &&
      !this.filter.include.length && !this.filter.exclude.length &&
      (this.mode === "mirror" || ownedDirs.has(directory))).sort((a, b) => b.split("/").length - a.split("/").length)) {
      if (![...remaining].some((child) => child.startsWith(`${rel}/`))) {
        removeDirectories.push(rel);
        remaining.delete(rel);
      }
    }
    const body = {
      version: 1, config: this.config, stateHash: state.hash, source, target,
      add: partition.add, update, remove,
      createDirectories: sourceDirs.filter((rel) => !targetDirs.includes(rel)),
      removeDirectories,
    };
    const plan = { ...body, digest: digest(JSON.stringify(body)) };
    this.onEvent({
      type: "plan", add: plan.add.length, update: plan.update.length, delete: plan.remove.length,
      uploadBytes: [...plan.add, ...plan.update].reduce((sum, rel) => sum + sourceFiles.get(rel).size, 0),
      digest: plan.digest,
    });
    return plan;
  }

  async writeState(manifest, expectedHash) {
    const current = await this.readState();
    if (current.hash !== expectedHash) throw new Error("State manifest changed during execution.");
    const temporary = `${this.canonicalStateFile}.${randomUUID()}.tmp`;
    const raw = `${JSON.stringify(manifest, null, 2)}\n`;
    const handle = await fs.open(temporary, "wx", 0o600);
    let renamed = false;
    try {
      await handle.writeFile(raw);
      await handle.sync();
      await handle.close();
      await fs.rename(temporary, this.canonicalStateFile);
      renamed = true;
    } finally {
      await handle.close();
      if (!renamed) await fs.unlink(temporary);
    }
    return digest(raw);
  }

  async apply(approvedPlan) {
    this.signal?.throwIfAborted();
    await this.roots();
    const lockPath = `${this.canonicalStateFile}.lock`;
    const lock = await fs.open(lockPath, "wx", 0o600);
    let completed = [];
    try {
      const plan = await this.plan();
      if (!approvedPlan || !same(approvedPlan, plan)) {
        throw new Error("Approved plan or source/target/state changed. Create and approve a new plan.");
      }
      const sourceFiles = files(plan.source);
      const targetFiles = files(plan.target);
      const previous = (await this.readState()).manifest;
      const owned = new Map((previous?.files ?? []).map((entry) => [entry.rel, entry.sha256]));
      let stateHash = plan.stateHash;
      const ownedDirs = new Set(previous?.directories ?? []);
      const expectedTarget = new Map(plan.target.entries.map((entry) => [entry.rel, entry]));
      const save = async (status) => {
        stateHash = await this.writeState({
          version: 1, config: this.config, status,
          roots: { source: this.source.identity, target: this.target.identity },
          files: [...owned].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([rel, sha256]) => ({ rel, sha256 })),
          directories: [...ownedDirs].sort(),
          ...(status !== "complete" ? { checkpoint: {
            source: plan.source,
            targetContent: content([...expectedTarget.values()]),
          } } : {}),
        }, stateHash);
      };
      this.onEvent({ type: "phase", name: "apply", label: "Apply approved plan" });
      for (const rel of plan.createDirectories) {
        this.signal?.throwIfAborted();
        await this.target.ensureDirectory(rel);
        ownedDirs.add(rel);
        expectedTarget.set(rel, { rel, type: "directory" });
      }
      const change = (rel) => ({ rel, sourceEntry: sourceFiles.get(rel), targetEntry: targetFiles.get(rel) ?? null });
      const verifySource = async () => {
        if (!same(await this.source.inventory(), plan.source)) throw new Error("Source changed during execution.");
      };
      const executor = new SyncExecutor({
        signal: this.signal,
        control: this.control,
        concurrency: this.concurrency,
        transport: {
          copy: (item) => this.target.copyFrom(this.source, item),
          remove: async (item) => {
            await this.source.open();
            await this.target.remove(item);
          },
        },
        onComplete: (kind, item) => {
          const operation = completionQueue.then(async () => {
            completed.push({ kind, rel: item.rel });
            if (kind === "delete") {
              owned.delete(item.rel);
              expectedTarget.delete(item.rel);
            } else {
              owned.set(item.rel, item.sourceEntry.sha256);
              expectedTarget.set(item.rel, item.sourceEntry);
            }
            await save("partial");
            this.onEvent({ type: "task-progress", kind, path: item.rel, current: completed.length, total: plan.add.length + plan.update.length + plan.remove.length });
          });
          completionQueue = operation;
          return operation;
        },
      });
      let completionQueue = Promise.resolve();
      await save("partial");
      try {
        await executor.execute({
          add: plan.add.map(change), update: plan.update.map(change), remove: plan.remove.map(change),
        }, { beforeDeletes: verifySource });
        if (plan.removeDirectories.length) await verifySource();
        for (const rel of plan.removeDirectories) {
          this.control.check();
          await this.source.open();
          await this.target.removeDirectory(rel);
          ownedDirs.delete(rel);
          expectedTarget.delete(rel);
          await save("partial");
        }
        const finalTarget = await this.target.inventory();
        if (!same(content(finalTarget.entries), content([...expectedTarget.values()]))) {
          throw new Error("Target changed during execution; final verification failed.");
        }
        await verifySource();
        this.control.check();
        owned.clear();
        for (const [rel, entry] of sourceFiles) owned.set(rel, entry.sha256);
        await save("complete");
        const result = { ok: true, exitCode: 0, completed };
        this.onEvent({ type: "complete", ...result });
        return result;
      } catch (error) {
        if (!(error instanceof SyncPausedError)) throw error;
        await completionQueue;
        await save("paused");
        const result = { ok: false, paused: true, exitCode: 0, completed };
        this.onEvent({ type: "paused", ...result });
        return result;
      }
    } catch (error) {
      const failure = error instanceof SyncExecutionError ? error :
        new SyncExecutionError(`Local sync incomplete: ${error.message}`, completed, error);
      failure.exitCode = this.signal?.aborted ? 130 : 1;
      this.onEvent({ type: "error", message: failure.message, completed: failure.completed });
      throw failure;
    } finally {
      await lock.close();
      await fs.unlink(lockPath);
    }
  }

  async resume() {
    await this.roots();
    const { manifest, hash } = await this.readState();
    if (!manifest?.checkpoint || !["paused", "partial"].includes(manifest.status)) {
      throw new Error("No resumable transfer checkpoint.");
    }
    const plan = await this.plan();
    if (plan.stateHash !== hash || !same(plan.source, manifest.checkpoint.source) ||
        !same(content(plan.target.entries), manifest.checkpoint.targetContent)) {
      throw new Error("Source or target changed since checkpoint; a new plan and explicit approval are required.");
    }
    return this.apply(plan);
  }
}
