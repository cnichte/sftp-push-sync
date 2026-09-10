#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const dryRun = process.argv.includes("--dry-run");
const allowDirty = process.argv.includes("--allow-dirty");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: npm run release:tag [-- --dry-run] [--allow-dirty]");
  console.log("Creates and pushes v<GUI version>, which starts the Linux release workflow.");
  process.exit(0);
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  }).trim();
}

const guiPackagePath = path.join(projectRoot, "packages", "gui", "package.json");
const guiPackage = JSON.parse(await readFile(guiPackagePath, "utf8"));
const version = guiPackage.version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Ungültige GUI-Version: ${version}`);
}

const tag = `v${version}`;
const changes = git(["status", "--porcelain"]);
if (changes && !allowDirty) {
  throw new Error("Arbeitsbaum ist nicht sauber. Bitte alle Release-Änderungen zuerst committen.");
}

try {
  git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]);
  throw new Error(`Tag ${tag} existiert bereits lokal.`);
} catch (error) {
  if (String(error.message).includes(`Tag ${tag} existiert bereits lokal.`)) throw error;
}

const remoteTag = git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`]);
if (remoteTag) {
  throw new Error(`Tag ${tag} existiert bereits auf origin.`);
}

if (dryRun) {
  console.log(`[dry-run] Würde annotierten Tag ${tag} erstellen und nach origin pushen.`);
  process.exit(0);
}

if (changes) {
  console.warn("Warnung: Tag wird trotz lokaler Änderungen erstellt; diese Änderungen sind nicht Teil des Tags.");
}

git(["tag", "-a", tag, "-m", `VeloSync ${version}`]);
try {
  execFileSync("git", ["push", "origin", tag], { cwd: projectRoot, stdio: "inherit" });
} catch (error) {
  throw new Error(`Tag ${tag} wurde lokal erstellt, konnte aber nicht gepusht werden: ${error.message}`);
}

console.log(`Release-Tag ${tag} gepusht. GitHub Actions erstellt das Linux-AppImage.`);