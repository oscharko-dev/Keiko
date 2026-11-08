import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { jiraIssueLinkTypeProjection } from "./jira-managed-issue-details.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { jiraNativeId } from "./jira-native-values.js";
import { jiraResourceSelfMatches } from "./jira-resource-self.js";
import { LINK_MALFORMED, bindLinkIssue, linkConflict, type LinkIssue, type LinkObservation } from "./jira-link-mutation-values.js";

export interface NativeLinkType { readonly id: string; readonly name: string; readonly inward: string; readonly outward: string }
export interface NativeIssueEdge { readonly id: string; readonly type: NativeLinkType; readonly direction: "inward" | "outward"; readonly otherId: string; readonly otherKey: string }
export interface IssueLinkState { readonly issue: LinkIssue; readonly edges: readonly NativeIssueEdge[] }
export function nativeLinkType(value: unknown): NativeLinkType | undefined {
  const item = jiraIssueLinkTypeProjection(value);
  return item !== undefined && typeof item.id === "string" && typeof item.name === "string" && typeof item.inward === "string" && typeof item.outward === "string"
    ? { id: item.id, name: item.name, inward: item.inward, outward: item.outward } : undefined;
}
export function sameLinkType(left: NativeLinkType, right: NativeLinkType): boolean {
  return left.id === right.id && left.name === right.name && left.inward === right.inward && left.outward === right.outward;
}
export async function readLinkType(request: JiraMutationRequest, expected: NativeLinkType): Promise<LinkObservation<NativeLinkType>> {
  const response = await request(`issueLinkType/${expected.id}`);
  if (!response.ok) return dispatchFailure(response);
  const type = response.status === 200 ? nativeLinkType(response.body) : undefined;
  if (type === undefined) return LINK_MALFORMED;
  return sameLinkType(type, expected) ? { ok: true, value: type }
    : linkConflict("The link type identity or relation labels changed after review. Read the current type before changing a relation.");
}
function edge(value: unknown): NativeIssueEdge | undefined {
  const raw = asRecord(value);
  const type = nativeLinkType(raw?.type);
  if (!jiraNativeId(raw?.id) || type === undefined) return undefined;
  if (raw.self !== undefined && raw.self !== null && !jiraResourceSelfMatches(raw.self, `issueLink/${raw.id}`)) return undefined;
  const inward = asRecord(raw.inwardIssue);
  const outward = asRecord(raw.outwardIssue);
  if ((inward === undefined) === (outward === undefined)) return undefined;
  const other = inward ?? outward;
  if (!jiraNativeId(other?.id) || !isSafeAtlassianIdentifier(other.key)) return undefined;
  return { id: raw.id, type, direction: inward === undefined ? "outward" : "inward", otherId: other.id, otherKey: other.key };
}
export async function readIssueLinkState(request: JiraMutationRequest, target: string): Promise<LinkObservation<IssueLinkState>> {
  const bound = await bindLinkIssue(request, target, ["issuelinks"]);
  if (!bound.ok) return bound;
  const values = asArray(bound.value.fields.issuelinks);
  if (values === undefined) return LINK_MALFORMED;
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return { ok: false, reason: "bounds-exceeded" };
  const edges: NativeIssueEdge[] = [];
  const ids = new Set<string>();
  for (const value of values) {
    const item = edge(value);
    if (item === undefined || ids.has(item.id)) return LINK_MALFORMED;
    ids.add(item.id);
    edges.push(item);
  }
  return { ok: true, value: { issue: bound.value, edges } };
}
export function sameIssueEdges(left: readonly NativeIssueEdge[], right: readonly NativeIssueEdge[]): boolean {
  return left.length === right.length && left.every((item) => right.some((other) => item.id === other.id && item.direction === other.direction && item.otherId === other.otherId && item.otherKey === other.otherKey && sameLinkType(item.type, other.type)));
}
export function matchingIssueEdges(state: IssueLinkState, other: LinkIssue, type: NativeLinkType, direction: "inward" | "outward"): readonly NativeIssueEdge[] {
  const symmetric = type.inward.toLowerCase() === type.outward.toLowerCase();
  return state.edges.filter((item) => item.otherId === other.id && item.otherKey === other.key && sameLinkType(item.type, type) && (symmetric || item.direction === direction));
}
export function edgeFields(edges: readonly NativeIssueEdge[]): readonly CatalogJsonObject[] {
  return edges.map((item) => ({ id: item.id, type: { ...item.type }, [`${item.direction}Issue`]: { id: item.otherId, key: item.otherKey } }));
}
function issueRefMatches(value: unknown, expected: LinkIssue): boolean {
  const raw = asRecord(value);
  return raw?.id === expected.id && raw.key === expected.key;
}
export async function confirmIssueLinkIdentity(request: JiraMutationRequest, linkId: string, type: NativeLinkType, inward: LinkIssue, outward: LinkIssue): Promise<LinkObservation<true>> {
  const response = await request(`issueLink/${linkId}`);
  if (!response.ok) return dispatchFailure(response);
  const raw = response.body;
  const observed = nativeLinkType(raw?.type);
  if (response.status !== 200 || raw?.id !== linkId || observed === undefined) return LINK_MALFORMED;
  if (raw.self !== undefined && raw.self !== null && !jiraResourceSelfMatches(raw.self, `issueLink/${linkId}`)) return LINK_MALFORMED;
  const ordered = issueRefMatches(raw.inwardIssue, inward) && issueRefMatches(raw.outwardIssue, outward);
  const symmetric = type.inward.toLowerCase() === type.outward.toLowerCase() && issueRefMatches(raw.inwardIssue, outward) && issueRefMatches(raw.outwardIssue, inward);
  return sameLinkType(type, observed) && (ordered || symmetric) ? { ok: true, value: true }
    : linkConflict("The exact link no longer binds the reviewed type and both native issues. No different relation is substituted.");
}
