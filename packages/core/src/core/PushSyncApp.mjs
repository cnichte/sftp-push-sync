import * as fs from "node:fs/promises";
import path from "node:path";
import { LocalSync } from "./LocalSync.mjs";
import { containsPath } from "../transports/LocalTransport.mjs";
import { SftpPushSyncApp, SftpPushSyncConfigError } from "./SftpPushSyncApp.mjs";

export class PushSyncApp {
  constructor(options = {}) {
    this.options = options;
  }

  async run() {
    const options = this.options;
    if (!options.target) throw new SftpPushSyncConfigError("No target specified.");
    const configPath = path.resolve(options.configPath ?? "sync.config.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    const profile = config.connections?.[options.target];
    if (!profile) throw new SftpPushSyncConfigError(`Connection '${options.target}' not found.`);
    if (!profile.transport || profile.transport === "sftp") {
      if (options.planFile || options.applyPlan) {
        throw new SftpPushSyncConfigError("--plan-file and --apply-plan currently require a local transport.");
      }
      return new SftpPushSyncApp(options).run();
    }
    if (profile.transport !== "local") throw new SftpPushSyncConfigError(`Unknown transport: ${profile.transport}`);
    if (options.sizeOnly || options.runUploadList || options.runDownloadList ||
        options.skipSync || options.checkResumeSupport) {
      throw new SftpPushSyncConfigError("Local transport does not support size-only, sidecar or SFTP capability options.");
    }
    if ((options.applyPlan && options.dryRun) || (options.planFile && !options.dryRun) ||
        (!options.dryRun && !options.applyPlan)) {
      throw new SftpPushSyncConfigError("Local sync requires --dry-run [--plan-file <file>] or --apply-plan <file>.");
    }
    const sync = profile.sync;
    if (!sync?.sourceRoot || !sync?.targetRoot || !profile.stateFile) {
      throw new SftpPushSyncConfigError("Local profiles require sync.sourceRoot, sync.targetRoot and stateFile.");
    }
    if ((sync.include?.length ?? 0) || (sync.exclude?.length ?? 0)) {
      throw new SftpPushSyncConfigError("Local sync currently copies the complete source root; filters are not supported.");
    }
    const configDir = path.dirname(configPath);
    const engine = new LocalSync({
      sourceRoot: path.resolve(configDir, sync.sourceRoot),
      targetRoot: path.resolve(configDir, sync.targetRoot),
      mode: sync.mode, owner: options.target,
      stateFile: path.resolve(configDir, profile.stateFile),
      signal: options.signal, onEvent: options.onEvent,
    });
    if (options.applyPlan) {
      const plan = JSON.parse(await fs.readFile(path.resolve(options.applyPlan), "utf8"));
      return engine.apply(plan);
    }
    const plan = await engine.plan();
    if (options.planFile) {
      const requested = path.resolve(options.planFile);
      const planPath = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested));
      if ([engine.source.root, engine.target.root].some((root) => containsPath(root, planPath)) ||
          planPath === engine.canonicalStateFile || planPath.startsWith(`${engine.canonicalStateFile}.`)) {
        throw new SftpPushSyncConfigError("Plan files must be outside content roots and separate from sync state.");
      }
      await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    }
    const log = options.onLog ?? ((level, line) => console.log(line));
    log("info", `Local sync plan: ${plan.add.length} add, ${plan.update.length} update, ${plan.remove.length} delete.`);
    for (const [kind, paths] of [
      ["add", plan.add], ["update", plan.update], ["delete", plan.remove],
      ["mkdir", plan.createDirectories], ["rmdir", plan.removeDirectories],
    ]) {
      for (const rel of paths) log("info", `${kind}: ${rel}`);
    }
    log("info", `Dry-run only. Plan digest: ${plan.digest}`);
    return { ok: true, exitCode: 0, plan };
  }
}
