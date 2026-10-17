import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PushSyncApp } from "../src/index.mjs";
import { SftpPushSyncApp } from "../src/index.mjs";
import SftpClient from "ssh2-sftp-client";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startSftpServer } from "./helpers/sftp-server.mjs";

async function fixture(t, serverOptions) {
  const root = await mkdtemp(path.join(tmpdir(), "sftp-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const remote = path.join(root, "remote");
  await mkdir(source);
  await mkdir(path.join(remote, "web"), { recursive: true });
  const port = await startSftpServer(t, remote, serverOptions);
  const configPath = path.join(root, "sync.config.json");
  const config = {
    connections: { test: {
      host: "127.0.0.1", port, user: "test", password: "test-only",
      sync: { localRoot: "source", remoteRoot: "/web" },
      workerUpload: 2, workerList: 2,
    } },
    exclude: ["**/*.ignore"], logFile: "test.log",
  };
  await writeFile(configPath, JSON.stringify(config));
  const events = [];
  const errors = [];
  const run = (options = {}) => new PushSyncApp({
    target: "test", configPath, structuredOutput: true,
    onLog: (level, line) => { if (level === "error") errors.push(line); },
    onEvent: (event) => events.push(event), ...options,
  }).run();
  return { root, source, target: path.join(remote, "web"), run, events, errors, config, configPath };
}

test("real SFTP protocol: dry-run, upload, same-size update, filter, delete and unchanged repeat", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.source, "nested"));
  await writeFile(path.join(f.source, "nested/note.md"), "old");
  await writeFile(path.join(f.source, "asset.bin"), Buffer.from([255, 0, 254]));
  await writeFile(path.join(f.source, "skip.ignore"), "excluded");
  await writeFile(path.join(f.target, "obsolete"), "old");
  assert.equal((await f.run({ dryRun: true })).ok, true);
  assert.deepEqual(await readdir(f.target), ["obsolete"]);
  const initial = await f.run();
  assert.equal(initial.ok, true, initial.error?.stack);
  assert.equal(await readFile(path.join(f.target, "nested/note.md"), "utf8"), "old");
  assert.deepEqual(await readFile(path.join(f.target, "asset.bin")), Buffer.from([255, 0, 254]));
  assert.deepEqual((await readdir(f.target)).sort(), ["asset.bin", "nested"]);
  await writeFile(path.join(f.source, "nested/note.md"), "new");
  await rm(path.join(f.source, "asset.bin"));
  const updated = await f.run();
  assert.equal(updated.ok, true, f.errors.join("\n"));
  assert.equal(await readFile(path.join(f.target, "nested/note.md"), "utf8"), "new");
  assert.deepEqual(await readdir(f.target), ["nested"]);
  assert.equal((await f.run()).ok, true);
  const lastPlan = f.events.filter((event) => event.type === "plan").at(-1);
  assert.deepEqual([lastPlan.add, lastPlan.update, lastPlan.delete], [0, 0, 0]);
});

test("real SFTP permission failure returns failure rather than a successful deletion", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, { denyDelete: true });
  await writeFile(path.join(f.target, "keep"), "keep");
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(await readFile(path.join(f.target, "keep"), "utf8"), "keep");
});

test("real SFTP authentication failure leaves remote contents untouched", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  f.config.connections.test.password = "invalid";
  await writeFile(f.configPath, JSON.stringify(f.config));
  await writeFile(path.join(f.target, "keep"), "keep");
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(await readFile(path.join(f.target, "keep"), "utf8"), "keep");
});

test("existing CLI selects SFTP for profiles without a transport field", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "note"), "source");
  const cli = fileURLToPath(new URL("../../cli/bin/sftp-push-sync.mjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [
    cli, "test", "--config", f.configPath, "--dry-run", "--json",
  ]);
  const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).ok, true);
  assert.equal(events.find((event) => event.type === "plan").add, 1);
  assert.deepEqual(await readdir(f.target), []);
});

test("existing SFTP sidecar upload/download bypass remains independent of normal sync", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, "sidecar-local"));
  await mkdir(path.join(f.root, "remote/sidecars"));
  await writeFile(path.join(f.root, "sidecar-local/upload.json"), "{}");
  await writeFile(path.join(f.root, "remote/sidecars/download.txt"), "download");
  await writeFile(path.join(f.target, "keep"), "keep");
  f.config.connections.test.sidecar = {
    localRoot: "sidecar-local", remoteRoot: "/sidecars",
    uploadList: ["upload.json"], downloadList: ["download.txt"],
  };
  await writeFile(f.configPath, JSON.stringify(f.config));
  const result = await f.run({ skipSync: true, runUploadList: true, runDownloadList: true });
  assert.equal(result.ok, true, result.error?.stack);
  assert.equal(await readFile(path.join(f.root, "remote/sidecars/upload.json"), "utf8"), "{}");
  assert.equal(await readFile(path.join(f.root, "sidecar-local/download.txt"), "utf8"), "download");
  assert.equal(await readFile(path.join(f.target, "keep"), "utf8"), "keep");
});

test("existing atomic SFTP uploader resumes an interrupted temporary upload", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "asset.bin"), "abcdef");
  await writeFile(path.join(f.target, ".asset-resume"), "abc");
  const client = new SftpClient();
  await client.connect({
    host: "127.0.0.1", port: f.config.connections.test.port, username: "test", password: "test-only",
  });
  try {
    const app = new SftpPushSyncApp({ onLog: () => {} });
    app._writeRecoveryState = async () => {};
    app.previousRecovery = { resumeUploads: {
      "asset.bin": { temporaryPath: "/web/.asset-resume", remotePath: "/web/asset.bin", size: 6 },
    } };
    await app._uploadFile(client, path.join(f.source, "asset.bin"), "/web/asset.bin", "asset.bin", 6);
    assert.equal(await readFile(path.join(f.target, "asset.bin"), "utf8"), "abcdef");
    assert.deepEqual(await readdir(f.target), ["asset.bin"]);
    assert.equal(app.activeResumeUploads.size, 0);
  } finally {
    await client.end();
  }
});
