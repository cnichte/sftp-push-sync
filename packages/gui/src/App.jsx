// packages/gui/src/App.jsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
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
} from "@tabler/icons-react";
import SettingsWindow from "./SettingsWindow.jsx";
import AboutModal from "./AboutModal.jsx";

const STATUS_ICON = {
  running: <Loader size={14} />,
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
    description: conn.description || "",
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

// Leichtgewichtiger Ersatz für Mantine's `Splitter` (der benötigt v9 + React 19
// als Peer-Dependency — zu großer/riskanter Sprung für eine Komponente).
// Liefert eine per Maus ziehbare Breite plus den Drag-Start-Handler.
export default function App() {
  const { t } = useTranslation();
  const [connections, setConnections] = useState([]);
  const [configErrors, setConfigErrors] = useState([]);
  const [selected, setSelected] = useState(null);
  const [jobs, setJobs] = useState({}); // connection.id -> { status, logs: string[], connection }
  const [activeTab, setActiveTab] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [dropError, setDropError] = useState(null);
  const [form, setForm] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const terminalsRef = useRef({}); // connection.id -> { term, fitAddon, resizeObserver }
  const pendingChunksRef = useRef({}); // connection.id -> string[] (data arriving before the terminal is mounted)
  const [openGroups, setOpenGroups] = useState([]);
  const [openPropertyGroups, setOpenPropertyGroups] = useState(["connection", "sync", "sidecar"]);
  const [appInfo, setAppInfo] = useState(null);
  const [settingsOpened, setSettingsOpened] = useState(false);
  const [settingsTab, setSettingsTab] = useState("general");
  const [aboutOpened, setAboutOpened] = useState(false);
  const [updateState, setUpdateState] = useState({ status: "idle" });
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
        const names = [...new Set(result.connections.map((c) => c.projectName))];
        const missing = names.filter((n) => !prev.includes(n));
        return missing.length ? [...prev, ...missing] : prev;
      });
      return result.connections;
    });
  }, []);

  useEffect(() => {
    reloadConnections();
  }, [reloadConnections]);

  useEffect(() => {
    const offData = window.sftpPushSync?.onJobData(({ connectionId, chunk }) => {
      const entry = terminalsRef.current[connectionId];
      if (entry) {
        entry.term.write(chunk);
      } else {
        (pendingChunksRef.current[connectionId] ||= []).push(chunk);
      }
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
      offExit?.();
    };
  }, []);

  // Erzeugt beim ersten Mount des Tab-Panels ein xterm.js-Terminal, das die
  // rohe PTY-Ausgabe (inkl. ANSI/Fortschrittsbalken) 1:1 wie im echten
  // Terminal rendert (siehe DEBUG-LOG-GUI.md: "Terminal zeigt nicht das
  // Gleiche wie CLI" — Ursache war die fehlende TTY, nicht das GUI-Terminal).
  // Ein ResizeObserver auf dem Container-Div passt Terminal + PTY bei JEDER
  // Größenänderung an (Fenster-Resize, Splitter-Drag, Tab-Wechsel von
  // verstecktem zu sichtbarem Panel) — ein einziger, robuster Mechanismus
  // statt mehrerer einzeln verdrahteter Trigger.
  const attachTerminal = useCallback(
    (id) => (el) => {
      if (!el || terminalsRef.current[id]) return;
      const term = new Terminal({ convertEol: true, fontSize: 12, theme: { background: "#1a1b1e" } });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(el);
      fitAddon.fit();

      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        window.sftpPushSync.resizeJob(id, term.cols, term.rows);
      });
      resizeObserver.observe(el);

      terminalsRef.current[id] = { term, fitAddon, resizeObserver };

      const pending = pendingChunksRef.current[id];
      if (pending) {
        pending.forEach((chunk) => term.write(chunk));
        delete pendingChunksRef.current[id];
      }
      window.sftpPushSync.resizeJob(id, term.cols, term.rows);
    },
    []
  );

  const focusTab = (id) => {
    setActiveTab(id);
  };

  const handleSelectConnection = (conn) => {
    setSelected(conn);
    setForm(connectionToForm(conn));
    setSaveError(null);
    if (jobs[conn.id]) {
      focusTab(conn.id);
    }
  };

  const handleFieldChange = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleRevealInFolder = (configPath) => {
    window.sftpPushSync.revealInFolder(configPath);
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


  const handleStartJob = async (conn) => {
    if (jobs[conn.id]?.status === "running") {
      focusTab(conn.id);
      return;
    }
    const result = await window.sftpPushSync.startJob(conn, [], 80, 24);
    if (!result.ok) {
      setConflict({ connection: conn, ...result.conflict });
      return;
    }
    setConflict(null);
    terminalsRef.current[conn.id]?.term.reset();
    delete pendingChunksRef.current[conn.id];
    setJobs((prev) => ({ ...prev, [conn.id]: { status: "running", connection: conn } }));
    focusTab(conn.id);
  };

  const handleStop = (id) => {
    window.sftpPushSync.abortJob(id);
  };

  // Play/Stop direkt in der Connection-Zeile — spart den Umweg über die
  // Properties, um einen Job zu starten (siehe DEBUG-LOG-GUI.md).
  const handleQuickStart = (conn, e) => {
    e.stopPropagation();
    handleSelectConnection(conn);
    handleStartJob(conn);
  };

  const handleQuickStop = (id, e) => {
    e.stopPropagation();
    handleStop(id);
  };

  const handleCloseTab = (id) => {
    if (jobs[id]?.status === "running") {
      window.sftpPushSync.abortJob(id);
    }
    terminalsRef.current[id]?.resizeObserver.disconnect();
    terminalsRef.current[id]?.term.dispose();
    delete terminalsRef.current[id];
    delete pendingChunksRef.current[id];
    setJobs((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
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
  const isPropertiesLocked = selected ? jobs[selected.id]?.status === "running" : false;

  // Nach Projekt (Ordner der jeweiligen sync.config.json) gruppieren, damit
  // gleichnamige Connections aus verschiedenen Projekten unterscheidbar
  // bleiben, ohne sich auf das optionale `description`-Feld zu verlassen.
  const groups = connections.reduce((acc, conn) => {
    (acc[conn.projectName] ||= []).push(conn);
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
                    {Object.entries(groups).map(([projectName, conns]) => (
                      <Accordion.Item key={projectName} value={projectName}>
                        <Accordion.Control>{projectName}</Accordion.Control>
                        <Accordion.Panel>
                          <Stack gap={4}>
                            {conns.map((conn) => (
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
                                    {jobs[conn.id].status === "running" ? (
                                    <Tooltip label={t("jobs.stop")}>
                                      <ActionIcon
                                        size="sm"
                                        color="red"
                                        variant="light"
                                        onClick={(e) => handleQuickStop(conn.id, e)}
                                      >
                                        <IconPlayerStop size={14} />
                                      </ActionIcon>
                                    </Tooltip>
                                    ) : (
                                      <Tooltip label={t("jobs.start")}>
                                        <ActionIcon
                                          size="sm"
                                          color="green"
                                          variant="light"
                                          onClick={(e) => handleQuickStart(conn, e)}
                                        >
                                          <IconPlayerPlay size={14} />
                                        </ActionIcon>
                                      </Tooltip>
                                    )}
                                  </Group>
                                ) : (
                                    <Tooltip label={t("jobs.start")}>
                                      <ActionIcon
                                        size="sm"
                                        color="green"
                                        variant="light"
                                        onClick={(e) => handleQuickStart(conn, e)}
                                      >
                                        <IconPlayerPlay size={14} />
                                      </ActionIcon>
                                    </Tooltip>
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
                  VeloSync{appInfo?.version ? ` v${appInfo.version}` : ""}
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
              {jobIds.length === 0 ? (
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
                  </Tabs.List>
                  {jobIds.map((id) => (
                    <Tabs.Panel
                      key={id}
                      value={id}
                      pt="sm"
                      style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column" }}
                    >
                      <div
                        ref={attachTerminal(id)}
                        style={{ flex: "1 1 0", minHeight: 0, background: "#1a1b1e", padding: 4 }}
                      />
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
                  {t("properties.title")}
                </Text>
                {selected && form && (
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
              {selected && form ? (
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
                    <Accordion.Item value="connection">
                      <Accordion.Control>{t("properties.groupConnection")}</Accordion.Control>
                      <Accordion.Panel>
                        <Stack gap="xs">
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
        onUpdate={{
          check: () => window.sftpPushSync.checkForUpdates(),
          download: () => window.sftpPushSync.startUpdateDownload(),
          install: () => window.sftpPushSync.quitAndInstall(),
        }}
      />
      <AboutModal opened={aboutOpened} onClose={() => setAboutOpened(false)} appInfo={appInfo} />

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


