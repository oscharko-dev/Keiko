// Policy-pack structures and deterministic pure evaluator for governed Git delivery
// (Issue #471, Epic #470). Ownership: git-delivery-policy domain.
// Leaf-package rules (ADR-0019): pure types and frozen const tables only.
// No IO, no clock, no randomness, no crypto. The evaluator is a pure function:
// same inputs always produce the same decision. Callers (keiko-server, keiko-workflows)
// assemble packs from storage BEFORE calling evaluateGitPolicy.
//
// Imports ONLY from ./git-delivery.js (action kinds, risk class, constraint union, policy decision,
// provider capability, parse result). No imports from git-delivery-provider.ts — one-directional DAG.

import type {
  GitDeliveryActionKind,
  GitDeliveryConstraint,
  GitDeliveryParseResult,
  GitDeliveryPolicyDecision,
  GitDeliveryProviderCapability,
} from "./git-delivery.js";
import {
  isGitDeliveryActionKind,
  isGitDeliveryConstraint,
  isGitDeliveryProviderCapability,
} from "./git-delivery.js";

export const GIT_DELIVERY_POLICY_SCHEMA_VERSION = "1" as const;

// ─── Rule decision and rule ──────────────────────────────────────────────────────

export type GitDeliveryRuleDecision = "allowed" | "blocked" | "approval-gated" | "constrained";

export const GIT_DELIVERY_RULE_DECISIONS: readonly GitDeliveryRuleDecision[] = [
  "allowed",
  "blocked",
  "approval-gated",
  "constrained",
] as const;

export interface GitDeliveryPolicyRule {
  readonly actionKind: GitDeliveryActionKind;
  readonly decision: GitDeliveryRuleDecision;
  // Required when decision === "approval-gated". Opaque user/group IDs. An empty array means
  // "at least one approver of any identity" — it is NOT the fail-closed case.
  readonly requiredApprovers?: readonly string[] | undefined;
  // Required when decision === "constrained".
  readonly constraints?: readonly GitDeliveryConstraint[] | undefined;
}

// Deny-by-default authorable as DATA. A pack can author { decision: "blocked" } so that any action
// kind without a specific rule is denied at that level.
export interface GitDeliveryDefaultRule {
  readonly decision: GitDeliveryRuleDecision;
  readonly requiredApprovers?: readonly string[] | undefined;
  readonly constraints?: readonly GitDeliveryConstraint[] | undefined;
}

// ─── Policy packs ────────────────────────────────────────────────────────────────

export interface GitDeliveryRepoPolicyPack {
  readonly schemaVersion: typeof GIT_DELIVERY_POLICY_SCHEMA_VERSION;
  readonly repoId: string;
  readonly rules: readonly GitDeliveryPolicyRule[];
  readonly defaultRule?: GitDeliveryDefaultRule | undefined;
}

export interface GitDeliveryOrgPolicyPack {
  readonly schemaVersion: typeof GIT_DELIVERY_POLICY_SCHEMA_VERSION;
  readonly orgId: string;
  readonly rules: readonly GitDeliveryPolicyRule[];
  readonly defaultRule?: GitDeliveryDefaultRule | undefined;
}

export interface GitDeliveryPolicyContext {
  readonly actionKind: GitDeliveryActionKind;
  readonly targetBranchName?: string | undefined;
  readonly activeProviderCapabilities: readonly GitDeliveryProviderCapability[];
}

// ─── Deterministic pure evaluator ───────────────────────────────────────────────
// Resolved per-level decision: one of allowed / blocked / approval-gated / constrained / none.
// `none` means neither a matching rule nor a defaultRule applied at that level.

type ResolvedLevel =
  | { readonly kind: "allowed" }
  | { readonly kind: "blocked" }
  | { readonly kind: "approval-gated"; readonly approvers: readonly string[] }
  | { readonly kind: "constrained"; readonly constraints: readonly GitDeliveryConstraint[] }
  | { readonly kind: "none" };

function resolveRuleToLevel(
  rule: Pick<GitDeliveryPolicyRule, "decision" | "requiredApprovers" | "constraints">,
): ResolvedLevel {
  if (rule.decision === "allowed") {
    return { kind: "allowed" };
  }
  if (rule.decision === "blocked") {
    return { kind: "blocked" };
  }
  if (rule.decision === "approval-gated") {
    return { kind: "approval-gated", approvers: rule.requiredApprovers ?? [] };
  }
  return { kind: "constrained", constraints: rule.constraints ?? [] };
}

function resolveLevel(
  pack: GitDeliveryRepoPolicyPack | GitDeliveryOrgPolicyPack | undefined,
  context: GitDeliveryPolicyContext,
): ResolvedLevel {
  if (pack === undefined) {
    return { kind: "none" };
  }
  const rule = pack.rules.find((candidate) => candidate.actionKind === context.actionKind);
  if (rule !== undefined) {
    return resolveRuleToLevel(rule);
  }
  if (pack.defaultRule !== undefined) {
    return resolveRuleToLevel(pack.defaultRule);
  }
  return { kind: "none" };
}

function unionConstraints(
  org: ResolvedLevel,
  repo: ResolvedLevel,
): readonly GitDeliveryConstraint[] {
  const orgConstraints = org.kind === "constrained" ? org.constraints : [];
  const repoConstraints = repo.kind === "constrained" ? repo.constraints : [];
  return [...orgConstraints, ...repoConstraints];
}

// Combine org (O) and repo (R) decisions by a total, deterministic precedence matrix (first match
// wins). Either level can tighten; org tightening dominates a repo loosen; both `none` fails closed.
function combineDecisions(org: ResolvedLevel, repo: ResolvedLevel): GitDeliveryPolicyDecision {
  if (org.kind === "blocked" || repo.kind === "blocked") {
    return { outcome: "blocked", reason: "policy-pack-blocked" };
  }
  if (org.kind === "approval-gated") {
    return { outcome: "approval-gated", requiredApprovers: org.approvers };
  }
  if (repo.kind === "approval-gated") {
    return { outcome: "approval-gated", requiredApprovers: repo.approvers };
  }
  if (org.kind === "constrained" || repo.kind === "constrained") {
    return { outcome: "constrained", constraints: unionConstraints(org, repo) };
  }
  if (org.kind === "allowed" || repo.kind === "allowed") {
    return { outcome: "allowed" };
  }
  return { outcome: "blocked", reason: "no-applicable-rule" };
}

export function evaluateGitPolicy(
  orgPack: GitDeliveryOrgPolicyPack | undefined,
  repoPack: GitDeliveryRepoPolicyPack | undefined,
  context: GitDeliveryPolicyContext,
): GitDeliveryPolicyDecision {
  const org = resolveLevel(orgPack, context);
  const repo = resolveLevel(repoPack, context);
  return combineDecisions(org, repo);
}

// ─── Private predicate helpers ───────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isUndefinedOr<T>(check: (v: unknown) => v is T): (v: unknown) => v is T | undefined {
  return (v: unknown): v is T | undefined => v === undefined || check(v);
}

function isConstraintArray(value: unknown): value is readonly GitDeliveryConstraint[] {
  return Array.isArray(value) && value.every(isGitDeliveryConstraint);
}

function isRuleDecision(value: unknown): value is GitDeliveryRuleDecision {
  return (
    typeof value === "string" && (GIT_DELIVERY_RULE_DECISIONS as readonly string[]).includes(value)
  );
}

// ─── Guards ──────────────────────────────────────────────────────────────────────

export { isGitDeliveryConstraint, isGitDeliveryProviderCapability };

function isActionKind(value: unknown): boolean {
  return isGitDeliveryActionKind(value);
}

// A decision's per-decision required fields must validate. approval-gated requires a string-array
// (possibly empty); constrained requires a valid constraint array. allowed/blocked carry neither.
function decisionShapeValid(value: Record<string, unknown>): boolean {
  if (value.decision === "approval-gated") {
    return isUndefinedOr(isStringArray)(value.requiredApprovers);
  }
  if (value.decision === "constrained") {
    return isUndefinedOr(isConstraintArray)(value.constraints);
  }
  return true;
}

export function isGitDeliveryPolicyRule(value: unknown): value is GitDeliveryPolicyRule {
  return (
    isRecord(value) &&
    isActionKind(value.actionKind) &&
    isRuleDecision(value.decision) &&
    decisionShapeValid(value)
  );
}

function isDefaultRule(value: unknown): value is GitDeliveryDefaultRule {
  return isRecord(value) && isRuleDecision(value.decision) && decisionShapeValid(value);
}

// ─── Parse functions (return the shared GitDeliveryParseResult) ──────────────────

function ruleErrors(rules: unknown, field: "rules"): readonly string[] {
  if (!Array.isArray(rules)) {
    return [`pack.${field} must be an array`];
  }
  if (!rules.every(isGitDeliveryPolicyRule)) {
    return [`pack.${field} contains an invalid GitDeliveryPolicyRule`];
  }
  return [];
}

function defaultRuleErrors(defaultRule: unknown): readonly string[] {
  if (defaultRule === undefined) {
    return [];
  }
  if (!isDefaultRule(defaultRule)) {
    return ["pack.defaultRule is not a valid GitDeliveryDefaultRule"];
  }
  return [];
}

function commonPackErrors(value: Record<string, unknown>): readonly string[] {
  const errors: string[] = [];
  if (value.schemaVersion !== GIT_DELIVERY_POLICY_SCHEMA_VERSION) {
    errors.push("pack.schemaVersion must equal the GIT_DELIVERY_POLICY_SCHEMA_VERSION literal");
  }
  errors.push(...ruleErrors(value.rules, "rules"));
  errors.push(...defaultRuleErrors(value.defaultRule));
  return errors;
}

export function parseGitRepoPolicyPack(
  value: unknown,
): GitDeliveryParseResult<GitDeliveryRepoPolicyPack> {
  if (!isRecord(value)) {
    return { ok: false, errors: ["repo policy pack must be an object"] };
  }
  const errors = [...commonPackErrors(value)];
  if (!isNonEmptyString(value.repoId)) {
    errors.push("repo policy pack.repoId must be a non-empty string");
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: value as unknown as GitDeliveryRepoPolicyPack };
}

export function parseGitOrgPolicyPack(
  value: unknown,
): GitDeliveryParseResult<GitDeliveryOrgPolicyPack> {
  if (!isRecord(value)) {
    return { ok: false, errors: ["org policy pack must be an object"] };
  }
  const errors = [...commonPackErrors(value)];
  if (!isNonEmptyString(value.orgId)) {
    errors.push("org policy pack.orgId must be a non-empty string");
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: value as unknown as GitDeliveryOrgPolicyPack };
}

// Discriminates a pack by the presence of repoId vs orgId.
export function parseGitPolicyPack(
  value: unknown,
): GitDeliveryParseResult<GitDeliveryRepoPolicyPack | GitDeliveryOrgPolicyPack> {
  if (!isRecord(value)) {
    return { ok: false, errors: ["policy pack must be an object"] };
  }
  if (isNonEmptyString(value.repoId)) {
    return parseGitRepoPolicyPack(value);
  }
  if (isNonEmptyString(value.orgId)) {
    return parseGitOrgPolicyPack(value);
  }
  return { ok: false, errors: ["policy pack must carry a non-empty repoId or orgId"] };
}
