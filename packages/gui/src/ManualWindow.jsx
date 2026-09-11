import { useEffect, useState } from "react";
import { Window } from "@gfazioli/mantine-window";
import {
  Group,
  SegmentedControl,
  Splitter,
  Stack,
} from "@mantine/core";
import MarkdownIt from "markdown-it";
import markdownItAnchor from "markdown-it-anchor";
import markdownItTocDoneRight from "markdown-it-toc-done-right";
import { useTranslation } from "react-i18next";
import germanManual from "../../../docs/catopushsync-app-manual.de.md?raw";
import englishManual from "../../../docs/catopushsync-app-manual.en.md?raw";

const slugifyHeading = (value) => String(value)
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .trim()
  .replace(/[^\w\s-]/g, "")
  .replace(/[\s_-]+/g, "-");

function MarkdownContent({ source }) {
  let toc = "";
  const sourceWithoutTitle = source
    .replace(/^# .*\n\s*\n?/, "")
  const sourceWithoutToc = sourceWithoutTitle.replace(/^\$\{toc\}\s*$/m, "");
  const markdown = new MarkdownIt({ html: false, linkify: true, typographer: true })
    .use(markdownItAnchor, { slugify: slugifyHeading, permalink: false })
    .use(markdownItTocDoneRight, {
      slugify: slugifyHeading,
      listType: "ul",
      callback: (html) => {
        toc = html;
      },
    });
  markdown.render(sourceWithoutTitle);
  const rendered = markdown.render(sourceWithoutToc);

  const handleClick = (event) => {
    const link = event.target.closest("a");
    if (!link) return;
    const href = link.getAttribute("href") || "";
    if (/^https?:\/\//i.test(href)) {
      event.preventDefault();
      window.sftpPushSync.openExternal(href);
    }
  };

  return { rendered, toc, handleClick };
}

export default function ManualWindow({ opened, onClose }) {
  const { t, i18n } = useTranslation();
  const [language, setLanguage] = useState(i18n.language?.startsWith("de") ? "de" : "en");

  useEffect(() => {
    if (opened) setLanguage(i18n.language?.startsWith("de") ? "de" : "en");
  }, [opened, i18n.language]);

  const { rendered, toc, handleClick } = MarkdownContent({
    source: language === "de" ? germanManual : englishManual,
  });

  return (
    <Window
      title={t("manual.title")}
      opened={opened}
      onClose={onClose}
      defaultX="12vw"
      defaultY="8vh"
      defaultWidth={820}
      defaultHeight={680}
      minWidth={520}
      minHeight={420}
      resizable="both"
      fullSizeResizeHandles
      withScrollArea={false}
      persistState
      id="manual-window"
    >
      <Stack gap="sm" h="100%" p="md" style={{ minHeight: 0, overflow: "hidden" }}>
        <Group justify="space-between" wrap="nowrap">
          <SegmentedControl
            size="xs"
            value={language}
            onChange={setLanguage}
            data={[
              { value: "de", label: "Deutsch" },
              { value: "en", label: "English" },
            ]}
          />
        </Group>
        <style>{`
          .catopushsync-manual-toc ul { list-style: none; margin: 0; padding: 0; }
          .catopushsync-manual-toc li { margin: 0.25rem 0; }
          .catopushsync-manual-toc a { color: var(--mantine-color-dimmed); text-decoration: none; font-size: var(--mantine-font-size-sm); line-height: 1.35; }
          .catopushsync-manual-toc a:hover { color: var(--mantine-color-blue-4); text-decoration: underline; }
          .catopushsync-manual-content { max-width: 760px; }
          .catopushsync-manual-content h1, .catopushsync-manual-content h2, .catopushsync-manual-content h3 { scroll-margin-top: 1rem; }
          .catopushsync-manual-content h2 { font-size: var(--mantine-font-size-lg); margin: 1.75rem 0 0.6rem; }
          .catopushsync-manual-content h3 { font-size: var(--mantine-font-size-md); margin: 1.25rem 0 0.4rem; }
          .catopushsync-manual-content p, .catopushsync-manual-content li { font-size: var(--mantine-font-size-sm); line-height: 1.6; }
          .catopushsync-manual-content pre { overflow-x: auto; padding: var(--mantine-spacing-sm); background: var(--mantine-color-dark-7); border-radius: var(--mantine-radius-sm); }
          .catopushsync-manual-content code { font-family: var(--mantine-font-family-monospace); }
          .catopushsync-manual-content table { border-collapse: collapse; font-size: var(--mantine-font-size-sm); }
          .catopushsync-manual-content th, .catopushsync-manual-content td { border: 1px solid var(--mantine-color-default-border); padding: 0.35rem 0.5rem; }
        `}</style>
        <Splitter style={{ flex: 1, minHeight: 0, width: "100%", overflow: "hidden" }} orientation="horizontal">
          <Splitter.Pane defaultSize="220px" min="170px" max="360px" style={{ minHeight: 0, overflow: "hidden" }}>
            <div className="catopushsync-manual-toc" style={{ height: "100%", minHeight: 0, overflow: "auto", paddingRight: "var(--mantine-spacing-md)", userSelect: "text", WebkitUserSelect: "text" }} dangerouslySetInnerHTML={{ __html: toc }} />
          </Splitter.Pane>
          <Splitter.Pane defaultSize={100} min="45%" style={{ minHeight: 0, overflow: "hidden" }}>
            <div style={{ height: "100%", minHeight: 0, overflow: "auto", paddingLeft: "var(--mantine-spacing-lg)", paddingRight: "var(--mantine-spacing-sm)", userSelect: "text", WebkitUserSelect: "text" }}>
              <div className="catopushsync-manual-content" onClick={handleClick} dangerouslySetInnerHTML={{ __html: rendered }} />
            </div>
          </Splitter.Pane>
        </Splitter>
      </Stack>
    </Window>
  );
}
