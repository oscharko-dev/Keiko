import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { jiraNativeId, jiraNativeNumericId } from "./jira-native-values.js";
import { jiraResourceSelfMatches } from "./jira-resource-self.js";
import { savedText } from "./jira-saved-configuration-values.js";
import {
  LINK_MALFORMED,
  type LinkIssue,
  type LinkObservation,
} from "./jira-link-mutation-values.js";

/** Explicit replacement fields: null means cleared, never an omitted unknown field. */
export interface RemoteLinkValue {
  readonly globalId: string | null;
  readonly applicationType: string | null;
  readonly applicationName: string | null;
  readonly relationship: string | null;
  readonly url: string;
  readonly title: string;
  readonly summary: string | null;
  readonly iconUrl: string | null;
  readonly iconTitle: string | null;
  readonly resolved: boolean | null;
  readonly statusIconUrl: string | null;
  readonly statusIconTitle: string | null;
  readonly statusIconLink: string | null;
}
export interface RemoteLinkSnapshot extends RemoteLinkValue {
  readonly id: string;
}
export const REMOTE_LINK_VALUE_KEYS = [
  "globalId",
  "applicationType",
  "applicationName",
  "relationship",
  "url",
  "title",
  "summary",
  "iconUrl",
  "iconTitle",
  "resolved",
  "statusIconUrl",
  "statusIconTitle",
  "statusIconLink",
] as const;
const VALUE_KEYS = new Set<string>(REMOTE_LINK_VALUE_KEYS);
const URL_KEYS = new Set(["url", "iconUrl", "statusIconUrl", "statusIconLink"]);
const URL_MAX_CHARS = 2048;
const TEXT_MAX_CHARS = 255;
const SUMMARY_MAX_CHARS = 32768;
/** These are remote-link metadata only. No URL is fetched, followed, or returned as a browse link. */
function metadataUrl(value: unknown): value is string {
  if (
    !savedText(value, URL_MAX_CHARS) ||
    /[\p{Cc}\\]/u.test(value) ||
    value.trim() !== value ||
    !URL.canParse(value)
  )
    return false;
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === ""
  );
}
function scalar(value: unknown, key: (typeof REMOTE_LINK_VALUE_KEYS)[number]): boolean {
  if (value === null) return key !== "url" && key !== "title";
  if (key === "resolved") return typeof value === "boolean";
  if (URL_KEYS.has(key)) return metadataUrl(value);
  return savedText(
    value,
    key === "summary" ? SUMMARY_MAX_CHARS : TEXT_MAX_CHARS,
    key === "summary",
  );
}
/**
 * The first rule a remote link value breaks, as one sentence for the model (#4357 AC3): the shape
 * (the fields themselves are in the descriptor), then the first field that fails in field order. Built from the same keys and limits `scalar`
 * enforces, within the 200-byte bound of a detail message, and never the refused value.
 */
export function remoteLinkValueProblem(value: unknown): string {
  const raw = asRecord(value);
  if (
    raw === undefined ||
    !Object.keys(raw).every((key) => VALUE_KEYS.has(key)) ||
    !REMOTE_LINK_VALUE_KEYS.every((key) => Object.hasOwn(raw, key))
  )
    return "value must be the complete remote link with every field present, null where it is empty.";
  const key = REMOTE_LINK_VALUE_KEYS.find((candidate) => !scalar(raw[candidate], candidate));
  if (key === undefined) return "value is not a remote link this call can send.";
  if (raw[key] === null) return `${key} must be text, never null.`;
  if (key === "resolved") return "resolved must be true, false or null.";
  if (URL_KEYS.has(key))
    return `${key} must be an http or https URL of at most ${String(URL_MAX_CHARS)} characters, with no credentials, control characters, backslash or surrounding spaces.`;
  return key === "summary"
    ? `summary must be text of at most ${String(SUMMARY_MAX_CHARS)} characters without control characters, or null.`
    : `${key} must be non-blank text of at most ${String(TEXT_MAX_CHARS)} characters without control characters, or null.`;
}
function isRemoteLinkValue(value: unknown, snapshot: boolean): value is RemoteLinkValue {
  const raw = asRecord(value);
  return (
    raw !== undefined &&
    Object.keys(raw).every((key) => VALUE_KEYS.has(key) || (snapshot && key === "id")) &&
    REMOTE_LINK_VALUE_KEYS.every((key) => Object.hasOwn(raw, key) && scalar(raw[key], key))
  );
}
export function remoteLinkValue(value: unknown, snapshot = false): RemoteLinkValue | undefined {
  if (!isRemoteLinkValue(value, snapshot)) return undefined;
  const {
    globalId,
    applicationType,
    applicationName,
    relationship,
    url,
    title,
    summary,
    iconUrl,
    iconTitle,
    resolved,
    statusIconUrl,
    statusIconTitle,
    statusIconLink,
  } = value;
  return {
    globalId,
    applicationType,
    applicationName,
    relationship,
    url,
    title,
    summary,
    iconUrl,
    iconTitle,
    resolved,
    statusIconUrl,
    statusIconTitle,
    statusIconLink,
  };
}
export function remoteLinkExpected(value: unknown): RemoteLinkSnapshot | undefined {
  const raw = asRecord(value);
  const selected = remoteLinkValue(value, true);
  return selected !== undefined && jiraNativeId(raw?.id) ? { id: raw.id, ...selected } : undefined;
}
function closedNative(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return {};
  const raw = asRecord(value);
  return raw !== undefined && Object.keys(raw).every((key) => keys.includes(key)) ? raw : undefined;
}
/** Jira names the parent issue by its key or its numeric ID in a remote link's self URL; both name
 * the same bound issue, and nothing else is accepted. */
export function remoteLinkSelfMatches(self: unknown, issue: LinkIssue, id: string): boolean {
  return (
    jiraResourceSelfMatches(self, `issue/${issue.id}/remotelink/${id}`) ||
    jiraResourceSelfMatches(self, `issue/${issue.key}/remotelink/${id}`)
  );
}
function remoteLinkIdentity(
  raw: Readonly<Record<string, unknown>>,
  issue: LinkIssue,
): string | undefined {
  const id = jiraNativeNumericId(raw.id);
  if (id === undefined) return undefined;
  if (raw.self !== undefined && raw.self !== null && !remoteLinkSelfMatches(raw.self, issue, id))
    return undefined;
  return id;
}
function nativeRemoteApplication(value: unknown): Readonly<Record<string, unknown>> | undefined {
  const application = closedNative(value, ["type", "name"]);
  return application === undefined
    ? undefined
    : { applicationType: application.type ?? null, applicationName: application.name ?? null };
}
function nativeRemoteStatus(value: unknown): Readonly<Record<string, unknown>> | undefined {
  const status = closedNative(value, ["resolved", "icon"]);
  if (status === undefined) return undefined;
  const icon = closedNative(status.icon, ["url16x16", "title", "link"]);
  if (icon === undefined) return undefined;
  return {
    resolved: status.resolved ?? null,
    statusIconUrl: icon.url16x16 ?? null,
    statusIconTitle: icon.title ?? null,
    statusIconLink: icon.link ?? null,
  };
}
function nativeRemoteObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  const object = closedNative(value, ["url", "title", "summary", "icon", "status"]);
  if (object === undefined) return undefined;
  const icon = closedNative(object.icon, ["url16x16", "title"]);
  const status = nativeRemoteStatus(object.status);
  if (icon === undefined || status === undefined) return undefined;
  return {
    url: object.url,
    title: object.title,
    summary: object.summary ?? null,
    iconUrl: icon.url16x16 ?? null,
    iconTitle: icon.title ?? null,
    ...status,
  };
}
export function projectRemoteLinkSnapshot(
  value: unknown,
  issue: LinkIssue,
): RemoteLinkSnapshot | undefined {
  const raw = closedNative(value, [
    "id",
    "self",
    "globalId",
    "application",
    "relationship",
    "object",
  ]);
  if (raw === undefined) return undefined;
  const id = remoteLinkIdentity(raw, issue);
  if (id === undefined) return undefined;
  const application = nativeRemoteApplication(raw.application);
  const object = nativeRemoteObject(raw.object);
  if (application === undefined || object === undefined) return undefined;
  const selected = remoteLinkValue({
    globalId: raw.globalId ?? null,
    relationship: raw.relationship ?? null,
    ...application,
    ...object,
  });
  return selected === undefined ? undefined : { id, ...selected };
}
export function sameRemoteLinkValue(left: RemoteLinkValue, right: RemoteLinkValue): boolean {
  return REMOTE_LINK_VALUE_KEYS.every((key) => left[key] === right[key]);
}
export function sameRemoteLinks(
  left: readonly RemoteLinkSnapshot[],
  right: readonly RemoteLinkSnapshot[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item) =>
      right.some((other) => item.id === other.id && sameRemoteLinkValue(item, other)),
    )
  );
}
function remoteLinkIdentitySeen(
  item: RemoteLinkSnapshot,
  ids: ReadonlySet<string>,
  globals: ReadonlySet<string>,
): boolean {
  return ids.has(item.id) || (item.globalId !== null && globals.has(item.globalId));
}
export async function readCompleteRemoteLinks(
  request: JiraMutationRequest,
  issue: LinkIssue,
): Promise<LinkObservation<readonly RemoteLinkSnapshot[]>> {
  const response = await request(`issue/${issue.id}/remotelink`, "GET", undefined, "json-array");
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.items === undefined) return LINK_MALFORMED;
  if (response.items.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return { ok: false, reason: "bounds-exceeded" };
  const items: RemoteLinkSnapshot[] = [];
  const ids = new Set<string>();
  const globals = new Set<string>();
  for (const raw of response.items) {
    const item = projectRemoteLinkSnapshot(raw, issue);
    if (item === undefined || remoteLinkIdentitySeen(item, ids, globals)) return LINK_MALFORMED;
    ids.add(item.id);
    if (item.globalId !== null) globals.add(item.globalId);
    items.push(item);
  }
  return { ok: true, value: items };
}
/** PUT and POST are full replacements. Every reviewed nullable field is sent explicitly. */
export function remoteLinkBody(value: RemoteLinkValue): CatalogJsonObject {
  return {
    globalId: value.globalId,
    application: { type: value.applicationType, name: value.applicationName },
    relationship: value.relationship,
    object: {
      url: value.url,
      title: value.title,
      summary: value.summary,
      icon: { url16x16: value.iconUrl, title: value.iconTitle },
      status: {
        resolved: value.resolved,
        icon: {
          url16x16: value.statusIconUrl,
          title: value.statusIconTitle,
          link: value.statusIconLink,
        },
      },
    },
  };
}
