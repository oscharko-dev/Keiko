import {
  isSafeAtlassianIdentifier,
  JIRA_MAINTENANCE_MUTATIONS,
  type JiraMaintenanceMutation,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import { asRecord } from "./atlassian-sync-classify.js";
import {
  jiraMaintenanceNode,
  jiraMaintenanceReindex,
  jiraMaintenanceUpgrade,
  jiraMaintenanceUpgradeResult,
  type JiraMaintenanceProjection,
} from "./jira-maintenance-values.js";
import { jiraMessageRefusal } from "./jira-mutation-failure.js";
import { jiraNativeId } from "./jira-native-values.js";
import { savedExactKeys, savedText } from "./jira-saved-configuration-values.js";

export { JIRA_MAINTENANCE_MUTATIONS, type JiraMaintenanceMutation };
const NAMES: ReadonlySet<string> = new Set(JIRA_MAINTENANCE_MUTATIONS);
export function isJiraMaintenanceMutation(value: string): value is JiraMaintenanceMutation {
  return NAMES.has(value);
}
export type MaintenanceReceipt = JiraMutationReceipt;
export type MaintenanceFailure = Extract<JiraMutationAttempt, { readonly ok: false }>;
export type MaintenanceAttempt = JiraMutationAttempt;
export type MaintenanceObservation<T> =
  MaintenanceFailure | { readonly ok: true; readonly value: T };
export const MAINTENANCE_MALFORMED: MaintenanceFailure = { ok: false, reason: "malformed-payload" };
export function maintenanceRefusal(
  message: string,
  reason: "field-validation" | "conflict" | "unavailable" = "field-validation",
  receipt?: MaintenanceReceipt,
): MaintenanceFailure {
  return jiraMessageRefusal(message, reason, receipt);
}
export interface MaintenanceIssue {
  readonly issueId: string;
  readonly issueKey: string;
}
export interface ReindexFlags {
  readonly indexComments: boolean;
  readonly indexChangeHistory: boolean;
  readonly indexWorklogs: boolean;
}
interface Common {
  readonly operation: JiraMaintenanceMutation;
  readonly actor: string;
}
export type MaintenanceInput = Common &
  (
    | { readonly kind: "node"; readonly nodeId: string; readonly expected: CatalogJsonObject }
    | { readonly kind: "cluster-upgrade"; readonly expected: CatalogJsonObject }
    | { readonly kind: "snapshot"; readonly expected: false }
    | {
        readonly kind: "reindex";
        readonly expected: CatalogJsonObject;
        readonly type: "FOREGROUND" | "BACKGROUND" | "BACKGROUND_PREFERRED";
        readonly flags: ReindexFlags;
      }
    | {
        readonly kind: "issues";
        readonly issues: readonly MaintenanceIssue[];
        readonly flags: ReindexFlags;
      }
    | { readonly kind: "requests"; readonly expected: CatalogJsonObject }
    | { readonly kind: "upgrade"; readonly expected: CatalogJsonObject }
  );
const COMMON = ["expectedActorKey", "confirmUnverifiedEffect"];
const FLAGS = ["indexComments", "indexChangeHistory", "indexWorklogs"];
const FIELDS: Readonly<Record<JiraMaintenanceMutation, ReadonlySet<string>>> = {
  "jira.request-cluster-index-snapshot": new Set([...COMMON, "expectedNode"]),
  "jira.delete-cluster-node": new Set([...COMMON, "expectedNode"]),
  "jira.mark-cluster-node-offline": new Set([...COMMON, "expectedNode"]),
  "jira.approve-cluster-upgrade": new Set([...COMMON, "expectedClusterState"]),
  "jira.cancel-cluster-upgrade": new Set([...COMMON, "expectedClusterState"]),
  "jira.retry-cluster-upgrade": new Set([...COMMON, "expectedClusterState"]),
  "jira.start-cluster-upgrade": new Set([...COMMON, "expectedClusterState"]),
  "jira.create-index-snapshot": new Set([...COMMON, "expectedRunning"]),
  "jira.start-reindex": new Set([...COMMON, "expectedReindex", "type", ...FLAGS]),
  "jira.reindex-issues": new Set([...COMMON, "expectedIssues", ...FLAGS]),
  "jira.process-reindex-requests": new Set([...COMMON, "expectedReindex"]),
  "jira.run-upgrade": new Set([...COMMON, "expectedUpgrade"]),
};
export function maintenanceSame(left: unknown, right: unknown): boolean {
  return canonicalise(left) === canonicalise(right);
}
function exactProjection(
  value: unknown,
  projector: (value: unknown) => JiraMaintenanceProjection,
): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const projected = projector(raw);
  return projected.ok && maintenanceSame(raw, projected.value) ? projected.value : undefined;
}
export function maintenanceNodeReview(value: unknown): CatalogJsonObject | undefined {
  const projected = exactProjection(value, jiraMaintenanceNode);
  return projected !== undefined &&
    maintenancePathNode(projected.nodeId) &&
    savedText(projected.state, 128) &&
    typeof projected.alive === "boolean"
    ? projected
    : undefined;
}
export function maintenancePathNode(value: unknown): value is string {
  return savedText(value, 255) && value !== "." && value !== ".." && !/[/%\\\p{Cc}]/u.test(value);
}
export function maintenanceClusterReview(value: unknown): CatalogJsonObject | undefined {
  const projected = exactProjection(value, jiraMaintenanceUpgrade);
  return projected !== undefined && savedText(projected.state, 128) ? projected : undefined;
}
export function maintenanceReindexReview(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  if (raw.taskState === "no-prior-task")
    return Object.keys(raw).length === 1 ? { taskState: "no-prior-task" } : undefined;
  if (raw.taskState !== "observed") return undefined;
  const { taskState, ...facts } = raw;
  const projected = exactProjection(facts, jiraMaintenanceReindex);
  return projected !== undefined &&
    savedText(projected.type, 128) &&
    typeof projected.currentProgress === "number" &&
    typeof projected.success === "boolean"
    ? { taskState, ...projected }
    : undefined;
}
export function maintenanceUpgradeReview(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  if (raw.upgradeState === "running" || raw.upgradeState === "no-prior-result")
    return Object.keys(raw).length === 1 ? { upgradeState: raw.upgradeState } : undefined;
  if (raw.upgradeState !== "result" || !savedText(raw.upgradeOutcome, 128)) return undefined;
  const { upgradeState, upgradeOutcome, ...facts } = raw;
  const projected = jiraMaintenanceUpgradeResult({ ...facts, outcome: upgradeOutcome });
  return projected.ok && maintenanceSame({ ...facts, upgradeOutcome }, projected.value)
    ? { upgradeState, ...projected.value }
    : undefined;
}
function flags(args: CatalogJsonObject): ReindexFlags | undefined {
  return typeof args.indexComments === "boolean" &&
    typeof args.indexChangeHistory === "boolean" &&
    typeof args.indexWorklogs === "boolean"
    ? {
        indexComments: args.indexComments,
        indexChangeHistory: args.indexChangeHistory,
        indexWorklogs: args.indexWorklogs,
      }
    : undefined;
}
function reviewedIssue(value: unknown): MaintenanceIssue | undefined {
  const raw = asRecord(value);
  if (
    raw === undefined ||
    !savedExactKeys(raw, new Set(["issueId", "issueKey"])) ||
    !jiraNativeId(raw.issueId) ||
    !isSafeAtlassianIdentifier(raw.issueKey)
  )
    return undefined;
  return Object.freeze({ issueId: raw.issueId, issueKey: raw.issueKey });
}
function issues(value: unknown): readonly MaintenanceIssue[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return undefined;
  const result: MaintenanceIssue[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const item of value) {
    const selected = reviewedIssue(item);
    if (selected === undefined) return undefined;
    const key = selected.issueKey.toUpperCase();
    if (ids.has(selected.issueId) || keys.has(key)) return undefined;
    ids.add(selected.issueId);
    keys.add(key);
    result.push(selected);
  }
  return Object.freeze(result);
}
function reindexInput(common: Common, args: CatalogJsonObject): MaintenanceInput | undefined {
  const selected = flags(args);
  if (selected === undefined) return undefined;
  if (common.operation === "jira.reindex-issues") {
    const bound = issues(args.expectedIssues);
    return bound === undefined
      ? undefined
      : { ...common, kind: "issues", issues: bound, flags: selected };
  }
  const expected = maintenanceReindexReview(args.expectedReindex);
  const type = args.type;
  return expected !== undefined &&
    (type === "FOREGROUND" || type === "BACKGROUND" || type === "BACKGROUND_PREFERRED")
    ? { ...common, kind: "reindex", expected, type, flags: selected }
    : undefined;
}
function clusterInput(common: Common, args: CatalogJsonObject): MaintenanceInput | undefined {
  if (Object.hasOwn(args, "expectedNode")) {
    const expected = maintenanceNodeReview(args.expectedNode);
    return expected !== undefined && typeof expected.nodeId === "string"
      ? { ...common, kind: "node", expected, nodeId: expected.nodeId }
      : undefined;
  }
  if (Object.hasOwn(args, "expectedClusterState")) {
    const expected = maintenanceClusterReview(args.expectedClusterState);
    return expected === undefined ? undefined : { ...common, kind: "cluster-upgrade", expected };
  }
  return undefined;
}
function jobInput(common: Common, args: CatalogJsonObject): MaintenanceInput | undefined {
  if (common.operation === "jira.start-reindex" || common.operation === "jira.reindex-issues")
    return reindexInput(common, args);
  if (common.operation === "jira.create-index-snapshot")
    return args.expectedRunning === false
      ? { ...common, kind: "snapshot", expected: false }
      : undefined;
  if (common.operation === "jira.process-reindex-requests") {
    const expected = maintenanceReindexReview(args.expectedReindex);
    return expected === undefined ? undefined : { ...common, kind: "requests", expected };
  }
  const expected = maintenanceUpgradeReview(args.expectedUpgrade);
  return common.operation === "jira.run-upgrade" && expected !== undefined
    ? { ...common, kind: "upgrade", expected }
    : undefined;
}
export function parseMaintenanceInput(
  operation: JiraMaintenanceMutation,
  args: CatalogJsonObject,
): MaintenanceInput | undefined {
  if (
    !savedExactKeys(args, FIELDS[operation]) ||
    !savedText(args.expectedActorKey, 255) ||
    args.confirmUnverifiedEffect !== true
  )
    return undefined;
  if (
    new TextEncoder().encode(JSON.stringify(args)).byteLength > TOOL_CATALOG_LIMITS.maxArgumentBytes
  )
    return undefined;
  const common = { operation, actor: args.expectedActorKey };
  return clusterInput(common, args) ?? jobInput(common, args);
}
export function maintenanceReceipt(input: MaintenanceInput): MaintenanceReceipt {
  if (input.kind === "node") return Object.freeze({ userKey: input.actor, nodeId: input.nodeId });
  if (input.kind === "issues")
    return Object.freeze({
      userKey: input.actor,
      issueIds: Object.freeze(input.issues.map((issue) => issue.issueId)),
    });
  return Object.freeze({ userKey: input.actor });
}
export function maintenanceReceiptFits(receipt: MaintenanceReceipt): boolean {
  return new TextEncoder().encode(JSON.stringify(receipt)).byteLength <= 16384;
}
