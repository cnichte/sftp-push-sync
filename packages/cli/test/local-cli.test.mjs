import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/sftp-push-sync.mjs", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "sync-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "source"));
  await mkdir(path.join(root, "target"));
  await writeFile(path.join(root, "source/note.md"), "---\ntitle: Test\n---\n[[note]]");
  const config = { connections: { archive: {
    transport: "local", stateFile: "state.json",
    sync: { mode: "mirror", sourceRoot: "source", targetRoot: "target" },
  } } };
  await writeFile(path.join(root, "sync.config.json"), JSON.stringify(config));
  const run = (...args) => exec(process.execPath, [cli, "archive", "--json", ...args], { cwd: root });
  return { root, run };
}

test("CLI dry-run, serialized plan approval, copy and stale-plan rejection", async (t) => {
  const { root, run } = await fixture(t);
  const dry = await run("--dry-run", "--plan-file", "approved.json");
  const events = dry.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.find((event) => event.type === "plan").add, 1);
  assert.equal(events.at(-1).ok, true);
  assert.deepEqual(await readdir(path.join(root, "target")), []);
  await run("--apply-plan", "approved.json");
  assert.equal(await readFile(path.join(root, "target/note.md"), "utf8"), "---\ntitle: Test\n---\n[[note]]");
  await assert.rejects(run("--apply-plan", "approved.json"), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /changed/);
    return true;
  });
});

test("CLI rejects implicit writes, unsupported options, unsafe plan files and overwrites", async (t) => {
  const { root, run } = await fixture(t);
  await assert.rejects(run(), /requires --dry-run/);
  await assert.rejects(run("--dry-run", "--size-only"), /does not support/);
  await assert.rejects(run("--dry-run", "--plan-file", "target/plan.json"), /outside/);
  await run("--dry-run", "--plan-file", "approved.json");
  await assert.rejects(run("--dry-run", "--plan-file", "approved.json"), /EEXIST/);
  assert.deepEqual(await readdir(path.join(root, "target")), []);
});

test("CLI reports unreadable source as failure without deleting target", async (t) => {
  const { root, run } = await fixture(t);
  await writeFile(path.join(root, "target/keep"), "keep");
  await rm(path.join(root, "source"), { recursive: true });
  await assert.rejects(run("--dry-run"), (error) => {
    assert.equal(error.code, 1);
    const event = JSON.parse(error.stderr.trim());
    assert.equal(event.type, "result");
    assert.equal(event.ok, false);
    assert.match(event.error, /ENOENT/);
    return true;
  });
  assert.equal(await readFile(path.join(root, "target/keep"), "utf8"), "keep");
});
