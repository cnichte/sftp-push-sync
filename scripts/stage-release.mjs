#!/usr/bin/env node

import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const releaseDir = path.join(projectRoot, "packages", "gui", "release");
const platformArg = process.argv.find((argument) => argument.startsWith("--platform="));
const platform = platformArg?.split("=", 2)[1];
const metadataByPlatform = { macos: "latest-mac.yml", linux: "latest-linux.yml", windows: "latest.yml" };

if (!metadataByPlatform[platform]) {
  throw new Error("--platform=macos, --platform=linux oder --platform=windows ist erforderlich.");
}

const metadataName = metadataByPlatform[platform];
const metadataPath = path.join(releaseDir, metadataName);
const metadata = await readFile(metadataPath, "utf8");
const version = metadata.match(/^version:\s*([^\s]+)/m)?.[1];
if (!version) throw new Error(`Version in ${metadataName} nicht gefunden.`);

const artifactNames = [...metadata.matchAll(/^\s*-\s+url:\s*([^\s]+)$/gm)]
  .map(([, url]) => path.basename(url))
  .flatMap((fileName) => [fileName, `${fileName}.blockmap`]);
const existingArtifacts = [];
for (const artifact of artifactNames) {
  const artifactPath = path.join(releaseDir, artifact);
  try {
    if ((await stat(artifactPath)).size > 0) existingArtifacts.push(artifact);
  } catch {
    if (!artifact.endsWith(".blockmap")) throw new Error(`Release-Artefakt fehlt: ${artifactPath}`);
  }
}
if (platform === "windows") {
  const versionedExecutables = (await readdir(releaseDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.includes(version) && entry.name.endsWith(".exe"))
    .map((entry) => entry.name);
  existingArtifacts.push(...versionedExecutables.filter((fileName) => !existingArtifacts.includes(fileName)));
}

const architecture = existingArtifacts.some((name) => name.includes("arm64")) ? "arm64" : "x64";
const targetDir = path.join(releaseDir, `v${version}`, `${platform}-${architecture}`);
await mkdir(targetDir, { recursive: true });
for (const fileName of [...existingArtifacts, metadataName]) {
  await rename(path.join(releaseDir, fileName), path.join(targetDir, fileName));
  console.log(`[verschoben] v${version}/${platform}-${architecture}/${fileName}`);
}

for (const fileName of ["builder-debug.yml", "builder-effective-config.yaml"]) {
  await rm(path.join(releaseDir, fileName), { force: true });
}
if (platform === "macos") await rm(path.join(releaseDir, "mac-arm64"), { recursive: true, force: true });

const staleArtifactPattern = platform === "macos"
  ? /^CatoPushSync-.*(?:\.dmg|\.zip|\.blockmap)$/
  : platform === "linux"
    ? /^CatoPushSync-.*\.AppImage(?:\.blockmap)?$/
    : /^CatoPushSync-.*(?:Setup|portable).*\.exe(?:\.blockmap)?$/;
for (const entry of await readdir(releaseDir, { withFileTypes: true })) {
  if (entry.name === ".DS_Store" || staleArtifactPattern.test(entry.name)) {
    await rm(path.join(releaseDir, entry.name), { force: true });
  }
}