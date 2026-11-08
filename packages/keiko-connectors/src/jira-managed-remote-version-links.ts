import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { JIRA_READ_TOOL_FAMILIES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray, asRecord, parseAtlassianJsonValue } from "./atlassian-sync-classify.js";
import { jiraPropertyValue, JIRA_PROPERTY_VALUE_MAX_BYTES } from "./jira-entity-property-values.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraSelectedRead,
  selectJiraReadPage,
  type JiraReadPageSelection,
  type JiraReadResponse,
} from "./jira-managed-read-request.js";
import { jiraVersionSummary } from "./jira-managed-versions.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";
import { jiraResourceSelfMatches } from "./jira-resource-self.js";

export const JIRA_REMOTE_VERSION_LINK_READS = JIRA_READ_TOOL_FAMILIES.remoteVersionLinks;
type LinkRead = (typeof JIRA_REMOTE_VERSION_LINK_READS)[number];
type Refusal = "malformed-payload" | "bounds-exceeded" | "conflict";
type Projected = { readonly item: CatalogJsonObject } | { readonly reason: Refusal };
interface Selection {
  readonly path: string;
  readonly versionId?: string;
  readonly globalId?: string;
  readonly page?: JiraReadPageSelection;
}
const GLOBAL_ARGS = new Set(["globalId", "startAt", "maxResults"]);
const VERSION_ARGS = new Set(["versionId", "startAt", "maxResults"]);
const SINGLE_ARGS = new Set(["versionId", "globalId"]);
export function jiraRemoteVersionLinkGlobalId(value: unknown, path: boolean): value is string {
  return (
    jiraNativeText(value, 2048) &&
    !/[\p{Cc}\p{Surrogate}]/u.test(value) &&
    (!path || (value !== "." && value !== ".." && !/[/\\%]/u.test(value)))
  );
}
function selection(name: LinkRead, args: CatalogJsonObject): Selection | undefined {
  if (name === "jira.remote-version-links") {
    const page = selectJiraReadPage(args, GLOBAL_ARGS);
    return page === undefined || !jiraRemoteVersionLinkGlobalId(args.globalId, false)
      ? undefined
      : {
          path: `version/remotelink?${new URLSearchParams({ globalId: args.globalId }).toString()}`,
          globalId: args.globalId,
          page,
        };
  }
  if (!jiraNativeId(args.versionId)) return undefined;
  const path = `version/${args.versionId}/remotelink`;
  if (name === "jira.version-remote-links") {
    const page = selectJiraReadPage(args, VERSION_ARGS);
    return page === undefined ? undefined : { path, versionId: args.versionId, page };
  }
  return Object.keys(args).some((key) => !SINGLE_ARGS.has(key)) ||
    !jiraRemoteVersionLinkGlobalId(args.globalId, true)
    ? undefined
    : {
        path: `${path}/${encodeURIComponent(args.globalId)}`,
        versionId: args.versionId,
        globalId: args.globalId,
      };
}
/** Only the native resource path is compared; proxy origins never become request destinations. */
function remoteLinkIdentity(
  self: string,
): { readonly versionId: string; readonly encodedGlobalId: string } | undefined {
  const url = new URL(self);
  const parts = /\/rest\/api\/2\/version\/([1-9]\d{0,18})\/remotelink\/([^/]+)$/u.exec(
    url.pathname,
  );
  const versionId = parts?.[1];
  const encodedGlobalId = parts?.[2];
  return jiraNativeId(versionId) && encodedGlobalId !== undefined
    ? { versionId, encodedGlobalId }
    : undefined;
}
function membership(self: unknown, selected: Selection): boolean {
  if (self === undefined || self === null) return true;
  if (typeof self !== "string" || !URL.canParse(self)) return false;
  const observed = remoteLinkIdentity(self);
  if (observed === undefined) return false;
  const { versionId, encodedGlobalId } = observed;
  if (selected.versionId !== undefined && versionId !== selected.versionId) return false;
  const target =
    selected.globalId === undefined ? encodedGlobalId : encodeURIComponent(selected.globalId);
  return jiraResourceSelfMatches(self, `version/${versionId}/remotelink/${target}`);
}
/** RemoteEntityLinkJsonBean.link is documented JSON-encoded native content. Decode exactly once. */
export function projectJiraRemoteVersionLinkValue(value: unknown): Projected {
  if (value === undefined || value === null) return { item: { valueAvailable: false } };
  if (typeof value !== "string") return { reason: "malformed-payload" };
  if (Buffer.byteLength(value, "utf8") > JIRA_PROPERTY_VALUE_MAX_BYTES)
    return { reason: "bounds-exceeded" };
  const decoded = parseAtlassianJsonValue(value);
  if (decoded === undefined) return { reason: "malformed-payload" };
  const nodes = jiraPropertyValue(decoded);
  return nodes.ok
    ? { item: { valueAvailable: true, valueNodes: nodes.items } }
    : { reason: nodes.reason };
}
function reviewCandidate(
  raw: Record<string, unknown>,
  selected: Selection,
  item: CatalogJsonObject,
): string | undefined {
  const nodes = asArray(item.valueNodes);
  const field = nodes
    ?.map(asRecord)
    .find((node) => node?.path === "/globalId" && node.kind === "string");
  const candidate = selected.globalId ?? field?.textValue;
  return jiraRemoteVersionLinkGlobalId(candidate, false) &&
    typeof raw.self === "string" &&
    URL.canParse(raw.self)
    ? candidate
    : undefined;
}
function reviewIdentity(
  raw: Record<string, unknown>,
  selected: Selection,
  item: CatalogJsonObject,
): CatalogJsonObject {
  const candidate = reviewCandidate(raw, selected, item);
  if (candidate === undefined || typeof raw.self !== "string")
    return { reviewIdentityAvailable: false };
  const observed = remoteLinkIdentity(raw.self);
  const versionId = selected.versionId ?? observed?.versionId;
  return versionId !== undefined &&
    jiraResourceSelfMatches(
      raw.self,
      `version/${versionId}/remotelink/${encodeURIComponent(candidate)}`,
    )
    ? { reviewIdentityAvailable: true, globalId: candidate }
    : { reviewIdentityAvailable: false };
}
function link(value: unknown, selected: Selection): Projected {
  const raw = asRecord(value);
  if (raw === undefined) return { reason: "malformed-payload" };
  if (!membership(raw.self, selected)) return { reason: "conflict" };
  if (
    raw.name !== undefined &&
    raw.name !== null &&
    (!jiraNativeText(raw.name, 255) || /\p{Surrogate}/u.test(raw.name))
  )
    return { reason: "malformed-payload" };
  const projected = projectJiraRemoteVersionLinkValue(raw.link);
  if ("reason" in projected) return projected;
  return {
    item: {
      ...projected.item,
      ...reviewIdentity(raw, selected, projected.item),
      ...(typeof raw.name === "string" ? { name: raw.name } : {}),
    },
  };
}
function context(selected: Selection): CatalogJsonObject {
  return {
    linkScope: "native-version-links",
    ...(selected.versionId === undefined ? {} : { versionId: selected.versionId }),
    ...(selected.globalId === undefined ? {} : { selectedGlobalId: selected.globalId }),
  };
}
function projectLinks(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const values = selected.page === undefined ? [response.body] : asArray(response.body?.links);
  if (values === undefined) return jiraReadFailure("malformed-payload");
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return jiraReadFailure("bounds-exceeded");
  const items: CatalogJsonObject[] = [];
  for (const value of values) {
    const projected = link(value, selected);
    if ("reason" in projected) return jiraReadFailure(projected.reason);
    items.push(projected.item);
  }
  const result =
    selected.page === undefined
      ? { data: { outcome: "succeeded", items } }
      : localJiraPage(items, selected.page.startAt, selected.page.maxResults);
  return boundJiraReadResult({ ...result, data: { ...result.data, ...context(selected) } });
}
function versionResponse(
  response: JiraReadResponse,
  selected: { readonly path: string; readonly versionId: string },
): ManagedMcpToolResult {
  const version = jiraVersionSummary(response.body);
  if (version === undefined) return jiraReadFailure("malformed-payload");
  if (
    version.versionId !== selected.versionId ||
    (response.body?.self !== undefined &&
      response.body.self !== null &&
      !jiraResourceSelfMatches(response.body.self, selected.path))
  )
    return jiraReadFailure("conflict");
  return {
    data: { outcome: "succeeded", versionId: version.versionId, versionName: version.name },
  };
}
export function isJiraRemoteVersionLinkRead(name: string): name is LinkRead {
  return (JIRA_REMOTE_VERSION_LINK_READS as readonly string[]).includes(name);
}
/** VersionResource/RemoteEntityLinkJsonBean 11.3.3. Arbitrary native payload remains typed data, never a command.
 * https://docs.atlassian.com/software/jira/docs/api/11.3.3/com/atlassian/jira/rest/v2/entity/RemoteEntityLinkJsonBean.html
 */
export async function executeJiraRemoteVersionLinkRead(
  name: LinkRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const selected = selection(name, args);
  if (selected === undefined) return jiraReadFailure("invalid-input");
  const version =
    selected.versionId === undefined
      ? undefined
      : await executeJiraSelectedRead(
          {
            path: `version/${selected.versionId}`,
            versionId: selected.versionId,
          },
          request,
          "json",
          versionResponse,
        );
  if (version?.isError) return version;
  const result = await executeJiraSelectedRead(selected, request, "json", projectLinks);
  const versionName = version?.data.versionName;
  return result.isError || typeof versionName !== "string"
    ? result
    : boundJiraReadResult({
        ...result,
        data: { ...result.data, versionName },
      });
}
