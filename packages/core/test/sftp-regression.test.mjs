import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { analyseDifferences, computeRemoteDeletes } from "../src/helpers/compare.mjs";
import { SftpPushSyncApp } from "../src/index.mjs";

test("SFTP comparison preserves additions, size changes, hashes and deletions", async () => {
  const local = new Map([
    ["new.bin", { size: 1 }],
    ["size.bin", { size: 3 }],
    ["equal.bin", { size: 2 }],
    ["changed.bin", { size: 2 }],
  ]);
  const remote = new Map([
    ["size.bin", { size: 2, remotePath: "/web/size.bin" }],
    ["equal.bin", { size: 2, remotePath: "/web/equal.bin" }],
    ["changed.bin", { size: 2, remotePath: "/web/changed.bin" }],
    ["old.bin", { size: 1, remotePath: "/web/old.bin" }],
  ]);
  const result = await analyseDifferences({
    local, remote, remoteRoot: "/web",
    getLocalHash: async () => "same",
    getRemoteHash: async (rel) => rel === "changed.bin" ? "different" : "same",
  });
  assert.deepEqual(result.toAdd.map((item) => item.rel), ["new.bin"]);
  assert.deepEqual(result.toUpdate.map((item) => item.rel), ["size.bin", "changed.bin"]);
  assert.deepEqual(result.compareErrors, []);
  assert.deepEqual(computeRemoteDeletes({ local, remote }), [
    { rel: "old.bin", remotePath: "/web/old.bin" },
  ]);
});

test("SFTP size-only comparison does not request hashes", async () => {
  const result = await analyseDifferences({
    local: new Map([["file", { size: 2 }]]),
    remote: new Map([["file", { size: 2 }]]),
    remoteRoot: "/web", sizeOnly: true,
    getLocalHash: () => assert.fail("must not hash"),
  });
  assert.equal(result.toUpdate.length, 0);
});

test("SFTP text comparison reads remote bytes and detects same-size edits", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sftp-regression-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "note.md"), "new");
  const result = await analyseDifferences({
    local: new Map([["note.md", { size: 3, isText: true, localPath: path.join(root, "note.md") }]]),
    remote: new Map([["note.md", { size: 3, remotePath: "/web/note.md" }]]),
    remoteRoot: "/web",
    sftp: {
      async get(remotePath, destination) {
        assert.equal(remotePath, "/web/note.md");
        assert.ok(destination instanceof Writable);
        destination.end(Buffer.from("old"));
      },
    },
  });
  assert.deepEqual(result.toUpdate.map((item) => item.rel), ["note.md"]);
});

test("SFTP compare failures remain explicitly reported", async () => {
  const result = await analyseDifferences({
    local: new Map([["file", { size: 2 }]]),
    remote: new Map([["file", { size: 2 }]]),
    remoteRoot: "/web",
    getLocalHash: async () => { throw new Error("read failed"); },
    getRemoteHash: async () => "hash",
  });
  assert.equal(result.toUpdate.length, 1);
  assert.deepEqual(result.compareErrors, [{ rel: "file", error: "read failed" }]);
});

test("SFTP host rejects missing target before opening any connection", async () => {
  await assert.rejects(new SftpPushSyncApp().run(), /No target specified/);
});
