#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const typeIndex = process.argv.indexOf("--type");
const releaseType = typeIndex === -1 ? "" : process.argv[typeIndex + 1];
const dryRun = process.argv.includes("--dry-run");
const allowDirty = process.argv.includes("--allow-dirty");
const validTypes = new Set(["patch", "minor", "major"]);

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: npm run release:<patch|minor|major> [-- --dry-run]");
  process.exit(0);
}

if (!validTypes.has(releaseType)) {
  throw new Error("Release-Typ muss patch, minor oder major sein.");
}

function run(command, args, options = {}) {
  const output = execFileSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  });
  return output?.trim() || "";
}

function nextVersion(currentVersion) {
  const match = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Ungültige GUI-Version: ${currentVersion}`);

  const [, major, minor, patch] = match.map(Number);
  if (releaseType === "major") return `${major + 1}.0.0`;
  if (releaseType === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const guiPackagePath = path.join(projectRoot, "packages", "gui", "package.json");
const currentVersion = JSON.parse(await readFile(guiPackagePath, "utf8")).version;
const newVersion = nextVersion(currentVersion);
const changes = run("git", ["status", "--porcelain"]);
if (changes && !allowDirty) {
  throw new Error("Arbeitsbaum ist nicht sauber. Bitte alle Release-Änderungen zuerst committen.");
}

if (dryRun) {
  console.log(`[dry-run] Würde VeloSync ${currentVersion} auf ${newVersion} (${releaseType}) erhöhen.`);
  console.log(`[dry-run] Würde packages/gui/package.json und package-lock.json committen.`);
  console.log(`[dry-run] Würde Tag v${newVersion} erstellen und nach origin pushen.`);
  process.exit(0);
}

run("npm", [
  "version",
  releaseType,
  "--workspace",
  "@sftp-push-sync/gui",
  "--no-git-tag-version",
  "--ignore-scripts",
], { stdio: "inherit" });
run("git", ["add", "packages/gui/package.json", "package-lock.json"]);
run("git", ["commit", "-m", `chore: release VeloSync ${newVersion}`], { stdio: "inherit" });
execFileSync("node", ["scripts/release-tag.mjs", ...(allowDirty ? ["--allow-dirty"] : [])], {
  cwd: projectRoot,
  stdio: "inherit",
});
execFileSync("npm", ["run", "release:mac"], { cwd: projectRoot, stdio: "inherit" });