import { LocalSync, PushSyncApp, SyncExecutor, type LocalSyncPlan, type SyncMode } from "sftp-push-sync-core";

const mode: SyncMode = "mirror";
const engine = new LocalSync({
  sourceRoot: "/source", targetRoot: "/target", mode,
  owner: "vault", stateFile: "/state/vault.json",
  onEvent(event) { const type: string = event.type; void type; },
});
const plan: LocalSyncPlan = await engine.plan();
const result = await engine.apply(plan);
const ok: boolean = result.ok;
void ok;
new PushSyncApp({ target: "local", dryRun: true, planFile: "plan.json" });
const executor = new SyncExecutor<{ rel: string; size: number }>({
  transport: { async copy(item) { void item.size; }, async remove(item) { void item.rel; } },
});
await executor.execute({ add: [{ rel: "file", size: 1 }] });
// @ts-expect-error Invalid modes must fail for TypeScript consumers.
const invalid: SyncMode = "automatic";
void invalid;
// @ts-expect-error A string is not an approved plan.
await engine.apply("plan.json");
