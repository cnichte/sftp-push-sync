import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renameSync } from "node:fs";
import { LocalSync } from "../src/index.mjs";

async function fixture(t, mode = "mirror") {
  const root = await mkdtemp(path.join(tmpdir(), "local-sync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const targetRoot = path.join(root, "target");
  await mkdir(sourceRoot);
  await mkdir(targetRoot);
  const options = { sourceRoot, targetRoot, mode, owner: "test", stateFile: path.join(root, "state.json") };
  return { root, sourceRoot, targetRoot, options, sync: new LocalSync(options) };
}

test("mirror copies exact bytes, hidden files and empty directories; repeat is unchanged", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.sourceRoot, ".obsidian"));
  await mkdir(path.join(f.sourceRoot, "empty"));
  await writeFile(path.join(f.sourceRoot, ".obsidian", "config.json"), "{}");
  const bytes = Buffer.from([0, 255, 254, 10]);
  await writeFile(path.join(f.sourceRoot, "asset.bin"), bytes);
  const plan = await f.sync.plan();
  assert.equal(plan.add.length, 2);
  assert.deepEqual(await readdir(f.targetRoot), []);
  await assert.rejects(readFile(f.options.stateFile), { code: "ENOENT" });
  const result = await f.sync.apply(JSON.parse(JSON.stringify(plan)));
  assert.equal(result.ok, true);
  assert.deepEqual(await readFile(path.join(f.targetRoot, "asset.bin")), bytes);
  assert.equal(await readFile(path.join(f.targetRoot, ".obsidian/config.json"), "utf8"), "{}");
  assert.deepEqual(await readdir(path.join(f.targetRoot, "empty")), []);
  const repeat = await f.sync.plan();
  assert.deepEqual([repeat.add, repeat.update, repeat.remove], [[], [], []]);
});

test("mirror detects same-size changes and propagates source deletions including empty source", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, "note.md"), "old");
  await f.sync.apply(await f.sync.plan());
  await writeFile(path.join(f.sourceRoot, "note.md"), "new");
  const changed = await f.sync.plan();
  assert.deepEqual(changed.update, ["note.md"]);
  await f.sync.apply(changed);
  assert.equal(await readFile(path.join(f.targetRoot, "note.md"), "utf8"), "new");
  await rm(path.join(f.sourceRoot, "note.md"));
  const deleted = await f.sync.plan();
  assert.deepEqual(deleted.remove, ["note.md"]);
  await f.sync.apply(deleted);
  assert.deepEqual(await readdir(f.targetRoot), []);
});

test("managed export deletes only owned files and retains unrelated project content", async (t) => {
  const f = await fixture(t, "managed");
  await writeFile(path.join(f.targetRoot, "hugo.toml"), "foreign");
  await writeFile(path.join(f.sourceRoot, "post.md"), "post");
  await f.sync.apply(await f.sync.plan());
  await rm(path.join(f.sourceRoot, "post.md"));
  const plan = await f.sync.plan();
  assert.deepEqual(plan.remove, ["post.md"]);
  await f.sync.apply(plan);
  assert.deepEqual(await readdir(f.targetRoot), ["hugo.toml"]);
});

test("managed export refuses both foreign collisions and modified owned files", async (t) => {
  const f = await fixture(t, "managed");
  await writeFile(path.join(f.targetRoot, "post.md"), "foreign");
  await writeFile(path.join(f.sourceRoot, "post.md"), "source");
  await assert.rejects(f.sync.plan(), /not owned/);
  await rm(path.join(f.targetRoot, "post.md"));
  await f.sync.apply(await f.sync.plan());
  await writeFile(path.join(f.targetRoot, "post.md"), "edited");
  await assert.rejects(f.sync.plan(), /modified/);
});

test("source offline is an error, never a deletion plan", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.targetRoot, "keep"), "keep");
  await rm(f.sourceRoot, { recursive: true });
  await assert.rejects(f.sync.plan(), /ENOENT/);
  assert.equal(await readFile(path.join(f.targetRoot, "keep"), "utf8"), "keep");
});

test("a replaced source root is not accepted as an empty vault in a later process", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, "keep"), "archived");
  await f.sync.apply(await f.sync.plan());
  renameSync(f.sourceRoot, path.join(f.root, "offline"));
  await mkdir(f.sourceRoot);
  await assert.rejects(new LocalSync(f.options).plan(), /Root identity/);
  assert.equal(await readFile(path.join(f.targetRoot, "keep"), "utf8"), "archived");
});

test("stale source, target, state and tampered plans are rejected before mutation", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, "note"), "one");
  const first = await f.sync.plan();
  const tampered = structuredClone(first);
  tampered.remove.push("../outside");
  await assert.rejects(f.sync.apply(tampered), /plan/i);
  await writeFile(path.join(f.sourceRoot, "note"), "two");
  await assert.rejects(f.sync.apply(first), /changed/i);
  const second = await f.sync.plan();
  await writeFile(path.join(f.targetRoot, "foreign"), "new");
  await assert.rejects(f.sync.apply(second), /changed/i);
  const third = await f.sync.plan();
  await writeFile(f.options.stateFile, "{}");
  await assert.rejects(f.sync.apply(third), /state|manifest/i);
  assert.equal(await readFile(path.join(f.targetRoot, "foreign"), "utf8"), "new");
});

test("symlinks and overlapping roots are refused without following them", async (t) => {
  const f = await fixture(t);
  await symlink(f.targetRoot, path.join(f.sourceRoot, "escape"));
  await assert.rejects(f.sync.plan(), /symbolic|symlink/i);
  await rm(path.join(f.sourceRoot, "escape"));
  await assert.rejects(new LocalSync({ ...f.options, targetRoot: f.sourceRoot }).plan(), /overlap/i);
  await mkdir(path.join(f.sourceRoot, "nested"));
  await assert.rejects(new LocalSync({
    ...f.options, targetRoot: path.join(f.sourceRoot, "nested"),
  }).plan(), /overlap/i);
});

test("aborted planning and execution leave content untouched", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, "note"), "source");
  const plan = await f.sync.plan();
  const controller = new AbortController();
  controller.abort();
  const aborted = new LocalSync({ ...f.options, signal: controller.signal });
  await assert.rejects(aborted.plan(), /abort/i);
  await assert.rejects(aborted.apply(plan), /abort/i);
  assert.deepEqual(await readdir(f.targetRoot), []);
});

test("state must be outside both content roots and ownership cannot be reassigned silently", async (t) => {
  const f = await fixture(t, "managed");
  await assert.rejects(new LocalSync({
    ...f.options, stateFile: path.join(f.targetRoot, "state.json"),
  }).plan(), /outside/i);
  await f.sync.apply(await f.sync.plan());
  await assert.rejects(new LocalSync({ ...f.options, owner: "other" }).plan(), /manifest/i);
});

test("file-directory conflicts are explicit and do not destroy the old target", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.targetRoot, "note"));
  await writeFile(path.join(f.sourceRoot, "note"), "source");
  await assert.rejects(f.sync.plan(), /type conflict/i);
  assert.deepEqual(await readdir(path.join(f.targetRoot, "note")), []);
});

test("interrupted managed sync persists completed ownership and can be replanned", async (t) => {
  const f = await fixture(t, "managed");
  await writeFile(path.join(f.sourceRoot, "a"), "first");
  await writeFile(path.join(f.sourceRoot, "b"), "second");
  const controller = new AbortController();
  const interrupted = new LocalSync({
    ...f.options, signal: controller.signal,
    onEvent(event) { if (event.type === "task-progress") controller.abort(); },
  });
  const plan = await interrupted.plan();
  await assert.rejects(interrupted.apply(plan), (error) => {
    assert.equal(error.exitCode, 130);
    assert.deepEqual(error.completed, [{ kind: "add", rel: "a" }]);
    return true;
  });
  assert.equal(JSON.parse(await readFile(f.options.stateFile, "utf8")).status, "partial");
  const remaining = await f.sync.plan();
  assert.deepEqual(remaining.add, ["b"]);
  await f.sync.apply(remaining);
  assert.deepEqual((await readdir(f.targetRoot)).sort(), ["a", "b"]);
});

test("source disappearing after copying prevents all planned deletions", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, "new"), "new");
  await writeFile(path.join(f.targetRoot, "keep"), "keep");
  const interrupted = new LocalSync({
    ...f.options,
    onEvent(event) {
      if (event.type === "task-progress" && event.kind === "add") {
        renameSync(f.sourceRoot, path.join(f.root, "offline"));
      }
    },
  });
  await assert.rejects(interrupted.apply(await interrupted.plan()), /ENOENT/);
  assert.equal(await readFile(path.join(f.targetRoot, "keep"), "utf8"), "keep");
});

test("aborting a streamed file copy preserves old bytes and cleans its temporary file", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(8 * 1024 * 1024, 42);
  await writeFile(path.join(f.sourceRoot, "large.bin"), bytes);
  await writeFile(path.join(f.targetRoot, "large.bin"), "old");
  const controller = new AbortController();
  const interrupted = new LocalSync({
    ...f.options, signal: controller.signal,
    onEvent(event) { if (event.type === "copy-progress") controller.abort(); },
  });
  await assert.rejects(interrupted.apply(await interrupted.plan()), /abort/i);
  assert.equal(await readFile(path.join(f.targetRoot, "large.bin"), "utf8"), "old");
  assert.deepEqual(await readdir(f.targetRoot), ["large.bin"]);
  await f.sync.apply(await f.sync.plan());
  assert.deepEqual(await readFile(path.join(f.targetRoot, "large.bin")), bytes);
});

test("case-only source/target collisions are rejected portably", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, "Note.md"), "source");
  await writeFile(path.join(f.targetRoot, "note.md"), "target");
  await assert.rejects(f.sync.plan(), /path collision/);
});

test("managed directory cleanup never removes unrelated project files", async (t) => {
  const f = await fixture(t, "managed");
  await mkdir(path.join(f.sourceRoot, "content"));
  await writeFile(path.join(f.sourceRoot, "content/post.md"), "post");
  await f.sync.apply(await f.sync.plan());
  await writeFile(path.join(f.targetRoot, "content/foreign.md"), "foreign");
  await rm(path.join(f.sourceRoot, "content"), { recursive: true });
  const plan = await f.sync.plan();
  assert.deepEqual(plan.removeDirectories, []);
  await f.sync.apply(plan);
  assert.deepEqual(await readdir(path.join(f.targetRoot, "content")), ["foreign.md"]);
});

test("a target changed during execution is not reported complete", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, "file"), "source");
  const changed = new LocalSync({
    ...f.options,
    onEvent(event) {
      if (event.type === "task-progress") renameSync(path.join(f.targetRoot, "file"), path.join(f.targetRoot, "moved"));
    },
  });
  await assert.rejects(changed.apply(await changed.plan()), /verification failed/);
  assert.equal(JSON.parse(await readFile(f.options.stateFile, "utf8")).status, "partial");
});
