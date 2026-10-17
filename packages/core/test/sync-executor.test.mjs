import assert from "node:assert/strict";
import { test } from "node:test";
import { SyncExecutor, SftpTransport, SftpPushSyncApp } from "../src/index.mjs";

test("both transports share add/update/delete ordering and explicit completed operations", async () => {
  const calls = [];
  const executor = new SyncExecutor({
    transport: {
      copy: async (item, kind) => calls.push(`${kind}:${item.rel}`),
      remove: async (item) => calls.push(`delete:${item.rel}`),
    },
  });
  const result = await executor.execute({
    add: [{ rel: "a" }], update: [{ rel: "b" }], remove: [{ rel: "c" }],
  });
  assert.deepEqual(calls, ["add:a", "update:b", "delete:c"]);
  assert.deepEqual(result.completed, [
    { kind: "add", rel: "a" }, { kind: "update", rel: "b" }, { kind: "delete", rel: "c" },
  ]);
});

test("copy failure prevents deletions and reports actual partial success", async () => {
  const executor = new SyncExecutor({
    transport: {
      async copy({ rel }) { if (rel === "b") throw new Error("disk full"); },
      async remove() { assert.fail("must not delete after failed copies"); },
    },
  });
  await assert.rejects(executor.execute({
    add: [{ rel: "a" }, { rel: "b" }], remove: [{ rel: "old" }],
  }), (error) => {
    assert.match(error.message, /disk full/);
    assert.deepEqual(error.completed, [{ kind: "add", rel: "a" }]);
    return true;
  });
});

test("SFTP adapter delegates atomic upload and propagates deletion/mkdir failures", async () => {
  const calls = [];
  const transport = new SftpTransport({
    client: {
      mkdir: async (...args) => calls.push(["mkdir", ...args]),
      delete: async () => { throw new Error("permission denied"); },
    },
    uploadFile: async (...args) => calls.push(["upload", ...args]),
    onFileCount: (...args) => calls.push(["count", ...args]),
  });
  await transport.copy({ local: { localPath: "/local/a", size: 5 }, remotePath: "/web/a", rel: "a" }, "add");
  assert.deepEqual(calls, [["mkdir", "/web", true], ["upload", "/local/a", "/web/a", "a", 5], ["count", "a", 1]]);
  await assert.rejects(transport.remove({ remotePath: "/web/a", rel: "a" }), /permission denied/);
  transport.client.mkdir = async () => { throw new Error("mkdir failed"); };
  await assert.rejects(transport.copy({ remotePath: "/web/a" }, "update"), /mkdir failed/);
});

test("SFTP workers count non-connection failures and exclude them from completed paths", async () => {
  const recovery = [];
  const app = new SftpPushSyncApp({ onLog: () => {} });
  app._writeRecoveryState = async (status, phase, data) => { recovery.push(structuredClone(data)); };
  app.updateProgress2 = () => {};
  const result = await app.runTasks([{ rel: "failed" }], 1, async () => {
    throw new Error("permission denied");
  });
  assert.equal(result.failed, 1);
  assert.deepEqual(recovery.at(-1).completedPaths, []);
  const executor = new SyncExecutor({
    transport: { copy: async () => {}, remove: async () => assert.fail("must not delete") },
    runGroup: async () => result,
  });
  await assert.rejects(executor.execute({ add: [{ rel: "failed" }], remove: [{ rel: "old" }] }), /operation.*failed/);
});
