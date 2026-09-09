/**
 * MultiLineProgressRenderer.mjs
 *
 * Multi-line cli-progress bar for parallel per-file jobs
 * (hash comparison, uploads/downloads, etc.).
 *
 * @author Carsten Nichte, 2025, https://carsten-nichte.de/
 *
 */
// src/core/MultiLineProgressRenderer.mjs
import cliProgress from "cli-progress";
import pc from "picocolors";
import { shortenPathForProgress } from "../helpers/directory.mjs";
import { PROGRESS_STATUS_LABELS } from "../helpers/progress-constants.mjs";

function formatBytes(bytes = 0) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

/**
 * Renders a batch of parallel per-file jobs (used during hash comparison)
 * as a cli-progress MultiBar: one header line + up to maxLines job bars.
 */
export class MultiLineProgressRenderer {
  constructor({ maxLines = 10 } = {}) {
    this.maxLines = maxLines;
    this.multibar = null;
    this.headerBar = null;
    this.jobBars = new Map(); // rel -> bar instance
    this.jobStartedAt = new Map();
    this.headerStartedAt = 0;
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
        autopadding: true,
      },
      cliProgress.Presets.rect
    );
    this.headerBar = this.multibar.create(1, 0, { phases: "" }, {
      format: pc.bold(pc.cyan(" {bar} {percentage}% | {value}/{total} Files | ETA {eta_formatted} | {speed} Files/s | {state} | {phases}")),
    });
    this.headerStartedAt = Date.now();
  }

  stop() {
    if (this.multibar) {
      this.multibar.stop();
    }
    this.multibar = null;
    this.headerBar = null;
    this.jobBars.clear();
    this.jobStartedAt.clear();
  }

  // Tears the bars down; the next render() call recreates them lazily.
  // Used before printing normal console lines so output doesn't overlap.
  clear() {
    this.stop();
  }

  render({ current = 0, total = 0, jobs = [], force = false }) {
    if (!this.enabled) return;
    this.start();

    this.headerBar.setTotal(total || 1);
    const elapsedSec = Math.max((Date.now() - this.headerStartedAt) / 1000, 0.001);
    this.headerBar.update(Math.min(current, total || 1), {
      phases: this.formatPhaseSummary(jobs),
      speed: (current / elapsedSec).toFixed(1),
      state: elapsedSec >= 3 && current > 0 && current / elapsedSec < 0.5
        ? "slow but steady"
        : "active",
    });

    const visibleJobs = jobs.slice(0, this.maxLines);
    const visibleRels = new Set(visibleJobs.map((job) => job.rel));

    for (const [rel, bar] of this.jobBars) {
      if (!visibleRels.has(rel)) {
        this.multibar.remove(bar);
        this.jobBars.delete(rel);
        this.jobStartedAt.delete(rel);
      }
    }

    for (const job of visibleJobs) {
      const total = job.totalBytes || 1;
      const value = Math.min(job.receivedBytes || 0, total);
      if (!this.jobStartedAt.has(job.rel)) {
        this.jobStartedAt.set(job.rel, Date.now());
      }
      const elapsedSec = Math.max(
        (Date.now() - this.jobStartedAt.get(job.rel)) / 1000,
        0.001
      );
      const rate = value / 1024 / 1024 / elapsedSec;
      const payload = { info: this.formatJobInfo(job, rate) };

      let bar = this.jobBars.get(job.rel);
      if (!bar) {
        bar = this.multibar.create(total, value, payload, {
          format: " {bar} {percentage}% | {info}",
        });
        this.jobBars.set(job.rel, bar);
      } else {
        bar.setTotal(total);
        bar.update(value, payload);
      }
    }
  }

  // Zählt, wie viele Jobs sich gerade in welcher Phase befinden
  // (queued/local/remote/text/done/changed/error), damit der Kopf-Balken
  // den aktuellen Batch aufgeschlüsselt zeigt statt nur eine Gesamtzahl.
  formatPhaseSummary(jobs) {
    const counts = new Map();
    for (const job of jobs) {
      const label = PROGRESS_STATUS_LABELS[job.status] || job.status || "work";
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, count]) => `${label}:${count}`)
      .join(" ");
  }

  formatJobInfo(job, megabytesPerSecond = 0) {
    const status = PROGRESS_STATUS_LABELS[job.status] || job.status || "work";
    const rel = shortenPathForProgress(job.rel || "");
    const progress = job.totalBytes
      ? `${formatBytes(job.receivedBytes || 0)}/${formatBytes(job.totalBytes)}`
      : "";
    const largeTag = job.isLarge ? "⚡" : "";
    const rate = job.isLarge && megabytesPerSecond > 0
      ? `  ${megabytesPerSecond.toFixed(1)} MB/s`
      : "";
    return `[${status.padEnd(13)}] ${largeTag}${rel}${progress ? "  " + progress : ""}${rate}`;
  }
}
