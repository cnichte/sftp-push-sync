import { SyncPausedError } from "./SyncControl.mjs";

export class SyncExecutionError extends Error {
  constructor(message, completed, cause) {
    super(message, { cause });
    this.name = "SyncExecutionError";
    this.completed = [...completed];
  }
}

export class SyncExecutor {
  constructor({ transport, signal, control, concurrency = 1, onComplete = async () => {}, runGroup } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      throw new Error("concurrency must be an integer between 1 and 32.");
    }
    this.transport = transport;
    this.signal = signal;
    this.control = control;
    this.onComplete = onComplete;
    this.runGroup = runGroup ?? (async (items, handler) => {
      let next = 0;
      let failure;
      await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (!failure && !this.control?.pauseRequested && !this.signal?.aborted) {
          const item = items[next++];
          if (!item) return;
          try { await handler(item); } catch (error) { failure ??= error; }
        }
      }));
      if (failure) throw failure;
      this.signal?.throwIfAborted();
      this.control?.check();
    });
  }

  async execute({ add = [], update = [], remove = [] }, { beforeDeletes = async () => {} } = {}) {
    const completed = [];
    try {
      for (const [kind, items] of [["add", add], ["update", update], ["delete", remove]]) {
        this.signal?.throwIfAborted();
        this.control?.check();
        if (kind === "delete" && items.length) await beforeDeletes();
        const result = await this.runGroup(items, async (item) => {
          this.signal?.throwIfAborted();
          if (kind === "delete") await this.transport.remove(item);
          else await this.transport.copy(item, kind);
          completed.push({ kind, rel: item.rel });
          await this.onComplete(kind, item);
        }, kind);
        if (result?.failed) throw new Error(`${result.failed} ${kind} operation(s) failed.`);
        this.control?.check();
      }
      return { completed };
    } catch (cause) {
      if (cause instanceof SyncPausedError) {
        cause.completed = [...completed];
        throw cause;
      }
      throw new SyncExecutionError(`Sync incomplete: ${cause.message ?? String(cause)}`, completed, cause);
    }
  }
}
