/**
 * Lightweight phase metrics for progress and summary output.
 */
export class ProgressMetrics {
  constructor() {
    this.phases = new Map();
  }

  start(name) {
    this.phases.set(name, {
      name,
      startedAt: Date.now(),
      endedAt: null,
      files: 0,
      bytes: 0,
    });
  }

  update(name, { files = 0, bytes = 0 } = {}) {
    const phase = this.phases.get(name);
    if (!phase) return;
    phase.files = Math.max(phase.files, Number(files) || 0);
    phase.bytes = Math.max(phase.bytes, Number(bytes) || 0);
  }

  finish(name, values = {}) {
    const phase = this.phases.get(name);
    if (!phase) return null;
    this.update(name, values);
    phase.endedAt = Date.now();
    return this.get(name);
  }

  get(name) {
    const phase = this.phases.get(name);
    if (!phase) return null;

    const end = phase.endedAt || Date.now();
    const durationSec = Math.max((end - phase.startedAt) / 1000, 0.001);
    return {
      name: phase.name,
      files: phase.files,
      bytes: phase.bytes,
      durationSec,
      filesPerSecond: phase.files / durationSec,
      megabytesPerSecond: phase.bytes / 1024 / 1024 / durationSec,
      complete: Boolean(phase.endedAt),
    };
  }

  slowest() {
    return [...this.phases.keys()]
      .map((name) => this.get(name))
      .filter((phase) => phase?.complete)
      .sort((left, right) => right.durationSec - left.durationSec)[0] || null;
  }
}