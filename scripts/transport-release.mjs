#!/usr/bin/env node

import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(projectRoot, "packages", "gui", "release");
const targetDir = "/Users/cnichte/develop-software/01-active/webseiten/carsten-nichte.de/production/carsten-nichte.de/static/releases/velosync-app";
const publishableExtensions = new Set([".dmg", ".zip", ".blockmap"]);
const updaterMetadata = new Set(["latest-mac.yml", "latest-linux.yml"]);

const entries = await readdir(sourceDir, { withFileTypes: true });
const artifacts = [];

for (const entry of entries) {
  if (!entry.isFile() || entry.name.startsWith(".")) continue;
  if (!publishableExtensions.has(path.extname(entry.name)) && !updaterMetadata.has(entry.name)) continue;

  const sourcePath = path.join(sourceDir, entry.name);
  if ((await stat(sourcePath)).size === 0) continue;
  artifacts.push(entry.name);
}

if (artifacts.length === 0) {
  throw new Error(`Keine Release-Artefakte in ${sourceDir} gefunden.`);
}

const metadataName = artifacts.find((name) => updaterMetadata.has(name));
if (!metadataName) {
  throw new Error("Keine Updater-Metadatei (latest-mac.yml oder latest-linux.yml) gefunden.");
}

const metadata = await readFile(path.join(sourceDir, metadataName), "utf8");
const version = metadata.match(/^version:\s*([^\s]+)/m)?.[1];
if (!version) {
  throw new Error(`Version in ${metadataName} nicht gefunden.`);
}

const platform = metadataName === "latest-mac.yml" ? "macos" : "linux";
const architecture = artifacts.some((name) => name.includes("arm64")) ? "arm64" : "x64";
const artifactDir = path.join(targetDir, `v${version}`, `${platform}-${architecture}`);
const artifactPrefix = `v${version}/${platform}-${architecture}/`;

await mkdir(targetDir, { recursive: true });
await mkdir(artifactDir, { recursive: true });
for (const fileName of ["builder-debug.yml", "builder-effective-config.yaml"]) {
  await rm(path.join(targetDir, fileName), { force: true });
}
for (const artifact of artifacts) {
  if (updaterMetadata.has(artifact)) continue;
  await copyFile(path.join(sourceDir, artifact), path.join(artifactDir, artifact));
  await rm(path.join(targetDir, artifact), { force: true });
  console.log(`[kopiert] ${artifactPrefix}${artifact}`);
}

const publishedMetadata = metadata
  .replace(/^(\s*(?:-\s+)?(?:url|path):\s*)([^\s]+)$/gm, (_, prefix, fileName) => `${prefix}${artifactPrefix}${fileName}`);
await writeFile(path.join(targetDir, metadataName), publishedMetadata);
console.log(`[aktualisiert] ${metadataName}`);

console.log(`\nRelease v${version} nach ${artifactDir} transportiert.`);