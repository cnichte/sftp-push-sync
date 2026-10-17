export class SyncPausedError extends Error {
  constructor() {
    super("Sync pause requested at an operation boundary.");
    this.name = "SyncPausedError";
  }
}

export class SyncControl {
  constructor() {
    this.pauseRequested = false;
  }

  requestPause() {
    this.pauseRequested = true;
  }

  check() {
    if (this.pauseRequested) throw new SyncPausedError();
  }
}
