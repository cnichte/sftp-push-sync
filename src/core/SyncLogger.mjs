/**
 * SyncLogger.mjs
 * 
 * @author Carsten Nichte, 2025 / https://carsten-nichte.de/
 * 
 */ 
// src/core/SyncLogger.mjs
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

/**
 * Very small logger: schreibt alles in eine Logdatei
 * und entfernt ANSI-Farbcodes.
 */
export class SyncLogger {
  constructor(filePath) {
    this.filePath = filePath;
    this.stream = null;
  }

  async init() {
    if (!this.filePath || this.stream) return;

    const dir = path.dirname(this.filePath);
    await fsp.mkdir(dir, { recursive: true });

    this.stream = fs.createWriteStream(this.filePath, {
      flags: "w",
      encoding: "utf8",
    });
  }

  writeLine(line) {
    if (!this.stream) return;
    const text = typeof line === "string" ? line : String(line);
    const clean = text.replace(/\x1b\[[0-9;]*m/g, "");

    try {
      this.stream.write(clean + "\n");
    } catch {
      // Stream schon zu → ignorieren
    }
  }

  close() {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}