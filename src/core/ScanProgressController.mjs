/**
 * ScanProgressController.mjs
 *
 * @author Carsten Nichte, 2025, https://carsten-nichte.de/
 *
 */
// src/core/ScanProgressController.mjs
import cliSpinners from "cli-spinners";
import pc from "picocolors";
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
    this.slots = new Map(); // id -> Map<slotIndex, currentPath>
    this.interval = null;
    this.frameIndex = 0;
    this.linesRendered = 0;
    this.lastRenderAt = 0;
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
    this.slots.clear();
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
    this.requestRender();
  }

  // Meldet Verzeichnis und lokalen Fortschritt eines einzelnen Scan-Workers.
  updateSlot(id, slotIndex, currentPath, current = 0, total = 0) {
    if (!this.slots.has(id)) this.slots.set(id, new Map());
    const channelSlots = this.slots.get(id);

    if (currentPath) {
      channelSlots.set(slotIndex, { path: currentPath, current, total });
    } else {
      channelSlots.delete(slotIndex);
    }

    if (!this.enabled) return;
    this.start();
    this.requestRender(current === 0 || (total > 0 && current >= total));
  }

  requestRender(force = false) {
    const now = Date.now();
    if (!force && now - this.lastRenderAt < 100) return;
    this.render();
  }

  done(id) {
    this.channels.delete(id);
    this.slots.delete(id);
    if (this.channels.size === 0) {
      this.stop();
    }
  }

  render() {
    if (!this.enabled) return;
    this.lastRenderAt = Date.now();
    this.clear();

    const frame = SPINNER.frames[this.frameIndex];
    this.frameIndex = (this.frameIndex + 1) % SPINNER.frames.length;

    const width = process.stdout.columns || 100;

    const clip = (line) => (line.length > width ? line.slice(0, width - 1) : line);
    const lines = [];

    for (const [id, data] of this.channels) {
      const { label, current, total, lastRel } = data;
      const count = total && total > 0 ? `${current}/${total}` : `${current}`;
      const channelSlots = this.slots.get(id);
      const hasSlots = Boolean(channelSlots && channelSlots.size > 0);

      const summary = hasSlots
        ? `   ${frame} ${label.padEnd(LABEL_WIDTH)} ${count} Files`
        : `   ${frame} ${label.padEnd(LABEL_WIDTH)} ${count} Files | ${
            lastRel ? shortenPathForProgress(toPosix(lastRel)) : "waiting …"
          }`;
      lines.push({ text: clip(summary), color: pc.cyan });

      if (!hasSlots) continue;

      for (const slotIndex of [...channelSlots.keys()].sort((a, b) => a - b)) {
        const slot = channelSlots.get(slotIndex);
        const hint = shortenPathForProgress(toPosix(slot.path));
        const localCount = slot.total > 0
          ? ` | ${slot.current}/${slot.total} entries`
          : " | listing...";
        lines.push({
          text: clip(`     ${String(slotIndex + 1).padStart(2)} | ${hint}${localCount}`),
          color: pc.dim,
        });
      }
    }

    process.stdout.write(
      lines.map(({ text, color }) => color(text.padEnd(width))).join("\n")
    );
    this.linesRendered = lines.length;
  }
}
