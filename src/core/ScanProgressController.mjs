/**
 * ScanProgressController.mjs
 *
 * @author Carsten Nichte, 2025 / https://carsten-nichte.de/
 *
 */
// src/core/ScanProgressController.mjs
import cliSpinners from "cli-spinners";
import { toPosix, shortenPathForProgress } from "../helpers/directory.mjs";

const SPINNER = cliSpinners.dots;
const LABEL_WIDTH = 11;

/**
 * Hält zwei "Kanäle" (local / remote) und rendert je Kanal eine Spinner-Zeile.
 * Die Gesamtanzahl der Dateien ist während des Scans unbekannt, daher genügt
 * hier ein Spinner statt eines Fortschrittsbalkens.
 */
export class ScanProgressController {
  constructor({ writeLogLine } = {}) {
    this.writeLogLine = writeLogLine || (() => {});
    this.channels = new Map(); // id -> { label, current, total, lastRel }
    this.interval = null;
    this.frameIndex = 0;
    this.linesRendered = 0;
  }

  get enabled() {
    return Boolean(process.stdout.isTTY && process.env.TERM !== "dumb");
  }

  start() {
    if (!this.enabled || this.interval) return;
    process.stdout.write("\x1b[?25l");
    this.interval = setInterval(() => this.render(), SPINNER.interval);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.clear();
    if (this.enabled) process.stdout.write("\x1b[?25h");
    this.channels.clear();
  }

  clear() {
    if (!this.enabled || this.linesRendered <= 0) return;
    if (this.linesRendered > 1) {
      process.stdout.write(`\x1b[${this.linesRendered - 1}F`);
    } else {
      process.stdout.write("\r");
    }
    for (let i = 0; i < this.linesRendered; i++) {
      process.stdout.write("\x1b[2K");
      if (i < this.linesRendered - 1) process.stdout.write("\x1b[1B");
    }
    if (this.linesRendered > 1) {
      process.stdout.write(`\x1b[${this.linesRendered - 1}F`);
    } else {
      process.stdout.write("\r");
    }
    this.linesRendered = 0;
  }

  updateChannel(id, data) {
    // data: { label, current, total?, lastRel? }
    const { label, current, total, lastRel } = data;

    const base =
      total && total > 0
        ? `${label}: ${current}/${total} Files`
        : `${label}: ${current} Files`;

    this.writeLogLine?.(
      `[scan-progress] ${base}${lastRel ? " – " + toPosix(lastRel) : ""}`
    );

    this.channels.set(id, data);
    if (!this.enabled) return;
    this.start();
  }

  done(id) {
    this.channels.delete(id);
    if (this.channels.size === 0) {
      this.stop();
    }
  }

  render() {
    if (!this.enabled) return;
    this.clear();

    const frame = SPINNER.frames[this.frameIndex];
    this.frameIndex = (this.frameIndex + 1) % SPINNER.frames.length;

    const width = process.stdout.columns || 100;

    const lines = [...this.channels.values()].map((data) => {
      const { label, current, total, lastRel } = data;
      const count = total && total > 0 ? `${current}/${total}` : `${current}`;
      const hint = lastRel ? shortenPathForProgress(toPosix(lastRel)) : "waiting …";
      const line = `   ${frame} ${label.padEnd(LABEL_WIDTH)} ${count} Files | ${hint}`;
      return line.length > width ? line.slice(0, width - 1) : line;
    });

    process.stdout.write(lines.map((l) => l.padEnd(width)).join("\n"));
    this.linesRendered = lines.length;
  }
}
