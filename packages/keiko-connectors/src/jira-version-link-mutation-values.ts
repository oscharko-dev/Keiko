import { JIRA_VERSION_REMOTE_LINK_MUTATIONS, type JiraVersionRemoteLinkMutation, type JiraMutationAttempt, type JiraMutationReceipt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject, type CatalogJsonValue } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { decodeJiraPropertyInput } from "./jira-entity-property-input.js";
import { jiraPropertyStatesEqual } from "./jira-entity-property-write-admission.js";
import { projectJiraRemoteVersionLinkValue, jiraRemoteVersionLinkGlobalId as versionLinkGlobalId } from "./jira-managed-remote-version-links.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { jiraResourceSelfMatches } from "./jira-resource-self.js";
import { releaseExactFields, releaseSelection, type ReleaseSelection } from "./jira-release-mutation-values.js";

export const JIRA_VERSION_LINK_MUTATIONS = JIRA_VERSION_REMOTE_LINK_MUTATIONS;
export type JiraVersionLinkMutation = JiraVersionRemoteLinkMutation;
export type JiraVersionLinkReceipt = JiraMutationReceipt;
/** Leaves half of the existing 32-KiB native-write result budget for outcome, failure detail and binding. */
export const VERSION_LINK_RECEIPT_BYTES_MAX = 16_384;
export type VersionLinkFailure = Omit<Extract<JiraMutationAttempt, { readonly ok: false }>, "receipt"> & { readonly receipt?: JiraVersionLinkReceipt };
export type JiraVersionLinkAttempt = VersionLinkFailure | { readonly ok: true; readonly receipt: JiraVersionLinkReceipt };
export type VersionLinkObservation<T> = VersionLinkFailure | { readonly ok: true; readonly value: T };
export interface VersionLink { readonly globalId: string; readonly value: CatalogJsonValue }
export interface VersionLinkInput {
  readonly operation: JiraVersionLinkMutation;
  readonly selected: ReleaseSelection;
  readonly expected: readonly VersionLink[];
  readonly desired: readonly VersionLink[];
  readonly globalId?: string;
  readonly value?: CatalogJsonValue;
}
export const VERSION_LINK_MALFORMED: VersionLinkFailure = { ok: false, reason: "malformed-payload" };
const CONTEXT = ["versionId", "expectedProjectId", "expectedActorKey", "expectedVersionSnapshot", "expectedLinks"];
const ITEM_FIELDS = new Set(["globalId", "valueNodes"]);
const INVALID_INPUT: VersionLinkFailure = { ok: false, reason: "field-validation", detail: { messages: [
  "Supply the complete reviewed link set with distinct exact global IDs and complete typed values; selected path identities and explicit all-links acceptance must be valid. Nothing was written.",
] } };
export function versionLinkRefusal(message: string, reason: VersionLinkFailure["reason"] = "field-validation", receipt?: JiraVersionLinkReceipt): VersionLinkFailure {
  return { ok: false, reason, detail: { messages: [message] }, ...(receipt === undefined ? {} : { receipt }) };
}
function expectedLink(raw: unknown): VersionLinkObservation<VersionLink> {
  const row = asRecord(raw);
  if (row === undefined || Object.keys(row).length !== 2 || !Object.keys(row).every((key) => ITEM_FIELDS.has(key)) ||
    !versionLinkGlobalId(row.globalId, false)) return INVALID_INPUT;
  const decoded = decodeJiraPropertyInput(row.valueNodes);
  return decoded.ok ? { ok: true, value: { globalId: row.globalId, value: decoded.value } }
    : versionLinkRefusal("Supply the complete bounded typed link value.", decoded.reason === "bounds-exceeded" ? decoded.reason : "field-validation");
}
function expectedLinks(raw: unknown): VersionLinkObservation<readonly VersionLink[]> {
  const values = asArray(raw);
  if (values === undefined) return INVALID_INPUT;
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return { ok: false, reason: "bounds-exceeded" };
  const links: VersionLink[] = [];
  const identities = new Set<string>();
  let bytes = 0;
  for (const value of values) {
    const selected = expectedLink(value);
    if (!selected.ok) return selected;
    const row = selected.value;
    if (identities.has(row.globalId)) return INVALID_INPUT;
    bytes += Buffer.byteLength(JSON.stringify(row.value), "utf8") + Buffer.byteLength(row.globalId, "utf8");
    if (bytes > TOOL_CATALOG_LIMITS.maxArgumentBytes) return { ok: false, reason: "bounds-exceeded" };
    identities.add(row.globalId);
    links.push(row);
  }
  return { ok: true, value: links };
}
function inputFields(operation: JiraVersionLinkMutation): ReadonlySet<string> {
  if (operation === "jira.delete-version-remote-links") return new Set([...CONTEXT, "confirmAll"]);
  return new Set([...CONTEXT, "globalId", ...(operation === "jira.delete-version-remote-link" ? [] : ["valueNodes"])]);
}
function newValue(operation: JiraVersionLinkMutation, nodes: unknown, globalId: string): VersionLinkObservation<CatalogJsonValue> {
  const decoded = decodeJiraPropertyInput(nodes);
  if (!decoded.ok) return versionLinkRefusal("Supply the complete bounded new value, with literal null/empty values preserved.", decoded.reason === "bounds-exceeded" ? decoded.reason : "field-validation");
  const object = asRecord(decoded.value);
  // Collection POST chooses globalId from the actual JSON; never request generated-ID inference.
  if (operation === "jira.upsert-version-remote-link" && object?.globalId !== globalId) return versionLinkRefusal("Collection POST requires the exact reviewed globalId in the native object value; generated IDs are not supported.");
  if (object !== undefined && Object.hasOwn(object, "globalId") && object.globalId !== globalId)
    return versionLinkRefusal("The native value's globalId contradicts the selected fixed resource.");
  return decoded;
}
function selectedInput(operation: JiraVersionLinkMutation, args: CatalogJsonObject, selected: ReleaseSelection, expected: readonly VersionLink[]): VersionLinkObservation<VersionLinkInput> {
  const base = { operation, selected, expected };
  if (operation === "jira.delete-version-remote-links") return args.confirmAll === true
    ? { ok: true, value: { ...base, desired: [] } } : INVALID_INPUT;
  if (!versionLinkGlobalId(args.globalId, operation !== "jira.upsert-version-remote-link")) return INVALID_INPUT;
  const globalId = args.globalId;
  const retained = expected.filter((item) => item.globalId !== globalId);
  if (operation === "jira.delete-version-remote-link") return retained.length < expected.length
    ? { ok: true, value: { ...base, globalId, desired: retained } } : versionLinkRefusal("The exact link must be present in the complete reviewed set before deletion.");
  const decoded = newValue(operation, args.valueNodes, globalId);
  return decoded.ok ? { ok: true, value: { ...base, globalId, value: decoded.value, desired: [...retained, { globalId, value: decoded.value }] } } : decoded;
}
export function parseVersionLinkInput(operation: JiraVersionLinkMutation, args: CatalogJsonObject): VersionLinkObservation<VersionLinkInput> {
  const selected = releaseSelection("version", args);
  if (selected === undefined || !releaseExactFields(args, inputFields(operation))) return versionLinkRefusal("Review the exact actor, project, complete version snapshot and complete native link set. No URL, headers, generated-ID mode or extra input is supported.");
  const expected = expectedLinks(args.expectedLinks);
  return expected.ok ? selectedInput(operation, args, selected, expected.value) : expected;
}
export function sameVersionLinks(left: readonly VersionLink[], right: readonly VersionLink[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item) => {
    const expected = right.find((candidate) => candidate.globalId === item.globalId);
    return expected !== undefined && jiraPropertyStatesEqual({ present: true, value: item.value }, { present: true, value: expected.value });
  });
}
function bindNativeLink(raw: unknown, versionId: string, expected: readonly VersionLink[]): VersionLinkObservation<VersionLink> {
  const row = asRecord(raw);
  if (row === undefined) return VERSION_LINK_MALFORMED;
  const matches = expected.filter((item) => jiraResourceSelfMatches(row.self, `version/${versionId}/remotelink/${encodeURIComponent(item.globalId)}`));
  const identity = matches.length === 1 ? matches[0] : undefined;
  if (identity === undefined) return versionLinkRefusal("The native link cannot be bound to one reviewed identity. Read and review the complete link set; opaque or contradictory self references cannot authorize a change.", "conflict");
  const projected = projectJiraRemoteVersionLinkValue(row.link);
  if ("reason" in projected) return { ok: false, reason: projected.reason };
  if (projected.item.valueAvailable !== true) return versionLinkRefusal("A complete native link value is unavailable; missing content is not null or empty.", "conflict");
  const decoded = decodeJiraPropertyInput(projected.item.valueNodes);
  return decoded.ok ? { ok: true, value: { globalId: identity.globalId, value: decoded.value } } : VERSION_LINK_MALFORMED;
}
/** This published native method returns every link for the bound version, without pagination.
 * Each row must match exactly one reviewed self path and complete typed content. No URI is followed.
 */
export async function readVersionLinkSet(request: JiraMutationRequest, versionId: string, expected: readonly VersionLink[]): Promise<VersionLinkObservation<readonly VersionLink[]>> {
  const response = await request(`version/${versionId}/remotelink`, "GET", undefined, "json");
  if (!response.ok) return dispatchFailure(response);
  const rows = response.status === 200 ? asArray(response.body?.links) : undefined;
  if (rows === undefined) return VERSION_LINK_MALFORMED;
  if (rows.length > TOOL_CATALOG_LIMITS.maxArrayItems) return { ok: false, reason: "bounds-exceeded" };
  if (rows.length !== expected.length) return versionLinkRefusal("The complete native link set differs from the reviewed expected set.", "conflict");
  const links: VersionLink[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const bound = bindNativeLink(row, versionId, expected);
    if (!bound.ok) return bound;
    if (seen.has(bound.value.globalId)) return VERSION_LINK_MALFORMED;
    seen.add(bound.value.globalId);
    links.push(bound.value);
  }
  return { ok: true, value: links };
}
