#!/usr/bin/env node

import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const source = path.join(projectRoot, "app-icon.svg");
const resourcesDir = path.join(projectRoot, "packages", "gui", "resources");
const iconsetDir = path.join(resourcesDir, "icon.iconset");

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

await mkdir(resourcesDir, { recursive: true });
await rm(iconsetDir, { recursive: true, force: true });
await mkdir(iconsetDir);

const sizes = [16, 32, 64, 128, 256, 512, 1024];
for (const size of sizes) {
  run("magick", [source, "-resize", `${size}x${size}`, path.join(resourcesDir, `icon-${size}.png`)]);
}
await copyFile(path.join(resourcesDir, "icon-1024.png"), path.join(resourcesDir, "icon.png"));

const iconsetSizes = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];
for (const [size, fileName] of iconsetSizes) {
  run("magick", [source, "-resize", `${size}x${size}`, path.join(iconsetDir, fileName)]);
}

run("iconutil", ["-c", "icns", iconsetDir, "-o", path.join(resourcesDir, "icon.icns")]);
run("magick", [
  ...sizes.map((size) => path.join(resourcesDir, `icon-${size}.png`)),
  path.join(resourcesDir, "icon.ico"),
]);

await rm(iconsetDir, { recursive: true, force: true });
console.log(`App icons generated in ${resourcesDir}`);