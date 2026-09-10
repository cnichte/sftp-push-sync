#!/usr/bin/env node

import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(projectRoot, "packages", "gui", "release");
const targetDir = "/Users/cnichte/develop-software/01-active/webseiten/carsten-nichte.de/production/carsten-nichte.de/static/releases/velosync-app";
const updaterMetadata = new Set(["latest-mac.yml", "latest-linux.yml"]);
const platformArg = process.argv.find((argument) => argument.startsWith("--platform="));
const requestedPlatform = platformArg?.split("=", 2)[1];
const metadataByPlatform = { macos: "latest-mac.yml", linux: "latest-linux.yml" };

if (requestedPlatform && !metadataByPlatform[requestedPlatform]) {
  throw new Error("--platform muss macos oder linux sein.");
}

if (!requestedPlatform) throw new Error("--platform=macos oder --platform=linux ist erforderlich.");
const metadataName = metadataByPlatform[requestedPlatform];
const versionEntries = (await readdir(sourceDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^v\d+\.\d+\.\d+/.test(entry.name))
  .map((entry) => entry.name)
  .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
const platformDirectories = await Promise.all(versionEntries.map(async (versionDirectory) => {
  const directory = path.join(sourceDir, versionDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${requestedPlatform}-`))
    .map((entry) => path.join(directory, entry.name));
}));
const sourceArtifactDir = platformDirectories.flat()[0];
if (!sourceArtifactDir) throw new Error(`Kein gestagter ${requestedPlatform}-Release gefunden.`);
const metadata = await readFile(path.join(sourceArtifactDir, metadataName), "utf8");
const version = metadata.match(/^version:\s*([^\s]+)/m)?.[1];
const architecture = path.basename(sourceArtifactDir).replace(`${requestedPlatform}-`, "");
const artifactDir = path.join(targetDir, `v${version}`, `${requestedPlatform}-${architecture}`);
const artifactPrefix = `v${version}/${requestedPlatform}-${architecture}/`;

const artifacts = (await readdir(sourceArtifactDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name !== metadataName)
  .map((entry) => entry.name);

await mkdir(targetDir, { recursive: true });
await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
for (const fileName of ["builder-debug.yml", "builder-effective-config.yaml"]) {
  await rm(path.join(targetDir, fileName), { force: true });
}
for (const artifact of artifacts) {
  await copyFile(path.join(sourceArtifactDir, artifact), path.join(artifactDir, artifact));
  console.log(`[kopiert] ${artifactPrefix}${artifact}`);
}

const publishedMetadata = metadata
  .replace(/^(\s*(?:-\s+)?(?:url|path):\s*)([^\s]+)$/gm, (_, prefix, fileName) => `${prefix}${artifactPrefix}${fileName}`);
await writeFile(path.join(targetDir, metadataName), publishedMetadata);
console.log(`[aktualisiert] ${metadataName}`);

console.log(`\nRelease v${version} nach ${artifactDir} transportiert.`);