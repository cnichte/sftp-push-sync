import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await check(full);
    else if (entry.name.endsWith(".mjs")) {
      const result = spawnSync(process.execPath, ["--check", full], { stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  }
}
await check(path.join(root, "packages/core/src"));
await check(path.join(root, "packages/cli/bin"));
await check(path.join(root, "packages/gui/electron"));
console.log("Core, CLI and Electron host syntax checks passed (native ESM; no compilation required).");
