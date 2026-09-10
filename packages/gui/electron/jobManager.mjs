// packages/gui/electron/jobManager.mjs
import pty from "node-pty";
import { app } from "electron";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = app.isPackaged
  ? path.join(process.resourcesPath, "app.asar", "node_modules", "sftp-push-sync", "bin", "sftp-push-sync.mjs")
  : path.resolve(__dirname, "../../cli/bin/sftp-push-sync.mjs");

// Läuft im Main-Prozess: eine Registry laufender Jobs nach Connection-ID.
// Eine ID ist `${configPath}::${name}` — der Name allein ist keine sichere
// Identität, da mehrere Projekte Connections mit gleichem Namen haben können.
// Ein Job = ein Child-Prozess der CLI in einem Pseudo-Terminal (siehe
// TODO-GUI.md P4), damit die CLI ihre normale, TTY-gebundene Ausgabe
// (Fortschrittsbalken, Farben) genau wie im echten Terminal rendert.
const jobs = new Map(); // connection.id -> { term, connection, startedAt }

function pathsOverlap(a, b) {
  if (!a || !b) return false;
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (ra === rb) return true;
  const relAB = path.relative(ra, rb);
  const relBA = path.relative(rb, ra);
  const bInsideA = !relAB.startsWith("..") && !path.isAbsolute(relAB);
  const aInsideB = !relBA.startsWith("..") && !path.isAbsolute(relBA);
  return bInsideA || aInsideB;
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
// 2. unterschiedliche Connections (auch aus verschiedenen Projekten) dürfen
//    nicht auf überlappende lokale/remote Verzeichnisse zugreifen (Race beim
//    Diff/Delete).
export function findConflict(candidate) {
  if (jobs.has(candidate.id)) {
    return { type: "same-connection", with: candidate.id };
  }
  for (const [id, job] of jobs) {
    const other = job.connection;
    if (pathsOverlap(candidate.localRootAbs, other.localRootAbs)) {
      return {
        type: "overlap",
        kind: "localRoot",
        with: id,
        withName: other.name,
        withProject: other.projectName,
        path: candidate.localRoot,
      };
    }
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
  return jobs.has(id);
}

export function listRunning() {
  return [...jobs.keys()];
}

// onData(chunk) erhält rohe Terminal-Bytes (inkl. ANSI) für ein xterm.js im
// Renderer; onExit(code, signal) meldet den Abschluss des Jobs.
export function startJob({ connection, flags = [], cols = 80, rows = 24, onData, onExit }) {
  const conflict = findConflict(connection);
  if (conflict) return { ok: false, conflict };

  const cwd = path.dirname(connection.configPath);
  const args = [CLI_BIN, connection.name, "--config", connection.configPath, ...flags];

  // Läuft in einem echten Pseudo-Terminal statt eines simplen Pipes, damit
  // `process.stdout.isTTY` in der CLI true ist und sie ihre normale,
  // interaktive Ausgabe (cli-progress-Balken, Farben) rendert statt in den
  // Non-TTY-Fallback (nackte Log-Zeilen) zu wechseln.
  let term;
  try {
    term = pty.spawn(process.execPath, args, {
      name: "xterm-color",
      cols,
      rows,
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "" },
    });
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }

  jobs.set(connection.id, { term, connection, startedAt: Date.now() });

  term.onData((chunk) => onData(chunk));
  term.onExit(({ exitCode, signal }) => {
    jobs.delete(connection.id);
    onExit(exitCode, signal);
  });

  return { ok: true };
}

export function resizeJob(id, cols, rows) {
  const job = jobs.get(id);
  if (!job || !cols || !rows) return false;
  job.term.resize(cols, rows);
  return true;
}

// SIGINT statt SIGKILL: die CLI hört selbst auf SIGINT/SIGTERM (siehe P1) und
// fährt Cache/Verbindung sauber herunter, statt den Prozess hart zu beenden.
export function abortJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.term.kill("SIGINT");
  return true;
}
