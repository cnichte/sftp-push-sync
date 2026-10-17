export class SyncExecutionError extends Error {
  constructor(message, completed, cause) {
    super(message, { cause });
    this.name = "SyncExecutionError";
    this.completed = [...completed];
  }
}

export class SyncExecutor {
  constructor({ transport, signal, onComplete = async () => {}, runGroup } = {}) {
    this.transport = transport;
    this.signal = signal;
    this.onComplete = onComplete;
    this.runGroup = runGroup ?? (async (items, handler) => {
      for (const item of items) await handler(item);
    });
  }

  async execute({ add = [], update = [], remove = [] }, { beforeDeletes = async () => {} } = {}) {
    const completed = [];
    try {
      for (const [kind, items] of [["add", add], ["update", update], ["delete", remove]]) {
        this.signal?.throwIfAborted();
        if (kind === "delete" && items.length) await beforeDeletes();
        const result = await this.runGroup(items, async (item) => {
          this.signal?.throwIfAborted();
          if (kind === "delete") await this.transport.remove(item);
          else await this.transport.copy(item, kind);
          completed.push({ kind, rel: item.rel });
          await this.onComplete(kind, item);
        }, kind);
        if (result?.failed) throw new Error(`${result.failed} ${kind} operation(s) failed.`);
      }
      return { completed };
    } catch (cause) {
      throw new SyncExecutionError(`Sync incomplete: ${cause.message ?? String(cause)}`, completed, cause);
    }
  }
}
