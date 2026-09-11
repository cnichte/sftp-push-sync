// packages/gui/src/App.jsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AppShell,
  Group,
  ActionIcon,
  Text,
  NavLink,
  Stack,
  Alert,
  Tabs,
  Button,
  Accordion,
  Splitter,
  Tooltip,
  Modal,
  Select,
  TextInput,
  PasswordInput,
  NumberInput,
  Textarea,
  Loader,
  Switch,
  Badge,
  Progress,
  ScrollArea,
  SimpleGrid,
  UnstyledButton,
} from "@mantine/core";
import {
  IconPlus,
  IconSettings,
  IconAlertCircle,
  IconPlayerPlay,
  IconPlayerStop,
  IconCheck,
  IconX,
  IconFolderPlus,
  IconDownload,
  IconInfoCircle,
  IconServer2,
  IconTerminal2,
  IconDeviceFloppy,
  IconFolderOpen,
  IconFlask,
  IconRestore,
  IconFileText,
  IconTrash,
  IconChevronRight,
  IconPlugConnected,
  IconBook,
} from "@tabler/icons-react";
import SettingsWindow from "./SettingsWindow.jsx";
import AboutModal from "./AboutModal.jsx";
import ManualWindow from "./ManualWindow.jsx";

const STATUS_ICON = {
  running: <Loader size={14} />,
  aborting: <Loader size={14} color="var(--mantine-color-blue-6)" />,
  done: <IconCheck size={14} color="var(--mantine-color-green-6)" />,
  failed: <IconX size={14} color="var(--mantine-color-red-6)" />,
  aborted: <IconX size={14} color="var(--mantine-color-yellow-6)" />,
};

// sync.config.json speichert Upload-/Download-Listen als Arrays; im Formular
// werden sie als Komma-getrennter Text bearbeitet.
function listToText(list) {
  return Array.isArray(list) ? list.join(", ") : "";
}
function textToList(text) {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
function connectionToForm(conn) {
  return {
    name: conn.name || "",
    host: conn.host || "",
    port: conn.port ?? 22,
    user: conn.user || "",
    password: conn.password || "",
    workerUpload: conn.workerUpload ?? 2,
    workerList: conn.workerList ?? 5,
    localRoot: conn.localRoot || "",
    remoteRoot: conn.remoteRoot || "",
    sidecarLocalRoot: conn.sidecarLocalRoot || "",
    sidecarRemoteRoot: conn.sidecarRemoteRoot || "",
    sidecarUploadList: listToText(conn.sidecarUploadList),
    sidecarDownloadList: listToText(conn.sidecarDownloadList),
  };
}
function projectSettingsToForm(settings) {
  return {
    ...settings,
    include: listToText(settings.include),
    exclude: listToText(settings.exclude),
    textExtensions: listToText(settings.textExtensions),
    mediaExtensions: listToText(settings.mediaExtensions),
  };
}
function formatFileInfo(file) {
  if (!file?.exists) return "-";
  const size = file.size < 1024 * 1024
    ? `${Math.round(file.size / 1024)} KB`
    : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
  return `${size} | ${new Date(file.modifiedAt).toLocaleString()}`;
}
function formatBytes(bytes = 0) {
  if (!bytes) return "0 B";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function formatDuration(seconds = 0) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  if (minutes > 0) return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
  return `${totalSeconds} s`;
}
function stripAnsi(value) {
  return String(value)
    .replace(/(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\))/g, "")
    .replace(/\[\d+(?:;\d+)*m/g, "");
}

function StructuredJobView({ job, t, lastHistory = null, historyView = false }) {
  const [now, setNow] = useState(() => Date.now());
  const events = job.events || [];
  const phase = job.phase || [...events].reverse().find((event) => event.type === "phase");
  const progress = job.progress || [...events].reverse().find((event) => ["progress", "task-progress", "scan-progress", "compare-progress"].includes(event.type));
  const plan = job.plan || [...events].reverse().find((event) => event.type === "plan");
  const complete = job.complete || [...events].reverse().find((event) => event.type === "complete");
  const percent = progress?.total ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 0;
  const phases = ["connecting", "scan", "compare", "plan", "apply", "cleanup"];
  const activePhase = phase?.name;
  const activePhaseIndex = phases.indexOf(activePhase);
  const scanWorkers = Object.values(job.scanWorkers || {}).filter((worker) => worker.active);
  const compareWorkers = job.compareWorkers || [];
  const workers = activePhase === "scan"
    ? [...scanWorkers.values()].filter((worker) => worker.active)
    : activePhase === "compare"
      ? compareWorkers
      : [];
  const isActive = job.status === "running" || job.status === "aborting";
  const elapsedSeconds = job.startedAt ? Math.max(0, Math.floor((now - job.startedAt) / 1000)) : 0;

  useEffect(() => {
    if (!isActive || !job.startedAt) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isActive, job.startedAt]);

  return (
    <Tabs defaultValue="overview" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Tabs.List>
        <Tabs.Tab value="overview">{t(historyView ? "jobView.summary" : "jobView.activeRun")}</Tabs.Tab>
        <Tabs.Tab value="log">{t("jobView.log")}</Tabs.Tab>
        {lastHistory && <Tabs.Tab value="lastRun">{t("jobView.lastRun")}</Tabs.Tab>}
      </Tabs.List>
      <Tabs.Panel value="overview" pt="md" style={{ flex: 1, minHeight: 0 }}>
        <Stack gap="md">
          <Group justify="space-between">
            <Stack gap={2}>
              <Text size="sm" fw={600}>
                {phase?.label || t("jobView.preparing")}
                {job.mode?.dryRun ? ` | ${t("jobView.dry")}` : ""}
                {isActive ? ` | ${formatDuration(elapsedSeconds)}` : ""}
              </Text>
              {progress?.path && <Text size="xs" c="dimmed">{progress.path}</Text>}
            </Stack>
          </Group>
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} spacing="xs">
            {phases.map((name) => {
              const phaseIndex = phases.indexOf(name);
              const active = job.status === "running" && (activePhase === name || (name === "connecting" && activePhase === "connected"));
              const complete = activePhaseIndex > phaseIndex || job.status === "done";
              return (
                <Group key={name} gap={5} wrap="nowrap">
                  {active ? <Loader size={13} /> : complete ? <IconCheck size={13} color="var(--mantine-color-green-6)" /> : <span style={{ width: 13, height: 13, borderRadius: "50%", background: "var(--mantine-color-gray-4)" }} />}
                  <Text size="xs" c={active ? "blue" : complete ? "green" : "dimmed"}>{t(`jobView.phase.${name}`)}</Text>
                </Group>
              );
            })}
          </SimpleGrid>
          {activePhase === "scan" && (
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
              {["local", "remote"].map((channel) => {
                const scan = job.scanChannels?.[channel];
                return (
                  <Group key={channel} gap="xs" align="flex-start" wrap="nowrap">
                    {scan?.complete ? <IconCheck size={16} color="var(--mantine-color-green-6)" style={{ marginTop: 2 }} /> : <Loader size={16} mt={2} />}
                    <Stack gap={1} style={{ minWidth: 0 }}>
                      <Group gap={5} wrap="nowrap"><Text size="xs">{t(`jobView.scan.${channel}`)} · {t("jobView.workerCount", { count: channel === "local" ? phase?.localWorkers || 1 : job.scanWorkerCount || phase?.remoteWorkers || 1 })}</Text><Text size="xs" c="dimmed">{scan?.current || 0} {t("jobView.files")}</Text></Group>
                      <Text size="xs" c="dimmed" truncate>{scan?.complete ? t("jobView.scanComplete") : scan?.lastRel || t("jobView.waiting")}</Text>
                    </Stack>
                  </Group>
                );
              })}
            </SimpleGrid>
          )}
          {progress && activePhase !== "scan" && (
            <Stack gap={5}>
              <Group justify="space-between"><Text size="xs">{progress.label}{job.taskWorkers ? ` · ${t("jobView.workerCount", { count: job.taskWorkers })}` : ""}</Text><Text size="xs" c="dimmed">{progress.total ? `${progress.current}/${progress.total} (${percent}%)` : `${progress.current} ${progress.unit || t("jobView.files")}`}</Text></Group>
              <Progress value={progress.total ? percent : 100} animated={job.status === "running"} />
              {progress.bytes > 0 && <Text size="xs" c="dimmed">{formatBytes(progress.bytes)}</Text>}
            </Stack>
          )}
          {workers.length > 0 && (
            <Stack gap={6}>
              <Text size="xs" fw={500}>{t("jobView.workers")}</Text>
              {workers.map((worker, index) => {
                const workerPercent = worker.total > 0 ? Math.min(100, Math.round((worker.current / worker.total) * 100)) : worker.totalBytes > 0 ? Math.min(100, Math.round((worker.receivedBytes / worker.totalBytes) * 100)) : 0;
                const workerCurrent = worker.current ?? worker.receivedBytes ?? 0;
                const workerTotal = worker.total ?? worker.totalBytes ?? 0;
                return (
                  <Stack key={worker.slotIndex ?? index} gap={3}>
                    <Group justify="space-between" gap="xs" wrap="nowrap">
                      <Text size="xs" c="dimmed" truncate>{t("jobView.worker", { number: (worker.slotIndex ?? index) + 1 })}: {worker.path}</Text>
                      {workerTotal > 0 && <Text size="xs" c="dimmed">{worker.totalBytes ? `${formatBytes(workerCurrent)}/${formatBytes(workerTotal)}` : `${workerCurrent}/${workerTotal}`}</Text>}
                    </Group>
                    <Progress size="sm" value={workerTotal > 0 ? workerPercent : 100} animated />
                  </Stack>
                );
              })}
            </Stack>
          )}
          {plan && (
            <SimpleGrid cols={4} spacing="xs">
              <Stack gap={0}><Text size="xs" c="dimmed">{t("jobView.add")}</Text><Text fw={600}>{plan.add}</Text></Stack>
              <Stack gap={0}><Text size="xs" c="dimmed">{t("jobView.update")}</Text><Text fw={600}>{plan.update}</Text></Stack>
              <Stack gap={0}><Text size="xs" c="dimmed">{t("jobView.delete")}</Text><Text fw={600}>{plan.delete}</Text></Stack>
              <Stack gap={0}><Text size="xs" c="dimmed">{t("jobView.upload")}</Text><Text fw={600}>{formatBytes(plan.uploadBytes)}</Text></Stack>
            </SimpleGrid>
          )}
          {Number.isFinite(complete?.durationSec) && (
            <Text size="xs" c="dimmed">{t("jobView.duration", { seconds: formatDuration(complete.durationSec) })}</Text>
          )}
          {complete?.metrics?.length > 0 && (
            <Stack gap={6}>
              <Text size="xs" fw={500}>{t("jobView.performance")}</Text>
              <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="xs">
                {complete.metrics.map((metric) => (
                  <Stack key={metric.name} gap={1} p="xs" style={{ border: "1px solid var(--mantine-color-default-border)" }}>
                    <Text size="xs" fw={500}>{metric.name}</Text>
                    <Text size="xs" c="dimmed">{t("jobView.metricDuration", { seconds: formatDuration(metric.durationSec) })} | {t("jobView.metricFiles", { count: metric.files })}</Text>
                    {metric.bytes > 0 && <Text size="xs" c="dimmed">{formatBytes(metric.bytes)} | {metric.megabytesPerSecond.toFixed(1)} MB/s</Text>}
                  </Stack>
                ))}
              </SimpleGrid>
            </Stack>
          )}
          {(complete?.addedPaths?.length || complete?.updatedPaths?.length || complete?.deletedPaths?.length) && (
            <Stack gap={4}>
              <Text size="xs" fw={500}>{t("jobView.changes")}</Text>
              {[{ symbol: "+", color: "green", paths: complete.addedPaths }, { symbol: "~", color: "yellow", paths: complete.updatedPaths }, { symbol: "-", color: "red", paths: complete.deletedPaths }].map((group) =>
                group.paths?.map((filePath) => <Text key={`${group.symbol}:${filePath}`} size="xs" c={group.color} ff="monospace">{group.symbol} {filePath}</Text>)
              )}
            </Stack>
          )}
          {complete?.folders && <Text size="xs" c="dimmed">{t("jobView.folders", complete.folders)}</Text>}
          {complete?.error && <Alert color="red" py={4}><Text size="xs">{complete.error}</Text></Alert>}
        </Stack>
      </Tabs.Panel>
      <Tabs.Panel value="log" pt="sm" style={{ flex: 1, minHeight: 0 }}>
        <ScrollArea h="100%" type="auto" style={{ background: "#1a1b1e", padding: "var(--mantine-spacing-xs)" }}>
          <Stack gap={2}>
            {job.logs.map((log, index) => <Text key={index} size="xs" ff="monospace" c={log.level === "error" ? "red.4" : "gray.3"} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{log.line}</Text>)}
          </Stack>
        </ScrollArea>
      </Tabs.Panel>
      {lastHistory && (
        <Tabs.Panel value="lastRun" pt="sm" style={{ flex: 1, minHeight: 0 }}>
          <StructuredJobView job={historyToJob(lastHistory)} t={t} historyView />
        </Tabs.Panel>
      )}
    </Tabs>
  );
}

function historyToJob(history) {
  return {
    status: history.ok ? "done" : history.aborted ? "aborted" : "failed",
    events: [],
    logs: (history.logs || []).map((log) => ({ ...log, line: stripAnsi(log.line) })),
    complete: history,
    plan: history,
    mode: history.mode,
    phase: { name: "cleanup", label: "Letzter Lauf" },
  };
}

function GroupHistoryView({ history, groupName, t, onOpenEntry = () => {} }) {
  return (
    <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
      <Text size="sm" fw={600}>{t("jobView.groupHistory", { name: groupName })}</Text>
      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        <Stack gap={4}>
          {history.map((entry) => (
            <Group key={`${entry.connectionId}:${entry.completedAt}`} justify="space-between" p="xs" style={{ border: "1px solid var(--mantine-color-default-border)" }}>
              <Stack gap={1}>
                <Text size="sm" fw={500}>{entry.name}</Text>
                <Text size="xs" c="dimmed">{new Date(entry.completedAt).toLocaleString()}</Text>
              </Stack>
              <Group gap="md">
                <Text size="xs">{t("jobView.duration", { seconds: formatDuration(entry.durationSec) })}</Text>
                <Text size="xs">+{entry.add || 0} ~{entry.update || 0} -{entry.delete || 0}</Text>
                <Badge size="xs" color={entry.ok ? "green" : entry.aborted ? "yellow" : "red"} variant="light">{entry.ok ? t("jobs.status.done") : entry.aborted ? t("jobs.status.aborted") : t("jobs.status.failed")}</Badge>
                <Tooltip label={t("jobView.openDetails")}>
                  <ActionIcon size="sm" variant="subtle" aria-label={t("jobView.openDetails")} onClick={() => onOpenEntry(entry)}>
                    <IconChevronRight size={15} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Group>
          ))}
        </Stack>
      </ScrollArea>
    </Stack>
  );
}

// Leichtgewichtiger Ersatz für Mantine's `Splitter` (der benötigt v9 + React 19
// als Peer-Dependency — zu großer/riskanter Sprung für eine Komponente).
// Liefert eine per Maus ziehbare Breite plus den Drag-Start-Handler.
export default function App() {
  const { t } = useTranslation();
  const [connections, setConnections] = useState([]);
  const [configErrors, setConfigErrors] = useState([]);
  const [selected, setSelected] = useState(null);
  const [selectedProject, setSelectedProject] = useState(null);
  const [selectedHistory, setSelectedHistory] = useState(null);
  const [projectHistory, setProjectHistory] = useState([]);
  const [historyTabs, setHistoryTabs] = useState([]);
  const [jobs, setJobs] = useState({}); // connection.id -> { status, logs: string[], connection }
  const [activeTab, setActiveTab] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [dropError, setDropError] = useState(null);
  const [form, setForm] = useState(null);
  const [projectForm, setProjectForm] = useState(null);
  const [jobFiles, setJobFiles] = useState(null);
  const [runOptions, setRunOptions] = useState({});
  const [saveError, setSaveError] = useState(null);
  const [connectionTest, setConnectionTest] = useState({ status: "idle" });
  const [openGroups, setOpenGroups] = useState([]);
  const [openPropertyGroups, setOpenPropertyGroups] = useState(["connection", "sync", "sidecar"]);
  const [appInfo, setAppInfo] = useState(null);
  const [settingsOpened, setSettingsOpened] = useState(false);
  const [settingsTab, setSettingsTab] = useState("general");
  const [aboutOpened, setAboutOpened] = useState(false);
  const [manualOpened, setManualOpened] = useState(false);
  const [updateState, setUpdateState] = useState({ status: "idle" });
  const [historySettings, setHistorySettings] = useState({ limit: 10, count: 0, bytes: 0 });
  const [newJobOpened, setNewJobOpened] = useState(false);
  const [newJobTarget, setNewJobTarget] = useState(null); // configPath or "__new__"
  const [newJobNewPath, setNewJobNewPath] = useState(null); // gewählter Speicherort, wenn "__new__"
  const [newJobName, setNewJobName] = useState("");
  const [newJobError, setNewJobError] = useState(null);

  useEffect(() => {
    window.sftpPushSync?.getAppInfo().then(setAppInfo);
  }, []);

  useEffect(() => {
    const off = window.sftpPushSync?.onUpdateEvent((payload) => {
      if (payload.type === "checking") setUpdateState({ status: "checking" });
      else if (payload.type === "available") setUpdateState({ status: "available", version: payload.version });
      else if (payload.type === "not-available") setUpdateState({ status: "not-available" });
      else if (payload.type === "progress") setUpdateState((prev) => ({ ...prev, status: "downloading", percent: payload.percent }));
      else if (payload.type === "downloaded") setUpdateState({ status: "downloaded", version: payload.version });
      else if (payload.type === "error") setUpdateState({ status: "error", message: payload.message });
    });
    return () => off?.();
  }, []);

  const openSettings = (tabName) => {
    setSettingsTab(tabName);
    setSettingsOpened(true);
  };

  const reloadConnections = useCallback(() => {
    return window.sftpPushSync?.listConnections().then((result) => {
      setConnections(result.connections);
      setConfigErrors(result.errors || []);
      // Neu entdeckte Projekte im Accordion standardmäßig aufgeklappt zeigen.
      setOpenGroups((prev) => {
        const configPaths = [...new Set(result.connections.map((connection) => connection.configPath))];
        const missing = configPaths.filter((configPath) => !prev.includes(configPath));
        return missing.length ? [...prev, ...missing] : prev;
      });
      return result.connections;
    });
  }, []);

  useEffect(() => {
    reloadConnections();
  }, [reloadConnections]);

  const reloadHistorySettings = useCallback(() => {
    return window.sftpPushSync?.getHistorySettings().then(setHistorySettings);
  }, []);

  useEffect(() => {
    reloadHistorySettings();
  }, [reloadHistorySettings]);

  useEffect(() => {
    const offData = window.sftpPushSync?.onJobData(({ connectionId, log }) => {
      setJobs((previous) => {
        const job = previous[connectionId];
        if (!job) return previous;
        return { ...previous, [connectionId]: { ...job, logs: [...job.logs, log].slice(-1_000) } };
      });
    });
    const offEvent = window.sftpPushSync?.onJobEvent(({ connectionId, event }) => {
      setJobs((previous) => {
        const job = previous[connectionId];
        if (!job) return previous;
        const events = [...job.events, event].slice(-250);
        const next = { ...job, events };
        if (event.type === "phase") next.phase = event;
        if (["progress", "task-progress", "compare-progress"].includes(event.type)) next.progress = event;
        if (event.type === "task-start") next.taskWorkers = event.workers;
        if (event.type === "plan") next.plan = event;
        if (event.type === "complete") next.complete = event;
        if (event.type === "scan-progress") {
          next.scanChannels = { ...job.scanChannels, [event.channel]: { ...event, complete: false } };
          next.progress = event;
        }
        if (event.type === "scan-complete") {
          next.scanChannels = { ...job.scanChannels, [event.channel]: { ...event, complete: true } };
        }
        if (event.type === "scan-worker") next.scanWorkers = { ...job.scanWorkers, [event.slotIndex]: event };
          if (event.type === "scan-workers") next.scanWorkerCount = event.count;
        if (event.type === "compare-progress") next.compareWorkers = event.workers || [];
        return { ...previous, [connectionId]: next };
      });
    });
    const offExit = window.sftpPushSync?.onJobExit(({ connectionId, code }) => {
      setJobs((prev) => {
        const job = prev[connectionId];
        if (!job) return prev;
        const status = code === 0 ? "done" : code === 130 ? "aborted" : "failed";
        return { ...prev, [connectionId]: { ...job, status } };
      });
    });
    return () => {
      offData?.();
      offEvent?.();
      offExit?.();
    };
  }, []);

  const focusTab = (id) => {
    setActiveTab(id);
  };

  const openHistoryEntry = (entry) => {
    const id = `history:run:${entry.connectionId}:${entry.completedAt}`;
    setHistoryTabs((tabs) => [
      ...tabs.filter((tab) => tab.id !== id),
      { id, type: "connection", title: `${entry.projectName || entry.configPath} | ${entry.name}`, history: entry },
    ]);
    focusTab(id);
  };

  const handleSelectConnection = (conn) => {
    setSelected(conn);
    setSelectedProject(null);
    setHistoryTabs((tabs) => tabs.filter((tab) => tab.type !== "connection"));
    setProjectHistory([]);
    setForm(connectionToForm(conn));
    window.sftpPushSync.getJobFiles(conn.configPath, conn.name).then((result) => {
      if (result?.ok) setJobFiles(result);
    });
    window.sftpPushSync.getJobHistory(conn.id).then((result) => {
      const history = result?.history || null;
      setSelectedHistory(history);
      if (history && Object.values(jobs).some((job) => job.status === "running") && jobs[conn.id]?.status !== "running") {
        const id = `history:${conn.id}`;
        setHistoryTabs((tabs) => [...tabs.filter((tab) => tab.id !== id), { id, type: "connection", title: `${conn.projectName} | ${conn.name}`, history }]);
        focusTab(id);
      }
    });
    setSaveError(null);
    window.sftpPushSync.getProjectSettings(conn.configPath).then((result) => {
      if (result?.ok) setProjectForm(projectSettingsToForm(result.settings));
    });
    if (jobs[conn.id]) {
      focusTab(conn.id);
    }
  };

  const handleSelectProject = (configPath) => {
    setSelected(null);
    setForm(null);
    setSelectedHistory(null);
    setSaveError(null);
    window.sftpPushSync.getProjectSettings(configPath).then((result) => {
      if (result?.ok) {
        setSelectedProject({ configPath });
        setProjectForm(projectSettingsToForm(result.settings));
      }
    });
    window.sftpPushSync.getProjectJobHistory(configPath).then((result) => {
      const history = result?.history || [];
      setProjectHistory(history);
      if (history.length > 0 && Object.values(jobs).some((job) => job.status === "running")) {
        const projectName = connections.find((connection) => connection.configPath === configPath)?.projectName || t("properties.group");
        const id = `history:group:${configPath}`;
        setHistoryTabs((tabs) => [...tabs.filter((tab) => tab.id !== id), { id, type: "group", title: projectName, history }]);
        focusTab(id);
      }
    });
  };

  const handleFieldChange = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleRunOptionChange = (connectionId, field, value) => {
    setRunOptions((previous) => ({
      ...previous,
      [connectionId]: { ...previous[connectionId], [field]: value },
    }));
  };

  const getJobFlags = (connection, forceDryRun = false) => {
    const options = runOptions[connection.id] || {};
    if (options.skipSync && !options.sidecarUpload && !options.sidecarDownload) {
      setSaveError(t("jobs.skipSyncRequiresSidecar"));
      return null;
    }
    return [
      ...(forceDryRun || options.dryRun ? ["--dry-run"] : []),
      ...(options.sidecarUpload ? ["--sidecar-upload"] : []),
      ...(options.sidecarDownload ? ["--sidecar-download"] : []),
      ...(options.skipSync ? ["--skip-sync"] : []),
    ];
  };

  const handleProjectFieldChange = (field, value) => {
    setProjectForm((prev) => ({ ...prev, [field]: value }));
  };

  const getDefaultProjectName = (configPath) => configPath.split(/[\\/]/).slice(-2, -1)[0];

  const handleResetProjectName = () => {
    if (!selectedProject) return;
    const defaultName = getDefaultProjectName(selectedProject.configPath);
    setProjectForm((prev) => ({ ...prev, projectName: defaultName, hasCustomProjectName: false, resetProjectName: true }));
  };

  const handleRevealInFolder = (configPath) => {
    window.sftpPushSync.revealInFolder(configPath);
  };

  const handleDeleteCache = async () => {
    if (!jobFiles?.cache?.exists) return;
    const result = await window.sftpPushSync.deleteJobCache(jobFiles.cache.path);
    if (!result.ok) {
      setSaveError(result.error || "unknown error");
      return;
    }
    setJobFiles((prev) => ({ ...prev, cache: { ...prev.cache, exists: false } }));
  };

  const handleOpenNewJob = () => {
    const firstExisting = [...new Map(connections.map((c) => [c.configPath, c.projectName])).keys()][0];
    setNewJobTarget(firstExisting || "__new__");
    setNewJobNewPath(null);
    setNewJobName("");
    setNewJobError(null);
    setNewJobOpened(true);
  };

  const handlePickNewJobLocation = async () => {
    const result = await window.sftpPushSync.pickNewConfigLocation();
    if (result?.ok) setNewJobNewPath(result.configPath);
  };

  const handleCreateJob = async () => {
    const targetPath = newJobTarget === "__new__" ? newJobNewPath : newJobTarget;
    if (!targetPath || !newJobName.trim()) {
      setNewJobError(t("newJob.missingFields"));
      return;
    }
    const result = await window.sftpPushSync.createConnection(targetPath, newJobName.trim());
    if (!result.ok) {
      setNewJobError(result.error || "unknown error");
      return;
    }
    setNewJobOpened(false);
    const updated = await reloadConnections();
    const created = updated?.find((c) => c.id === result.id);
    if (created) handleSelectConnection(created);
  };

  const handleSaveProperties = async () => {
    if (selectedProject && projectForm) {
      const result = await window.sftpPushSync.updateProjectSettings(selectedProject.configPath, {
        ...projectForm,
        resetProjectName: Boolean(projectForm.resetProjectName),
        include: textToList(projectForm.include),
        exclude: textToList(projectForm.exclude),
        textExtensions: textToList(projectForm.textExtensions),
        mediaExtensions: textToList(projectForm.mediaExtensions),
      });
      if (!result.ok) {
        setSaveError(result.error || "unknown error");
        return;
      }
      setSaveError(null);
      await reloadConnections();
      return;
    }

    if (!selected || !form) return;
    const updates = {
      ...form,
      sidecarUploadList: textToList(form.sidecarUploadList),
      sidecarDownloadList: textToList(form.sidecarDownloadList),
    };
    // `selected.name` ist die alte ID beim Speichern — bei Umbenennung
    // liefert der Handler die neue `id` zurück (der Name ist der JSON-Key).
    const result = await window.sftpPushSync.updateConnection(selected.configPath, selected.name, updates);
    if (!result.ok) {
      setSaveError(result.error || "unknown error");
      return;
    }

    setSaveError(null);
    const updatedConnections = await reloadConnections();
    const updated = updatedConnections?.find((c) => c.id === (result.id || selected.id));
    if (updated) {
      setSelected(updated);
      setForm(connectionToForm(updated));
    }
  };


  const handleStartJob = async (conn, flags = []) => {
    if (jobs[conn.id]?.status === "running") {
      focusTab(conn.id);
      return;
    }
    const result = await window.sftpPushSync.startJob(conn, flags, 80, 24);
    if (!result.ok) {
      setConflict({ connection: conn, ...result.conflict });
      return;
    }
    setConflict(null);
    setJobs((prev) => ({ ...prev, [conn.id]: {
      status: "running", connection: conn, startedAt: Date.now(), events: [], logs: [], phase: null, progress: null,
      plan: null, complete: null, mode: { dryRun: flags.includes("--dry-run") }, scanChannels: {}, scanWorkers: {}, scanWorkerCount: null, compareWorkers: [], taskWorkers: null,
    } }));
    focusTab(conn.id);
  };

  const handleStop = (id) => {
    window.sftpPushSync.abortJob(id);
    setJobs((previous) => {
      const job = previous[id];
      return job ? { ...previous, [id]: { ...job, status: "aborting" } } : previous;
    });
  };

  const handleTestConnection = async () => {
    if (!selected || !form) return;
    setConnectionTest({ status: "testing" });
    const result = await window.sftpPushSync.testConnection({ ...selected, ...form });
    setConnectionTest(result.ok
      ? { status: "success", remotePath: result.remotePath }
      : { status: "error", message: result.error });
  };

  // Play/Stop direkt in der Connection-Zeile — spart den Umweg über die
  // Properties, um einen Job zu starten (siehe DEBUG-LOG-GUI.md).
  const handleQuickStart = (conn, e) => {
    e.stopPropagation();
    handleSelectConnection(conn);
    const flags = getJobFlags(conn);
    if (flags) handleStartJob(conn, flags);
  };

  const handleQuickDryRun = (conn, e) => {
    e.stopPropagation();
    handleSelectConnection(conn);
    const flags = getJobFlags(conn, true);
    if (flags) handleStartJob(conn, flags);
  };

  const handleQuickStop = (id, e) => {
    e.stopPropagation();
    handleStop(id);
  };

  const handleCloseTab = (id) => {
    if (jobs[id]?.status === "running") {
      window.sftpPushSync.abortJob(id);
    }
    setJobs((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setActiveTab((current) => (current === id ? null : current));
  };

  const handleCloseHistoryTab = (id) => {
    setHistoryTabs((tabs) => tabs.filter((tab) => tab.id !== id));
    setActiveTab((current) => (current === id ? null : current));
  };

  const handleAddConfig = async () => {
    const result = await window.sftpPushSync.addConfigPath();
    if (result?.ok) reloadConnections();
  };

  const handleDrop = async (event) => {
    event.preventDefault();
    setDropError(null);
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;

    let addedAny = false;
    const failures = [];
    for (const file of files) {
      try {
        const filePath = window.sftpPushSync.getPathForFile(file);
        if (!filePath) {
          failures.push(`${file.name}: could not resolve a file system path (only files, not folders, can be dropped)`);
          continue;
        }
        const result = await window.sftpPushSync.addConfigPath(filePath);
        if (result?.ok) {
          addedAny = true;
        } else {
          failures.push(`${file.name}: ${result?.error || "unknown error"}`);
        }
      } catch (err) {
        failures.push(`${file.name}: ${err?.message || err}`);
      }
    }
    if (failures.length > 0) setDropError(failures.join("\n"));
    if (addedAny) reloadConnections();
  };

  const conflictMessage = (() => {
    if (!conflict) return null;
    if (conflict.type === "same-connection") return t("jobs.conflictSameConnection");
    const key = conflict.kind === "remoteRoot" ? "jobs.conflictOverlapRemote" : "jobs.conflictOverlapLocal";
    const label = conflict.withProject ? `${conflict.withProject} / ${conflict.withName}` : conflict.withName;
    return t(key, { name: label, path: conflict.path });
  })();

  const jobIds = Object.keys(jobs);
  const hasRunningJobs = Object.values(jobs).some((job) => job.status === "running");
  const hasOpenHistoryTab = historyTabs.some((tab) => tab.id === activeTab);
  const isPropertiesLocked = selected
    ? ["running", "aborting"].includes(jobs[selected.id]?.status)
    : selectedProject
      ? Object.values(jobs).some((job) => ["running", "aborting"].includes(job.status) && job.connection.configPath === selectedProject.configPath)
      : false;

  // Nach Projekt (Ordner der jeweiligen sync.config.json) gruppieren, damit
  // gleichnamige Connections aus verschiedenen Projekten unterscheidbar
  // bleiben, ohne sich auf das optionale `description`-Feld zu verlassen.
  const groups = connections.reduce((acc, conn) => {
    (acc[conn.configPath] ||= { name: conn.projectName, connections: [] }).connections.push(conn);
    return acc;
  }, {});

  // Optionen für den "Neuer Job"-Dialog: jede bereits registrierte
  // sync.config.json einmal, plus die Option, eine neue Datei anzulegen.
  const configPathOptions = [
    ...new Map(connections.map((c) => [c.configPath, c.projectName])),
  ].map(([configPath, projectName]) => ({ value: configPath, label: projectName }));
  configPathOptions.push({ value: "__new__", label: t("newJob.newFile") });

  return (
    <AppShell padding="md">
      <AppShell.Main>
        <Splitter h="calc(100dvh - 2rem)">
          <Splitter.Pane defaultSize="260px" min="190px" max="480px">
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              style={{ height: "100%", display: "flex", flexDirection: "column" }}
            >
              <Group
                justify="space-between"
                p="md"
                style={{ flexShrink: 0, borderBottom: "1px solid var(--mantine-color-default-border)" }}
              >
                <Text size="sm" fw={600}>
                  {t("sidebar.connectionsTitle")}
                </Text>
                <Group gap={4}>
                  <Tooltip label={t("toolbar.newJob")}>
                    <ActionIcon
                      variant="subtle"
                      size="sm"
                      aria-label={t("toolbar.newJob")}
                      onClick={handleOpenNewJob}
                    >
                      <IconPlus size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label={t("sidebar.addConfig")}>
                    <ActionIcon
                      variant="subtle"
                      size="sm"
                      aria-label={t("sidebar.addConfig")}
                      onClick={handleAddConfig}
                    >
                      <IconFolderPlus size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Group>
              <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "var(--mantine-spacing-md)" }}>
                {dropError && (
                  <Alert
                    icon={<IconAlertCircle size={16} />}
                    color="red"
                    mb="sm"
                    withCloseButton
                    onClose={() => setDropError(null)}
                  >
                    <Text size="xs" style={{ whiteSpace: "pre-wrap" }}>
                      {dropError}
                    </Text>
                  </Alert>
                )}
                {configErrors.map((err) => (
                  <Alert key={err.configPath} icon={<IconAlertCircle size={16} />} color="yellow" mb="sm">
                    {err.error}
                    <Text size="xs" c="dimmed">
                      {err.configPath}
                    </Text>
                  </Alert>
                ))}
                {connections.length === 0 && configErrors.length === 0 && (
                  <Text size="xs" c="dimmed" mb="sm">
                    {t("sidebar.dropHint")}
                  </Text>
                )}
                <Stack gap="md">
                  <Accordion
                    multiple
                    value={openGroups}
                    onChange={setOpenGroups}
                    chevronPosition="left"
                    variant="contained"
                  >
                    {Object.entries(groups).map(([configPath, group]) => (
                      <Accordion.Item key={configPath} value={configPath}>
                        <Group gap={0} wrap="nowrap">
                          <Accordion.Control
                            aria-label={t("sidebar.toggleGroup", { name: group.name })}
                            style={{ flex: "0 0 36px", width: 36, paddingInline: 8 }}
                          />
                          <UnstyledButton
                            onClick={() => handleSelectProject(configPath)}
                            style={{ flex: 1, minWidth: 0, padding: "var(--mantine-spacing-sm) var(--mantine-spacing-md)" }}
                          >
                            <Text size="sm" fw={500} lh={1.2} truncate>{group.name}</Text>
                          </UnstyledButton>
                        </Group>
                        <Accordion.Panel>
                          <Stack gap={4}>
                            {group.connections.map((conn) => (
                              <NavLink
                                key={conn.id}
                                label={conn.name}
                                description={conn.description || conn.host}
                                leftSection={<IconServer2 size={16} />}
                                active={selected?.id === conn.id}
                                rightSection={jobs[conn.id] ? (
                                  <Group gap={4} wrap="nowrap">
                                    <Tooltip label={t(`jobs.status.${jobs[conn.id].status}`)}>
                                      <span style={{ display: "inline-flex" }}>
                                        {STATUS_ICON[jobs[conn.id].status]}
                                      </span>
                                    </Tooltip>
                                    {["running", "aborting"].includes(jobs[conn.id].status) ? (
                                    <Tooltip label={t("jobs.stop")}>
                                      <ActionIcon
                                        size="sm"
                                        color="red"
                                        variant="light"
                                        loading={jobs[conn.id].status === "aborting"}
                                        disabled={jobs[conn.id].status === "aborting"}
                                        onClick={(e) => handleQuickStop(conn.id, e)}
                                      >
                                        <IconPlayerStop size={14} />
                                      </ActionIcon>
                                    </Tooltip>
                                    ) : (
                                      <>
                                        <Tooltip label={t("jobs.dryRun")}>
                                          <ActionIcon size="sm" color="orange" variant="light" onClick={(e) => handleQuickDryRun(conn, e)}>
                                            <IconFlask size={14} />
                                          </ActionIcon>
                                        </Tooltip>
                                        <Tooltip label={t("jobs.start")}>
                                          <ActionIcon size="sm" color="green" variant="light" onClick={(e) => handleQuickStart(conn, e)}>
                                            <IconPlayerPlay size={14} />
                                          </ActionIcon>
                                        </Tooltip>
                                      </>
                                    )}
                                  </Group>
                                ) : (
                                    <Group gap={4} wrap="nowrap">
                                      <Tooltip label={t("jobs.dryRun")}>
                                        <ActionIcon size="sm" color="orange" variant="light" onClick={(e) => handleQuickDryRun(conn, e)}>
                                          <IconFlask size={14} />
                                        </ActionIcon>
                                      </Tooltip>
                                      <Tooltip label={t("jobs.start")}>
                                        <ActionIcon size="sm" color="green" variant="light" onClick={(e) => handleQuickStart(conn, e)}>
                                          <IconPlayerPlay size={14} />
                                        </ActionIcon>
                                      </Tooltip>
                                    </Group>
                                  )
                                }
                                onClick={() => handleSelectConnection(conn)}
                              />
                            ))}
                          </Stack>
                        </Accordion.Panel>
                      </Accordion.Item>
                    ))}
                  </Accordion>
                </Stack>
              </div>
              <Group
                justify="space-between"
                p="md"
                style={{ flexShrink: 0, borderTop: "1px solid var(--mantine-color-default-border)" }}
              >
                <Text size="xs" fw={600}>
                  CatoPushSync{appInfo?.version ? ` v${appInfo.version}` : ""}
                </Text>
                <Group gap={4}>
                  {["available", "downloading", "downloaded"].includes(updateState.status) && (
                    <Tooltip label={t("toolbar.updateAvailable")}>
                      <ActionIcon
                        variant="filled"
                        color="yellow"
                        size="sm"
                        aria-label={t("toolbar.updateAvailable")}
                        onClick={() => openSettings("updates")}
                      >
                        <IconDownload size={16} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                  <Tooltip label={t("toolbar.settings")}>
                    <ActionIcon
                      variant="subtle"
                      size="sm"
                      aria-label={t("toolbar.settings")}
                      onClick={() => openSettings("general")}
                    >
                      <IconSettings size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label={t("toolbar.about")}>
                    <ActionIcon
                      variant="subtle"
                      size="sm"
                      aria-label={t("toolbar.about")}
                      onClick={() => setAboutOpened(true)}
                    >
                      <IconInfoCircle size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label={t("toolbar.manual")}>
                    <ActionIcon
                      variant="subtle"
                      size="sm"
                      aria-label={t("toolbar.manual")}
                      onClick={() => setManualOpened(true)}
                    >
                      <IconBook size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Group>
            </div>
          </Splitter.Pane>

          <Splitter.Pane defaultSize={100} min="20%">
            <div
              style={{
                height: "100%",
                padding: "var(--mantine-spacing-md)",
                display: "flex",
                flexDirection: "column",
              }}
            >
              {conflict && (
                <Alert
                  icon={<IconAlertCircle size={16} />}
                  color="red"
                  mb="sm"
                  withCloseButton
                  onClose={() => setConflict(null)}
                >
                  {conflictMessage}
                </Alert>
              )}
              {!hasRunningJobs && !hasOpenHistoryTab && selected && selectedHistory ? (
                <StructuredJobView job={historyToJob(selectedHistory)} t={t} historyView />
              ) : !hasRunningJobs && !hasOpenHistoryTab && selectedProject && projectHistory.length > 0 ? (
                <GroupHistoryView history={projectHistory} groupName={projectForm?.projectName} t={t} onOpenEntry={openHistoryEntry} />
              ) : jobIds.length === 0 && !hasOpenHistoryTab ? (
                <Stack align="center" justify="center" gap="xs" style={{ flex: 1, minHeight: 0 }}>
                  <IconTerminal2 size={32} color="var(--mantine-color-dimmed)" />
                  <Text c="dimmed" ta="center">
                    {t("tabs.empty")}
                  </Text>
                </Stack>
              ) : (
                <Tabs
                  value={activeTab}
                  onChange={focusTab}
                  keepMounted
                  style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
                >
                  <Tabs.List>
                    {jobIds.map((id) => (
                      <Tabs.Tab
                        key={id}
                        value={id}
                        leftSection={
                          <Tooltip label={t(`jobs.status.${jobs[id].status}`)}>
                            <span style={{ display: "inline-flex" }}>{STATUS_ICON[jobs[id].status]}</span>
                          </Tooltip>
                        }
                        rightSection={
                          <Tooltip label={t("jobs.close")}>
                            <ActionIcon
                              component="span"
                              variant="subtle"
                              size="sm"
                              role="button"
                              tabIndex={0}
                              aria-label={t("jobs.close")}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleCloseTab(id);
                              }}
                            >
                              <IconX size={14} />
                            </ActionIcon>
                          </Tooltip>
                        }
                      >
                        {jobs[id].connection.projectName} | {jobs[id].connection.name}
                      </Tabs.Tab>
                    ))}
                    {historyTabs.map((tab) => (
                      <Tabs.Tab
                        key={tab.id}
                        value={tab.id}
                        rightSection={
                          <Tooltip label={t("jobs.close")}>
                            <ActionIcon component="span" variant="subtle" size="sm" role="button" tabIndex={0} aria-label={t("jobs.close")} onClick={(event) => { event.stopPropagation(); handleCloseHistoryTab(tab.id); }}>
                              <IconX size={14} />
                            </ActionIcon>
                          </Tooltip>
                        }
                      >
                        {tab.type === "connection" ? `${t("jobView.lastRun")} | ${tab.title}` : `${t("properties.group")} | ${tab.title}`}
                      </Tabs.Tab>
                    ))}
                  </Tabs.List>
                  {jobIds.map((id) => (
                    <Tabs.Panel
                      key={id}
                      value={id}
                      pt="sm"
                      style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column" }}
                    >
                      <StructuredJobView job={jobs[id]} t={t} lastHistory={selected?.id === id ? selectedHistory : null} />
                    </Tabs.Panel>
                  ))}
                  {historyTabs.map((tab) => (
                    <Tabs.Panel key={tab.id} value={tab.id} pt="sm" style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column" }}>
                      {tab.type === "connection" ? <StructuredJobView job={historyToJob(tab.history)} t={t} historyView /> : <GroupHistoryView history={tab.history} groupName={tab.title} t={t} onOpenEntry={openHistoryEntry} />}
                    </Tabs.Panel>
                  ))}
                </Tabs>
              )}
            </div>
          </Splitter.Pane>

          <Splitter.Pane defaultSize="300px" min="240px" max="560px">
            <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
              <Group
                justify="space-between"
                p="md"
                style={{ flexShrink: 0, borderBottom: "1px solid var(--mantine-color-default-border)" }}
              >
                <Text size="sm" fw={600}>
                  {t("properties.title")} | {selectedProject ? t("properties.group") : t("properties.job")}
                </Text>
                {((selected && form) || (selectedProject && projectForm)) && (
                  <Tooltip label={t("properties.save")}>
                    <ActionIcon
                      variant="subtle"
                      size="sm"
                      aria-label={t("properties.save")}
                      disabled={isPropertiesLocked}
                      onClick={handleSaveProperties}
                    >
                      <IconDeviceFloppy size={16} />
                    </ActionIcon>
                  </Tooltip>
                )}
              </Group>
              <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "var(--mantine-spacing-md)" }}>
              {selectedProject && projectForm ? (
                <Stack gap="xs" pb="md">
                  <TextInput
                    size="sm"
                    styles={{ input: { fontWeight: 500 } }}
                    value={projectForm.projectName}
                    disabled={isPropertiesLocked}
                    onChange={(event) => handleProjectFieldChange("projectName", event.currentTarget.value)}
                    rightSection={
                      <Tooltip label={t("properties.resetProjectName")}>
                        <ActionIcon
                          size="sm"
                          variant="subtle"
                          aria-label={t("properties.resetProjectName")}
                          disabled={isPropertiesLocked || projectForm.projectName === getDefaultProjectName(selectedProject.configPath)}
                          onClick={handleResetProjectName}
                        >
                          <IconRestore size={16} />
                        </ActionIcon>
                      </Tooltip>
                    }
                  />
                  <Group justify="space-between" gap="xs" wrap="nowrap">
                    <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>{selectedProject.configPath}</Text>
                    <Tooltip label={t("properties.revealInFolder")}><ActionIcon size="sm" variant="subtle" aria-label={t("properties.revealInFolder")} onClick={() => handleRevealInFolder(selectedProject.configPath)}><IconFolderOpen size={16} /></ActionIcon></Tooltip>
                  </Group>
                  {isPropertiesLocked && <Alert color="blue" py={4}><Text size="xs">{t("properties.projectLockedWhileRunning")}</Text></Alert>}
                  {saveError && <Alert color="red" py={4} withCloseButton onClose={() => setSaveError(null)}><Text size="xs">{saveError}</Text></Alert>}
                  <Accordion multiple defaultValue={["settings"]} chevronPosition="left" variant="contained">
                    <Accordion.Item value="settings">
                      <Accordion.Control>{t("properties.projectSettings")}</Accordion.Control>
                      <Accordion.Panel>
                        <Stack gap="xs">
                          <Switch size="sm" label={t("properties.parallelScan")} checked={projectForm.parallelScan} disabled={isPropertiesLocked} onChange={(event) => handleProjectFieldChange("parallelScan", event.currentTarget.checked)} />
                          <Switch size="sm" label={t("properties.cleanupEmptyDirs")} checked={projectForm.cleanupEmptyDirs} disabled={isPropertiesLocked} onChange={(event) => handleProjectFieldChange("cleanupEmptyDirs", event.currentTarget.checked)} />
                          <Textarea size="xs" label={t("properties.include")} autosize minRows={1} value={projectForm.include} disabled={isPropertiesLocked} onChange={(event) => handleProjectFieldChange("include", event.currentTarget.value)} />
                          <Textarea size="xs" label={t("properties.exclude")} autosize minRows={1} value={projectForm.exclude} disabled={isPropertiesLocked} onChange={(event) => handleProjectFieldChange("exclude", event.currentTarget.value)} />
                          <Textarea size="xs" label={t("properties.textExtensions")} autosize minRows={1} value={projectForm.textExtensions} disabled={isPropertiesLocked} onChange={(event) => handleProjectFieldChange("textExtensions", event.currentTarget.value)} />
                          <Textarea size="xs" label={t("properties.mediaExtensions")} autosize minRows={1} value={projectForm.mediaExtensions} disabled={isPropertiesLocked} onChange={(event) => handleProjectFieldChange("mediaExtensions", event.currentTarget.value)} />
                          <NumberInput size="xs" label={t("properties.scanChunk")} min={1} value={projectForm.scanChunk} disabled={isPropertiesLocked} onChange={(value) => handleProjectFieldChange("scanChunk", value)} />
                          <NumberInput size="xs" label={t("properties.analyzeChunk")} min={1} value={projectForm.analyzeChunk} disabled={isPropertiesLocked} onChange={(value) => handleProjectFieldChange("analyzeChunk", value)} />
                          <Select size="xs" label={t("properties.logLevel")} data={["normal", "verbose", "laconic"]} value={projectForm.logLevel} disabled={isPropertiesLocked} onChange={(value) => handleProjectFieldChange("logLevel", value || "normal")} />
                          <Switch size="sm" label={t("properties.logTimestamps")} checked={projectForm.logTimestamps} disabled={isPropertiesLocked} onChange={(event) => handleProjectFieldChange("logTimestamps", event.currentTarget.checked)} />
                          <TextInput size="xs" label={t("properties.logFile")} value={projectForm.logFile} disabled={isPropertiesLocked} onChange={(event) => handleProjectFieldChange("logFile", event.currentTarget.value)} />
                        </Stack>
                      </Accordion.Panel>
                    </Accordion.Item>
                  </Accordion>
                </Stack>
              ) : selected && form ? (
                <Stack gap="xs" pb="md">
                  <TextInput
                    size="sm"
                    styles={{ input: { fontWeight: 500 } }}
                    value={form.name}
                    disabled={isPropertiesLocked}
                    onChange={(e) => handleFieldChange("name", e.currentTarget.value)}
                  />
                  <Group justify="space-between" gap="xs" wrap="nowrap">
                    <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
                      {selected.projectName} — {selected.configPath}
                    </Text>
                    <Tooltip label={t("properties.revealInFolder")}>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        aria-label={t("properties.revealInFolder")}
                        onClick={() => handleRevealInFolder(selected.configPath)}
                      >
                        <IconFolderOpen size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>

                  {isPropertiesLocked && (
                    <Alert color="blue" py={4}>
                      <Text size="xs">{t("properties.lockedWhileRunning")}</Text>
                    </Alert>
                  )}
                  {saveError && (
                    <Alert color="red" py={4} withCloseButton onClose={() => setSaveError(null)}>
                      <Text size="xs">{saveError}</Text>
                    </Alert>
                  )}

                  <Accordion
                    multiple
                    value={openPropertyGroups}
                    onChange={setOpenPropertyGroups}
                    chevronPosition="left"
                    variant="contained"
                  >
                    {false && projectForm && (
                      <Accordion.Item value="project">
                        <Accordion.Control>{t("properties.groupProject")}</Accordion.Control>
                        <Accordion.Panel>
                          <Stack gap="xs">
                            <Switch
                              size="sm"
                              label={t("properties.parallelScan")}
                              checked={projectForm.parallelScan}
                              disabled={isPropertiesLocked}
                              onChange={(event) => handleProjectFieldChange("parallelScan", event.currentTarget.checked)}
                            />
                            <Switch
                              size="sm"
                              label={t("properties.cleanupEmptyDirs")}
                              checked={projectForm.cleanupEmptyDirs}
                              disabled={isPropertiesLocked}
                              onChange={(event) => handleProjectFieldChange("cleanupEmptyDirs", event.currentTarget.checked)}
                            />
                            <Textarea size="xs" label={t("properties.include")} autosize minRows={1} value={projectForm.include} disabled={isPropertiesLocked} onChange={(event) => handleProjectFieldChange("include", event.currentTarget.value)} />
                            <Textarea size="xs" label={t("properties.exclude")} autosize minRows={1} value={projectForm.exclude} disabled={isPropertiesLocked} onChange={(event) => handleProjectFieldChange("exclude", event.currentTarget.value)} />
                            <Textarea size="xs" label={t("properties.textExtensions")} autosize minRows={1} value={projectForm.textExtensions} disabled={isPropertiesLocked} onChange={(event) => handleProjectFieldChange("textExtensions", event.currentTarget.value)} />
                            <Textarea size="xs" label={t("properties.mediaExtensions")} autosize minRows={1} value={projectForm.mediaExtensions} disabled={isPropertiesLocked} onChange={(event) => handleProjectFieldChange("mediaExtensions", event.currentTarget.value)} />
                            <NumberInput size="xs" label={t("properties.scanChunk")} min={1} value={projectForm.scanChunk} disabled={isPropertiesLocked} onChange={(value) => handleProjectFieldChange("scanChunk", value)} />
                            <NumberInput size="xs" label={t("properties.analyzeChunk")} min={1} value={projectForm.analyzeChunk} disabled={isPropertiesLocked} onChange={(value) => handleProjectFieldChange("analyzeChunk", value)} />
                            <Select size="xs" label={t("properties.logLevel")} data={["normal", "verbose", "laconic"]} value={projectForm.logLevel} disabled={isPropertiesLocked} onChange={(value) => handleProjectFieldChange("logLevel", value || "normal")} />
                            <Switch size="sm" label={t("properties.logTimestamps")} checked={projectForm.logTimestamps} disabled={isPropertiesLocked} onChange={(event) => handleProjectFieldChange("logTimestamps", event.currentTarget.checked)} />
                            <TextInput size="xs" label={t("properties.logFile")} value={projectForm.logFile} disabled={isPropertiesLocked} onChange={(event) => handleProjectFieldChange("logFile", event.currentTarget.value)} />
                          </Stack>
                        </Accordion.Panel>
                      </Accordion.Item>
                    )}
                    <Accordion.Item value="connection" style={{ position: "relative" }}>
                      <Accordion.Control style={{ paddingRight: 48 }}>
                        {t("properties.groupConnection")}
                      </Accordion.Control>
                      <Tooltip label={t("properties.testConnection")}>
                        <ActionIcon
                          size="sm"
                          variant="subtle"
                          aria-label={t("properties.testConnection")}
                          disabled={isPropertiesLocked || connectionTest.status === "testing"}
                          onClick={(event) => { event.stopPropagation(); handleTestConnection(); }}
                          style={{ position: "absolute", top: 7, right: 8, zIndex: 1 }}
                        >
                          {connectionTest.status === "testing" ? <Loader size={15} /> : <IconPlugConnected size={16} />}
                        </ActionIcon>
                      </Tooltip>
                      <Accordion.Panel>
                        <Stack gap="xs">
                          {connectionTest.status === "success" && <Alert color="green" py={4}><Text size="xs">{t("properties.testConnectionSuccess", { path: connectionTest.remotePath })}</Text></Alert>}
                          {connectionTest.status === "error" && <Alert color="red" py={4} withCloseButton onClose={() => setConnectionTest({ status: "idle" })}><Text size="xs">{connectionTest.message}</Text></Alert>}
                          <TextInput
                            size="xs"
                            label={t("properties.description")}
                            value={form.description}
                            disabled={isPropertiesLocked}
                            onChange={(e) => handleFieldChange("description", e.currentTarget.value)}
                          />
                          <TextInput
                            size="xs"
                            label={t("properties.host")}
                            value={form.host}
                            disabled={isPropertiesLocked}
                            onChange={(e) => handleFieldChange("host", e.currentTarget.value)}
                          />
                          <NumberInput
                            size="xs"
                            label={t("properties.port")}
                            value={form.port}
                            disabled={isPropertiesLocked}
                            onChange={(value) => handleFieldChange("port", value)}
                          />
                          <TextInput
                            size="xs"
                            label={t("properties.user")}
                            value={form.user}
                            disabled={isPropertiesLocked}
                            onChange={(e) => handleFieldChange("user", e.currentTarget.value)}
                          />
                          <PasswordInput
                            size="xs"
                            label={t("properties.password")}
                            value={form.password}
                            disabled={isPropertiesLocked}
                            onChange={(e) => handleFieldChange("password", e.currentTarget.value)}
                          />
                          <NumberInput
                            size="xs"
                            label={t("properties.workerUpload")}
                            value={form.workerUpload}
                            disabled={isPropertiesLocked}
                            onChange={(value) => handleFieldChange("workerUpload", value)}
                          />
                          <NumberInput
                            size="xs"
                            label={t("properties.workerList")}
                            value={form.workerList}
                            disabled={isPropertiesLocked}
                            onChange={(value) => handleFieldChange("workerList", value)}
                          />
                        </Stack>
                      </Accordion.Panel>
                    </Accordion.Item>

                    <Accordion.Item value="sync">
                      <Accordion.Control>{t("properties.groupSync")}</Accordion.Control>
                      <Accordion.Panel>
                        <Stack gap="xs">
                          <TextInput
                            size="xs"
                            label={t("properties.localRoot")}
                            value={form.localRoot}
                            disabled={isPropertiesLocked}
                            onChange={(e) => handleFieldChange("localRoot", e.currentTarget.value)}
                          />
                          <TextInput
                            size="xs"
                            label={t("properties.remoteRoot")}
                            value={form.remoteRoot}
                            disabled={isPropertiesLocked}
                            onChange={(e) => handleFieldChange("remoteRoot", e.currentTarget.value)}
                          />
                        </Stack>
                      </Accordion.Panel>
                    </Accordion.Item>

                    <Accordion.Item value="sidecar">
                      <Accordion.Control>{t("properties.groupSidecar")}</Accordion.Control>
                      <Accordion.Panel>
                        <Stack gap="xs">
                          <Switch
                            size="sm"
                            label={t("properties.dryRun")}
                            checked={Boolean(runOptions[selected.id]?.dryRun)}
                            disabled={isPropertiesLocked}
                            onChange={(event) => handleRunOptionChange(selected.id, "dryRun", event.currentTarget.checked)}
                          />
                          <Switch
                            size="sm"
                            label={t("properties.sidecarUpload")}
                            checked={Boolean(runOptions[selected.id]?.sidecarUpload)}
                            disabled={isPropertiesLocked}
                            onChange={(event) => handleRunOptionChange(selected.id, "sidecarUpload", event.currentTarget.checked)}
                          />
                          <Switch
                            size="sm"
                            label={t("properties.sidecarDownload")}
                            checked={Boolean(runOptions[selected.id]?.sidecarDownload)}
                            disabled={isPropertiesLocked}
                            onChange={(event) => handleRunOptionChange(selected.id, "sidecarDownload", event.currentTarget.checked)}
                          />
                          <Switch
                            size="sm"
                            label={t("properties.skipSync")}
                            checked={Boolean(runOptions[selected.id]?.skipSync)}
                            disabled={isPropertiesLocked}
                            onChange={(event) => handleRunOptionChange(selected.id, "skipSync", event.currentTarget.checked)}
                          />
                          <TextInput
                            size="xs"
                            label={t("properties.sidecarLocalRoot")}
                            value={form.sidecarLocalRoot}
                            disabled={isPropertiesLocked}
                            onChange={(e) => handleFieldChange("sidecarLocalRoot", e.currentTarget.value)}
                          />
                          <TextInput
                            size="xs"
                            label={t("properties.sidecarRemoteRoot")}
                            value={form.sidecarRemoteRoot}
                            disabled={isPropertiesLocked}
                            onChange={(e) => handleFieldChange("sidecarRemoteRoot", e.currentTarget.value)}
                          />
                          <Textarea
                            size="xs"
                            label={t("properties.sidecarUploadList")}
                            description={t("properties.commaSeparated")}
                            autosize
                            minRows={1}
                            value={form.sidecarUploadList}
                            disabled={isPropertiesLocked}
                            onChange={(e) => handleFieldChange("sidecarUploadList", e.currentTarget.value)}
                  />
                  <Textarea
                    size="xs"
                    label={t("properties.sidecarDownloadList")}
                    description={t("properties.commaSeparated")}
                    autosize
                    minRows={1}
                    value={form.sidecarDownloadList}
                    disabled={isPropertiesLocked}
                    onChange={(e) => handleFieldChange("sidecarDownloadList", e.currentTarget.value)}
                  />
                        </Stack>
                      </Accordion.Panel>
                    </Accordion.Item>

                    <Accordion.Item value="jobFiles">
                      <Accordion.Control>{t("properties.groupJobFiles")}</Accordion.Control>
                      <Accordion.Panel>
                        <Stack gap="sm">
                          <Stack gap={2}>
                            <Text size="xs" fw={500}>{t("properties.logFile")}</Text>
                            <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>{jobFiles?.log?.path || "-"}</Text>
                            <Group gap={4}>
                              <Tooltip label={t("properties.showFile")}><ActionIcon size="sm" variant="light" disabled={!jobFiles?.log?.exists} onClick={() => window.sftpPushSync.showJobFile(jobFiles.log.path)}><IconFolderOpen size={15} /></ActionIcon></Tooltip>
                              <Tooltip label={t("properties.openLogFile")}><ActionIcon size="sm" variant="light" disabled={!jobFiles?.log?.exists} onClick={() => window.sftpPushSync.openJobFile(jobFiles.log.path)}><IconFileText size={15} /></ActionIcon></Tooltip>
                              <Text size="xs" c="dimmed">{formatFileInfo(jobFiles?.log)}</Text>
                            </Group>
                          </Stack>
                          <Stack gap={2}>
                            <Text size="xs" fw={500}>{t("properties.cacheFile")}</Text>
                            <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>{jobFiles?.cache?.path || "-"}</Text>
                            <Group gap={4}>
                              <Tooltip label={t("properties.showFile")}><ActionIcon size="sm" variant="light" disabled={!jobFiles?.cache?.exists} onClick={() => window.sftpPushSync.showJobFile(jobFiles.cache.path)}><IconFolderOpen size={15} /></ActionIcon></Tooltip>
                              <Tooltip label={t("properties.deleteCache")}><ActionIcon size="sm" color="red" variant="light" disabled={!jobFiles?.cache?.exists || isPropertiesLocked} onClick={handleDeleteCache}><IconTrash size={15} /></ActionIcon></Tooltip>
                              <Text size="xs" c="dimmed">{formatFileInfo(jobFiles?.cache)}</Text>
                            </Group>
                          </Stack>
                        </Stack>
                      </Accordion.Panel>
                    </Accordion.Item>
                  </Accordion>
                </Stack>
              ) : (
                <Text c="dimmed" size="sm">
                  {t("properties.empty")}
                </Text>
              )}
              </div>
            </div>
          </Splitter.Pane>
        </Splitter>
      </AppShell.Main>

      <SettingsWindow
        opened={settingsOpened}
        onClose={() => setSettingsOpened(false)}
        initialTab={settingsTab}
        appInfo={appInfo}
        updateState={updateState}
        historySettings={historySettings}
        onHistoryLimitChange={async (limit) => setHistorySettings(await window.sftpPushSync.updateHistoryLimit(limit))}
        onClearHistory={async () => setHistorySettings(await window.sftpPushSync.clearHistoryExceptLatest())}
        onUpdate={{
          check: () => window.sftpPushSync.checkForUpdates(),
          download: () => window.sftpPushSync.startUpdateDownload(),
          install: () => window.sftpPushSync.quitAndInstall(),
        }}
      />
      <AboutModal opened={aboutOpened} onClose={() => setAboutOpened(false)} appInfo={appInfo} />
      <ManualWindow opened={manualOpened} onClose={() => setManualOpened(false)} />

      <Modal opened={newJobOpened} onClose={() => setNewJobOpened(false)} title={t("newJob.title")}>
        <Stack gap="sm">
          <Select
            label={t("newJob.target")}
            data={configPathOptions}
            value={newJobTarget}
            onChange={setNewJobTarget}
          />
          {newJobTarget === "__new__" && (
            <Group gap="xs">
              <Button size="xs" variant="light" onClick={handlePickNewJobLocation}>
                {t("newJob.chooseLocation")}
              </Button>
              <Text size="xs" c="dimmed">
                {newJobNewPath || t("newJob.noLocationChosen")}
              </Text>
            </Group>
          )}
          <TextInput
            label={t("newJob.name")}
            value={newJobName}
            onChange={(e) => setNewJobName(e.currentTarget.value)}
          />
          {newJobError && (
            <Alert color="red" py={4}>
              <Text size="xs">{newJobError}</Text>
            </Alert>
          )}
          <Button onClick={handleCreateJob}>{t("newJob.create")}</Button>
        </Stack>
      </Modal>
    </AppShell>
  );
}


