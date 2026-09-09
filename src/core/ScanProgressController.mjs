/**
 * ScanProgressController.mjs
 *
 * @author Carsten Nichte, 2025 / https://carsten-nichte.de/
 *
 */
// src/core/ScanProgressController.mjs
import cliProgress from "cli-progress";
import { toPosix, shortenPathForProgress } from "../helpers/directory.mjs";

const LABEL_WIDTH = 11;

/**
 * Hält zwei "Kanäle" (local / remote) und rendert sie als
 * cli-progress MultiBar.
 */
export class ScanProgressController {
  constructor({ writeLogLine } = {}) {
    this.writeLogLine = writeLogLine || (() => {});
    this.multibar = null;
    this.bars = new Map(); // id -> bar instance
  }

  get enabled() {
    return Boolean(process.stdout.isTTY && process.env.TERM !== "dumb");
  }

  start() {
    if (!this.enabled || this.multibar) return;
    this.multibar = new cliProgress.MultiBar(
      {
        hideCursor: true,
        clearOnComplete: true,
        forceRedraw: true,
        format: " {label} |{bar}| {value}{totalSuffix} Files | {hint}",
      },
      cliProgress.Presets.shades_classic
    );
  }

  stop() {
    if (this.multibar) {
      this.multibar.stop();
      this.multibar = null;
    }
    this.bars.clear();
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

    if (!this.enabled) return;
    this.start();

    const hint = lastRel ? shortenPathForProgress(toPosix(lastRel)) : "waiting …";
    const hasTotal = Boolean(total && total > 0);
    const totalSuffix = hasTotal ? `/${total}` : "";
    const barTotal = hasTotal ? total : Math.max(current, 1);
    const payload = { label: label.padEnd(LABEL_WIDTH), hint, totalSuffix };

    let bar = this.bars.get(id);
    if (!bar) {
      bar = this.multibar.create(barTotal, current, payload);
      this.bars.set(id, bar);
    } else {
      bar.setTotal(barTotal);
      bar.update(current, payload);
    }
  }

  done(id) {
    const bar = this.bars.get(id);
    if (bar && this.multibar) {
      this.multibar.remove(bar);
    }
    this.bars.delete(id);

    if (this.bars.size === 0) {
      this.stop();
    }
  }
}
