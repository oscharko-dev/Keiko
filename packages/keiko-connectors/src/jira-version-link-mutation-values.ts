import {
  type JiraVersionRemoteLinkMutation,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { JIRA_PROPERTY_VALUE_MAX_BYTES } from "./jira-entity-property-values.js";
import { decodeJiraPropertyInput } from "./jira-entity-property-input.js";
import { jiraPropertyStatesEqual } from "./jira-entity-property-write-admission.js";
import {
  projectJiraRemoteVersionLinkValue,
  jiraRemoteVersionLinkGlobalId as versionLinkGlobalId,
} from "./jira-managed-remote-version-links.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { jiraResourceSelfMatches } from "./jira-resource-self.js";
import {
  releaseExactFields,
  releaseSelection,
  type ReleaseSelection,
} from "./jira-release-mutation-values.js";

export { JIRA_VERSION_REMOTE_LINK_MUTATIONS as JIRA_VERSION_LINK_MUTATIONS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
export type JiraVersionLinkMutation = JiraVersionRemoteLinkMutation;
export type JiraVersionLinkReceipt = JiraMutationReceipt;
/** Leaves half of the existing 32-KiB native-write result budget for outcome, failure detail and binding. */
export const VERSION_LINK_RECEIPT_BYTES_MAX = 16_384;
export type VersionLinkFailure = Omit<
  Extract<JiraMutationAttempt, { readonly ok: false }>,
  "receipt"
> & { readonly receipt?: JiraVersionLinkReceipt };
export type JiraVersionLinkAttempt =
  VersionLinkFailure | { readonly ok: true; readonly receipt: JiraVersionLinkReceipt };
export type VersionLinkObservation<T> =
  VersionLinkFailure | { readonly ok: true; readonly value: T };
export interface VersionLink {
  readonly globalId: string;
  readonly value: CatalogJsonValue;
}
export interface VersionLinkInput {
  readonly operation: JiraVersionLinkMutation;
  readonly selected: ReleaseSelection;
  readonly expected: readonly VersionLink[];
  readonly desired: readonly VersionLink[];
  readonly globalId?: string;
  readonly value?: CatalogJsonValue;
}
export const VERSION_LINK_MALFORMED: VersionLinkFailure = {
  ok: false,
  reason: "malformed-payload",
};
const CONTEXT = [
  "versionId",
  "expectedProjectId",
  "expectedActorKey",
  "expectedVersionSnapshot",
  "expectedLinks",
];
const ITEM_FIELDS = new Set(["globalId", "valueNodes"]);
const NOT_WRITTEN = "Nothing was written.";
/** Largest value a link or a new value may carry, as the property value reader bounds it. */
const VALUE_BYTES = String(JIRA_PROPERTY_VALUE_MAX_BYTES);
// One sentence per cause (#4357 AC3), each within the 200-byte bound of a detail message so the bound
// never cuts the rule, and none naming a refused value.
const EXPECTED_NOT_LIST = `expectedLinks must be the complete current list of the version's remote links, each as { globalId, valueNodes }. ${NOT_WRITTEN}`;
const EXPECTED_ROW = `Each expectedLinks entry takes exactly globalId and valueNodes, as the version's remote link read lists them. ${NOT_WRITTEN}`;
const GLOBAL_ID_RULE = `A globalId is text of at most 2048 characters without control characters; one that selects a link also has no / \\ or % and is not . or .. ${NOT_WRITTEN}`;
const EXPECTED_DUPLICATE = `expectedLinks must not repeat a globalId: list each remote link of the version once. ${NOT_WRITTEN}`;
const CONFIRM_ALL = `Deleting all remote links takes confirmAll:true and expectedLinks, the complete current list. ${NOT_WRITTEN}`;
const TOO_MANY_LINKS = `expectedLinks holds more links, or more argument bytes, than Keiko can review in one call. ${NOT_WRITTEN}`;
function invalid(message: string, fieldId?: string): VersionLinkFailure {
  return {
    ok: false,
    reason: "field-validation",
    detail: {
      ...(fieldId === undefined ? {} : { fieldId }),
      validation: "invalid-field",
      messages: [message],
    },
  };
}
export function versionLinkRefusal(
  message: string,
  reason: VersionLinkFailure["reason"] = "field-validation",
  receipt?: JiraVersionLinkReceipt,
): VersionLinkFailure {
  return {
    ok: false,
    reason,
    detail: { messages: [message] },
    ...(receipt === undefined ? {} : { receipt }),
  };
}
function tooManyLinks(): VersionLinkFailure {
  return versionLinkRefusal(TOO_MANY_LINKS, "bounds-exceeded");
}
/** A value that failed decoding: too large is its own cause, with the field that carried it. */
function valueRefusal(
  message: string,
  cause: "invalid-input" | "bounds-exceeded",
  fieldId: string,
): VersionLinkFailure {
  return {
    ok: false,
    reason: cause === "bounds-exceeded" ? "bounds-exceeded" : "field-validation",
    detail: {
      fieldId,
      validation: cause === "bounds-exceeded" ? "bounds-exceeded" : "invalid-field",
      messages: [message],
    },
  };
}
function expectedLink(raw: unknown): VersionLinkObservation<VersionLink> {
  const row = asRecord(raw);
  if (
    row === undefined ||
    Object.keys(row).length !== 2 ||
    !Object.keys(row).every((key) => ITEM_FIELDS.has(key))
  )
    return invalid(EXPECTED_ROW, "expectedLinks");
  if (!versionLinkGlobalId(row.globalId, false)) return invalid(GLOBAL_ID_RULE, "expectedLinks");
  const decoded = decodeJiraPropertyInput(row.valueNodes);
  if (decoded.ok) {
    return { ok: true, value: { globalId: row.globalId, value: decoded.value } };
  }
  return valueRefusal(
    `Each expectedLinks valueNodes must be that link's complete typed value, within ${VALUE_BYTES} UTF-8 JSON bytes and the depth and node limits. ${NOT_WRITTEN}`,
    decoded.reason,
    "expectedLinks",
  );
}
function expectedLinks(raw: unknown): VersionLinkObservation<readonly VersionLink[]> {
  const values = asArray(raw);
  if (values === undefined) return invalid(EXPECTED_NOT_LIST, "expectedLinks");
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return tooManyLinks();
  const links: VersionLink[] = [];
  const identities = new Set<string>();
  let bytes = 0;
  for (const value of values) {
    const selected = expectedLink(value);
    if (!selected.ok) return selected;
    const row = selected.value;
    if (identities.has(row.globalId)) return invalid(EXPECTED_DUPLICATE, "expectedLinks");
    bytes +=
      Buffer.byteLength(JSON.stringify(row.value), "utf8") +
      Buffer.byteLength(row.globalId, "utf8");
    if (bytes > TOOL_CATALOG_LIMITS.maxArgumentBytes) return tooManyLinks();
    identities.add(row.globalId);
    links.push(row);
  }
  return { ok: true, value: links };
}
function inputFields(operation: JiraVersionLinkMutation): ReadonlySet<string> {
  if (operation === "jira.delete-version-remote-links") return new Set([...CONTEXT, "confirmAll"]);
  return new Set([
    ...CONTEXT,
    "globalId",
    ...(operation === "jira.delete-version-remote-link" ? [] : ["valueNodes"]),
  ]);
}
function newValue(
  operation: JiraVersionLinkMutation,
  nodes: unknown,
  globalId: string,
): VersionLinkObservation<CatalogJsonValue> {
  const decoded = decodeJiraPropertyInput(nodes);
  if (!decoded.ok)
    return valueRefusal(
      `valueNodes must be the complete new link value as typed nodes, null and empty values kept, within ${VALUE_BYTES} UTF-8 JSON bytes. ${NOT_WRITTEN}`,
      decoded.reason,
      "valueNodes",
    );
  const object = asRecord(decoded.value);
  // Collection POST chooses globalId from the actual JSON; never request generated-ID inference.
  if (operation === "jira.upsert-version-remote-link" && object?.globalId !== globalId)
    return versionLinkRefusal(
      "Collection POST requires the exact reviewed globalId in the native object value; generated IDs are not supported.",
    );
  if (object !== undefined && Object.hasOwn(object, "globalId") && object.globalId !== globalId)
    return versionLinkRefusal(
      "The native value's globalId contradicts the selected fixed resource.",
    );
  return decoded;
}
function selectedInput(
  operation: JiraVersionLinkMutation,
  args: CatalogJsonObject,
  selected: ReleaseSelection,
  expected: readonly VersionLink[],
): VersionLinkObservation<VersionLinkInput> {
  const base = { operation, selected, expected };
  if (operation === "jira.delete-version-remote-links")
    return args.confirmAll === true
      ? { ok: true, value: { ...base, desired: [] } }
      : invalid(CONFIRM_ALL, "confirmAll");
  if (!versionLinkGlobalId(args.globalId, operation !== "jira.upsert-version-remote-link"))
    return invalid(GLOBAL_ID_RULE, "globalId");
  const globalId = args.globalId;
  const retained = expected.filter((item) => item.globalId !== globalId);
  if (operation === "jira.delete-version-remote-link")
    return retained.length < expected.length
      ? { ok: true, value: { ...base, globalId, desired: retained } }
      : versionLinkRefusal(
          "The exact link must be present in the complete reviewed set before deletion.",
        );
  const decoded = newValue(operation, args.valueNodes, globalId);
  return decoded.ok
    ? {
        ok: true,
        value: {
          ...base,
          globalId,
          value: decoded.value,
          desired: [...retained, { globalId, value: decoded.value }],
        },
      }
    : decoded;
}
export function parseVersionLinkInput(
  operation: JiraVersionLinkMutation,
  args: CatalogJsonObject,
): VersionLinkObservation<VersionLinkInput> {
  const fields = inputFields(operation);
  if (!releaseExactFields(args, fields))
    return invalid(`This call takes only ${[...fields].join(", ")}. ${NOT_WRITTEN}`);
  const selected = releaseSelection("version", args);
  if (selected === undefined)
    return invalid(
      `versionId, expectedProjectId, expectedActorKey and expectedVersionSnapshot must be exactly as the version read lists them, the snapshot with every field. ${NOT_WRITTEN}`,
    );
  const expected = expectedLinks(args.expectedLinks);
  return expected.ok ? selectedInput(operation, args, selected, expected.value) : expected;
}
export function sameVersionLinks(
  left: readonly VersionLink[],
  right: readonly VersionLink[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((item) => {
    const expected = right.find((candidate) => candidate.globalId === item.globalId);
    return (
      expected !== undefined &&
      jiraPropertyStatesEqual(
        { present: true, value: item.value },
        { present: true, value: expected.value },
      )
    );
  });
}
function bindNativeLink(
  raw: unknown,
  versionId: string,
  expected: readonly VersionLink[],
): VersionLinkObservation<VersionLink> {
  const row = asRecord(raw);
  if (row === undefined) return VERSION_LINK_MALFORMED;
  const matches = expected.filter((item) =>
    jiraResourceSelfMatches(
      row.self,
      `version/${versionId}/remotelink/${encodeURIComponent(item.globalId)}`,
    ),
  );
  const identity = matches.length === 1 ? matches[0] : undefined;
  if (identity === undefined)
    return versionLinkRefusal(
      "The native link cannot be bound to one reviewed identity. Read and review the complete link set; opaque or contradictory self references cannot authorize a change.",
      "conflict",
    );
  const projected = projectJiraRemoteVersionLinkValue(row.link);
  if ("reason" in projected) return { ok: false, reason: projected.reason };
  if (projected.item.valueAvailable !== true)
    return versionLinkRefusal(
      "A complete native link value is unavailable; missing content is not null or empty.",
      "conflict",
    );
  const decoded = decodeJiraPropertyInput(projected.item.valueNodes);
  return decoded.ok
    ? { ok: true, value: { globalId: identity.globalId, value: decoded.value } }
    : VERSION_LINK_MALFORMED;
}
/** This published native method returns every link for the bound version, without pagination.
 * Each row must match exactly one reviewed self path and complete typed content. No URI is followed.
 */
export async function readVersionLinkSet(
  request: JiraMutationRequest,
  versionId: string,
  expected: readonly VersionLink[],
): Promise<VersionLinkObservation<readonly VersionLink[]>> {
  const response = await request(`version/${versionId}/remotelink`, "GET", undefined, "json");
  if (!response.ok) return dispatchFailure(response);
  const rows = response.status === 200 ? asArray(response.body?.links) : undefined;
  if (rows === undefined) return VERSION_LINK_MALFORMED;
  if (rows.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return { ok: false, reason: "bounds-exceeded" };
  if (rows.length !== expected.length)
    return versionLinkRefusal(
      "The complete native link set differs from the reviewed expected set.",
      "conflict",
    );
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
