/**
 * SimpleProgressBar.mjs
 *
 * Single-line cli-progress bar for sequential task loops
 * (uploads/downloads, directory preparation, cleanup scans).
 *
 * @author Carsten Nichte, 2025, https://carsten-nichte.de/
 *
 */
// src/core/SimpleProgressBar.mjs
import cliProgress from "cli-progress";
import { shortenPathForProgress } from "../helpers/directory.mjs";

const STATE_WIDTH = 15;
const SPEED_WIDTH = 8;

function formatTimeFixed(seconds = 0, options, roundToMultipleOf = 1) {
  const rounded = roundToMultipleOf * Math.round(seconds / roundToMultipleOf);
  const pad = (value) => String(value).padStart(2, options.autopaddingChar || "0");
  let formatted;
  if (rounded > 3600) {
    formatted = `${pad(Math.floor(rounded / 3600))}h${pad(Math.floor((rounded % 3600) / 60))}m`;
  } else if (rounded > 60) {
    formatted = `${pad(Math.floor(rounded / 60))}m${pad(rounded % 60)}s`;
  } else {
    formatted = `${pad(rounded)}s`;
  }
  return formatted.padStart(7);
}

function formatCount(current, total) {
  const width = String(Math.max(total, 1)).length;
  return `${String(current).padStart(width)}/${String(total).padStart(width)}`;
}

export class SimpleProgressBar {
  constructor() {
    this.bar = null;
    this.label = null;
    this.startedAt = 0;
  }

  get enabled() {
    return Boolean(process.stdout.isTTY && process.env.TERM !== "dumb");
  }

  /**
   * @param {string} label static prefix, e.g. "Prepare dirs: "
   * @param {number} current
   * @param {number} total 0/undefined = indeterminate (no bar/percentage)
   * @param {string} rel current item, "done" ends the bar
   * @param {string} suffix unit label, e.g. "Files" / "Folders"
   */
  update(label, current, total, rel = "", suffix = "Files") {
    if (!this.enabled) return;

    const hasTotal = Boolean(total && total > 0);
    const isDone = rel === "done" || (hasTotal && current >= total);

    if (!this.bar || this.label !== label) {
      this.stop();
      this.label = label;
      this.bar = new cliProgress.SingleBar(
        {
          hideCursor: true,
          clearOnComplete: true,
          forceRedraw: true,
          formatTime: formatTimeFixed,
          format: hasTotal
            ? `   ${label}|{bar}| {percentage}% | {count} ${suffix} | ETA {eta_formatted} | {speed} ${suffix}/s | {state} | {rel}`
            : `   ${label}{value} ${suffix} | {speed} ${suffix}/s | {state} | {rel}`,
        },
        cliProgress.Presets.rect
      );
      this.startedAt = Date.now();
      this.bar.start(hasTotal ? total : Math.max(current, 1), 0, {
        rel: shortenPathForProgress(rel),
        count: formatCount(0, hasTotal ? total : Math.max(current, 1)),
        speed: "0.0",
        state: "starting",
      });
    }

    const elapsedSec = Math.max((Date.now() - this.startedAt) / 1000, 0.001);
    const speed = current / elapsedSec;
    this.bar.update(current, {
      rel: shortenPathForProgress(rel),
      count: formatCount(current, hasTotal ? total : Math.max(current, 1)),
      speed: speed.toFixed(1).padStart(SPEED_WIDTH),
      state: (elapsedSec >= 3 && current > 0 && speed < 0.5 ? "slow but steady" : "active").padEnd(STATE_WIDTH),
    });

    if (isDone) this.stop();
  }

  stop() {
    if (this.bar) {
      this.bar.stop();
      this.bar = null;
      this.label = null;
      this.startedAt = 0;
    }
  }
}
