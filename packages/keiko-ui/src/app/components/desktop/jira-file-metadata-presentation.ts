import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";

type Source = Readonly<Record<string, unknown>>;
const AVATARS = new Set([
  "jira_system_avatars",
  "jira_project_avatars",
  "jira_user_avatars",
  "jira_avatars",
]);
export const JIRA_FILE_METADATA_TOOLS: ReadonlySet<string> = new Set([
  ...AVATARS,
  "jira_attachment_settings",
  "jira_attachment",
  "jira_attachment_archive",
  "jira_attachment_archive_summary",
]);
const TEXT_FACTS: Readonly<Record<string, WidgetMessageKey>> = {
  owner: "chat.jira.fact.avatarOwner",
  mimeType: "chat.jira.fact.mediaType",
  mediaType: "chat.jira.fact.mediaType",
  created: "chat.jira.fact.created",
};
const COUNT_FACTS: Readonly<Record<string, WidgetMessageKey>> = {
  size: "chat.jira.fact.sizeBytes",
  entryIndex: "chat.jira.fact.entryIndex",
  totalEntryCount: "chat.jira.fact.archiveTotal",
  uploadLimit: "chat.jira.fact.uploadLimit",
  maxBytes: "chat.jira.fact.attachmentMaxBytes",
};
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function identity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9]\d{0,18}$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
function content(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
function factsOf(source: Source): JiraOutcomeFact[] {
  return [
    ...Object.entries(TEXT_FACTS).flatMap(([field, label]) => {
      const value = content(source[field]);
      return value === undefined ? [] : [{ label, value }];
    }),
    ...Object.entries(COUNT_FACTS).flatMap(([field, label]) =>
      integer(source[field]) ? [{ label, value: String(source[field]) }] : [],
    ),
  ];
}
function avatarDetails(source: Source): JiraAgileDetails {
  if (!identity(source.id) || (source.category !== "system" && source.category !== "custom"))
    return { facts: [], labels: [] };
  return {
    facts: [{ label: "chat.jira.fact.avatarId", value: source.id }, ...factsOf(source)],
    labels: [
      source.category === "system"
        ? "chat.jira.asset.systemAvatar"
        : "chat.jira.asset.customAvatar",
      source.selected === true
        ? "chat.jira.asset.selected"
        : source.selected === false
          ? "chat.jira.asset.notSelected"
          : "chat.jira.asset.selectionUnknown",
    ],
  };
}
function archiveLabels(tool: string, source: Source): WidgetMessageKey[] {
  if (tool !== "jira_attachment_archive" || !identity(source.attachmentId)) return [];
  if (source.entriesComplete === true) return ["chat.jira.asset.archiveComplete"];
  return [
    source.entriesComplete === false
      ? "chat.jira.asset.archivePartial"
      : "chat.jira.asset.archiveCoverageUnknown",
  ];
}
/** Saved JSON metadata only: native self, image and download URLs never become UI destinations. */
export function jiraFileMetadataDetails(tool: string, source: Source): JiraAgileDetails {
  if (AVATARS.has(tool)) return avatarDetails(source);
  if (!JIRA_FILE_METADATA_TOOLS.has(tool)) return { facts: [], labels: [] };
  const facts = factsOf(source);
  if (identity(source.attachmentId))
    facts.unshift({ label: "chat.jira.fact.attachmentId", value: source.attachmentId });
  const labels = archiveLabels(tool, source);
  if (tool === "jira_attachment_settings" && typeof source.enabled === "boolean")
    labels.push(
      source.enabled ? "chat.jira.asset.attachmentsEnabled" : "chat.jira.asset.attachmentsDisabled",
    );
  const name = content(source.filename) ?? content(source.name) ?? content(source.abbreviatedName);
  return { ...(name === undefined ? {} : { name }), facts, labels };
}
