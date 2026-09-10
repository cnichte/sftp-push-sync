// packages/gui/electron/jobManager.mjs
import { SftpPushSyncApp } from "@sftp-push-sync/core";

// Läuft im Main-Prozess: eine Registry laufender Jobs nach Connection-ID.
// Eine ID ist `${configPath}::${name}` — der Name allein ist keine sichere
// Identität, da mehrere Projekte Connections mit gleichem Namen haben können.
// Ein Job = ein Child-Prozess der CLI in einem Pseudo-Terminal (siehe
// TODO-GUI.md P4), damit die CLI ihre normale, TTY-gebundene Ausgabe
// (Fortschrittsbalken, Farben) genau wie im echten Terminal rendert.
const jobs = new Map(); // connection.id -> { term, connection, startedAt }
const ANSI_ESCAPE = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\))/g;

function stripAnsi(value) {
  return String(value)
    .replace(ANSI_ESCAPE, "")
    .replace(/\[\d+(?:;\d+)*m/g, "");
}

function pruneStaleJobs() {
  for (const [id, job] of jobs) {
    if (!job?.controller || !job.connection?.id) {
      jobs.delete(id);
    }
  }
}

// Remote-Pfade liegen auf dem SFTP-Server, nicht auf der lokalen Platte —
// `path.resolve` würde sie fälschlich gegen das lokale Prozess-cwd auflösen
// (und auf Windows sogar Backslash-Semantik anwenden). Stattdessen rein
// POSIX-artig normalisieren, verankert an einem virtuellen "/".
function remotePathsOverlap(a, b) {
  if (!a || !b) return false;
  const ra = path.posix.resolve("/", a);
  const rb = path.posix.resolve("/", b);
  if (ra === rb) return true;
  const relAB = path.posix.relative(ra, rb);
  const relBA = path.posix.relative(rb, ra);
  const bInsideA = !relAB.startsWith("..") && !path.posix.isAbsolute(relAB);
  const aInsideB = !relBA.startsWith("..") && !path.posix.isAbsolute(relBA);
  return bInsideA || aInsideB;
}

// Zwei Regeln (siehe TODO-GUI.md "Entscheidung: Concurrency-Regeln"):
// 1. dieselbe Connection (gleiche ID = gleiche Config-Datei + gleicher Name)
//    darf nicht zweimal laufen (Cache/Log/Recovery-Dateien sind pro
//    Connection-Name im jeweiligen Projektverzeichnis benannt),
// 2. unterschiedliche Connections dürfen denselben lokalen Quellordner
//    verwenden; gesperrt werden nur überlappende Remote-Ziele auf demselben
//    Host, da dort Diff/Delete kollidieren könnten.
export function findConflict(candidate) {
  pruneStaleJobs();
  if (jobs.has(candidate.id)) {
    return { type: "same-connection", with: candidate.id };
  }
  for (const [id, job] of jobs) {
    const other = job.connection;
    if (
      candidate.host &&
      other.host &&
      candidate.host === other.host &&
      remotePathsOverlap(candidate.remoteRoot, other.remoteRoot)
    ) {
      return {
        type: "overlap",
        kind: "remoteRoot",
        with: id,
        withName: other.name,
        withProject: other.projectName,
        path: candidate.remoteRoot,
      };
    }
  }
  return null;
}

export function isRunning(id) {
  pruneStaleJobs();
  return jobs.has(id);
}

export function listRunning() {
  pruneStaleJobs();
  return [...jobs.keys()];
}

// onData(chunk) erhält rohe Terminal-Bytes (inkl. ANSI) für ein xterm.js im
// Renderer; onExit(code, signal) meldet den Abschluss des Jobs.
export function startJob({ connection, flags = [], onData, onEvent, onExit }) {
  if (!connection?.id || !connection?.name || !connection?.configPath) {
    return { ok: false, error: "Ungültige Connection für den Sync-Job." };
  }

  const conflict = findConflict(connection);
  if (conflict) return { ok: false, conflict };

  const controller = new AbortController();
  const logs = [];
  try {
    const options = new Set(flags);
    const mode = { dryRun: options.has("--dry-run") };
    const syncApp = new SftpPushSyncApp({
      target: connection.name,
      configPath: connection.configPath,
      dryRun: options.has("--dry-run"),
      runUploadList: options.has("--sidecar-upload"),
      runDownloadList: options.has("--sidecar-download"),
      skipSync: options.has("--skip-sync"),
      sizeOnly: options.has("--size-only"),
      checkResumeSupport: options.has("--check-resume-support"),
      cliLogLevel: options.has("--verbose") ? "verbose" : options.has("--laconic") ? "laconic" : null,
      signal: controller.signal,
      structuredOutput: true,
      onLog: (level, line) => {
        const log = { level, line: stripAnsi(line), ts: Date.now() };
        logs.push(log);
        if (logs.length > 1_000) logs.shift();
        onData(log);
      },
      onEvent: (event) => onEvent({ ...event, mode, ...(event.type === "complete" ? { logs } : {}) }),
    });
    jobs.set(connection.id, { controller, connection, mode, startedAt: Date.now() });
    syncApp.run()
      .then((result) => {
        if (jobs.get(connection.id)?.controller === controller) jobs.delete(connection.id);
        onExit(result?.exitCode ?? (result?.ok ? 0 : 1));
      })
      .catch((error) => {
        if (jobs.get(connection.id)?.controller === controller) jobs.delete(connection.id);
        onData({ level: "error", line: error?.stack || error?.message || String(error), ts: Date.now() });
        onExit(1);
      });
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  return { ok: true };
}

export function resizeJob(id, cols, rows) {
  return false;
}

// SIGINT statt SIGKILL: die CLI hört selbst auf SIGINT/SIGTERM (siehe P1) und
// fährt Cache/Verbindung sauber herunter, statt den Prozess hart zu beenden.
export function abortJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.controller.abort("SIGINT");
  return true;
}
