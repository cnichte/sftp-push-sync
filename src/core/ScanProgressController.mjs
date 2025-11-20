/**
 * ScanProgressController.mjs
 * 
 * @author Carsten Nichte, 2025 / https://carsten-nichte.de/
 * 
 */ 
// src/core/ScanProgressController.mjs
import { toPosix, shortenPathForProgress } from "../helpers/directory.mjs";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TAB_A = "   ";

/**
 * Hält zwei "Kanäle": local / remote
 * und rendert periodisch einen gemeinsamen Status.
 */
export class ScanProgressController {
  constructor({ writeLogLine } = {}) {
    this.channels = new Map(); // id -> { label, current, total, lastRel }
    this.interval = null;
    this.spinnerIndex = 0;
    this.writeLogLine = writeLogLine || (() => {});
  }

  start() {
    if (!process.stdout.isTTY || this.interval) return;
    this.interval = setInterval(() => this.render(), 80);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    if (process.stdout.isTTY) {
      const width = process.stdout.columns || 80;
      process.stdout.write("\r" + " ".repeat(width) + "\n");
      process.stdout.write(" ".repeat(width) + "\x1b[1A");
    }

    this.channels.clear();
  }

  updateChannel(id, data) {
    // data: { label, current, total?, lastRel? }
    this.channels.set(id, data);
    if (!this.interval) this.start();

    const { label, current, total, lastRel } = data;
    const base =
      total && total > 0
        ? `${label}: ${current}/${total} Files`
        : `${label}: ${current} Files`;

    this.writeLogLine?.(
      `[scan-progress] ${base}${
        lastRel ? " – " + toPosix(lastRel) : ""
      }`
    );
  }

  done(id) {
    this.channels.delete(id);
    if (this.channels.size === 0) {
      this.stop();
    }
  }

  render() {
    if (!process.stdout.isTTY) return;

    this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
    const spin = SPINNER_FRAMES[this.spinnerIndex];
    const width = process.stdout.columns || 80;

    const entries = [...this.channels.entries()];
    const local = entries.find(([id]) => id === "local")?.[1];
    const remote = entries.find(([id]) => id === "remote")?.[1];

    const headerParts = [];
    if (local) {
      headerParts.push(
        `local ${local.current}${local.total ? "/" + local.total : ""}`
      );
    }
    if (remote) {
      headerParts.push(
        `remote ${remote.current}${remote.total ? "/" + remote.total : ""}`
      );
    }

    const header =
      headerParts.length > 0
        ? `Scan files: ${headerParts.join(", ")}`
        : "Scan files: –";

    const line1Raw = `${TAB_A}${spin} ${header}`;

    const localHint = local?.lastRel
      ? shortenPathForProgress(toPosix(local.lastRel))
      : "";
    const remoteHint = remote?.lastRel
      ? shortenPathForProgress(toPosix(remote.lastRel))
      : "";

    const detailParts = [];
    if (localHint) detailParts.push(`[local] ${localHint}`);
    if (remoteHint) detailParts.push(`[remote] ${remoteHint}`);

    const detail =
      detailParts.length > 0 ? detailParts.join("    ") : "waiting …";

    const line2Raw = `${TAB_A}→ ${detail}`;

    const line1 =
      line1Raw.length > width ? line1Raw.slice(0, width - 1) : line1Raw;
    const line2 =
      line2Raw.length > width ? line2Raw.slice(0, width - 1) : line2Raw;

    process.stdout.write("\r" + line1.padEnd(width) + "\n");
    process.stdout.write(line2.padEnd(width) + "\x1b[1A");
  }
}