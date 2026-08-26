import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  EDITOR_AGENT_TARGET_PATH_MAX_BYTES,
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
import { containedRealPathInfo, PathEscapeError } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

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
  // KEIKO-0557: parity with classifyContentMutation (editor-agent-governance.ts). When the caller
  // has already resolved the sensitive-path deny classification for `targetPath`, threading it
  // through here lets decideSupervisedFileEdit deny even when the sidecar-declared
  // allowedRelativePaths would otherwise contain the path.
  readonly targetSensitive?: boolean;
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
  // KEIKO-0557: sensitive-path deny takes precedence over the sidecar's self-declared
  // allowedRelativePaths — a mutation whose target sits on the shared sensitive deny list is
  // rejected even if the sidecar would otherwise contain it. Mirrors classifyContentMutation's
  // context.targetSensitive gate.
  if (request.targetSensitive === true) {
    return fileEditDecision(request, "denied", "out-of-scope-file-edit", true);
  }
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

interface ResolvedEditTarget {
  readonly root: string;
  readonly target: string;
}

// Syntax gate, workspace-root realpath, symlink-aware resolution (containedPath/
// containedRealPathInfo), and root-containment -- the resolution chain shared by
// resolveContainedEditTarget's scope check below and resolveEditTargetRealPath's sensitivity
// classification. containedRealPathInfo rejects a target whose symlink chain escapes the
// workspace root entirely; it does NOT (and must not) reject a target that stays contained but
// resolves somewhere other than its lexical name suggests -- that classification is the caller's
// job (see resolveEditTargetRealPath).
function resolveEditTargetAbsolute(
  workspaceRoot: string,
  targetPath: string,
): ResolvedEditTarget | undefined {
  if (!candidatePathSyntaxAllowed(targetPath)) return undefined;
  const root = realPath(workspaceRoot);
  if (root === undefined) return undefined;
  const target = resolveCandidatePath(root, targetPath);
  if (target === undefined || !pathInside(root, target)) return undefined;
  return { root, target };
}

export interface EditTargetRealPath {
  readonly contained: boolean;
  // The workspace-root-relative path the target resolves to after following symlinks, present
  // whenever `contained` is true.
  readonly realRelative: string | undefined;
}

// #2906: exposes the root-containment half of the resolution chain above WITHOUT the
// allowedRelativePaths scope narrowing that only decideSupervisedFileEdit's own containment check
// needs. A caller that must classify a target's SENSITIVITY -- a check KEIKO-0557 deliberately
// keeps independent of the sidecar's own declared scope -- runs it against the REAL,
// symlink-resolved target this returns instead of the lexical targetPath string alone. A
// benign-looking in-workspace symlink (e.g. `src/config-alias` -> `../.env`, which stays
// root-contained since `../` from `src/` lands back on the workspace root) would otherwise pass
// every check: it is syntactically fine, it resolves inside the root, and its own lexical name
// matches no deny pattern -- only the REAL target name (`.env`) does. See
// codingRuntimeManager.ts's supervisedFileEditEvent.
export function resolveEditTargetRealPath(
  workspaceRoot: string,
  targetPath: string,
): EditTargetRealPath {
  if (!candidatePathSyntaxAllowed(targetPath)) return { contained: false, realRelative: undefined };
  const root = realPath(workspaceRoot);
  if (root === undefined) return { contained: false, realRelative: undefined };
  const absolute = isAbsolute(targetPath) ? resolve(targetPath) : resolve(join(root, targetPath));
  const info = containedRealPathInfoOrUndefined(root, absolute);
  if (info === undefined || !pathInside(root, info.path)) {
    return { contained: false, realRelative: undefined };
  }
  return { contained: true, realRelative: canonicalRealRelative(info, absolute) };
}

function containedRealPathInfoOrUndefined(
  root: string,
  absolute: string,
): ReturnType<typeof containedRealPathInfo> | undefined {
  try {
    return containedRealPathInfo(nodeWorkspaceFs, root, absolute);
  } catch (error) {
    if (error instanceof PathEscapeError) return undefined;
    throw error;
  }
}

// #2906 round 2: for a not-yet-existing (create) target, containedRealPathInfo's own
// `.realRelative` is only the resolved NEAREST EXISTING ancestor -- the trailing segments that
// don't exist yet (so there is nothing to symlink-resolve) are not included. Appending them back
// makes a create target under a symlinked parent classify under its REAL location, not the
// resolved parent alone (missing the target's own name) and not the unresolved lexical spelling
// this function previously derived its result from via resolveEditTargetAbsolute's `.path`
// (`safe-alias/hooks/new-hook` with `safe-alias -> .git` used to classify under the benign
// lexical spelling and be admitted).
function canonicalRealRelative(
  info: ReturnType<typeof containedRealPathInfo>,
  absolute: string,
): string {
  const suffix = untouchedSuffix(absolute);
  return suffix === "" ? info.realRelative : join(info.realRelative, suffix);
}

// Walks up from `absolutePath` to the nearest ancestor that exists on disk -- the same ground
// containedRealPathInfo's own create-target branch covers -- and returns the path below that
// ancestor. Empty when `absolutePath` itself exists: containedRealPathInfo's `.realRelative` is
// already the complete resolved path in that case. Terminates at `root`, which `realPath` above
// already proved exists, so the walk can never reach the filesystem root empty-handed.
function untouchedSuffix(absolutePath: string): string {
  let current = absolutePath;
  for (;;) {
    if (existsSync(current)) return relative(current, absolutePath);
    const parent = dirname(current);
    if (parent === current) return relative(current, absolutePath);
    current = parent;
  }
}

function resolveContainedEditTarget(request: SupervisedCodingFileEditRequest): boolean {
  const resolved = resolveEditTargetAbsolute(request.workspaceRoot, request.targetPath);
  if (resolved === undefined) return false;
  const scopes = resolveAllowedScopes(resolved.root, request.allowedRelativePaths);
  return scopes?.some((scope) => pathInside(scope, resolved.target)) ?? false;
}

function candidatePathSyntaxAllowed(targetPath: string): boolean {
  if (!isAbsolute(targetPath)) return isContainedAgentPath(targetPath);
  return (
    !targetPath.includes("\u0000") &&
    !hasAlternateDataStreamDelimiter(targetPath) &&
    Buffer.byteLength(targetPath, "utf8") <= EDITOR_AGENT_TARGET_PATH_MAX_BYTES
  );
}

function hasAlternateDataStreamDelimiter(targetPath: string): boolean {
  const volumePrefixLength = /^[A-Za-z]:[\\/]/u.test(targetPath) ? 2 : 0;
  return targetPath.slice(volumePrefixLength).includes(":");
}

function resolveCandidatePath(root: string, targetPath: string): string | undefined {
  const absolute = isAbsolute(targetPath) ? resolve(targetPath) : resolve(join(root, targetPath));
  return containedPath(root, absolute);
}

function resolveAllowedScopes(
  root: string,
  paths: readonly string[],
): readonly string[] | undefined {
  if (paths.length === 0) return [root];
  // KEIKO-0438: collapsing to `undefined` when ANY single scope fails to resolve turns one bad
  // path (typo, not-yet-existing directory) into a wholesale denial of the operator-approved
  // scope list. Keep the scopes that DID resolve; deny only when nothing survives.
  const scopes = paths
    .map((scope) => resolveScope(root, scope))
    .filter((scope): scope is string => scope !== undefined);
  return scopes.length > 0 ? scopes : undefined;
}

function resolveScope(root: string, scope: string): string | undefined {
  if (!isContainedAgentPath(scope)) return undefined;
  const resolved = containedPath(root, resolve(join(root, scope)));
  return resolved !== undefined && pathInside(root, resolved) ? resolved : undefined;
}

function containedPath(root: string, absolute: string): string | undefined {
  try {
    return containedRealPathInfo(nodeWorkspaceFs, root, absolute).path;
  } catch (error) {
    if (error instanceof PathEscapeError) return undefined;
    throw error;
  }
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

// KEIKO-0764: broadened to recognise the mutating subcommands the audit identified so a denied
// command outside the allowlist is labeled 'mutating-command-denied' rather than the less-alarming
// 'unknown-command-denied' in audit evidence whenever it actually mutates state. This changes only
// the evidence-reason CLASSIFICATION, not the allow/deny DECISION — decideSupervisedVerificationCommand
// remains fail-closed via the fixed allowlist.
function gitSubcommandMutates(subcommand: string): boolean {
  return [
    "commit",
    "push",
    "merge",
    "rebase",
    "reset",
    "checkout",
    "clean",
    "branch",
    "tag",
    "stash",
    "worktree",
    "remote",
    "config",
    "gc",
  ].includes(subcommand);
}

function npmSubcommandMutates(subcommand: string): boolean {
  return [
    "install",
    "ci",
    "publish",
    "version",
    "add",
    "remove",
    "uninstall",
    "dedupe",
    "link",
    "rebuild",
    "pkg",
    "audit",
  ].includes(subcommand);
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
