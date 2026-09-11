// packages/gui/src/AboutModal.jsx
import { useTranslation } from "react-i18next";
import { Modal, Stack, Text, Anchor, Group, Badge } from "@mantine/core";

export default function AboutModal({ opened, onClose, appInfo }) {
  const { t } = useTranslation();

  return (
    <Modal opened={opened} onClose={onClose} title={t("about.title")} centered size="sm">
      <Stack gap="xs">
        <Text fw={600}>{appInfo?.name || "CatoPushSync"}</Text>
        <Text size="sm" c="dimmed">
          {t("about.description")}
        </Text>
        <Group gap="xs">
          <Text size="sm">{t("settings.currentVersion")}:</Text>
          <Badge variant="light">{appInfo?.version || "—"}</Badge>
        </Group>
        <Text size="sm" c="dimmed">
          {appInfo?.author}
        </Text>
        {appInfo?.homepage && (
          <Anchor size="sm" href={appInfo.homepage} target="_blank" rel="noreferrer">
            {appInfo.homepage}
          </Anchor>
        )}
        <Text size="xs" c="dimmed" mt="sm">
          Electron {appInfo?.electron} · Node {appInfo?.node}
        </Text>
      </Stack>
    </Modal>
  );
}
