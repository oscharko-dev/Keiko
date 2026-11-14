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
/** Longest text of an actor key, an application or link name and a relationship; longest destination. */
const TEXT_MAX_CHARS = 255;
const URL_MAX_CHARS = 2048;
function destination(value: unknown): value is string {
  return (
    isSafeAtlassianConnectorBaseUrl(value) &&
    savedText(value, URL_MAX_CHARS) &&
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
    savedText(raw.name, TEXT_MAX_CHARS) &&
    destination(raw.displayUrl) &&
    destination(raw.rpcUrl)
    ? { id: raw.id, name: raw.name, displayUrl: raw.displayUrl, rpcUrl: raw.rpcUrl }
    : undefined;
}
export function reciprocalManifest(value: unknown): ReciprocalManifest | undefined {
  const raw = asRecord(value);
  return raw?.typeId === "jira" &&
    jiraApplicationLinkId(raw.id) &&
    savedText(raw.name, TEXT_MAX_CHARS)
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
    savedText(args.remoteIssueTitle, TEXT_MAX_CHARS) &&
    savedText(args.sourceRelationship, TEXT_MAX_CHARS) &&
    savedText(args.targetRelationship, TEXT_MAX_CHARS)
    ? {
        remoteId: args.remoteIssueId,
        remoteTitle: args.remoteIssueTitle,
        sourceRelationship: args.sourceRelationship,
        targetRelationship: args.targetRelationship,
      }
    : undefined;
}
/** The one check order of an input, named by its first broken rule. */
export type ReciprocalInputCause =
  "arguments" | "actor" | "acceptance" | "issue" | "application" | "remote" | "size";
export type ReciprocalInputCheck =
  | { readonly ok: true; readonly input: ReciprocalInput }
  | { readonly ok: false; readonly cause: ReciprocalInputCause };
const refused = (name: ReciprocalInputCause): ReciprocalInputCheck => ({ ok: false, cause: name });
/**
 * The input of one reciprocal link, or the first rule it breaks. The parser and the sentence a
 * refused model reads both come from this one function (#4357 AC3), so they cannot drift apart.
 */
export function checkReciprocalInput(
  args: CatalogJsonObject,
  maxBytes: number = TOOL_CATALOG_LIMITS.maxArgumentBytes,
): ReciprocalInputCheck {
  if (!savedExactKeys(args, INPUT_KEYS)) return refused("arguments");
  if (!savedText(args.expectedActorKey, TEXT_MAX_CHARS)) return refused("actor");
  if (args.expectLocalLinkAbsent !== true || args.acceptNativeDelegatedEffect !== true)
    return refused("acceptance");
  const issue = issueLifecycleReview(args.expectedIssue);
  if (issue === undefined) return refused("issue");
  const application = reciprocalApplication(args.expectedApplication, true);
  if (application === undefined) return refused("application");
  const remote = remoteFields(args);
  if (remote === undefined) return refused("remote");
  if (new TextEncoder().encode(JSON.stringify(args)).byteLength > maxBytes) return refused("size");
  return { ok: true, input: { actor: args.expectedActorKey, issue, application, ...remote } };
}
const NOTHING_CHANGED = "Nothing was changed.";
/**
 * One sentence per cause (#4357 AC3): it names the rule the model must satisfy, built from the
 * constants the checks use, never the refused value, and within the 200-byte bound of a detail
 * message. The record is exhaustive, so a cause added to the check cannot be left without one.
 */
const INPUT_SENTENCES: Readonly<Record<ReciprocalInputCause, string>> = {
  arguments: `This call takes only ${[...INPUT_KEYS].join(", ")}.`,
  actor: `expectedActorKey must be the key of the connected Jira user (non-blank, at most ${String(TEXT_MAX_CHARS)} characters); jira.myself returns it. ${NOTHING_CHANGED}`,
  acceptance: `Send expectLocalLinkAbsent:true and acceptNativeDelegatedEffect:true: the local link must not exist yet, and Jira performs the reciprocal effect itself. ${NOTHING_CHANGED}`,
  issue: `expectedIssue must be the issue as reviewed: id, key, summary, projectId and issueTypeId, nothing else. ${NOTHING_CHANGED}`,
  application: `expectedApplication must be the configured link: id (UUID), name (at most ${String(TEXT_MAX_CHARS)}), displayUrl and rpcUrl (HTTPS, at most ${String(URL_MAX_CHARS)}, no credentials, query, fragment, whitespace or backslash).`,
  remote: `remoteIssueId must be a numeric ID; remoteIssueTitle, sourceRelationship and targetRelationship must be non-blank text of at most ${String(TEXT_MAX_CHARS)} characters. ${NOTHING_CHANGED}`,
  size: `The arguments are larger than one call may carry. ${NOTHING_CHANGED}`,
};
export function reciprocalInputRefusal(failed: ReciprocalInputCause): ReciprocalFailure {
  return {
    ok: false,
    reason: "field-validation",
    detail: { validation: "invalid-field", messages: [INPUT_SENTENCES[failed]] },
  };
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
