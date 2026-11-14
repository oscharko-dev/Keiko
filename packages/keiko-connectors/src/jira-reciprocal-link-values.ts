import {
  isSafeAtlassianConnectorBaseUrl,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraBrowseUrl } from "./jira-browse-url.js";
import { issueLifecycleReview, type IssueLifecycleReview } from "./jira-issue-lifecycle-values.js";
import { jiraNativeId } from "./jira-native-values.js";
import { savedExactKeys, savedText } from "./jira-saved-configuration-values.js";

export interface ReciprocalApplication {
  readonly id: string;
  readonly name: string;
  readonly displayUrl: string;
  readonly rpcUrl: string;
}
export interface ReciprocalManifest {
  readonly id: string;
  readonly name: string;
}
export interface ReciprocalInput {
  readonly actor: string;
  readonly issue: IssueLifecycleReview;
  readonly application: ReciprocalApplication;
  readonly remoteId: string;
  readonly remoteTitle: string;
  readonly sourceRelationship: string;
  readonly targetRelationship: string;
}
export interface ReciprocalReceipt extends JiraMutationReceipt {
  readonly userKey: string;
  readonly applicationLinkId: string;
  readonly applicationLinkDestinationDigest: string;
  readonly selectedRemoteIssueId: string;
  readonly delegatedEffectRequested: true;
}
export type ReciprocalFailure = Omit<Extract<JiraMutationAttempt, { ok: false }>, "receipt"> & {
  readonly receipt?: ReciprocalReceipt;
};
export type ReciprocalAttempt =
  ReciprocalFailure | { readonly ok: true; readonly receipt: Record<string, never> };
export type ReciprocalObservation<T> = ReciprocalFailure | { readonly ok: true; readonly value: T };
export const RECIPROCAL_MALFORMED: ReciprocalFailure = { ok: false, reason: "malformed-payload" };
export function reciprocalFailure(
  value: Extract<JiraMutationAttempt, { ok: false }>,
): ReciprocalFailure {
  return {
    ok: false,
    reason: value.reason,
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    ...(value.violations === undefined ? {} : { violations: value.violations }),
  };
}
export function reciprocalRefusal(
  message: string,
  reason: "field-validation" | "conflict" | "unavailable" = "field-validation",
): ReciprocalFailure {
  return { ok: false, reason, detail: { messages: [message] } };
}
export function jiraApplicationLinkId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
  );
}
function destination(value: unknown): value is string {
  return (
    isSafeAtlassianConnectorBaseUrl(value) &&
    savedText(value, 2048) &&
    !/[\s\\]/u.test(value) &&
    !/%(?:2e|2f|5c|25)/iu.test(new URL(value).pathname)
  );
}
const APPLICATION_KEYS = new Set(["id", "name", "displayUrl", "rpcUrl"]);
export function reciprocalApplication(
  value: unknown,
  exact = false,
): ReciprocalApplication | undefined {
  const raw = asRecord(value);
  if (raw === undefined || (exact && !savedExactKeys(raw, APPLICATION_KEYS))) return undefined;
  return jiraApplicationLinkId(raw.id) &&
    savedText(raw.name, 255) &&
    destination(raw.displayUrl) &&
    destination(raw.rpcUrl)
    ? { id: raw.id, name: raw.name, displayUrl: raw.displayUrl, rpcUrl: raw.rpcUrl }
    : undefined;
}
export function reciprocalManifest(value: unknown): ReciprocalManifest | undefined {
  const raw = asRecord(value);
  return raw?.typeId === "jira" && jiraApplicationLinkId(raw.id) && savedText(raw.name, 255)
    ? { id: raw.id, name: raw.name }
    : undefined;
}
const INPUT_KEYS = new Set([
  "expectedActorKey",
  "expectedIssue",
  "expectedApplication",
  "remoteIssueId",
  "remoteIssueTitle",
  "sourceRelationship",
  "targetRelationship",
  "expectLocalLinkAbsent",
  "acceptNativeDelegatedEffect",
]);
function remoteFields(
  args: CatalogJsonObject,
):
  | Pick<ReciprocalInput, "remoteId" | "remoteTitle" | "sourceRelationship" | "targetRelationship">
  | undefined {
  return jiraNativeId(args.remoteIssueId) &&
    savedText(args.remoteIssueTitle, 255) &&
    savedText(args.sourceRelationship, 255) &&
    savedText(args.targetRelationship, 255)
    ? {
        remoteId: args.remoteIssueId,
        remoteTitle: args.remoteIssueTitle,
        sourceRelationship: args.sourceRelationship,
        targetRelationship: args.targetRelationship,
      }
    : undefined;
}
export function parseReciprocalInput(args: CatalogJsonObject): ReciprocalInput | undefined {
  if (
    !savedExactKeys(args, INPUT_KEYS) ||
    !savedText(args.expectedActorKey, 255) ||
    args.expectLocalLinkAbsent !== true ||
    args.acceptNativeDelegatedEffect !== true
  )
    return undefined;
  const issue = issueLifecycleReview(args.expectedIssue);
  const application = reciprocalApplication(args.expectedApplication, true);
  const remote = remoteFields(args);
  if (issue === undefined || application === undefined || remote === undefined) return undefined;
  return new TextEncoder().encode(JSON.stringify(args)).byteLength <=
    TOOL_CATALOG_LIMITS.maxArgumentBytes
    ? { actor: args.expectedActorKey, issue, application, ...remote }
    : undefined;
}
const NOTHING_CHANGED = "Nothing was changed.";
/**
 * The cause of a refused input, one sentence each (#4357 AC3): it names the rule the model must
 * satisfy and never the refused value. Every text fits the 200-byte bound of a detail message, so
 * the bound cannot cut the rule. It follows the order of `parseReciprocalInput`.
 */
export function reciprocalInputRefusal(args: CatalogJsonObject): ReciprocalFailure {
  const refusal = (...messages: readonly string[]): ReciprocalFailure => ({
    ok: false,
    reason: "field-validation",
    detail: { validation: "invalid-field", messages },
  });
  if (!savedExactKeys(args, INPUT_KEYS))
    return refusal(
      "This call takes only expectedActorKey, expectedIssue, expectedApplication, remoteIssueId, remoteIssueTitle,",
      `sourceRelationship, targetRelationship, expectLocalLinkAbsent and acceptNativeDelegatedEffect. ${NOTHING_CHANGED}`,
    );
  if (!savedText(args.expectedActorKey, 255))
    return refusal(
      `expectedActorKey must be the key of the connected Jira user; jira.myself returns it. ${NOTHING_CHANGED}`,
    );
  if (args.expectLocalLinkAbsent !== true || args.acceptNativeDelegatedEffect !== true)
    return refusal(
      `Send expectLocalLinkAbsent:true and acceptNativeDelegatedEffect:true: the local link must not exist yet, and Jira performs the reciprocal effect itself. ${NOTHING_CHANGED}`,
    );
  if (issueLifecycleReview(args.expectedIssue) === undefined)
    return refusal(
      `expectedIssue must be the issue as reviewed: id, key, summary, projectId and issueTypeId, nothing else. ${NOTHING_CHANGED}`,
    );
  if (reciprocalApplication(args.expectedApplication, true) === undefined)
    return refusal(
      `expectedApplication must be the configured application link: id (UUID), name, displayUrl and rpcUrl, both HTTPS without credentials, query or fragment, at most 2048 characters. ${NOTHING_CHANGED}`,
    );
  // The remote issue is the last input the parser checks; the byte limit of one call cannot be
  // reached by values that pass the field limits above.
  return refusal(
    `remoteIssueId must be a numeric ID; remoteIssueTitle, sourceRelationship and targetRelationship must be text of at most 255 characters. ${NOTHING_CHANGED}`,
  );
}
export function reciprocalGlobalId(applicationId: string, issueId: string): string {
  return `appId=${applicationId}&issueId=${issueId}`;
}
export function sameReciprocalApplication(
  left: ReciprocalApplication,
  right: ReciprocalApplication,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.displayUrl === right.displayUrl &&
    left.rpcUrl === right.rpcUrl
  );
}
export function reciprocalReceipt(input: ReciprocalInput): ReciprocalReceipt {
  return Object.freeze({
    userKey: input.actor,
    issueId: input.issue.id,
    issueKey: input.issue.key,
    applicationLinkId: input.application.id,
    applicationLinkDestinationDigest: sha256Hex(
      JSON.stringify([input.application.displayUrl, input.application.rpcUrl]),
    ),
    selectedRemoteIssueId: input.remoteId,
    delegatedEffectRequested: true,
  });
}
/** Atlassian's explicit reciprocal example reverses the apparent labels: source is the link
 * stored locally pointing to the remote issue, target is the backlink sent to the remote Jira.
 * https://confluence.atlassian.com/adminjiraserver/preparing-for-jira-10-6-1540228562.html */
export function reciprocalBody(
  input: ReciprocalInput,
  manifest: ReciprocalManifest,
  baseUrl: string,
): CatalogJsonObject | undefined {
  const remoteUrl = jiraBrowseUrl(input.application.displayUrl, input.remoteId);
  const localUrl = jiraBrowseUrl(baseUrl, input.issue.id);
  if (remoteUrl === undefined || localUrl === undefined) return undefined;
  return {
    source: {
      application: { type: "com.atlassian.jira", name: input.application.name },
      globalId: reciprocalGlobalId(input.application.id, input.remoteId),
      relationship: input.sourceRelationship,
      object: { url: remoteUrl, title: input.remoteTitle },
    },
    target: {
      application: { type: "com.atlassian.jira", name: manifest.name },
      globalId: reciprocalGlobalId(manifest.id, input.issue.id),
      relationship: input.targetRelationship,
      object: { url: localUrl, title: input.issue.key, summary: input.issue.summary },
    },
  };
}
