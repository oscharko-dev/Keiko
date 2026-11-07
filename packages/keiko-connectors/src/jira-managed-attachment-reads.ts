import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraAttachmentRecord, jiraAttachmentSettings } from "./jira-attachments.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";

export const JIRA_ATTACHMENT_READS = [
  "jira.attachment-settings",
  "jira.attachment",
  "jira.attachment-archive",
  "jira.attachment-archive-summary",
] as const;
type AttachmentRead = (typeof JIRA_ATTACHMENT_READS)[number];
const READS: ReadonlySet<string> = new Set(JIRA_ATTACHMENT_READS);
const FIELDS: Readonly<Record<AttachmentRead, readonly string[]>> = {
  "jira.attachment-settings": [],
  "jira.attachment": ["attachmentId"],
  "jira.attachment-archive": ["attachmentId", "startAt", "maxResults"],
  "jira.attachment-archive-summary": ["attachmentId"],
};
interface Selection {
  readonly path: string;
  readonly attachmentId?: string;
  readonly startAt: number;
  readonly maxResults: number;
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function pageInput(args: CatalogJsonObject): Pick<Selection, "startAt" | "maxResults"> | undefined {
  const startAt = args.startAt === undefined ? 0 : args.startAt;
  const maxResults = args.maxResults === undefined ? 25 : args.maxResults;
  if (
    !integer(startAt) ||
    startAt > 1_000_000 ||
    !integer(maxResults) ||
    maxResults < 1 ||
    maxResults > 100
  )
    return undefined;
  return { startAt, maxResults };
}
function selection(name: AttachmentRead, args: CatalogJsonObject): Selection | undefined {
  const allowed = new Set(FIELDS[name]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return undefined;
  const page = pageInput(args);
  if (page === undefined) return undefined;
  const { startAt, maxResults } = page;
  if (name === "jira.attachment-settings") return { path: "attachment/meta", startAt, maxResults };
  if (!jiraNativeId(args.attachmentId)) return undefined;
  const suffix =
    name === "jira.attachment-archive"
      ? "/expand/raw"
      : name === "jira.attachment-archive-summary"
        ? "/expand/human"
        : "";
  return {
    path: `attachment/${args.attachmentId}${suffix}`,
    attachmentId: args.attachmentId,
    startAt,
    maxResults,
  };
}
function optionalText(
  raw: Record<string, unknown>,
  fields: Readonly<Record<string, number>>,
): CatalogJsonObject | undefined {
  const result: Record<string, string> = {};
  for (const [key, max] of Object.entries(fields)) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (!jiraNativeText(value, max)) return undefined;
    result[key] = value;
  }
  return result;
}
function attachment(
  raw: Record<string, unknown>,
  selected: Selection,
): CatalogJsonObject | undefined {
  const record = jiraAttachmentRecord(raw);
  if (record === undefined || (raw.id !== undefined && raw.id !== selected.attachmentId))
    return undefined;
  const metadata = optionalText(raw, { mimeType: 255, created: 128 });
  return metadata === undefined || selected.attachmentId === undefined
    ? undefined
    : { attachmentId: selected.attachmentId, ...record, ...metadata };
}
function entry(value: unknown): (CatalogJsonObject & { readonly entryIndex: number }) | undefined {
  const raw = asRecord(value);
  const size = raw?.size ?? undefined;
  if (raw === undefined || !integer(raw.entryIndex) || (size !== undefined && !integer(size)))
    return undefined;
  const metadata = optionalText(raw, { name: 1024, mediaType: 255, abbreviatedName: 1024 });
  return metadata === undefined
    ? undefined
    : { entryIndex: raw.entryIndex, ...(size === undefined ? {} : { size }), ...metadata };
}
function archiveEntries(
  entries: readonly unknown[],
  total: number | undefined,
): readonly CatalogJsonObject[] | undefined {
  const items: CatalogJsonObject[] = [];
  const indexes = new Set<number>();
  for (const value of entries) {
    const item = entry(value);
    if (
      item === undefined ||
      indexes.has(item.entryIndex) ||
      (typeof total === "number" && item.entryIndex >= total)
    )
      return undefined;
    indexes.add(item.entryIndex);
    items.push(item);
  }
  if (typeof total === "number" && total < items.length) return undefined;
  return items;
}
function archive(raw: Record<string, unknown>, selected: Selection): ManagedMcpToolResult {
  const total = raw.totalEntryCount ?? undefined;
  if (!Array.isArray(raw.entries) || (total !== undefined && !integer(total)))
    return jiraReadFailure("malformed-payload");
  if (raw.entries.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return jiraReadFailure("bounds-exceeded");
  const items = archiveEntries(raw.entries, total);
  if (items === undefined) return jiraReadFailure("malformed-payload");
  const page = localJiraPage(items, selected.startAt, selected.maxResults);
  return boundJiraReadResult({
    data: {
      ...page.data,
      ...(selected.attachmentId === undefined ? {} : { attachmentId: selected.attachmentId }),
      ...(total === undefined
        ? {}
        : {
            totalEntryCount: total,
            entriesComplete: total === items.length,
          }),
    },
  });
}
function summary(raw: Record<string, unknown>, selected: Selection): CatalogJsonObject | undefined {
  const total = raw.totalEntryCount ?? undefined;
  if (
    !integer(raw.id) ||
    raw.id === 0 ||
    String(raw.id) !== selected.attachmentId ||
    (total !== undefined && !integer(total))
  )
    return undefined;
  const metadata = optionalText(raw, { name: 1024, mediaType: 255 });
  return metadata === undefined
    ? undefined
    : {
        attachmentId: String(raw.id),
        ...metadata,
        ...(total === undefined ? {} : { totalEntryCount: total }),
      };
}
export function isJiraAttachmentRead(name: string): name is AttachmentRead {
  return READS.has(name);
}
/** Fixed JSON GETs only; archive entries are data, never local paths or download destinations. */
export async function executeJiraAttachmentRead(
  name: AttachmentRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const selected = selection(name, args);
  if (selected === undefined) return jiraReadFailure("invalid-input");
  const response = await request(selected.path);
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  if (response.status !== 200 || response.body === undefined)
    return jiraReadFailure("malformed-payload");
  if (name === "jira.attachment-archive") return archive(response.body, selected);
  const data =
    name === "jira.attachment-settings"
      ? jiraAttachmentSettings(response.body)
      : name === "jira.attachment"
        ? attachment(response.body, selected)
        : summary(response.body, selected);
  return data === undefined
    ? jiraReadFailure("malformed-payload")
    : boundJiraReadResult({ data: { outcome: "succeeded", ...data } });
}
