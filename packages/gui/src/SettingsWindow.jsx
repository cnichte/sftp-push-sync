// packages/gui/src/SettingsWindow.jsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Window } from "@gfazioli/mantine-window";
import {
  Tabs,
  Stack,
  Text,
  Button,
  Progress,
  Badge,
  Group,
  Select,
} from "@mantine/core";
import { IconSettings, IconDownload, IconWorld } from "@tabler/icons-react";
import i18n from "./i18n.js";

const STATUS_COLOR = {
  idle: "gray",
  checking: "blue",
  available: "yellow",
  downloading: "blue",
  downloaded: "green",
  error: "red",
  "not-available": "gray",
};

export default function SettingsWindow({ opened, onClose, initialTab, appInfo, updateState, onUpdate }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState(initialTab || "general");

  useEffect(() => {
    if (opened) setTab(initialTab || "general");
  }, [opened, initialTab]);

  if (!opened) return null;

  return (
    <Window
      title={t("settings.title")}
      opened={opened}
      onClose={onClose}
      defaultX="20vw"
      defaultY="10vh"
      defaultWidth={640}
      defaultHeight={440}
      minWidth={480}
      minHeight={360}
      persistState
      id="settings-window"
    >
      <Tabs value={tab} onChange={setTab} orientation="vertical" style={{ height: "100%" }}>
        <Tabs.List>
          <Tabs.Tab value="general" leftSection={<IconSettings size={16} />}>
            {t("settings.general")}
          </Tabs.Tab>
          <Tabs.Tab value="updates" leftSection={<IconDownload size={16} />}>
            {t("settings.updates")}
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="general" p="md">
          <Stack gap="sm">
            <Select
              label={t("settings.language")}
              leftSection={<IconWorld size={16} />}
              data={[
                { value: "de", label: "Deutsch" },
                { value: "en", label: "English" },
              ]}
              value={i18n.language}
              onChange={(value) => value && i18n.changeLanguage(value)}
              w={220}
            />
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="updates" p="md">
          <Stack gap="sm">
            <Group gap="xs">
              <Text size="sm">{t("settings.currentVersion")}:</Text>
              <Badge variant="light">{appInfo?.version || "—"}</Badge>
            </Group>

            <Group gap="xs">
              <Text size="sm">{t("settings.status")}:</Text>
              <Badge color={STATUS_COLOR[updateState.status] || "gray"}>
                {t(`settings.updateStatus.${updateState.status}`)}
              </Badge>
            </Group>

            {updateState.status === "available" && (
              <Text size="sm">{t("settings.newVersionAvailable", { version: updateState.version })}</Text>
            )}

            {updateState.status === "downloading" && (
              <Progress value={updateState.percent || 0} animated />
            )}

            {updateState.status === "error" && (
              <Text size="sm" c="red">
                {updateState.message}
              </Text>
            )}

            <Group gap="xs">
              <Button
                size="xs"
                variant="light"
                onClick={onUpdate.check}
                disabled={updateState.status === "checking" || updateState.status === "downloading"}
              >
                {t("settings.checkForUpdates")}
              </Button>
              {updateState.status === "available" && (
                <Button size="xs" onClick={onUpdate.download}>
                  {t("settings.downloadUpdate")}
                </Button>
              )}
              {updateState.status === "downloaded" && (
                <Button size="xs" color="green" onClick={onUpdate.install}>
                  {t("settings.restartAndInstall")}
                </Button>
              )}
            </Group>
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Window>
  );
}
