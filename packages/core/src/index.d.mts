export type SyncMode = "mirror" | "managed";
export type SyncOperation = "add" | "update" | "delete";
export interface CompletedOperation { kind: SyncOperation; rel: string }
export interface SyncEvent { type: string; [key: string]: unknown }
export interface SyncResult {
  ok: boolean;
  exitCode: number;
  completed?: CompletedOperation[];
  error?: Error;
  plan?: LocalSyncPlan;
  paused?: boolean;
}
export interface SyncHostOptions {
  target?: string;
  configPath?: string;
  dryRun?: boolean;
  planFile?: string;
  applyPlan?: string;
  runUploadList?: boolean;
  runDownloadList?: boolean;
  skipSync?: boolean;
  sizeOnly?: boolean;
  checkResumeSupport?: boolean;
  cliLogLevel?: string | null;
  workerUpload?: number;
  workerList?: number;
  version?: string;
  structuredOutput?: boolean;
  signal?: AbortSignal;
  onLog?: (level: string, line: string) => void;
  onEvent?: (event: SyncEvent) => void;
  control?: SyncControl;
}
export class SftpPushSyncConfigError extends Error {}
export class SftpPushSyncApp {
  constructor(options?: SyncHostOptions);
  run(): Promise<SyncResult>;
}
export class PushSyncApp {
  constructor(options?: SyncHostOptions);
  run(): Promise<SyncResult>;
}
export interface LocalFileEntry {
  rel: string;
  type: "file";
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  sha256: string;
}
export interface LocalDirectoryEntry { rel: string; type: "directory" }
export type LocalEntry = LocalFileEntry | LocalDirectoryEntry;
export interface LocalSnapshot {
  identity: { root: string; dev: number; ino: number };
  entries: LocalEntry[];
}
export interface LocalSyncConfig {
  sourceRoot: string;
  targetRoot: string;
  mode: SyncMode;
  owner: string;
  stateFile: string;
  include?: string[];
  exclude?: string[];
}
export interface LocalSyncOptions extends LocalSyncConfig {
  signal?: AbortSignal;
  onEvent?: (event: SyncEvent) => void;
  control?: SyncControl;
  concurrency?: number;
}
export interface LocalSyncPlan {
  version: 1;
  config: LocalSyncConfig;
  stateHash: string | null;
  source: LocalSnapshot;
  target: LocalSnapshot;
  add: string[];
  update: string[];
  remove: string[];
  createDirectories: string[];
  removeDirectories: string[];
  digest: string;
}
export class LocalSync {
  constructor(options: LocalSyncOptions);
  plan(): Promise<LocalSyncPlan>;
  apply(approvedPlan: LocalSyncPlan): Promise<SyncResult>;
  resume(): Promise<SyncResult>;
}
export interface LocalChange {
  rel: string;
  sourceEntry: LocalFileEntry;
  targetEntry: LocalFileEntry | null;
}
export class LocalTransport {
  constructor(root: string, options?: Pick<LocalSyncOptions, "signal" | "onEvent" | "include" | "exclude">);
  open(): Promise<LocalSnapshot["identity"]>;
  inventory(): Promise<LocalSnapshot>;
  entry(rel: string): Promise<LocalEntry | null>;
  checkedPath(rel: string): Promise<string>;
  ensureDirectory(rel: string): Promise<void>;
  copyFrom(source: LocalTransport, change: LocalChange): Promise<void>;
  remove(change: Pick<LocalChange, "rel" | "targetEntry">): Promise<void>;
  removeDirectory(rel: string): Promise<void>;
}
export class SyncPlanner {
  static partition<S extends { size: number }, T extends { size: number }>(
    source: ReadonlyMap<string, S>, target: ReadonlyMap<string, T>,
  ): { add: string[]; update: string[]; compare: string[] };
  static deletions<S, T>(
    source: ReadonlyMap<string, S>, target: ReadonlyMap<string, T>,
    options?: { mode?: SyncMode; owned?: ReadonlySet<string> },
  ): string[];
}
export class SyncExecutionError extends Error {
  constructor(message: string, completed: CompletedOperation[], cause?: unknown);
  completed: CompletedOperation[];
  exitCode?: number;
}
export interface TransferAdapter<T> {
  copy(item: T, kind: "add" | "update"): Promise<void>;
  remove(item: T): Promise<void>;
}
export class SyncExecutor<T extends { rel: string }> {
  constructor(options: {
    transport: TransferAdapter<T>;
    signal?: AbortSignal;
    control?: SyncControl;
    concurrency?: number;
    onComplete?: (kind: SyncOperation, item: T) => Promise<void>;
    runGroup?: (items: T[], handler: (item: T) => Promise<void>, kind: SyncOperation) => Promise<{ failed?: number } | void>;
  });
  execute(
    changes: { add?: T[]; update?: T[]; remove?: T[] },
    options?: { beforeDeletes?: () => Promise<void> },
  ): Promise<{ completed: CompletedOperation[] }>;
}
export class FileFilter {
  constructor(options?: { include?: string[]; exclude?: string[] });
  readonly include: string[];
  readonly exclude: string[];
  static validatePatterns(value: unknown): string[];
  excludesDirectory(rel: string): boolean;
  includesFile(rel: string): boolean;
}
export class SyncControl {
  readonly pauseRequested: boolean;
  requestPause(): void;
  check(): void;
}
export class SyncPausedError extends Error {
  completed?: CompletedOperation[];
}
export interface SftpChange {
  rel: string;
  local: { localPath: string; size: number };
  remotePath: string;
}
export class SftpTransport implements TransferAdapter<SftpChange> {
  constructor(options: {
    client: { mkdir(path: string, recursive: boolean): Promise<unknown>; delete(path: string): Promise<unknown> };
    uploadFile(localPath: string, remotePath: string, rel: string, size: number): Promise<void>;
    onFileCount?: (rel: string, delta: number) => void;
  });
  copy(item: SftpChange, kind: "add" | "update"): Promise<void>;
  remove(item: Pick<SftpChange, "remotePath" | "rel">): Promise<void>;
}
