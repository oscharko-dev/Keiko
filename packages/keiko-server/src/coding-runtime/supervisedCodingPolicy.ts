import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  isContainedAgentPath,
  permissionKindForSupervisedCodingAction,
  validateCodingWorkbenchEvidenceRecord,
  type CodingWorkbenchActionClass,
  type CodingWorkbenchConnectorScope,
  type CodingWorkbenchEvidenceKind,
  type CodingWorkbenchEvidenceRecord,
  type CodingWorkbenchModelSource,
  type CodingWorkbenchMode,
  type CodingWorkbenchPermissionRequest,
  type CodingWorkbenchRuntimeSource,
  type CodingWorkbenchSupervisedActionKind,
  type CodingWorkbenchSupervisedPolicyReason,
} from "@oscharko-dev/keiko-contracts";

import type { SupervisedCodingConsumedApproval } from "./supervisedCodingApprovalStore.js";

export type SupervisedCodingDecisionStatus = "allowed" | "approval-required" | "denied";

export type SupervisedCodingVerificationKind =
  "typecheck" | "lint" | "format-check" | "test" | "arch-check" | "diagnostic";

export interface SupervisedCodingVerificationCommand {
  readonly kind: SupervisedCodingVerificationKind;
  readonly executable: string;
  readonly args: readonly string[];
}

export interface SupervisedCodingDecision {
  readonly status: SupervisedCodingDecisionStatus;
  readonly reason: CodingWorkbenchSupervisedPolicyReason;
  readonly evidence: CodingWorkbenchEvidenceRecord;
  readonly permissionRequest?: CodingWorkbenchPermissionRequest | undefined;
}

interface EvidenceContext {
  readonly recordId: string;
  readonly runId: string;
  readonly occurredAt: string;
  readonly effectiveMode: CodingWorkbenchMode;
  readonly runtimeSource: CodingWorkbenchRuntimeSource;
  readonly modelSource: CodingWorkbenchModelSource;
}

export interface SupervisedCodingFileEditRequest extends EvidenceContext {
  readonly workspaceRoot: string;
  readonly allowedRelativePaths: readonly string[];
  readonly targetPath: string;
  readonly fileCount: number;
  readonly addedLines: number;
  readonly deletedLines: number;
}

export interface SupervisedCodingCommandRequest extends EvidenceContext {
  readonly executable: string;
  readonly args: readonly string[];
  readonly allowlist?: readonly SupervisedCodingVerificationCommand[] | undefined;
  readonly passedCount?: number | undefined;
  readonly failedCount?: number | undefined;
  readonly skippedCount?: number | undefined;
}

export interface SupervisedCodingMutationRequest extends EvidenceContext {
  readonly actionKind: CodingWorkbenchSupervisedActionKind;
  readonly requestId: string;
  readonly scopeDigest: string;
  readonly expiresAt: string;
  readonly approval?: SupervisedCodingConsumedApproval | undefined;
  readonly connectorScopes?: readonly CodingWorkbenchConnectorScope[] | undefined;
  readonly nowIso: string;
  readonly operatorStopped?: boolean | undefined;
}

export const DEFAULT_SUPERVISED_VERIFICATION_COMMANDS: readonly SupervisedCodingVerificationCommand[] =
  Object.freeze([
    { kind: "typecheck", executable: "npm", args: ["run", "typecheck"] },
    { kind: "lint", executable: "npm", args: ["run", "lint"] },
    { kind: "format-check", executable: "npm", args: ["run", "format:check"] },
    { kind: "test", executable: "npm", args: ["test"] },
    { kind: "test", executable: "npm", args: ["run", "test"] },
    { kind: "arch-check", executable: "npm", args: ["run", "arch:check"] },
    { kind: "arch-check", executable: "npm", args: ["run", "arch:check:negative"] },
    { kind: "diagnostic", executable: "git", args: ["status", "--short"] },
  ] as const satisfies readonly SupervisedCodingVerificationCommand[]);

export function decideSupervisedFileEdit(
  request: SupervisedCodingFileEditRequest,
): SupervisedCodingDecision {
  const contained = resolveContainedEditTarget(request);
  return contained
    ? fileEditDecision(request, "allowed", "scoped-file-edit", false)
    : fileEditDecision(request, "denied", "out-of-scope-file-edit", true);
}

export function decideSupervisedVerificationCommand(
  request: SupervisedCodingCommandRequest,
): SupervisedCodingDecision {
  const allowlist = request.allowlist ?? DEFAULT_SUPERVISED_VERIFICATION_COMMANDS;
  const matched = allowlist.find((command) => commandMatches(command, request));
  if (matched !== undefined) return verificationDecision(request, matched.kind);
  const reason = isMutatingCommand(request) ? "mutating-command-denied" : "unknown-command-denied";
  return commandDeniedDecision(request, reason);
}

export function decideSupervisedMutation(
  request: SupervisedCodingMutationRequest,
): SupervisedCodingDecision {
  if (request.operatorStopped === true) return mutationDeniedDecision(request, "operator-stopped");
  if (request.actionKind === "file-edit") return fileEditMutationDenied(request);
  if (request.actionKind === "verification-command") return verificationMutationDenied(request);
  if (request.approval !== undefined) return mutationAllowedDecision(request);
  return mutationApprovalRequiredDecision(request);
}

function resolveContainedEditTarget(request: SupervisedCodingFileEditRequest): boolean {
  if (!candidatePathSyntaxAllowed(request.targetPath)) return false;
  const root = realPath(request.workspaceRoot);
  if (root === undefined) return false;
  const target = resolveCandidatePath(root, request.targetPath);
  if (target === undefined || !pathInside(root, target)) return false;
  const scopes = resolveAllowedScopes(root, request.allowedRelativePaths);
  return scopes?.some((scope) => pathInside(scope, target)) ?? false;
}

function candidatePathSyntaxAllowed(targetPath: string): boolean {
  return isAbsolute(targetPath) || isContainedAgentPath(targetPath);
}

function resolveCandidatePath(root: string, targetPath: string): string | undefined {
  const absolute = isAbsolute(targetPath) ? resolve(targetPath) : resolve(join(root, targetPath));
  const existing = realPath(absolute);
  if (existing !== undefined) return existing;
  const parent = realPath(dirname(absolute));
  return parent === undefined ? undefined : resolve(parent, basename(absolute));
}

function resolveAllowedScopes(
  root: string,
  paths: readonly string[],
): readonly string[] | undefined {
  if (paths.length === 0) return [root];
  const scopes = paths.map((scope) => resolveScope(root, scope));
  return scopes.every((scope): scope is string => scope !== undefined) ? scopes : undefined;
}

function resolveScope(root: string, scope: string): string | undefined {
  if (!isContainedAgentPath(scope)) return undefined;
  const resolved = realPath(resolve(join(root, scope)));
  return resolved !== undefined && pathInside(root, resolved) ? resolved : undefined;
}

function realPath(path: string): string | undefined {
  try {
    return existsSync(path) ? realpathSync(path) : undefined;
  } catch {
    return undefined;
  }
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function commandMatches(
  command: SupervisedCodingVerificationCommand,
  request: SupervisedCodingCommandRequest,
): boolean {
  return command.executable === request.executable && arraysEqual(command.args, request.args);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => right[index] === value);
}

function isMutatingCommand(request: SupervisedCodingCommandRequest): boolean {
  const subcommand = request.args.find((arg) => !arg.startsWith("-")) ?? "";
  if (["bash", "sh", "zsh", "python", "node"].includes(request.executable)) return true;
  if (request.executable === "git") return gitSubcommandMutates(subcommand);
  if (request.executable === "gh") return ghSubcommandMutates(request.args);
  return request.executable === "npm" && npmSubcommandMutates(subcommand);
}

function gitSubcommandMutates(subcommand: string): boolean {
  return ["commit", "push", "merge", "rebase", "reset", "checkout", "clean"].includes(subcommand);
}

function npmSubcommandMutates(subcommand: string): boolean {
  return ["install", "ci", "publish", "version", "add", "remove", "uninstall"].includes(subcommand);
}

function ghSubcommandMutates(args: readonly string[]): boolean {
  const command = args.join(":");
  return /(?:^|:)pr:(?:create|edit|merge)|(?:^|:)issue:(?:create|edit|close)/u.test(command);
}

function fileEditDecision(
  request: SupervisedCodingFileEditRequest,
  status: SupervisedCodingDecisionStatus,
  reason: CodingWorkbenchSupervisedPolicyReason,
  denied: boolean,
): SupervisedCodingDecision {
  return {
    status,
    reason,
    evidence: evidenceRecord(request, {
      actionKind: "file-edit",
      evidenceKind: "diff",
      reason,
      denied,
      fileCount: request.fileCount,
      addedLines: request.addedLines,
      deletedLines: request.deletedLines,
    }),
  };
}

function verificationDecision(
  request: SupervisedCodingCommandRequest,
  kind: SupervisedCodingVerificationKind,
): SupervisedCodingDecision {
  return {
    status: "allowed",
    reason: "allowlisted-verification-command",
    evidence: evidenceRecord(request, {
      actionKind: "verification-command",
      evidenceKind: "verification",
      reason: "allowlisted-verification-command",
      verificationKind: kind,
      denied: false,
      passedCount: request.passedCount ?? 0,
      failedCount: request.failedCount ?? 0,
      skippedCount: request.skippedCount ?? 0,
    }),
  };
}

function commandDeniedDecision(
  request: SupervisedCodingCommandRequest,
  reason: CodingWorkbenchSupervisedPolicyReason,
): SupervisedCodingDecision {
  return {
    status: "denied",
    reason,
    evidence: evidenceRecord(request, {
      actionKind: "verification-command",
      evidenceKind: "failure",
      reason,
      denied: true,
    }),
  };
}

function fileEditMutationDenied(
  request: SupervisedCodingMutationRequest,
): SupervisedCodingDecision {
  return mutationDeniedDecision(request, "out-of-scope-file-edit");
}

function verificationMutationDenied(
  request: SupervisedCodingMutationRequest,
): SupervisedCodingDecision {
  return mutationDeniedDecision(request, "unknown-command-denied");
}

function mutationAllowedDecision(
  request: SupervisedCodingMutationRequest,
): SupervisedCodingDecision {
  return {
    status: "allowed",
    reason: "approval-proof-accepted",
    evidence: permissionEvidence(request, "approval-proof-accepted", false),
  };
}

function mutationDeniedDecision(
  request: SupervisedCodingMutationRequest,
  reason: CodingWorkbenchSupervisedPolicyReason,
): SupervisedCodingDecision {
  return {
    status: "denied",
    reason,
    evidence: permissionEvidence(request, reason, true),
  };
}

function mutationApprovalRequiredDecision(
  request: SupervisedCodingMutationRequest,
): SupervisedCodingDecision {
  const permissionRequest = buildPermissionRequest(request);
  return {
    status: "approval-required",
    reason: "approval-required",
    permissionRequest,
    evidence: permissionEvidence(request, "approval-required", false),
  };
}

function buildPermissionRequest(
  request: SupervisedCodingMutationRequest,
): CodingWorkbenchPermissionRequest {
  const kind = permissionKindForSupervisedCodingAction(request.actionKind);
  return {
    requestId: request.requestId,
    kind,
    actionClass: actionClassForPermissionKind(kind),
    actionKind: request.actionKind,
    reasonCode: "approval-required",
    scopeLabel: "workspace-scope",
    risk: riskForActionKind(request.actionKind),
    policyReason: "approval-required",
    expiresAt: request.expiresAt,
    ...(kind === "connector-access" ? { connectorScopes: connectorScopes(request) } : {}),
    commandLabel: commandLabelForAction(request.actionKind),
  };
}

function actionClassForPermissionKind(
  kind: CodingWorkbenchPermissionRequest["kind"],
): CodingWorkbenchActionClass {
  return kind;
}

function riskForActionKind(
  actionKind: CodingWorkbenchSupervisedActionKind,
): "medium" | "high" | "critical" {
  if (actionKind === "merge" || actionKind === "system-mutation") return "critical";
  if (actionKind === "commit") return "medium";
  return "high";
}

function connectorScopes(
  request: SupervisedCodingMutationRequest,
): readonly CodingWorkbenchConnectorScope[] {
  return request.connectorScopes ?? ["issue-tracker.write"];
}

function commandLabelForAction(actionKind: CodingWorkbenchSupervisedActionKind): string {
  if (actionKind === "pull-request") return "pull-request";
  if (actionKind === "connector-write") return "connector-write";
  if (actionKind === "external-write") return "external-write";
  return actionKind;
}

function permissionEvidence(
  request: SupervisedCodingMutationRequest,
  reason: CodingWorkbenchSupervisedPolicyReason,
  denied: boolean,
): CodingWorkbenchEvidenceRecord {
  return evidenceRecord(request, {
    actionKind: request.actionKind,
    evidenceKind: denied ? "failure" : "permission",
    reason,
    denied,
    digest: request.approval?.approvalDigest,
  });
}

function evidenceRecord(
  context: EvidenceContext,
  input: {
    readonly actionKind: CodingWorkbenchSupervisedActionKind;
    readonly evidenceKind: CodingWorkbenchEvidenceKind;
    readonly reason: CodingWorkbenchSupervisedPolicyReason;
    readonly denied: boolean;
    readonly verificationKind?: SupervisedCodingVerificationKind | undefined;
    readonly fileCount?: number | undefined;
    readonly addedLines?: number | undefined;
    readonly deletedLines?: number | undefined;
    readonly passedCount?: number | undefined;
    readonly failedCount?: number | undefined;
    readonly skippedCount?: number | undefined;
    readonly digest?: string | undefined;
  },
): CodingWorkbenchEvidenceRecord {
  const record = {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    recordId: context.recordId,
    runId: context.runId,
    occurredAt: context.occurredAt,
    kind: input.evidenceKind,
    effectiveMode: context.effectiveMode,
    runtimeSource: context.runtimeSource,
    modelSource: context.modelSource,
    artifactLabel: input.actionKind,
    safeSummary: input.reason,
    digest: input.digest ?? digest([context.runId, input.actionKind, input.reason]),
    denied: input.denied,
    ...optionalCounts(input),
  } as const satisfies CodingWorkbenchEvidenceRecord;
  const validation = validateCodingWorkbenchEvidenceRecord(record);
  if (!validation.ok) throw new Error("supervised coding evidence validation failed");
  return record;
}

function optionalCounts(input: {
  readonly fileCount?: number | undefined;
  readonly addedLines?: number | undefined;
  readonly deletedLines?: number | undefined;
  readonly passedCount?: number | undefined;
  readonly failedCount?: number | undefined;
  readonly skippedCount?: number | undefined;
}): Partial<CodingWorkbenchEvidenceRecord> {
  return {
    ...(input.fileCount === undefined ? {} : { fileCount: input.fileCount }),
    ...(input.addedLines === undefined ? {} : { addedLines: input.addedLines }),
    ...(input.deletedLines === undefined ? {} : { deletedLines: input.deletedLines }),
    ...(input.passedCount === undefined ? {} : { passedCount: input.passedCount }),
    ...(input.failedCount === undefined ? {} : { failedCount: input.failedCount }),
    ...(input.skippedCount === undefined ? {} : { skippedCount: input.skippedCount }),
  };
}

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}
