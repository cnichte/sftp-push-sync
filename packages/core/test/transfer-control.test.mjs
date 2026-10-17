import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { FileFilter, LocalSync, SyncControl, SyncExecutor, SyncPausedError, SftpPushSyncApp } from "../src/index.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "transfer-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const targetRoot = path.join(root, "target");
  await mkdir(sourceRoot);
  await mkdir(targetRoot);
  return { root, sourceRoot, targetRoot, mode: "mirror", owner: "fixture", stateFile: path.join(root, "state.json") };
}

test("relative filters preserve spaces/semicolons, include hidden files and let exclusion win", () => {
  const filter = new FileFilter({
    include: ["Projekte/Buchprojekt; Tagebuch/**"],
    exclude: ["Projekte/Buchprojekt; Tagebuch/Compiled/**", "**/.git/**"],
  });
  assert.equal(filter.includesFile("Projekte/Buchprojekt; Tagebuch/sub/.hidden"), true);
  assert.equal(filter.includesFile("Projekte/Buchprojekt; Tagebuch/Compiled/note.md"), false);
  assert.equal(filter.excludesDirectory("Projekte/Buchprojekt; Tagebuch/.git"), true);
  for (const pattern of ["../x", "/absolute", "!x", "a\\b", ""]) {
    assert.throws(() => new FileFilter({ include: [pattern] }), /Patterns/);
  }
});

test("filters apply symmetrically and do not delete omitted target files/directories", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.sourceRoot, "notes"));
  await mkdir(path.join(f.targetRoot, "other"));
  await writeFile(path.join(f.sourceRoot, "notes/a.md"), "note");
  await writeFile(path.join(f.sourceRoot, "notes/omit.tmp"), "omit");
  await writeFile(path.join(f.targetRoot, "other/keep.tmp"), "keep");
  const engine = new LocalSync({ ...f, include: ["**/*.md"] });
  const plan = await engine.plan();
  assert.deepEqual(plan.add, ["notes/a.md"]);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.removeDirectories, []);
  await engine.apply(plan);
  assert.equal(await readFile(path.join(f.targetRoot, "other/keep.tmp"), "utf8"), "keep");
});

test("parallel executor is bounded, drains in-flight copies and never enters deletes on pause", async () => {
  const control = new SyncControl();
  let active = 0;
  let maxActive = 0;
  const copied = [];
  const executor = new SyncExecutor({
    concurrency: 3, control,
    transport: {
      async copy(item) {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        copied.push(item.rel);
        control.requestPause();
        active--;
      },
      async remove() { assert.fail("No deletion is authorized after pause."); },
    },
  });
  await assert.rejects(executor.execute({
    add: Array.from({ length: 10 }, (_, i) => ({ rel: `${i}` })),
    remove: [{ rel: "old" }],
  }), SyncPausedError);
  assert.equal(maxActive, 3);
  assert.equal(active, 0);
  assert.equal(copied.length, 3);
});

test("pause is durable even in the final copy batch; fresh instance resumes without duplicate work", async (t) => {
  const f = await fixture(t);
  for (const name of ["a", "b", "c", "d"]) await writeFile(path.join(f.sourceRoot, name), name);
  const control = new SyncControl();
  const engine = new LocalSync({
    ...f, concurrency: 2, control,
    onEvent(event) { if (event.type === "task-progress") control.requestPause(); },
  });
  const result = await engine.apply(await engine.plan());
  assert.equal(result.paused, true);
  const state = JSON.parse(await readFile(f.stateFile, "utf8"));
  assert.equal(state.status, "paused");
  assert.equal(state.files.length, 2);
  const resumed = await new LocalSync({ ...f, concurrency: 2 }).resume();
  assert.equal(resumed.ok, true);
  assert.equal(resumed.completed.length, 2);
  assert.deepEqual(await readdir(f.targetRoot), ["a", "b", "c", "d"]);
  assert.equal(JSON.parse(await readFile(f.stateFile, "utf8")).status, "complete");
});

test("paused transfers reject same-size changed source and changed filters", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, "a"), "old");
  await writeFile(path.join(f.sourceRoot, "b"), "bbb");
  const control = new SyncControl();
  const engine = new LocalSync({
    ...f, control, onEvent(event) { if (event.type === "task-progress") control.requestPause(); },
  });

  await engine.apply(await engine.plan());
  await assert.rejects(new LocalSync({ ...f, exclude: ["b"] }).resume(), /manifest/);
  await writeFile(path.join(f.sourceRoot, "b"), "new");
  await assert.rejects(new LocalSync(f).resume(), /changed/);
  assert.deepEqual(await readdir(f.targetRoot), ["a"]);
});

test("paused transfers reject changed targets without overwriting them", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, "a"), "aaa");
  await writeFile(path.join(f.sourceRoot, "b"), "bbb");
  const control = new SyncControl();
  const engine = new LocalSync({
    ...f, control, onEvent(event) { if (event.type === "task-progress") control.requestPause(); },
  });
  await engine.apply(await engine.plan());
  await writeFile(path.join(f.targetRoot, "a"), "NEW");
  await assert.rejects(new LocalSync(f).resume(), /changed/);
  assert.equal(await readFile(path.join(f.targetRoot, "a"), "utf8"), "NEW");
  assert.deepEqual(await readdir(f.targetRoot), ["a"]);
});

test("pause requested before apply persists an empty checkpoint and can resume", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, "a"), "a");
  const control = new SyncControl();
  const engine = new LocalSync({ ...f, control });
  const plan = await engine.plan();
  control.requestPause();
  assert.equal((await engine.apply(plan)).paused, true);
  assert.deepEqual(await readdir(f.targetRoot), []);
  assert.equal(JSON.parse(await readFile(f.stateFile, "utf8")).status, "paused");
  assert.equal((await new LocalSync(f).resume()).ok, true);
});

test("worker failure drains active operations before returning and blocks all deletions", async () => {
  let active = 0;
  const copied = [];
  const executor = new SyncExecutor({
    concurrency: 3,
    transport: {
      async copy(item) {
        active++;
        try {
          if (item.rel === "0") throw new Error("disk full fixture");
          await new Promise(resolve => setTimeout(resolve, 10));
          copied.push(item.rel);
        } finally { active--; }
      },
      async remove() { assert.fail("Deletes must not start after copy failure."); },
    },
  });
  await assert.rejects(executor.execute({
    add: Array.from({ length: 10 }, (_, i) => ({ rel: String(i) })),
    remove: [{ rel: "old" }],
  }), error => {
    assert.match(error.message, /disk full fixture/);
    assert.equal(active, 0);
    assert.equal(error.completed.length, copied.length);
    return true;
  });
  assert.equal(copied.length, 2);
});

test("invalid concurrency is rejected and SFTP cannot silently ignore local pause control", () => {
  for (const concurrency of [0, 33, 1.5, NaN]) {
    assert.throws(() => new SyncExecutor({ concurrency }), /concurrency/);
  }
  assert.throws(() => new SftpPushSyncApp({ control: new SyncControl() }), /only for LocalSync/);
});

test("pause during the only file persists a resumable final boundary", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, "a"), "a");
  const control = new SyncControl();
  const engine = new LocalSync({
    ...f, control, onEvent(event) { if (event.type === "task-progress") control.requestPause(); },
  });
  assert.equal((await engine.apply(await engine.plan())).paused, true);
  assert.equal((await new LocalSync(f).resume()).ok, true);
});

test("pause requested during final verification is persisted instead of reported complete", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, "a"), "a");
  const control = new SyncControl();
  let copied = false;
  const engine = new LocalSync({
    ...f, control, onEvent(event) {
      if (event.type === "task-progress") copied = true;
      if (copied && event.type === "scan-progress") control.requestPause();
    },
  });
  assert.equal((await engine.apply(await engine.plan())).paused, true);
  assert.equal(JSON.parse(await readFile(f.stateFile, "utf8")).status, "paused");
  assert.equal((await new LocalSync(f).resume()).ok, true);
});
