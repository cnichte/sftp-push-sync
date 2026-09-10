#!/usr/bin/env node

import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(projectRoot, "packages", "gui", "release");
const targetDir = "/Users/cnichte/develop-software/01-active/webseiten/carsten-nichte.de/production/carsten-nichte.de/static/releases/velosync-app";
const updaterMetadata = new Set(["latest-mac.yml", "latest-linux.yml"]);

const entries = await readdir(sourceDir, { withFileTypes: true });
const metadataName = entries.find((entry) => entry.isFile() && updaterMetadata.has(entry.name))?.name;
if (!metadataName) {
  throw new Error("Keine Updater-Metadatei (latest-mac.yml oder latest-linux.yml) gefunden.");
}

const metadata = await readFile(path.join(sourceDir, metadataName), "utf8");
const version = metadata.match(/^version:\s*([^\s]+)/m)?.[1];
if (!version) {
  throw new Error(`Version in ${metadataName} nicht gefunden.`);
}

const platform = metadataName === "latest-mac.yml" ? "macos" : "linux";
const artifactNames = [...metadata.matchAll(/^\s*-\s+url:\s*([^\s]+)$/gm)]
  .map(([, url]) => path.basename(url))
  .flatMap((fileName) => [fileName, `${fileName}.blockmap`]);
const artifacts = [];
for (const artifact of artifactNames) {
  const sourcePath = path.join(sourceDir, artifact);
  try {
    if ((await stat(sourcePath)).size > 0) artifacts.push(artifact);
  } catch {
    if (!artifact.endsWith(".blockmap")) throw new Error(`Release-Artefakt fehlt: ${sourcePath}`);
  }
}
const architecture = artifacts.some((name) => name.includes("arm64")) ? "arm64" : "x64";
const artifactDir = path.join(targetDir, `v${version}`, `${platform}-${architecture}`);
const artifactPrefix = `v${version}/${platform}-${architecture}/`;

await mkdir(targetDir, { recursive: true });
await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
for (const fileName of ["builder-debug.yml", "builder-effective-config.yaml"]) {
  await rm(path.join(targetDir, fileName), { force: true });
}
for (const artifact of artifacts) {
  await copyFile(path.join(sourceDir, artifact), path.join(artifactDir, artifact));
  console.log(`[kopiert] ${artifactPrefix}${artifact}`);
}

const publishedMetadata = metadata
  .replace(/^(\s*(?:-\s+)?(?:url|path):\s*)([^\s]+)$/gm, (_, prefix, fileName) => `${prefix}${artifactPrefix}${fileName}`);
await writeFile(path.join(targetDir, metadataName), publishedMetadata);
console.log(`[aktualisiert] ${metadataName}`);

console.log(`\nRelease v${version} nach ${artifactDir} transportiert.`);