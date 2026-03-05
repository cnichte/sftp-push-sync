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
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.stream = null;
    this.enableTimestamps = options.enableTimestamps ?? false;
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

  /**
   * Returns current timestamp in ISO format: [YYYY-MM-DD HH:mm:ss.SSS]
   */
  _getTimestamp() {
    const now = new Date();
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return `[${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}]`;
  }

  writeLine(line) {
    if (!this.stream) return;
    const text = typeof line === "string" ? line : String(line);
    const clean = text.replace(/\x1b\[[0-9;]*m/g, "");

    const prefix = this.enableTimestamps ? this._getTimestamp() + " " : "";

    try {
      this.stream.write(prefix + clean + "\n");
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
