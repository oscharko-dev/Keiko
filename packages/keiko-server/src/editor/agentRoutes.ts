// Issue #1392 — BFF routes for the editor-agent control plane: session discovery, snapshot read/write,
// action queueing, browser result reporting, and the SSE event stream. The durable control-plane state
// (session registry, live bridge tracking, bounded action queue, timeouts, fan-out) lives in
// agentSessionRegistry.ts; this module is the HTTP edge that parses requests, enforces *preflight*
// policy, and threads idempotency. The browser owns editor state; an accepted applyChangeset result
// is a one-use commit request for the server's governed atomic workspace patch boundary.
//
// Preflight conflicts (status "conflict", HTTP 409) gate admission to the queue. The Issue #1391/#1394
// structural gates (DIRTY / VERSION / HASH / OUT_OF_SCOPE / INVALID_EDITS / PRECONDITION_REQUIRED) run
// first; the Issue #1392 liveness gate runs last: an otherwise-valid action for a session with no live
// browser bridge is answered with NO_ACTIVE_BRIDGE (AC1). Past preflight, the registry can still return
// a lifecycle failure: QUEUE_FULL (HTTP 429, the bounded queue is saturated) or, asynchronously,
// TIMED_OUT when the bridge never acknowledges before the deadline (AC2).
//
// No raw source content (snapshot text, text edits, patch bodies) is logged anywhere in this path.

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { basename, resolve } from "node:path";
import { Readable } from "node:stream";
import type {
  EditorAgentAction,
  EditorAgentActionDenyReason,
  EditorAgentActionPolicyDecision,
  EditorAgentActionResult,
  EditorAgentActionResultRequest,
  EditorAgentBridgeActionRequest,
  EditorAgentBridgeSnapshotRequest,
  EditorAgentConflictCode,
  EditorAgentEvent,
  EditorAgentGitAspect,
  EditorAgentQueryGitBlame,
  EditorAgentQueryGitData,
  EditorAgentQueryGitDiff,
  EditorAgentQueryGitDiffFile,
  EditorAgentQueryGitDiffLayer,
  EditorAgentQueryGitMachineReason,
  EditorAgentQueryGitOmission,
  EditorAgentQueryGitOmissionReason,
  EditorAgentQueryGitStatus,
  GitEditorDiffScope,
  GitEditorDiffFile,
  GitRepositoryStatusResponse,
  EditorAgentFailureCode,
  EditorAgentSessionSnapshot,
  EditorAgentSessionsRequest,
  EditorAgentSnapshotRequest,
  EditorAgentSnapshotTextMode,
  CodingWorkbenchMode,
  LanguageRange,
  WorkspaceTrustLevel,
} from "@oscharko-dev/keiko-contracts";
import {
  EDITOR_AGENT_BRIDGE_DECISION_CAPABILITY_BYTES,
  EDITOR_AGENT_SCHEMA_VERSION,
  EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS,
  EDITOR_AGENT_SESSION_ID_MAX_BYTES,
  EDITOR_AGENT_SNAPSHOT_TEXT_MAX_BYTES,
  EDITOR_AGENT_NAVIGATION_DOCUMENT_MAX_BYTES,
  editorAgentWritePreconditionError,
  isContainedAgentPath,
  isEditorAgentAction,
  isEditorAgentActionResult,
  isEditorAgentActiveBufferActionType,
  isEditorAgentBridgeDecisionCapability,
  isEditorAgentSessionsRequest,
  isEditorAgentWriteActionType,
  parseEditorAgentActionsPostBody,
  parseEditorAgentSnapshotRequest,
  validateAgentTextEdits,
  EDITOR_AGENT_QUERY_GIT_SCHEMA_VERSION,
  parseEditorAgentQueryGitData,
} from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import {
  EDITOR_AGENT_ACTION_APPROVAL_RISK,
  EDITOR_AGENT_WORKBENCH_ACTION_CLASS,
  classifyEditorAgentAction,
  composeEditorAgentActionPolicyDecision,
} from "@oscharko-dev/keiko-contracts/runtime/editor-agent-governance";
import { validateCodingWorkbenchAuthorityEnvelope } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";
import {
  GIT_AGENT_CONTEXT_MAX_BLAME_LINES,
  GIT_AGENT_CONTEXT_MAX_FILES,
  GIT_AGENT_CONTEXT_MAX_HUNKS,
  GIT_AGENT_CONTEXT_MAX_RESULT_BYTES,
  parseGitEditorBlameResponse,
  parseGitEditorDiffResponse,
} from "@oscharko-dev/keiko-contracts/runtime/git-editor";
import { validateGitRepositoryStatusResponse } from "@oscharko-dev/keiko-contracts/runtime/git-repository";
import {
  PatchApplyError,
  PatchValidationError,
  applyPatch,
  inspectPatch,
  parseUnifiedDiff,
  projectValidatedPatch,
  validatePatch,
  type PatchInspection,
  type PatchInspectionFile,
  type PatchValidation,
  type WorkspaceWriter,
} from "@oscharko-dev/keiko-tools";
import {
  detectWorkspaceAt,
  isDenied,
  readWorkspaceFile,
  type WorkspaceFs,
  type WorkspaceInfo,
  containedRealPathInfo,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { workspaceRootAccessOrUndefined } from "../task-workspace/workspace-root-access.js";
import { isValidCorrelationId } from "../correlation.js";
import {
  errorBody,
  STREAMING,
  type HandlerOutcome,
  type RouteContext,
  type RouteResult,
} from "../routes.js";
import { SSE_HEADERS, readyMessage, startSseHeartbeat } from "../sse.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import { readJsonObject } from "../files.js";
import { handleGitStatus, handleGitStructuredDiff, handleGitBlame } from "../gitRoutes.js";
import type { UiHandlerDeps } from "../deps.js";
import { handleEditorLanguage } from "./languageRoutes.js";
import {
  handleEditorWorkspaceSearch,
  handleEditorWorkspaceSymbols,
} from "./workspaceSearchRoutes.js";
import type { AutonomousDeliveryConfirmation } from "../coding-runtime/autonomousDeliveryPolicy.js";
import type { CodingRuntimeEditorMutationLeaseRequest } from "../coding-runtime/codingRuntimeEditorMutationLeaseCoordinator.js";
import {
  editorAgentAuthorityRegistry,
  editorAgentWorkspaceRootDigest,
  type EditorAgentAuthorityResolution,
} from "./agentAuthorityRegistry.js";
import { EDITOR_AGENT_MAX_SESSIONS, editorAgentRegistry } from "./agentSessionRegistry.js";
import {
  _resetEditorAgentAuditForTests,
  editorAgentAuditRootAttribution,
  listEditorAgentActionAudit,
  recordEditorAgentActionAudit,
} from "./agentActionAudit.js";
import {
  EDITOR_AGENT_ROOT_BOUNDARY_ERROR_CODE,
  editorAgentRootContainmentReason,
  isEditorAgentRootBoundaryDenial,
  resolveEditorAgentActionRoot,
  resolveEditorAgentContainmentPort,
  resolveEditorAgentSessionRoot,
  type EditorAgentRootBoundaryReason,
} from "./agentRootBoundary.js";

type EditorAgentRouteDeps = Pick<
  UiHandlerDeps,
  | "autonomousDeliveryApprovalStore"
  | "autonomousDeliveryDeploymentCeiling"
  | "runtimeMutationLease"
  | "workspaceRootAccessResolver"
  | "workspaceScriptTrust"
> & { readonly store?: UiHandlerDeps["store"] | undefined };

type EditorAgentActionRouteDeps = UiHandlerDeps;

// The helpers both route families share (root binding, path containment, policy decisions) accept
// either dependency shape; naming the union once keeps their signatures in step.
type EditorAgentEitherRouteDeps = EditorAgentActionRouteDeps | EditorAgentRouteDeps;

const MAX_AGENT_BODY_BYTES = 1_048_576;
const DEFAULT_SNAPSHOT_TEXT_BUDGET_BYTES = EDITOR_AGENT_SNAPSHOT_TEXT_MAX_BYTES;
const MAX_ACTIVE_BRIDGE_STREAMS = 256;

type Changeset = NonNullable<EditorAgentAction["changeset"]>;
type ChangesetFile = Changeset["files"][number];
type PreparedChangeset = NonNullable<Changeset["prepared"]>;
type PreparedFile = PreparedChangeset["files"][number];
type PreparedTextEdit = PreparedFile["textEdits"][number];
type ChangesetFileResult = NonNullable<EditorAgentActionResult["files"]>[number];
type DocumentVersion = NonNullable<ChangesetFile["expectedDocumentVersion"]>;

function isServerResolvedAction(action: EditorAgentAction): boolean {
  return (
    action.type === "navigateSymbol" ||
    action.type === "searchWorkspace" ||
    action.type === "queryGit"
  );
}

let editorAgentPatchWriterForTests: WorkspaceWriter | undefined;

interface QueuedRecord {
  readonly requestHash: string;
  readonly result: EditorAgentActionResult;
}

// HTTP-level idempotency: a replayed Idempotency-Key returns the original outcome; a key reused with a
// different action body is a 409. This is request de-duplication and stays at the route edge. The map
// is bounded (FIFO eviction) and stores only a hash of the request body, so it cannot grow without
// limit or retain raw action content (text edits, patch bodies) on a long-lived server.
const MAX_IDEMPOTENCY_ENTRIES = 1024;
const idempotency = new Map<string, QueuedRecord>();
const activeBridgeStreams = new Map<string, () => void>();

function hashRequest(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function bridgeCapabilityDigest(capability: string): string {
  return createHash("sha256").update(capability, "utf8").digest("hex");
}

function issueBridgeDecisionCapability(): string {
  return randomBytes(EDITOR_AGENT_BRIDGE_DECISION_CAPABILITY_BYTES).toString("base64url");
}

function rememberIdempotency(
  key: string,
  requestHash: string,
  result: EditorAgentActionResult,
): void {
  if (!idempotency.has(key) && idempotency.size >= MAX_IDEMPOTENCY_ENTRIES) {
    const oldest = idempotency.keys().next().value;
    if (oldest !== undefined) idempotency.delete(oldest);
  }
  idempotency.set(key, { requestHash, result });
}

function isRouteResult(value: unknown): value is RouteResult {
  return typeof value === "object" && value !== null && "status" in value && "body" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Prefix(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const nextBytes = Buffer.byteLength(char, "utf8");
    if (bytes + nextBytes > maxBytes) return { text: text.slice(0, end), truncated: true };
    bytes += nextBytes;
    end += char.length;
  }
  return { text, truncated: false };
}

function characterPrefix(
  text: string,
  maxCharacters: number,
): { readonly text: string; readonly truncated: boolean } {
  let characters = 0;
  let end = 0;
  for (const character of text) {
    if (characters === maxCharacters) return { text: text.slice(0, end), truncated: true };
    characters += 1;
    end += character.length;
  }
  return { text, truncated: false };
}

function shapeDiagnosticsDetail(
  detail: NonNullable<EditorAgentSessionSnapshot["diagnosticsDetail"]>,
): NonNullable<EditorAgentSessionSnapshot["diagnosticsDetail"]> {
  let truncated = detail.truncated || detail.items.length > EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS;
  const items = detail.items.slice(0, EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS).map((diagnostic) => {
    const message = characterPrefix(diagnostic.message, EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS);
    truncated ||= message.truncated;
    return message.truncated ? { ...diagnostic, message: message.text } : diagnostic;
  });
  return { items, truncated };
}

function shapeSnapshot(
  snapshot: EditorAgentSessionSnapshot,
  textMode: EditorAgentSnapshotTextMode,
  maxBytes: number,
): EditorAgentSessionSnapshot {
  if (textMode === "none") {
    const rest = { ...snapshot };
    Reflect.deleteProperty(rest, "diagnosticsDetail");
    Reflect.deleteProperty(rest, "text");
    Reflect.deleteProperty(rest, "textTruncated");
    return { ...rest, textMode };
  }
  const shapedSnapshot =
    snapshot.diagnosticsDetail === undefined
      ? snapshot
      : { ...snapshot, diagnosticsDetail: shapeDiagnosticsDetail(snapshot.diagnosticsDetail) };
  if (shapedSnapshot.text === undefined) {
    const rest = { ...shapedSnapshot };
    Reflect.deleteProperty(rest, "text");
    Reflect.deleteProperty(rest, "textTruncated");
    return { ...rest, textMode };
  }
  const bounded = utf8Prefix(shapedSnapshot.text, maxBytes);
  return {
    ...shapedSnapshot,
    textMode,
    text: bounded.text,
    textTruncated: shapedSnapshot.textTruncated === true || bounded.truncated,
  };
}

function dirtyBufferConflict(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): EditorAgentActionResult | null {
  const file = targetFile(action, snapshot);
  if (file !== null && snapshot.dirtyFiles.includes(file) && action.type !== "save") {
    return conflict(action, "DIRTY", "The target buffer has unsaved changes.");
  }
  return null;
}

function documentVersionConflict(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): EditorAgentActionResult | null {
  if (action.expectedDocumentVersion === undefined || snapshot.documentVersion === undefined)
    return null;
  return action.expectedDocumentVersion.contentHash === snapshot.documentVersion.contentHash
    ? null
    : conflict(action, "VERSION_MISMATCH", "The active document version no longer matches.");
}

function contentHashConflict(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): EditorAgentActionResult | null {
  if (action.expectedContentHash === undefined || snapshot.activeFileContentHash === undefined)
    return null;
  return action.expectedContentHash === snapshot.activeFileContentHash
    ? null
    : conflict(
        action,
        "CONTENT_HASH_MISMATCH",
        "The active document content hash no longer matches.",
      );
}

function containmentConflict(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): EditorAgentActionResult | null {
  const file = targetFile(action, snapshot);
  if (file === null) return null;
  return isContainedAgentPath(file)
    ? null
    : conflict(action, "OUT_OF_SCOPE", "The target file escapes the workspace root.");
}

// Issue #1395 (ADR-0062) — a write action whose target is a contained but always-on-deny-listed path
// (.env, .ssh, .keiko, credentials, …) is denied by policy across ALL write action types. Previously
// the deny-list was enforced only on the applyPatch path (via validatePatch); this closes the gap for
// applyTextEdits/save/format. Surfaced as the existing OUT_OF_SCOPE conflict so no new wire code is
// introduced; the fine-grained governance reason (denied-sensitive-path) lives in the audit record.
function sensitivePathConflict(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): EditorAgentActionResult | null {
  const file = targetFile(action, snapshot);
  if (file === null || !isContainedAgentPath(file)) return null;
  return isDenied(file)
    ? conflict(action, "OUT_OF_SCOPE", "The target file is a protected workspace path.")
    : null;
}

function textEditsConflict(action: EditorAgentAction): EditorAgentActionResult | null {
  if (action.type !== "applyTextEdits") return null;
  const error = validateAgentTextEdits(action.textEdits ?? []);
  return error === null ? null : conflict(action, "INVALID_EDITS", error);
}

function workspaceInfoFromRoot(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

const OUT_OF_SCOPE_REJECTION_CODES = new Set(["path-unsafe", "path-denied", "binary"]);

interface ChangesetIssue {
  readonly code: EditorAgentConflictCode;
  readonly message: string;
  readonly file?: string | undefined;
}

interface ChangesetInspection {
  readonly validation: PatchValidation;
  readonly prepared: PreparedChangeset | null;
  readonly result: EditorAgentActionResult | null;
}

interface AdmissionInspection {
  readonly patch?: PatchInspection | undefined;
  readonly changeset?: ChangesetInspection | undefined;
}

type PreflightOutcome =
  | { readonly ok: true; readonly inspection: AdmissionInspection }
  | { readonly ok: false; readonly result: EditorAgentActionResult };

interface ChangesetProjection {
  readonly kind: "ready";
  readonly diff: string;
  readonly selectedPaths: readonly string[];
}

type ChangesetProjectionOutcome =
  ChangesetProjection | { readonly kind: "conflict"; readonly result: EditorAgentActionResult };

function normalizedChangesetPaths(action: EditorAgentAction): readonly string[] {
  return (action.changeset?.files ?? []).map((file) => normalizeWorkspaceRelativePath(file.file));
}

function patchScopeIssues(validation: PatchValidation): readonly ChangesetIssue[] {
  return validation.reasons
    .filter((reason) => OUT_OF_SCOPE_REJECTION_CODES.has(reason.code))
    .map((reason) => ({
      code: "OUT_OF_SCOPE",
      message: reason.message,
      ...(reason.path === undefined || !isContainedAgentPath(reason.path)
        ? {}
        : { file: normalizeWorkspaceRelativePath(reason.path) }),
    }));
}

function duplicatePaths(paths: readonly string[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) duplicates.add(path);
    seen.add(path);
  }
  return duplicates;
}

function changesetShapeIssues(
  action: EditorAgentAction,
  validation: PatchValidation,
): readonly ChangesetIssue[] {
  const declared = normalizedChangesetPaths(action);
  const parsed = validation.files.map((file) => normalizeWorkspaceRelativePath(file.path));
  const declaredSet = new Set(declared);
  const parsedSet = new Set(parsed);
  const issues: ChangesetIssue[] = [...duplicatePaths(parsed)].map((file) => ({
    code: "INVALID_EDITS",
    message: "The patch contains a duplicate normalized file path.",
    file,
  }));
  for (const file of declared) {
    if (!parsedSet.has(file)) {
      issues.push({
        code: "INVALID_EDITS",
        message: "A declared file is missing from the patch.",
        file,
      });
    }
  }
  for (const file of parsedSet) {
    if (!declaredSet.has(file)) {
      issues.push({
        code: "INVALID_EDITS",
        message: "The patch contains an undeclared file.",
        file,
      });
    }
  }
  return issues;
}

function dirtyChangesetIssues(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): readonly ChangesetIssue[] {
  const dirty = new Set(snapshot.dirtyFiles.map(normalizeWorkspaceRelativePath));
  return normalizedChangesetPaths(action)
    .filter((file) => dirty.has(file))
    .map((file) => ({
      code: "DIRTY",
      message: "The changeset file has unsaved buffer changes.",
      file,
    }));
}

function documentVersionsMatch(left: DocumentVersion, right: DocumentVersion): boolean {
  return (
    left.sizeBytes === right.sizeBytes &&
    left.modifiedAt === right.modifiedAt &&
    left.contentHash === right.contentHash
  );
}

function changesetFileIsActive(file: string, snapshot: EditorAgentSessionSnapshot): boolean {
  return (
    snapshot.activeFile !== null &&
    normalizeWorkspaceRelativePath(snapshot.activeFile) === normalizeWorkspaceRelativePath(file)
  );
}

function versionPreconditionIssue(
  file: ChangesetFile,
  inspection: PatchInspectionFile,
  snapshot: EditorAgentSessionSnapshot,
): ChangesetIssue | null {
  const expected = file.expectedDocumentVersion;
  if (expected === undefined) return null;
  if (inspection.sourceVersion === undefined) {
    return {
      code: "PRECONDITION_REQUIRED",
      message: "The declared document version cannot be verified for this file.",
      file: normalizeWorkspaceRelativePath(file.file),
    };
  }
  const activeVersion = changesetFileIsActive(file.file, snapshot)
    ? snapshot.documentVersion
    : undefined;
  if (changesetFileIsActive(file.file, snapshot) && activeVersion === undefined) {
    return {
      code: "PRECONDITION_REQUIRED",
      message: "The active snapshot document version cannot be verified.",
      file: normalizeWorkspaceRelativePath(file.file),
    };
  }
  return documentVersionsMatch(expected, inspection.sourceVersion) &&
    (activeVersion === undefined || documentVersionsMatch(expected, activeVersion))
    ? null
    : {
        code: "VERSION_MISMATCH",
        message: "The changeset file version no longer matches.",
        file: normalizeWorkspaceRelativePath(file.file),
      };
}

function hashPreconditionIssue(
  file: ChangesetFile,
  inspection: PatchInspectionFile,
  snapshot: EditorAgentSessionSnapshot,
): ChangesetIssue | null {
  const expected = file.expectedContentHash;
  if (expected === undefined) return null;
  const activeHash = changesetFileIsActive(file.file, snapshot)
    ? snapshot.activeFileContentHash
    : undefined;
  if (changesetFileIsActive(file.file, snapshot) && activeHash === undefined) {
    return {
      code: "PRECONDITION_REQUIRED",
      message: "The active snapshot content hash cannot be verified.",
      file: normalizeWorkspaceRelativePath(file.file),
    };
  }
  return expected === inspection.sourceContentHash &&
    (activeHash === undefined || expected === activeHash)
    ? null
    : {
        code: "CONTENT_HASH_MISMATCH",
        message: "The changeset file content hash no longer matches.",
        file: normalizeWorkspaceRelativePath(file.file),
      };
}

function changesetPreconditionIssue(
  file: ChangesetFile,
  snapshot: EditorAgentSessionSnapshot,
  inspections: ReadonlyMap<string, PatchInspectionFile>,
): ChangesetIssue | null {
  const normalized = normalizeWorkspaceRelativePath(file.file);
  const inspection = inspections.get(normalized);
  if (inspection === undefined) {
    return {
      code: "PRECONDITION_REQUIRED",
      message: "The changeset file precondition could not be verified.",
      file: normalized,
    };
  }
  return (
    versionPreconditionIssue(file, inspection, snapshot) ??
    hashPreconditionIssue(file, inspection, snapshot) ??
    (file.expectedDocumentVersion === undefined && file.expectedContentHash === undefined
      ? {
          code: "PRECONDITION_REQUIRED",
          message: "Every changeset file requires a verifiable precondition.",
          file: normalized,
        }
      : null)
  );
}

function inspectionsByPath(
  files: readonly PatchInspectionFile[],
): ReadonlyMap<string, PatchInspectionFile> {
  return new Map(
    files.map((file) => [normalizeWorkspaceRelativePath(file.change.path), file] as const),
  );
}

function changesetPreconditionIssues(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  files: readonly PatchInspectionFile[],
): readonly ChangesetIssue[] {
  const issues: ChangesetIssue[] = [];
  const inspections = inspectionsByPath(files);
  for (const file of action.changeset?.files ?? []) {
    const issue = changesetPreconditionIssue(file, snapshot, inspections);
    if (issue !== null) issues.push(issue);
  }
  return issues;
}

function patchEditIssues(validation: PatchValidation): readonly ChangesetIssue[] {
  const reasons = validation.reasons
    .filter((reason) => !OUT_OF_SCOPE_REJECTION_CODES.has(reason.code))
    .map((reason) => ({
      code: "INVALID_EDITS" as const,
      message: reason.message,
      ...(reason.path === undefined || !isContainedAgentPath(reason.path)
        ? {}
        : { file: normalizeWorkspaceRelativePath(reason.path) }),
    }));
  const conflicts = validation.conflicts.map((entry) => ({
    code: "INVALID_EDITS" as const,
    message: entry.reason,
    ...(isContainedAgentPath(entry.path)
      ? { file: normalizeWorkspaceRelativePath(entry.path) }
      : {}),
  }));
  return [...reasons, ...conflicts];
}

function firstChangesetIssueGroup(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  inspection: PatchInspection,
): readonly ChangesetIssue[] {
  const scope = patchScopeIssues(inspection.validation);
  if (scope.length > 0) return scope;
  const shape = changesetShapeIssues(action, inspection.validation);
  if (shape.length > 0) return shape;
  const dirty = dirtyChangesetIssues(action, snapshot);
  if (dirty.length > 0) return dirty;
  const edits = patchEditIssues(inspection.validation);
  if (inspection.files === null) return edits;
  const preconditions = changesetPreconditionIssues(action, snapshot, inspection.files);
  return preconditions.length > 0 ? preconditions : edits;
}

function changesetFileConflictResult(
  file: string,
  issues: readonly ChangesetIssue[],
): ChangesetFileResult {
  const issue =
    issues.find((candidate) => candidate.file === file) ??
    issues.find((candidate) => candidate.file === undefined);
  if (issue === undefined) {
    return {
      file,
      status: "failed",
      message: "The changeset was rejected because another file failed validation.",
    };
  }
  return {
    file,
    status: "conflict",
    message: issue.message,
    conflict: { code: issue.code, message: issue.message, file },
  };
}

function changesetConflict(
  action: EditorAgentAction,
  issues: readonly ChangesetIssue[],
): EditorAgentActionResult {
  const first = issues[0] ?? {
    code: "INVALID_EDITS" as const,
    message: "The changeset failed validation.",
  };
  const files = normalizedChangesetPaths(action).map((file) =>
    changesetFileConflictResult(file, issues.length === 0 ? [first] : issues),
  );
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: action.actionId,
    sessionId: action.sessionId,
    status: "conflict",
    message: first.message,
    conflict: {
      code: first.code,
      message: first.message,
      ...(first.file === undefined ? {} : { file: first.file }),
    },
    files,
  };
}

function inspectChangeset(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  fs: WorkspaceFs = nodeWorkspaceFs,
): ChangesetInspection {
  const inspection = inspectPatch(
    workspaceInfoFromRoot(snapshot.workspaceRoot),
    action.changeset?.patch ?? "",
    { fs },
  );
  const validation = inspection.validation;
  const issues = firstChangesetIssueGroup(action, snapshot, inspection);
  if (issues.length > 0) {
    return { validation, prepared: null, result: changesetConflict(action, issues) };
  }
  const prepared = derivePreparedChangeset(action, inspection.files ?? [], snapshot);
  if (prepared === null) {
    const issue = { code: "INVALID_EDITS" as const, message: "Changeset preview is not bounded." };
    return { validation, prepared: null, result: changesetConflict(action, [issue]) };
  }
  return { validation, prepared, result: null };
}

function derivePreparedFile(inspection: PatchInspectionFile): PreparedFile | null {
  const currentContent = inspection.original ?? "";
  const { change, outcome } = inspection;
  if (outcome.conflicts.length > 0) return null;
  const textEdit: PreparedTextEdit = wholeDocumentReplaceEdit(
    currentContent,
    outcome.content ?? "",
  );
  return {
    file: normalizeWorkspaceRelativePath(change.path),
    kind: change.kind,
    textEdits: [textEdit],
  };
}

function derivePreparedChangeset(
  action: EditorAgentAction,
  inspections: readonly PatchInspectionFile[],
  snapshot: EditorAgentSessionSnapshot,
): PreparedChangeset | null {
  if (inspections.length === 0) return null;
  try {
    const files: PreparedFile[] = [];
    for (const inspection of inspections) {
      const preparedFile = derivePreparedFile(inspection);
      if (preparedFile === null) return null;
      files.push(preparedFile);
    }
    const prepared = { files };
    const changeset = action.changeset;
    if (changeset === undefined) return null;
    const emitAction = { ...action, changeset: { ...changeset, prepared } };
    return isEditorAgentAction(emitAction) ? prepared : null;
  } catch (error) {
    emitServerDiagnostic(
      undefined,
      serverDiagnosticFromError({
        correlationId: snapshot.sessionId,
        operation: "editor.agent.applyChangeset",
        source: "editor.agent.deriveChangeset",
        error,
        redact: () => "Changeset preview derivation failed.",
      }),
    );
    return null;
  }
}

function mapPatchValidation(
  action: EditorAgentAction,
  validation: PatchValidation,
): EditorAgentActionResult | null {
  if (validation.files.length > 1) {
    return conflict(
      action,
      "OUT_OF_SCOPE",
      "Multi-file patches are not supported on the agent action path.",
    );
  }
  const scopeRejection = validation.reasons.find((reason) =>
    OUT_OF_SCOPE_REJECTION_CODES.has(reason.code),
  );
  if (scopeRejection !== undefined) {
    return conflict(action, "OUT_OF_SCOPE", scopeRejection.message);
  }
  const firstReason = validation.reasons.at(0);
  if (firstReason !== undefined) {
    return conflict(action, "INVALID_EDITS", firstReason.message);
  }
  const firstConflict = validation.conflicts.at(0);
  if (firstConflict !== undefined) {
    return conflict(action, "INVALID_EDITS", firstConflict.reason);
  }
  if (validation.ok && validation.files.length === 0) {
    return conflict(action, "INVALID_EDITS", "Patch contains no applicable file change.");
  }
  return null;
}

function patchValidationConflict(
  action: EditorAgentAction,
  inspection: PatchInspection | undefined,
): EditorAgentActionResult | null {
  if (action.type !== "applyPatch") return null;
  return inspection === undefined
    ? conflict(action, "INVALID_EDITS", "Patch inspection is unavailable.")
    : mapPatchValidation(action, inspection.validation);
}

interface AgentTextEdit {
  readonly range: LanguageRange;
  readonly newText: string;
}

function wholeDocumentReplaceEdit(currentContent: string, postImage: string): AgentTextEdit {
  const currentLineCount = currentContent.split("\n").length;
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: currentLineCount + 1, character: 0 },
    },
    newText: postImage,
  };
}

function deriveSingleFilePostImage(inspection: PatchInspectionFile): AgentTextEdit | null {
  const currentContent = inspection.original ?? "";
  const { outcome } = inspection;
  if (outcome.content === null || outcome.conflicts.length > 0) return null;
  return wholeDocumentReplaceEdit(currentContent, outcome.content);
}

// Translates a queued, preflight-validated single-file applyPatch into the contract textEdits the
// browser reviews and applies. The post-image comes from keiko-tools' bounded admission snapshot,
// which guarantees the cross-cutting invariant
// applyTextEditsToText(currentContent, edits) === patchedSingleFileContent. Returns null when the
// patch is not the expected single-file shape or its post-image cannot be derived, so the caller
// fails the action rather than emitting an un-appliable one.
// keiko-tools strips a/ b/ git prefixes; both the patch path and snapshot.activeFile are
// workspace-relative POSIX paths. Normalize a leading ./ and backslashes so a legitimately
// matching same-file patch is not rejected on a cosmetic difference.
function normalizeWorkspaceRelativePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
}

function singlePatchInspectionFile(
  inspection: PatchInspection | undefined,
): PatchInspectionFile | null {
  if (inspection === undefined || !inspection.validation.ok || inspection.files === null) {
    return null;
  }
  return inspection.files.length === 1 ? (inspection.files[0] ?? null) : null;
}

function patchTargetsActiveFile(
  file: PatchInspectionFile,
  snapshot: EditorAgentSessionSnapshot,
): boolean {
  return (
    snapshot.activeFile !== null &&
    normalizeWorkspaceRelativePath(file.change.path) ===
      normalizeWorkspaceRelativePath(snapshot.activeFile)
  );
}

function derivePatchEditWithDiagnostic(
  action: EditorAgentAction,
  file: PatchInspectionFile,
): AgentTextEdit | null {
  try {
    return deriveSingleFilePostImage(file);
  } catch (error) {
    emitServerDiagnostic(
      undefined,
      serverDiagnosticFromError({
        correlationId: action.actionId,
        operation: "editor.agent.applyPatch",
        source: "editor.agent.derivePatch",
        error,
        redact: () => "Patch preview derivation failed.",
      }),
    );
    return null;
  }
}

function deriveAgentPatchTextEdits(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  inspection: PatchInspection | undefined,
): readonly AgentTextEdit[] | null {
  const file = singlePatchInspectionFile(inspection);
  if (file === null || !patchTargetsActiveFile(file, snapshot)) return null;
  const edit = derivePatchEditWithDiagnostic(action, file);
  return edit === null ? null : [edit];
}

// Builds the action envelope to broadcast to the bridge. Patch previews and the review requirement
// are server-derived; null means the patch could not be prepared and must fail before queueing.
function buildEmitAction(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  inspection: AdmissionInspection,
  requiresReview: boolean,
): EditorAgentAction | null {
  const browserAction = stripAuthorityReferences(action);
  if (action.type === "applyChangeset") {
    const changesetInspection = inspection.changeset;
    if (
      changesetInspection?.result !== null ||
      changesetInspection.prepared === null ||
      action.changeset === undefined
    ) {
      return null;
    }
    return {
      ...browserAction,
      requiresReview,
      changeset: { ...action.changeset, prepared: changesetInspection.prepared },
    };
  }
  if (action.type !== "applyPatch") return browserAction;
  const textEdits = deriveAgentPatchTextEdits(action, snapshot, inspection.patch);
  if (textEdits === null) return null;
  return { ...browserAction, requiresReview, textEdits };
}

function stripAuthorityReferences(action: EditorAgentAction): EditorAgentAction {
  const browserAction = { ...action };
  delete browserAction.authorityRef;
  delete browserAction.approvalRef;
  delete browserAction.requiresReview;
  return browserAction;
}

function targetFile(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): string | null {
  return action.target?.file ?? snapshot.activeFile;
}

function bindActiveBufferTarget(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): EditorAgentAction {
  if (!isEditorAgentActiveBufferActionType(action.type)) return action;
  if (snapshot.activeFile === null || snapshot.activePaneId === null) return action;
  return {
    ...action,
    target: {
      ...action.target,
      file: snapshot.activeFile,
      paneId: snapshot.activePaneId,
    },
  };
}

function activeBufferTargetConflict(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): EditorAgentActionResult | null {
  if (!isEditorAgentActiveBufferActionType(action.type)) return null;
  const claimedFile = action.target?.file;
  const claimedPane = action.target?.paneId;
  const fileMismatch =
    snapshot.activeFile === null ||
    (claimedFile !== undefined &&
      normalizeWorkspaceRelativePath(claimedFile) !==
        normalizeWorkspaceRelativePath(snapshot.activeFile));
  const paneMismatch =
    snapshot.activePaneId === null ||
    (claimedPane !== undefined && claimedPane !== snapshot.activePaneId);
  return fileMismatch || paneMismatch
    ? conflict(action, "OUT_OF_SCOPE", "Action target does not match the active editor buffer.")
    : null;
}

// A direct write needs at least one asserted pin that the current snapshot can verify. Missing
// snapshot counterparts are tolerated only when the other asserted pin was verifiable; the mismatch
// gates above still win whenever a counterpart exists and differs.
function preconditionConflict(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): EditorAgentActionResult | null {
  if (action.type === "applyChangeset") return null;
  const error = editorAgentWritePreconditionError(action);
  if (error !== null) return conflict(action, "PRECONDITION_REQUIRED", error);
  const versionVerifiable =
    action.expectedDocumentVersion !== undefined && snapshot.documentVersion !== undefined;
  const hashVerifiable =
    action.expectedContentHash !== undefined && snapshot.activeFileContentHash !== undefined;
  return versionVerifiable || hashVerifiable
    ? null
    : conflict(
        action,
        "PRECONDITION_REQUIRED",
        "At least one asserted write precondition must be verifiable from the current snapshot.",
      );
}

function conflict(
  action: EditorAgentAction,
  code: EditorAgentConflictCode,
  message: string,
): EditorAgentActionResult {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: action.actionId,
    sessionId: action.sessionId,
    status: "conflict",
    message,
    conflict: { code, message },
  };
}

// The Issue #1391/#1394 structural write gates, unchanged: a doubly-invalid write reports its most
// specific failure. Non-write actions have no structural gate.
function snapshotWriteConflict(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): EditorAgentActionResult | null {
  return (
    dirtyBufferConflict(action, snapshot) ??
    documentVersionConflict(action, snapshot) ??
    contentHashConflict(action, snapshot) ??
    containmentConflict(action, snapshot) ??
    sensitivePathConflict(action, snapshot)
  );
}

function actionWriteConflict(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  inspection: AdmissionInspection,
): EditorAgentActionResult | null {
  return (
    textEditsConflict(action) ??
    patchValidationConflict(action, inspection.patch) ??
    preconditionConflict(action, snapshot)
  );
}

function structuralWriteConflict(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  inspection: AdmissionInspection,
): EditorAgentActionResult | null {
  if (!isEditorAgentWriteActionType(action.type)) return null;
  if (action.type === "applyChangeset") {
    return inspection.changeset === undefined
      ? conflict(action, "INVALID_EDITS", "Changeset inspection is unavailable.")
      : inspection.changeset.result;
  }
  return (
    snapshotWriteConflict(action, snapshot) ?? actionWriteConflict(action, snapshot, inspection)
  );
}

function inspectAdmissionAction(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  fs: WorkspaceFs = nodeWorkspaceFs,
): AdmissionInspection {
  if (action.type === "applyChangeset") {
    return { changeset: inspectChangeset(action, snapshot, fs) };
  }
  if (action.type === "applyPatch") {
    // The SAME port the changeset branch above uses. Hardcoding the node port here inspected a
    // managed task worktree under the user-workspace rules and refused every path inside it
    // (cursor review, PR #3381) — see `admissionInspectionFs`.
    return {
      patch: inspectPatch(workspaceInfoFromRoot(snapshot.workspaceRoot), action.patch ?? "", {
        fs,
      }),
    };
  }
  return {};
}

// Returns a structured conflict result when the action must not be admitted to the queue, or null when
// it is clear to enqueue. The structural gates run first (above); the Issue #1392 liveness gate runs
// last so any otherwise-valid action for a session with no live bridge is answered with the structured
// NO_ACTIVE_BRIDGE conflict (AC1) rather than queued where it could never be executed.
function preflight(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
  fs: WorkspaceFs = nodeWorkspaceFs,
): PreflightOutcome {
  if (snapshot === undefined) {
    return {
      ok: false,
      result: conflict(action, "NO_ACTIVE_SESSION", "No active browser bridge is registered."),
    };
  }
  const targetConflict = activeBufferTargetConflict(action, snapshot);
  if (targetConflict !== null) return { ok: false, result: targetConflict };
  const inspection = inspectAdmissionAction(action, snapshot, fs);
  const structural = structuralWriteConflict(action, snapshot, inspection);
  if (structural !== null) return { ok: false, result: structural };
  if (!editorAgentRegistry.hasLiveBridge(action.sessionId)) {
    return {
      ok: false,
      result: conflict(
        action,
        "NO_ACTIVE_BRIDGE",
        "No live browser bridge is connected for this session.",
      ),
    };
  }
  return { ok: true, inspection };
}

function sessionMatchesDiscoveryScope(
  snapshot: EditorAgentSessionSnapshot,
  request: EditorAgentSessionsRequest,
  deps: EditorAgentRouteDeps | undefined,
): boolean {
  const rooted =
    request.rootBinding === undefined
      ? resolveEditorAgentSessionRoot(snapshot, deps?.store)
      : resolveEditorAgentActionRoot(snapshot, request.rootBinding, deps?.store);
  if (!rooted.ok) return false;
  if (
    request.rootBinding === undefined &&
    (rooted.root.explicitBindingRequired || snapshot.rootBinding !== undefined)
  ) {
    return false;
  }
  return editorAgentAuthorityRegistry.resolve(
    request.authorityRef,
    rooted.root.workspaceRoot,
    editorAgentDeploymentCeiling(deps),
    new Date().toISOString(),
  ).ok;
}

export function handleEditorAgentSessions(): RouteResult {
  const sessions = editorAgentRegistry
    .listSessions()
    .filter((snapshot) => editorAgentRegistry.hasLiveBridge(snapshot.sessionId))
    .map((snapshot) => shapeSnapshot(snapshot, "none", 0));
  return { status: 200, body: { sessions } };
}

export async function handleEditorAgentScopedSessions(
  ctx: RouteContext,
  deps?: EditorAgentRouteDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_AGENT_BODY_BYTES);
  if (isRouteResult(body)) return body;
  if (!isEditorAgentSessionsRequest(body)) {
    return { status: 400, body: errorBody("INVALID_REQUEST", "Session scope is invalid.") };
  }
  const sessions = editorAgentRegistry
    .listSessions()
    .filter((snapshot) => editorAgentRegistry.hasLiveBridge(snapshot.sessionId))
    .filter((snapshot) => sessionMatchesDiscoveryScope(snapshot, body, deps))
    .map((snapshot) => shapeSnapshot(snapshot, "none", 0));
  return { status: 200, body: { sessions } };
}

function bridgeCapabilityError(): RouteResult {
  return {
    status: 403,
    body: errorBody(
      "BRIDGE_CAPABILITY_INVALID",
      "A valid browser bridge decision capability is required.",
    ),
  };
}

function snapshotRootPaths(snapshot: EditorAgentSessionSnapshot): readonly string[] {
  return [
    ...(snapshot.activeFile === null ? [] : [snapshot.activeFile]),
    ...snapshot.dirtyFiles,
    ...snapshot.panes.flatMap((pane) => [
      ...(pane.activeFile === null ? [] : [pane.activeFile]),
      ...pane.openFiles,
    ]),
  ];
}

function rootBoundaryError(reason: EditorAgentRootBoundaryReason): RouteResult {
  return {
    status: 403,
    body: errorBody(
      EDITOR_AGENT_ROOT_BOUNDARY_ERROR_CODE[reason],
      "The editor agent request is not authorized for this workspace root.",
    ),
  };
}

function registerBridgeSnapshot(
  request: EditorAgentBridgeSnapshotRequest,
  deps?: EditorAgentRouteDeps,
): RouteResult {
  const root = resolveEditorAgentSessionRoot(request.snapshot, deps?.store);
  if (!root.ok) return rootBoundaryError(root.reason);
  const pathReason = editorAgentRootContainmentReason(
    root.root,
    snapshotRootPaths(request.snapshot),
    deps,
    shapedCorrelationId(request.snapshot.sessionId),
  );
  if (pathReason !== null) return rootBoundaryError(pathReason);
  const snapshot =
    root.root.workspaceRoot === request.snapshot.workspaceRoot
      ? request.snapshot
      : { ...request.snapshot, workspaceRoot: root.root.workspaceRoot };
  const existing = editorAgentRegistry.snapshotFor(snapshot.sessionId);
  const supplied = request.bridgeDecisionCapability;
  if (
    existing !== undefined &&
    supplied !== undefined &&
    editorAgentRegistry.refreshSnapshot(snapshot, bridgeCapabilityDigest(supplied))
  ) {
    return { status: 200, body: { snapshot } };
  }
  const capability = issueBridgeDecisionCapability();
  const digest = bridgeCapabilityDigest(capability);
  const registered =
    existing === undefined
      ? editorAgentRegistry.registerSnapshot(snapshot, digest)
      : editorAgentRegistry.rotateSnapshotCapability(snapshot, digest);
  return registered
    ? { status: 200, body: { snapshot, bridgeDecisionCapability: capability } }
    : bridgeCapabilityError();
}

function snapshotReadAction(request: EditorAgentSnapshotRequest): EditorAgentAction {
  const identity = createHash("sha256")
    .update(`${request.sessionId ?? "selected"}:${request.textMode}`, "utf8")
    .digest("hex");
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: `snapshot-${identity}`,
    idempotencyKey: `snapshot-${identity}`,
    sessionId: request.sessionId ?? "selected",
    type: "searchWorkspace",
    ...(request.rootBinding === undefined ? {} : { rootBinding: request.rootBinding }),
    ...(request.authorityRef === undefined ? {} : { authorityRef: request.authorityRef }),
    searchWorkspace: { mode: "text", query: "editor-agent-snapshot", maxResults: 1 },
  };
}

function authorizeSnapshotRead(
  request: EditorAgentSnapshotRequest,
  snapshot: EditorAgentSessionSnapshot,
  deps: EditorAgentRouteDeps | undefined,
): RouteResult | null {
  // Whether an explicit binding is required is a property of the live manifest, never of the
  // snapshot. Deciding it from the snapshot let a session that was registered while the workspace
  // still had one root keep reading after a second root arrived, skipping both the root boundary
  // and the authority reservation.
  const session = resolveEditorAgentSessionRoot(snapshot, deps?.store);
  if (!session.ok) return rootBoundaryError(session.reason);
  if (!session.root.explicitBindingRequired && snapshot.rootBinding === undefined) return null;
  const rooted = resolveEditorAgentActionRoot(snapshot, request.rootBinding, deps?.store);
  if (!rooted.ok) return rootBoundaryError(rooted.reason);
  const action = { ...snapshotReadAction(request), sessionId: snapshot.sessionId };
  const decision = decideActionPolicy(action, snapshot, deps);
  const policyConflict = policyAdmissionConflict(action, decision);
  if (policyConflict !== null) {
    return { status: 403, body: { result: resultForAction(policyConflict, snapshot) } };
  }
  // Non-consuming validation: bound-session snapshot reads must not increment
  // the authority envelope's toolCalls counter, or repeated polls silently
  // burn maxToolCalls before the first real edit ever runs.
  const authorityRejection = validateActionAuthority(action, snapshot, decision, deps);
  return authorityRejection === null
    ? null
    : {
        status: 403,
        body: errorBody(
          "EDITOR_AGENT_SNAPSHOT_AUTHORITY_INVALID",
          "Snapshot context is not authorized for this workspace root.",
        ),
      };
}

export async function handleEditorAgentSnapshot(
  ctx: RouteContext,
  deps?: EditorAgentRouteDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_AGENT_BODY_BYTES);
  if (isRouteResult(body)) return body;
  const parsed = parseEditorAgentSnapshotRequest(body);
  if (!parsed.ok) {
    return { status: 400, body: errorBody("INVALID_REQUEST", parsed.errors.join("; ")) };
  }
  if ("kind" in parsed.value) {
    return registerBridgeSnapshot(parsed.value, deps);
  }
  const selected = editorAgentRegistry.selectSnapshot(parsed.value.sessionId);
  if (selected === undefined) return { status: 200, body: { snapshot: null } };
  const readRejection = authorizeSnapshotRead(parsed.value, selected, deps);
  if (readRejection !== null) return readRejection;
  const maxBytes = parsed.value.maxBytes ?? DEFAULT_SNAPSHOT_TEXT_BUDGET_BYTES;
  return {
    status: 200,
    body: { snapshot: shapeSnapshot(selected, parsed.value.textMode, maxBytes) },
  };
}

const EDITOR_AGENT_AUTHORITY_REQUEST_KEYS = new Set([
  "schemaVersion",
  "authorityEnvelope",
  "confirmation",
]);
const EDITOR_AGENT_AUTHORITY_CONFIRMATION_KEYS = new Set([
  "confirmed",
  "approvalProofDigest",
  "confirmedAt",
]);

function editorAgentDeploymentCeiling(deps: EditorAgentRouteDeps | undefined): CodingWorkbenchMode {
  return deps?.autonomousDeliveryDeploymentCeiling ?? "governed-assist";
}

function parseAuthorityConfirmation(value: unknown): AutonomousDeliveryConfirmation | undefined {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) => EDITOR_AGENT_AUTHORITY_CONFIRMATION_KEYS.has(key)) ||
    value.confirmed !== true ||
    typeof value.approvalProofDigest !== "string" ||
    typeof value.confirmedAt !== "string"
  ) {
    return undefined;
  }
  return {
    confirmed: true,
    approvalProofDigest: value.approvalProofDigest,
    confirmedAt: value.confirmedAt,
  };
}

interface ParsedEditorAgentAuthorityRequest {
  readonly envelope: unknown;
  readonly confirmation: AutonomousDeliveryConfirmation;
}

function parseAuthorityRequest(
  body: Record<string, unknown>,
): ParsedEditorAgentAuthorityRequest | undefined {
  const confirmation = parseAuthorityConfirmation(body.confirmation);
  if (
    body.schemaVersion !== EDITOR_AGENT_SCHEMA_VERSION ||
    !Object.keys(body).every((key) => EDITOR_AGENT_AUTHORITY_REQUEST_KEYS.has(key)) ||
    body.authorityEnvelope === undefined ||
    confirmation === undefined
  ) {
    return undefined;
  }
  return { envelope: body.authorityEnvelope, confirmation };
}

export async function handleEditorAgentAuthority(
  ctx: RouteContext,
  deps?: EditorAgentRouteDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_AGENT_BODY_BYTES);
  if (isRouteResult(body)) return body;
  const request = parseAuthorityRequest(body);
  if (request === undefined) {
    return { status: 400, body: errorBody("INVALID_REQUEST", "Authority request is invalid.") };
  }
  const parsed = validateCodingWorkbenchAuthorityEnvelope(request.envelope);
  const ceiling = editorAgentDeploymentCeiling(deps);
  const approvalStore = deps?.autonomousDeliveryApprovalStore;
  const nowIso = new Date().toISOString();
  if (
    !parsed.ok ||
    parsed.value.deploymentCeiling !== ceiling ||
    approvalStore?.consume(parsed.value, request.confirmation, nowIso) !== true
  ) {
    return {
      status: 403,
      body: errorBody("AUTHORITY_PROOF_INVALID", "Authority confirmation was not accepted."),
    };
  }
  const registration = editorAgentAuthorityRegistry.register(parsed.value, ceiling, nowIso);
  if (!registration.ok) {
    const code = registration.reason === "expired" ? "AUTHORITY_EXPIRED" : "AUTHORITY_INVALID";
    return { status: 403, body: errorBody(code, "The Authority Envelope was not accepted.") };
  }
  return { status: 200, body: { authorityRef: registration.authorityRef } };
}

function resolveNonMutationTargetPath(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
): readonly string[] {
  return optionalTargetPath(action.target?.file ?? snapshot?.activeFile);
}

function resolveActionTargetPaths(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
): readonly string[] {
  if (action.type === "applyChangeset") {
    return (action.changeset?.files ?? []).map((file) => file.file);
  }
  if (isEditorAgentActiveBufferActionType(action.type)) {
    return optionalTargetPath(snapshot?.activeFile);
  }
  if (action.type === "searchWorkspace") {
    return optionalTargetPath(action.searchWorkspace?.scopePath);
  }
  if (action.type === "queryGit") {
    return optionalTargetPath(action.queryGit?.path);
  }
  return resolveNonMutationTargetPath(action, snapshot);
}

function searchWorkspaceResolvedPaths(action: EditorAgentAction): readonly (string | undefined)[] {
  return [
    action.searchWorkspace?.scopePath,
    action.target?.file,
    ...(action.searchWorkspace?.includeGlobs ?? []),
    ...(action.searchWorkspace?.excludeGlobs ?? []),
  ];
}

function serverResolvedActionPaths(action: EditorAgentAction): readonly (string | undefined)[] {
  if (action.type === "navigateSymbol") {
    return [action.navigateSymbol?.document.path, action.target?.file];
  }
  if (action.type === "queryGit") {
    return [action.queryGit?.path, action.target?.file];
  }
  return searchWorkspaceResolvedPaths(action);
}

function serverResolvedPathIssue(path: string): EditorAgentActionDenyReason | null {
  if (!isContainedAgentPath(path)) return "workspace-boundary-escape";
  return isDenied(path) ? "denied-sensitive-path" : null;
}

// The correlation the containment port's own denial line is recorded under. A governed action
// carries its run id; a bridge snapshot has only its session id. Both are shape-checked, so an
// unshaped value is omitted (and logged as UNKNOWN_CORRELATION_ID) rather than smuggled onto the
// activity log.
function shapedCorrelationId(candidate: string | undefined): string | undefined {
  return candidate !== undefined && isValidCorrelationId(candidate) ? candidate : undefined;
}

function actionCorrelationId(action: EditorAgentAction): string | undefined {
  return shapedCorrelationId(action.authorityRef?.runId) ?? shapedCorrelationId(action.actionId);
}

// The filesystem port the root's own authority resolved: the owned-root port for a proven managed
// task worktree, the plain node port for an ordinary root. A refused root keeps the previous
// fail-closed outcome at this seam (the git query is denied) but no longer silently borrows the
// node port to get there.
function queryGitPathIssue(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  deps: EditorAgentActionRouteDeps | undefined,
): EditorAgentActionDenyReason | null {
  if (action.type !== "queryGit" || action.queryGit === undefined) return null;
  const queryPath = normalizeWorkspaceRelativePath(action.queryGit.path);
  const targetPath = action.target?.file;
  if (targetPath !== undefined && normalizeWorkspaceRelativePath(targetPath) !== queryPath) {
    return "workspace-boundary-escape";
  }
  const port = resolveEditorAgentContainmentPort(
    deps,
    snapshot.workspaceRoot,
    actionCorrelationId(action),
  );
  if (!port.ok) return port.reason;
  try {
    containedRealPathInfo(
      port.fs,
      snapshot.workspaceRoot,
      resolve(snapshot.workspaceRoot, queryPath),
    );
    return null;
  } catch {
    return "workspace-boundary-escape";
  }
}

function serverResolvedPathIssues(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  deps: EditorAgentActionRouteDeps | undefined,
): EditorAgentActionDenyReason | null {
  const paths = serverResolvedActionPaths(action);
  for (const path of paths) {
    if (path === undefined) continue;
    const issue = serverResolvedPathIssue(path);
    if (issue !== null) return issue;
  }
  return queryGitPathIssue(action, snapshot, deps);
}

// `correlationId` is the ACTION's own id, not a request id: these contexts are synthesized to run
// an editor-agent action's server-resolved step in-process, and the action is the operation an
// operator reconstructs. `executeServerResolvedAction` already keys its diagnostics on the same
// value, so a delegated route's activity-log lines now join to the identical id (AGENTS.md §8).
function serverActionContext(body: unknown, path: string, actionId: string): RouteContext {
  const req = Readable.from([
    Buffer.from(JSON.stringify(body), "utf8"),
  ]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  const res = {
    writableEnded: false,
    on: (): typeof res => res,
  } as unknown as ServerResponse;
  return {
    req,
    res,
    params: {},
    url: new URL(`http://127.0.0.1${path}`),
    correlationId: actionId,
  };
}

function actionAbortSignal(ctx: RouteContext): AbortSignal {
  const controller = new AbortController();
  ctx.req.on("aborted", () => {
    controller.abort();
  });
  if (typeof ctx.res.on === "function") {
    ctx.res.on("close", () => {
      if (!ctx.res.writableEnded) controller.abort();
    });
  }
  if (ctx.req.destroyed && typeof ctx.req.complete === "boolean" && !ctx.req.complete) {
    controller.abort();
  }
  return controller.signal;
}

function serverResolvedDocumentText(
  snapshot: EditorAgentSessionSnapshot,
  path: string,
  text: string | undefined,
): string {
  if (text !== undefined) return text;
  const workspace = detectWorkspaceAt(snapshot.workspaceRoot, nodeWorkspaceFs);
  return readWorkspaceFile(
    workspace,
    path,
    { maxBytes: EDITOR_AGENT_NAVIGATION_DOCUMENT_MAX_BYTES },
    nodeWorkspaceFs,
  ).text;
}

function optionalTargetPath(path: string | null | undefined): readonly string[] {
  return path === null || path === undefined ? [] : [path];
}

function governedActionTarget(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
): { readonly targetPath: string | null; readonly targetSensitive: boolean } {
  const paths = resolveActionTargetPaths(action, snapshot);
  const escaping = paths.find((path) => !isContainedAgentPath(path));
  const sensitive = paths.find((path) => isContainedAgentPath(path) && isDenied(path));
  return {
    targetPath: escaping ?? sensitive ?? paths[0] ?? null,
    targetSensitive: sensitive !== undefined,
  };
}

function denyByAuthority(
  baseline: EditorAgentActionPolicyDecision,
  denyReason: EditorAgentActionDenyReason,
): EditorAgentActionPolicyDecision {
  return {
    disposition: "denied",
    effectClass: baseline.effectClass,
    origin: baseline.origin,
    denyReason,
  };
}

// Exported for direct regression coverage (mirrors verificationAuthorityDenyReason, Issue #2723):
// otherwise only reachable by forcing a real authority resolution failure (expiry, revocation, or
// budget exhaustion) through the full governed action route.
export function authorityDenyReason(
  resolution: Extract<EditorAgentAuthorityResolution, { readonly ok: false }>,
): EditorAgentActionDenyReason {
  if (resolution.reason === "expired") return "authority-expired";
  if (resolution.reason === "revoked") return "authority-revoked";
  return resolution.reason === "budget-exceeded"
    ? "authority-budget-exceeded"
    : "authority-invalid";
}

function editorWorkspaceTrust(
  deps: EditorAgentRouteDeps | undefined,
  workspaceRoot: string,
): WorkspaceTrustLevel {
  try {
    return deps?.workspaceScriptTrust?.trustLevelForRoot(workspaceRoot) === "trusted"
      ? "trusted"
      : "restricted";
  } catch {
    return "restricted";
  }
}

// Deterministic policy classification (AC2). Containment reuses the contract guard; sensitivity reuses
// the always-on workspace deny-list (a keiko-workspace concern the leaf classifier cannot reach, so
// the boolean is resolved here). Pure browser navigation/layout remains exempt; server-resolved
// repository reads compose and reserve through the same non-null workspace-read class as queryGit.
function decideActionPolicy(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
  deps?: EditorAgentRouteDeps,
  runtimeMutation?: RuntimeMutationClassification,
): EditorAgentActionPolicyDecision {
  const { targetPath, targetSensitive } = governedActionTarget(action, snapshot);
  const baseline = classifyEditorAgentAction(action.type, {
    targetPath,
    targetSensitive,
    origin: action.origin,
  });
  if (baseline.disposition === "denied") return baseline;
  if (action.approvalRef !== undefined) {
    return denyByAuthority(baseline, "approval-reference-invalid");
  }
  if (runtimeMutation?.kind === "runtime") return baseline;
  if (EDITOR_AGENT_WORKBENCH_ACTION_CLASS[baseline.effectClass] === null) return baseline;
  if (action.authorityRef === undefined) {
    return denyByAuthority(baseline, "authority-missing");
  }
  if (snapshot === undefined) return denyByAuthority(baseline, "authority-invalid");
  const resolution = editorAgentAuthorityRegistry.resolveForAction(
    action.authorityRef,
    action,
    snapshot.workspaceRoot,
    editorAgentDeploymentCeiling(deps),
    new Date().toISOString(),
  );
  if (!resolution.ok) return denyByAuthority(baseline, authorityDenyReason(resolution));
  return composeEditorAgentActionPolicyDecision(
    baseline,
    resolution.envelope,
    EDITOR_AGENT_ACTION_APPROVAL_RISK[action.type],
    editorWorkspaceTrust(deps, snapshot.workspaceRoot),
  );
}

function reserveActionAuthority(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
  decision: EditorAgentActionPolicyDecision,
  deps?: EditorAgentRouteDeps,
): EditorAgentActionPolicyDecision | null {
  if (EDITOR_AGENT_WORKBENCH_ACTION_CLASS[decision.effectClass] === null) return null;
  if (snapshot === undefined) return denyByAuthority(decision, "authority-invalid");
  if (action.authorityRef === undefined) {
    return denyByAuthority(decision, "authority-missing");
  }
  const rooted = resolveEditorAgentActionRoot(snapshot, action.rootBinding, deps?.store);
  if (!rooted.ok) return denyByAuthority(decision, rooted.reason);
  const pathReason = editorAgentRootContainmentReason(
    rooted.root,
    actionRootPaths(action, snapshot),
    deps,
    actionCorrelationId(action),
  );
  if (pathReason !== null) return denyByAuthority(decision, pathReason);
  const reservation = editorAgentAuthorityRegistry.reserveForAction(
    action.authorityRef,
    action,
    snapshot.workspaceRoot,
    editorAgentDeploymentCeiling(deps),
    actionPatchByteLength(action) ?? 0,
    new Date().toISOString(),
  );
  return reservation.ok ? null : denyByAuthority(decision, authorityDenyReason(reservation));
}

// Non-consuming twin of `reserveActionAuthority`: mirrors every guard but
// calls `resolveForAction` instead of `reserveForAction`, so a bound-session
// poll (snapshot read) validates its authority without incrementing the
// `toolCalls` usage counter. Without this a governed session that polls N
// times before its first real edit burns N of maxToolCalls and then hits
// budget-exceeded on the very first mutation.
function validateActionAuthority(
  action: EditorAgentAction,
  // Bound-session snapshot reads (the only caller — `authorizeSnapshotRead`)
  // always have a resolved snapshot, so the parameter narrows from the
  // `reserveActionAuthority` shape here and the snapshot-undefined guard
  // becomes provably unreachable and is removed.
  snapshot: EditorAgentSessionSnapshot,
  decision: EditorAgentActionPolicyDecision,
  deps?: EditorAgentRouteDeps,
): EditorAgentActionPolicyDecision | null {
  if (EDITOR_AGENT_WORKBENCH_ACTION_CLASS[decision.effectClass] === null) return null;
  if (action.authorityRef === undefined) {
    return denyByAuthority(decision, "authority-missing");
  }
  const rooted = resolveEditorAgentActionRoot(snapshot, action.rootBinding, deps?.store);
  if (!rooted.ok) return denyByAuthority(decision, rooted.reason);
  const pathReason = editorAgentRootContainmentReason(
    rooted.root,
    actionRootPaths(action, snapshot),
    deps,
    actionCorrelationId(action),
  );
  if (pathReason !== null) return denyByAuthority(decision, pathReason);
  const resolution = editorAgentAuthorityRegistry.resolveForAction(
    action.authorityRef,
    action,
    snapshot.workspaceRoot,
    editorAgentDeploymentCeiling(deps),
    new Date().toISOString(),
  );
  return resolution.ok ? null : denyByAuthority(decision, authorityDenyReason(resolution));
}

// Issue #1395 (AC1) — record one content-free audit entry for this action at its admission decision.
// Best-effort: the ledger filters to mutating/denied actions and never throws. `editCount`/
// `patchByteLength` are counts only, never edit or patch content.
function auditAction(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
  decision: EditorAgentActionPolicyDecision,
  result: EditorAgentActionResult,
  metadataRedactor?: EditorAgentActionRouteDeps["redactor"],
  runtimeOrigin = false,
): void {
  const queryPath =
    action.type === "queryGit" && action.queryGit !== undefined
      ? normalizeWorkspaceRelativePath(action.queryGit.path)
      : undefined;
  recordEditorAgentActionAudit({
    occurredAt: Date.now(),
    sessionId: action.sessionId,
    actionId: action.actionId,
    actionType: action.type,
    ...editorAgentAuditRootAttribution(snapshot),
    decision,
    outcome: result.status,
    conflictCode: result.conflict?.code,
    failureCode: result.failure?.code,
    ...auditTargetFields(action, snapshot, decision, queryPath, metadataRedactor, runtimeOrigin),
    editCount: action.type === "applyTextEdits" ? action.textEdits?.length : undefined,
    patchByteLength: actionPatchByteLength(action),
  });
}

function auditTargetFields(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
  decision: EditorAgentActionPolicyDecision,
  queryPath: string | undefined,
  metadataRedactor: EditorAgentActionRouteDeps["redactor"] | undefined,
  runtimeOrigin: boolean,
):
  | { readonly targetPath: string | null }
  | { readonly targetBasename: string; readonly targetPathHash: string }
  | Record<never, never> {
  if (runtimeOrigin) return {};
  if (isEditorAgentRootBoundaryDenial(decision.denyReason)) return {};
  if (queryPath !== undefined) {
    return {
      targetBasename: redactedQueryGitBasename(queryPath, metadataRedactor),
      targetPathHash: hashRequest(queryPath),
    };
  }
  return { targetPath: governedActionTarget(action, snapshot).targetPath };
}

function redactedQueryGitBasename(
  path: string,
  redactor: EditorAgentActionRouteDeps["redactor"] | undefined,
): string {
  const candidate = redactor?.(basename(path)) ?? basename(path);
  return typeof candidate === "string" && candidate.length > 0 ? candidate : "redacted-target";
}

function actionPatchByteLength(action: EditorAgentAction): number | undefined {
  if (action.type === "applyTextEdits") {
    return action.textEdits?.reduce(
      (total, edit) => total + Buffer.byteLength(edit.newText, "utf8"),
      0,
    );
  }
  const patch = action.type === "applyChangeset" ? action.changeset?.patch : action.patch;
  return patch === undefined ? undefined : Buffer.byteLength(patch, "utf8");
}

function selectedChangesetPaths(action: EditorAgentAction): readonly string[] {
  const selected =
    action.changeset?.selectedFiles ?? action.changeset?.files.map((file) => file.file);
  return (selected ?? []).map(normalizeWorkspaceRelativePath);
}

function changesetFileResults(
  action: EditorAgentAction,
  selectedPaths: readonly string[],
  selectedStatus: "succeeded" | "failed",
): readonly ChangesetFileResult[] {
  const selected = new Set(selectedPaths);
  return normalizedChangesetPaths(action).map((file) =>
    selected.has(file) ? { file, status: selectedStatus } : { file, status: "not-selected" },
  );
}

function changesetTerminalResult(
  action: EditorAgentAction,
  selectedPaths: readonly string[],
  status: "succeeded" | "failed",
  message?: string,
): EditorAgentActionResult {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: action.actionId,
    sessionId: action.sessionId,
    status,
    ...(message === undefined ? {} : { message }),
    files: changesetFileResults(action, selectedPaths, status),
  };
}

function emitChangesetDiagnostic(
  action: EditorAgentAction,
  source: string,
  error: unknown,
  summary: string,
): void {
  emitServerDiagnostic(
    undefined,
    serverDiagnosticFromError({
      correlationId: action.actionId,
      operation: "editor.agent.applyChangeset",
      source,
      error,
      redact: () => summary,
    }),
  );
}

function projectedAction(
  action: EditorAgentAction,
  diff: string,
  selectedPaths: readonly string[],
): EditorAgentAction {
  const selected = new Set(selectedPaths);
  const files = (action.changeset?.files ?? []).filter((file) =>
    selected.has(normalizeWorkspaceRelativePath(file.file)),
  );
  return { ...action, changeset: { patch: diff, files } };
}

function projectedChangesetIssues(
  action: EditorAgentAction,
  validation: PatchValidation,
): readonly ChangesetIssue[] {
  const groups = [
    patchScopeIssues(validation),
    changesetShapeIssues(action, validation),
    patchEditIssues(validation),
  ];
  const issues = groups.find((group) => group.length > 0) ?? [];
  if (issues.length > 0 || (validation.ok && validation.files.length > 0)) return issues;
  return [{ code: "INVALID_EDITS", message: "The selected changeset failed validation." }];
}

function projectChangeset(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  validation: PatchValidation,
  fs: WorkspaceFs = nodeWorkspaceFs,
): ChangesetProjectionOutcome {
  const selectedPaths = selectedChangesetPaths(action);
  try {
    const diff = projectValidatedPatch(validation, selectedPaths);
    const projected = projectedAction(action, diff, selectedPaths);
    const projectedValidation = validatePatch(workspaceInfoFromRoot(snapshot.workspaceRoot), diff, {
      fs,
    });
    const issues = projectedChangesetIssues(projected, projectedValidation);
    return issues.length === 0
      ? { kind: "ready", diff, selectedPaths }
      : { kind: "conflict", result: changesetConflict(action, issues) };
  } catch (error) {
    const message =
      error instanceof PatchValidationError
        ? "The selected changeset could not be projected."
        : "The selected changeset projection failed.";
    emitChangesetDiagnostic(action, "editor.agent.projectChangeset", error, message);
    return {
      kind: "conflict",
      result: changesetConflict(action, [{ code: "INVALID_EDITS", message }]),
    };
  }
}

// Exported for direct regression coverage (Issue #2723): pure, no closures, otherwise only reachable
// by forcing applyPatch to fail deep inside a queued changeset commit.
export function applyChangesetErrorMessage(error: unknown): string {
  if (error instanceof PatchApplyError) return "The changeset write failed and was rolled back.";
  if (error instanceof PatchValidationError) {
    return "The selected changeset no longer passes patch validation.";
  }
  return "The changeset could not be applied atomically.";
}

function applyChangeset(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  projection: ChangesetProjection,
  runtimeMutation: RuntimeMutationClassification,
  deps?: EditorAgentRouteDeps,
): EditorAgentActionResult {
  if (!claimRuntimeMutation(runtimeMutation, deps)) {
    return runtimeMutationLeaseDeniedResult(action);
  }
  const fs = changesetWorkspaceFs(snapshot.workspaceRoot, runtimeMutation, deps);
  if (fs === undefined) return runtimeMutationLeaseDeniedResult(action);
  try {
    applyPatch(workspaceInfoFromRoot(snapshot.workspaceRoot), projection.diff, {
      applyEnabled: true,
      signal: new AbortController().signal,
      fs,
      ...(editorAgentPatchWriterForTests === undefined
        ? {}
        : { writer: editorAgentPatchWriterForTests }),
    });
    return changesetTerminalResult(action, projection.selectedPaths, "succeeded");
  } catch (error) {
    const message = applyChangesetErrorMessage(error);
    emitChangesetDiagnostic(action, "editor.agent.commitChangeset", error, message);
    return changesetTerminalResult(action, projection.selectedPaths, "failed", message);
  }
}

function changesetWorkspaceFs(
  workspaceRoot: string,
  runtimeMutation: RuntimeMutationClassification,
  deps?: EditorAgentRouteDeps,
): WorkspaceFs | undefined {
  if (runtimeMutation.kind !== "runtime") return nodeWorkspaceFs;
  try {
    // Only a proven managed root grants a writable fs here, so both refusal decisions collapse to
    // the same answer; the collapse is stated at this consumer rather than in the resolver (#3347).
    const access = workspaceRootAccessOrUndefined(
      deps?.workspaceRootAccessResolver?.(workspaceRoot),
    );
    return access?.kind === "managed-task" && access.canonicalRoot === workspaceRoot
      ? access.fs
      : undefined;
  } catch {
    return undefined;
  }
}

function runtimeMutationLeaseDeniedResult(action: EditorAgentAction): EditorAgentActionResult {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: action.actionId,
    sessionId: action.sessionId,
    status: "failed",
    message: "The runtime mutation authority is no longer valid.",
  };
}

type RuntimeMutationClassification =
  | { readonly kind: "local" }
  | {
      readonly kind: "runtime";
      readonly request: CodingRuntimeEditorMutationLeaseRequest;
      readonly requiresReview?: boolean | undefined;
    }
  | { readonly kind: "denied" };

function classifyRuntimeMutation(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
  deps: EditorAgentRouteDeps | undefined,
): RuntimeMutationClassification {
  if (editorAgentRegistry.isRuntimeOwnedAction(action)) {
    return runtimeMutationRequest(action, snapshot);
  }
  if (deps?.runtimeMutationLease === undefined) return { kind: "local" };
  const request = runtimeMutationRequest(action, snapshot);
  if (request.kind !== "runtime") return request;
  const matched = matchesRuntimeMutationLease(deps.runtimeMutationLease, request);
  if (matched.kind !== "local") return matched;
  const authorityRef = action.authorityRef;
  if (authorityRef === undefined || snapshot === undefined) return { kind: "denied" };
  const resolution = editorAgentAuthorityRegistry.resolve(
    authorityRef,
    snapshot.workspaceRoot,
    editorAgentDeploymentCeiling(deps),
    new Date().toISOString(),
  );
  if (!resolution.ok) return { kind: "denied" };
  return { kind: "local" };
}

function matchesRuntimeMutationLease(
  lease: NonNullable<EditorAgentRouteDeps["runtimeMutationLease"]>,
  request: Extract<RuntimeMutationClassification, { readonly kind: "runtime" }>,
): RuntimeMutationClassification {
  try {
    if (!lease.matches(request.request)) return { kind: "local" };
    const requiresReview = lease.requiresReview(request.request);
    return requiresReview === undefined ? { kind: "denied" } : { ...request, requiresReview };
  } catch {
    return { kind: "denied" };
  }
}

function runtimeMutationRequest(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
): RuntimeMutationClassification {
  const authorityRef = action.authorityRef;
  if (authorityRef === undefined || snapshot === undefined) return { kind: "denied" };
  return {
    kind: "runtime",
    request: {
      authorityRef,
      runId: authorityRef.runId,
      envelopeDigest: authorityRef.envelopeDigest,
      workspaceRootDigest: editorAgentWorkspaceRootDigest(snapshot.workspaceRoot),
      actionId: action.actionId,
      idempotencyKey: action.idempotencyKey,
    },
  };
}

function claimRuntimeMutation(
  classification: RuntimeMutationClassification,
  deps: EditorAgentRouteDeps | undefined,
): boolean {
  if (classification.kind === "local") return true;
  if (classification.kind === "denied" || deps?.runtimeMutationLease === undefined) return false;
  try {
    return deps.runtimeMutationLease.claim(classification.request);
  } catch {
    return false;
  }
}

function finishChangesetResult(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
  result: EditorAgentActionResult,
  deps: EditorAgentRouteDeps | undefined,
  decision = decideActionPolicy(action, snapshot, deps),
  runtimeOrigin = false,
): RouteResult {
  const attributed = resultForAction(result, snapshot);
  auditAction(action, snapshot, decision, attributed, undefined, runtimeOrigin);
  editorAgentRegistry.reportResult(attributed);
  return { status: 200, body: { result: attributed } };
}

function handleChangesetResult(
  action: EditorAgentAction,
  reported: EditorAgentActionResult,
  deps?: EditorAgentRouteDeps,
): RouteResult {
  const snapshot = editorAgentRegistry.snapshotFor(action.sessionId);
  const runtimeMutation = classifyRuntimeMutation(action, snapshot, deps);
  if (reported.status !== "succeeded") {
    const failed = changesetTerminalResult(
      action,
      selectedChangesetPaths(action),
      "failed",
      "The browser rejected the changeset.",
    );
    return finishRuntimeChangeset(action, snapshot, failed, deps, runtimeMutation);
  }
  if (snapshot === undefined) {
    const result = changesetConflict(action, [
      { code: "NO_ACTIVE_SESSION", message: "The browser session is no longer available." },
    ]);
    return finishRuntimeChangeset(action, snapshot, result, deps, runtimeMutation);
  }
  return handleApprovedChangesetResult(action, snapshot, deps, runtimeMutation);
}

type ApprovedChangesetRoot =
  | { readonly ok: true; readonly action: EditorAgentAction }
  | { readonly ok: false; readonly response: RouteResult };

function approvedChangesetRoot(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  deps: EditorAgentRouteDeps | undefined,
  runtimeMutation: RuntimeMutationClassification,
): ApprovedChangesetRoot {
  const rooted = bindActionRoot(action, snapshot, deps);
  if (rooted.ok) return rooted;
  return {
    ok: false,
    response: finishRuntimeChangeset(
      action,
      snapshot,
      rooted.result,
      deps,
      runtimeMutation,
      rooted.decision,
    ),
  };
}

function handleApprovedChangesetResult(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  deps: EditorAgentRouteDeps | undefined,
  runtimeMutation: RuntimeMutationClassification,
): RouteResult {
  const rooted = approvedChangesetRoot(action, snapshot, deps, runtimeMutation);
  if (!rooted.ok) return rooted.response;
  action = rooted.action;
  const decision = decideActionPolicy(action, snapshot, deps, runtimeMutation);
  const policyConflict = policyAdmissionConflict(action, decision);
  if (policyConflict !== null) {
    return finishRuntimeChangeset(
      action,
      snapshot,
      policyConflict,
      deps,
      runtimeMutation,
      decision,
    );
  }
  if (runtimeMutation.kind === "denied") {
    return finishRuntimeChangeset(
      action,
      snapshot,
      runtimeMutationLeaseDeniedResult(action),
      deps,
      runtimeMutation,
      decision,
    );
  }
  const projection = projectApprovedChangeset(action, snapshot, runtimeMutation, deps);
  const result =
    projection.kind === "conflict"
      ? projection.result
      : applyChangeset(action, snapshot, projection, runtimeMutation, deps);
  return finishRuntimeChangeset(action, snapshot, result, deps, runtimeMutation, decision);
}

function projectApprovedChangeset(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  runtimeMutation: RuntimeMutationClassification,
  deps: EditorAgentRouteDeps | undefined,
): ChangesetProjectionOutcome {
  const inspectionFs = changesetWorkspaceFs(snapshot.workspaceRoot, runtimeMutation, deps);
  if (inspectionFs === undefined) {
    return { kind: "conflict", result: runtimeMutationLeaseDeniedResult(action) };
  }
  const inspection = inspectChangeset(action, snapshot, inspectionFs);
  if (inspection.result !== null) {
    return { kind: "conflict", result: inspection.result };
  }
  return projectChangeset(action, snapshot, inspection.validation, inspectionFs);
}

function finishRuntimeChangeset(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
  result: EditorAgentActionResult,
  deps: EditorAgentRouteDeps | undefined,
  runtimeMutation: RuntimeMutationClassification,
  decision = decideActionPolicy(action, snapshot, deps, runtimeMutation),
): RouteResult {
  completeRuntimeMutation(action, runtimeMutation, deps, result.status === "succeeded");
  return finishChangesetResult(
    action,
    snapshot,
    result,
    deps,
    decision,
    runtimeMutation.kind !== "local",
  );
}

function completeRuntimeMutation(
  action: EditorAgentAction,
  classification: RuntimeMutationClassification,
  deps: EditorAgentRouteDeps | undefined,
  succeeded: boolean,
): void {
  if (classification.kind !== "runtime" || deps?.runtimeMutationLease === undefined) return;
  try {
    deps.runtimeMutationLease.complete(classification.request, succeeded);
  } catch (error) {
    emitChangesetDiagnostic(
      action,
      "editor.agent.completeRuntimeMutation",
      error,
      "The runtime mutation lease could not be settled.",
    );
  }
}

type ResultLeaseValidation =
  | { readonly ok: true; readonly capabilityDigest: string }
  | { readonly ok: false; readonly response: RouteResult };

function validateResultLease(request: EditorAgentActionResultRequest): ResultLeaseValidation {
  const capability = request.bridgeDecisionCapability;
  if (capability === undefined) return { ok: false, response: bridgeCapabilityError() };
  const capabilityDigest = bridgeCapabilityDigest(capability);
  if (
    !editorAgentRegistry.matchesBridgeDecisionCapabilityDigest(
      request.result.sessionId,
      capabilityDigest,
    )
  ) {
    return { ok: false, response: bridgeCapabilityError() };
  }
  if (!editorAgentRegistry.hasLiveBridge(request.result.sessionId)) {
    return {
      ok: false,
      response: {
        status: 409,
        body: errorBody("BRIDGE_LEASE_INACTIVE", "The browser bridge lease is not live."),
      },
    };
  }
  return { ok: true, capabilityDigest };
}

function resultForAction(
  result: EditorAgentActionResult,
  snapshot: EditorAgentSessionSnapshot | undefined,
): EditorAgentActionResult {
  const rootAttribution = editorAgentAuditRootAttribution(snapshot).rootAttribution;
  if (rootAttribution !== undefined) return { ...result, rootAttribution };
  return result.rootAttribution === undefined ? result : { ...result, rootAttribution: undefined };
}

function finishBrowserActionResult(
  action: EditorAgentAction,
  result: EditorAgentActionResult,
): RouteResult {
  const attributed = resultForAction(result, editorAgentRegistry.snapshotFor(action.sessionId));
  editorAgentRegistry.reportResult(attributed);
  return { status: 200, body: { result: attributed } };
}

function handlePatchResult(
  action: EditorAgentAction,
  reported: EditorAgentActionResult,
  deps?: EditorAgentRouteDeps,
): RouteResult {
  if (reported.status !== "succeeded") return finishBrowserActionResult(action, reported);
  const snapshot = editorAgentRegistry.snapshotFor(action.sessionId);
  if (snapshot !== undefined) {
    const rooted = bindActionRoot(action, snapshot, deps);
    if (!rooted.ok) return finishBrowserActionResult(action, rooted.result);
    action = rooted.action;
  }
  const decision = decideActionPolicy(action, snapshot, deps);
  const policyConflict = policyAdmissionConflict(action, decision);
  if (policyConflict !== null) return finishBrowserActionResult(action, policyConflict);
  const admission = preflight(action, snapshot);
  return finishBrowserActionResult(action, admission.ok ? reported : admission.result);
}

function handleReportedActionResult(
  request: EditorAgentActionResultRequest,
  deps?: EditorAgentRouteDeps,
): RouteResult {
  const lease = validateResultLease(request);
  if (!lease.ok) return lease.response;
  const { result } = request;
  if (result.status === "queued") {
    return {
      status: 400,
      body: errorBody("INVALID_ACTION_RESULT_STATUS", "A browser result must be terminal."),
    };
  }
  const action = editorAgentRegistry.takePendingAction(
    result.sessionId,
    result.actionId,
    lease.capabilityDigest,
  );
  if (action === undefined) {
    return {
      status: 409,
      body: errorBody(
        "ACTION_RESULT_NOT_PENDING",
        "No pending action matches this terminal result.",
      ),
    };
  }
  if (action.type === "applyChangeset") return handleChangesetResult(action, result, deps);
  if (action.type === "applyPatch") return handlePatchResult(action, result, deps);
  return finishBrowserActionResult(action, result);
}

function actionHasBrowserReview(type: EditorAgentAction["type"]): boolean {
  return type === "applyPatch" || type === "applyChangeset";
}

function policyAdmissionConflict(
  action: EditorAgentAction,
  decision: EditorAgentActionPolicyDecision,
): EditorAgentActionResult | null {
  if (decision.disposition === "denied") {
    return conflict(action, "POLICY_DENIED", "The action is denied by editor policy.");
  }
  if (decision.disposition === "review-required" && !actionHasBrowserReview(action.type)) {
    return conflict(action, "APPROVAL_REQUIRED", "The action requires explicit approval.");
  }
  return null;
}

function rejectActionRequest(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
  decision: EditorAgentActionPolicyDecision,
  result: EditorAgentActionResult,
  requestHash: string,
  status: 403 | 409,
): RouteResult {
  const attributed = resultForAction(result, snapshot);
  rememberIdempotency(action.idempotencyKey, requestHash, attributed);
  auditAction(action, snapshot, decision, attributed);
  editorAgentRegistry.reportResult(attributed);
  return { status, body: { result: attributed } };
}

type BridgeActionLease =
  | {
      readonly ok: true;
      readonly action: EditorAgentAction;
      readonly snapshot: EditorAgentSessionSnapshot;
    }
  | { readonly ok: false; readonly response: RouteResult };

function validateBridgeActionLease(request: EditorAgentBridgeActionRequest): BridgeActionLease {
  const { action, bridgeDecisionCapability } = request;
  const snapshot = editorAgentRegistry.snapshotFor(action.sessionId);
  if (
    snapshot === undefined ||
    !actionHasBrowserReview(action.type) ||
    action.authorityRef !== undefined ||
    action.approvalRef !== undefined
  ) {
    return { ok: false, response: bridgeCapabilityError() };
  }
  const capabilityDigest = bridgeCapabilityDigest(bridgeDecisionCapability);
  if (!editorAgentRegistry.hasValidBridgeLease(action.sessionId, capabilityDigest)) {
    return { ok: false, response: bridgeCapabilityError() };
  }
  return { ok: true, action: { ...action, origin: "chat", requiresReview: true }, snapshot };
}

function attachBridgeActionAuthority(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  deps?: EditorAgentRouteDeps,
): BridgeActionAuthorization {
  const registration = editorAgentAuthorityRegistry.registerLocalBridge(
    snapshot,
    action,
    editorAgentDeploymentCeiling(deps),
    new Date().toISOString(),
  );
  if (!registration.ok) {
    return {
      ok: false,
      response: {
        status: 403,
        body: errorBody("AUTHORITY_INVALID", "Local editor authority was not accepted."),
      },
    };
  }
  return {
    ok: true,
    action: { ...action, authorityRef: registration.authorityRef },
  };
}

type BridgeActionAuthorization =
  | { readonly ok: true; readonly action: EditorAgentAction }
  | { readonly ok: false; readonly response: RouteResult };

function editorActionRequestHash(
  value: EditorAgentAction | EditorAgentBridgeActionRequest,
): string {
  return hashRequest(
    JSON.stringify(
      isEditorAgentAction(value)
        ? value
        : { schemaVersion: value.schemaVersion, kind: value.kind, action: value.action },
    ),
  );
}

interface PreparedEditorActionRequest {
  readonly action: EditorAgentAction;
  readonly bridgeSnapshot?: EditorAgentSessionSnapshot | undefined;
  readonly requestHash: string;
}

type EditorActionRequestPreparation =
  | { readonly ok: true; readonly request: PreparedEditorActionRequest }
  | { readonly ok: false; readonly response: RouteResult };

function navigationTargetMatchesDocument(action: EditorAgentAction): boolean {
  return (
    action.type !== "navigateSymbol" || action.target?.file === action.navigateSymbol?.document.path
  );
}

function invalidNavigationTargetResponse(): EditorActionRequestPreparation {
  return {
    ok: false,
    response: {
      status: 400,
      body: errorBody(
        "INVALID_REQUEST",
        "navigateSymbol target.file must equal navigateSymbol.document.path.",
      ),
    },
  };
}

function prepareEditorActionRequest(
  value: EditorAgentAction | EditorAgentBridgeActionRequest,
): EditorActionRequestPreparation {
  const action = isEditorAgentAction(value) ? value : value.action;
  if (!navigationTargetMatchesDocument(action)) return invalidNavigationTargetResponse();
  const requestHash = editorActionRequestHash(value);
  if (isEditorAgentAction(value)) {
    return { ok: true, request: { action: value, requestHash } };
  }
  const lease = validateBridgeActionLease(value);
  return lease.ok
    ? {
        ok: true,
        request: { action: lease.action, bridgeSnapshot: lease.snapshot, requestHash },
      }
    : lease;
}

// The replay path only consumes the governance pick plus the optional metadata redactor, so it
// accepts both the full handler deps and the narrow reported-result deps after the dev merge.
type EditorAgentReplayDeps = EditorAgentRouteDeps & Partial<Pick<UiHandlerDeps, "redactor">>;

function rejectServerResolvedReplay(
  action: EditorAgentAction,
  requestHash: string,
  deps: EditorAgentReplayDeps | undefined,
): RouteResult | null {
  if (!isServerResolvedAction(action)) return null;
  const snapshot = editorAgentRegistry.snapshotFor(action.sessionId);
  if (snapshot !== undefined) {
    const rooted = bindActionRoot(action, snapshot, deps);
    if (!rooted.ok) {
      return serverResolvedFailure(
        action,
        snapshot,
        rooted.decision,
        rooted.result,
        requestHash,
        403,
        deps?.redactor,
      );
    }
    action = rooted.action;
  }
  const decision = decideActionPolicy(action, snapshot, deps);
  const policyConflict = policyAdmissionConflict(action, decision);
  if (policyConflict !== null) {
    return serverResolvedFailure(
      action,
      snapshot,
      decision,
      policyConflict,
      requestHash,
      403,
      deps?.redactor,
    );
  }
  if (snapshot === undefined || !editorAgentRegistry.hasLiveBridge(action.sessionId)) {
    return serverResolvedFailure(
      action,
      snapshot,
      decision,
      conflict(action, "NO_ACTIVE_SESSION", "No live editor session is connected."),
      requestHash,
      409,
      deps?.redactor,
    );
  }
  return null;
}

function replayEditorAction(
  action: EditorAgentAction,
  requestHash: string,
  deps: EditorAgentReplayDeps | undefined,
): RouteResult | null {
  const replay = idempotency.get(action.idempotencyKey);
  if (replay === undefined) return null;
  if (replay.requestHash !== requestHash) {
    return {
      status: 409,
      body: errorBody(
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key was reused with a different action.",
      ),
    };
  }
  const rejection = rejectServerResolvedReplay(action, requestHash, deps);
  if (rejection !== null) return rejection;
  return { status: 200, body: { result: replay.result } };
}

function serverResolvedFailure(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
  decision: EditorAgentActionPolicyDecision,
  result: EditorAgentActionResult,
  requestHash: string,
  status: 200 | 403 | 409,
  metadataRedactor?: EditorAgentActionRouteDeps["redactor"],
): RouteResult {
  const attributed = resultForAction(result, snapshot);
  rememberIdempotency(action.idempotencyKey, requestHash, attributed);
  auditAction(action, snapshot, decision, attributed, metadataRedactor);
  editorAgentRegistry.reportResult(attributed);
  return { status, body: { result: attributed } };
}

async function runNavigateSymbolAction(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  deps: EditorAgentActionRouteDeps,
  signal: AbortSignal,
): Promise<RouteResult> {
  const request = action.navigateSymbol;
  if (request === undefined) throw new Error("navigateSymbol payload is missing");
  return handleEditorLanguage(
    serverActionContext(
      {
        root: snapshot.workspaceRoot,
        operation: request.operation,
        document: {
          path: request.document.path,
          languageId: request.document.languageId,
          text: serverResolvedDocumentText(snapshot, request.document.path, request.document.text),
        },
        position: request.position,
        ...(request.range === undefined ? {} : { range: request.range }),
        ...(request.diagnostics === undefined ? {} : { diagnostics: request.diagnostics }),
      },
      "/api/editor/language",
      action.actionId,
    ),
    deps,
    deps.editorLanguageRouteOptions,
    signal,
  );
}

function symbolSearchContext(
  root: string,
  request: NonNullable<EditorAgentAction["searchWorkspace"]>,
  actionId: string,
): RouteContext {
  return serverActionContext(
    {
      root,
      query: request.query,
      maxResults: request.maxResults ?? 50,
      ...(request.scopePath === undefined ? {} : { scopePath: request.scopePath }),
    },
    "/api/editor/workspace-symbols",
    actionId,
  );
}

// Issue #2489 (Finding 3) — additive parity with #2217's human search: "regex" maps onto the same
// WorkspaceSearchMode the human route already accepts; any other agent mode is literal.
function textSearchContext(
  root: string,
  request: NonNullable<EditorAgentAction["searchWorkspace"]>,
  actionId: string,
): RouteContext {
  return serverActionContext(
    {
      root,
      query: request.query,
      mode: request.mode === "regex" ? "regex" : "literal",
      caseSensitive: request.caseSensitive ?? false,
      wholeWord: request.wholeWord ?? false,
      includeGlobs: request.includeGlobs ?? [],
      excludeGlobs: request.excludeGlobs ?? [],
      maxResults: request.maxResults ?? 50,
      ...(request.scopePath === undefined ? {} : { scopePath: request.scopePath }),
    },
    "/api/editor/workspace-search",
    actionId,
  );
}

async function runSearchWorkspaceAction(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  deps: EditorAgentActionRouteDeps,
): Promise<RouteResult> {
  const request = action.searchWorkspace;
  if (request === undefined) throw new Error("searchWorkspace payload is missing");
  if (request.mode === "symbol") {
    return handleEditorWorkspaceSymbols(
      symbolSearchContext(snapshot.workspaceRoot, request, action.actionId),
      deps,
    );
  }
  return handleEditorWorkspaceSearch(
    textSearchContext(snapshot.workspaceRoot, request, action.actionId),
    deps,
  );
}

// Issue #2298: a GET-style synthesized route context so the read-only git handlers (which read
// `root`/`path` from the query string) can run in-process — mirroring the gitDelivery agent-ops
// in-process read path, never a second HTTP hop.
function gitReadContext(
  path: string,
  entries: readonly (readonly [string, string])[],
  actionId: string,
): RouteContext {
  const url = new URL(`http://127.0.0.1${path}`);
  for (const [key, value] of entries) url.searchParams.set(key, value);
  const req = Readable.from([]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "GET";
  const res = {
    writableEnded: false,
    on: (): typeof res => res,
  } as unknown as ServerResponse;
  return { req, res, params: {}, url, correlationId: actionId };
}

function runGitStatusResult(
  root: string,
  path: string,
  deps: EditorAgentActionRouteDeps,
  actionId: string,
): Promise<RouteResult> {
  return handleGitStatus(
    gitReadContext(
      "/api/git/status",
      [
        ["root", root],
        ["path", path],
      ],
      actionId,
    ),
    deps,
  );
}

function runGitDiffResult(
  root: string,
  path: string,
  scope: "staged" | "unstaged",
  deps: EditorAgentActionRouteDeps,
  actionId: string,
): Promise<RouteResult> {
  return handleGitStructuredDiff(
    gitReadContext(
      "/api/git/diff/structured",
      [
        ["root", root],
        ["path", path],
        ["scope", scope],
      ],
      actionId,
    ),
    deps,
  );
}

function runGitBlameResult(
  root: string,
  path: string,
  deps: EditorAgentActionRouteDeps,
  actionId: string,
): Promise<RouteResult> {
  return handleGitBlame(
    gitReadContext(
      "/api/git/blame",
      [
        ["root", root],
        ["path", path],
        ["startLine", "1"],
        ["maxLines", String(GIT_AGENT_CONTEXT_MAX_BLAME_LINES + 1)],
      ],
      actionId,
    ),
    deps,
  );
}

type QueryGitOmissionReason = EditorAgentQueryGitOmissionReason;
type QueryGitOmission = EditorAgentQueryGitOmission;

interface QueryGitProjection {
  readonly value?: unknown;
  readonly omission?: QueryGitOmissionReason;
  readonly machineReason?: EditorAgentQueryGitMachineReason | undefined;
}

interface QueryGitPolicyDenial {
  readonly kind: "query-git-policy-denial";
  readonly reason: EditorAgentActionDenyReason;
}

interface QueryGitCancellation {
  readonly kind: "query-git-cancelled";
}

function isQueryGitPolicyDenial(value: unknown): value is QueryGitPolicyDenial {
  return isRecord(value) && value.kind === "query-git-policy-denial";
}

function isQueryGitCancellation(value: unknown): value is QueryGitCancellation {
  return isRecord(value) && value.kind === "query-git-cancelled";
}

function queryGitWasCancelled(deps: EditorAgentActionRouteDeps): boolean {
  return deps.gitRouteOptions?.abortSignal?.aborted === true;
}

function routeErrorCode(result: RouteResult): string | undefined {
  if (!isRecord(result.body) || !isRecord(result.body.error)) return undefined;
  return typeof result.body.error.code === "string" ? result.body.error.code : undefined;
}

function queryGitBoundaryDenial(results: readonly RouteResult[]): QueryGitPolicyDenial | undefined {
  return results.some((result) => result.status === 400 && routeErrorCode(result) === "BAD_PATH")
    ? { kind: "query-git-policy-denial", reason: "workspace-boundary-escape" }
    : undefined;
}

function queryGitMachineReason(result: RouteResult): EditorAgentQueryGitMachineReason {
  if (result.status !== 200 || !isRecord(result.body)) return "git-error";
  switch (result.body.reason) {
    case "not-a-repository":
      return "not-repository";
    case "git-missing":
      return "git-missing";
    case "unsafe-repository":
      return "unsafe-repository";
    case "git-error":
    case "unknown":
    case "repository-root-outside-root":
      return "git-error";
    default:
      return "malformed-response";
  }
}

function projectGitStatus(
  result: RouteResult,
  path: string,
): QueryGitProjection & {
  readonly repositoryAvailable: boolean;
} {
  const validation = validateGitRepositoryStatusResponse(result.body);
  if (result.status !== 200 || !validation.ok) {
    return {
      repositoryAvailable: false,
      omission: "unavailable",
      machineReason: queryGitMachineReason(result),
    };
  }
  const status = result.body as GitRepositoryStatusResponse;
  const normalized = normalizeWorkspaceRelativePath(path);
  const change = status.changes.find(
    (entry) => normalizeWorkspaceRelativePath(entry.path) === normalized,
  );
  const projectedChange = change === undefined ? null : projectGitStatusChange(change);
  const value: EditorAgentQueryGitStatus = {
    available: status.available,
    state: status.state,
    ...(status.branch === undefined ? {} : { branch: status.branch }),
    detached: status.detached,
    clean: status.available && change === undefined && !status.truncated,
    change: projectedChange,
    truncated: status.truncated,
  };
  if (!status.available) {
    return {
      repositoryAvailable: false,
      value,
      omission: "unavailable",
      machineReason: queryGitMachineReason(result),
    };
  }
  return {
    repositoryAvailable: true,
    value,
    ...(status.truncated ? { omission: "out-of-budget" as const } : {}),
  };
}

function projectGitStatusChange(change: GitRepositoryStatusResponse["changes"][number]): {
  readonly indexStatus: GitRepositoryStatusResponse["changes"][number]["indexStatus"];
  readonly worktreeStatus: GitRepositoryStatusResponse["changes"][number]["worktreeStatus"];
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
  readonly conflicted: boolean;
} {
  return {
    indexStatus: change.indexStatus,
    worktreeStatus: change.worktreeStatus,
    staged: change.staged,
    unstaged: change.unstaged,
    untracked: change.untracked,
    conflicted: change.conflicted,
  };
}

function projectDiffFile(
  file: GitEditorDiffFile,
  remainingHunks: number,
): {
  readonly file: EditorAgentQueryGitDiffFile;
  readonly consumed: number;
  readonly truncated: boolean;
} {
  const hunks = file.hunks.slice(0, remainingHunks);
  const truncated = file.truncated || hunks.length < file.hunks.length;
  return {
    file: {
      layer: file.layer,
      status: file.status,
      binary: file.binary,
      hunks,
      addedLines: file.addedLines,
      removedLines: file.removedLines,
      truncated,
    },
    consumed: hunks.length,
    truncated,
  };
}

interface QueryGitDiffBudget {
  remainingFiles: number;
  remainingHunks: number;
}

function projectGitDiffLayer(
  scope: "staged" | "unstaged",
  result: RouteResult,
  budget: QueryGitDiffBudget,
): { readonly layer?: EditorAgentQueryGitDiffLayer; readonly omission?: QueryGitOmission } {
  const parsed = parseGitEditorDiffResponse(result.body);
  if (result.status !== 200 || !parsed.ok) {
    return {
      omission: {
        aspect: "diff",
        scope,
        reason: "unavailable",
        machineReason: queryGitMachineReason(result),
      },
    };
  }
  const files: EditorAgentQueryGitDiffFile[] = [];
  let truncated = false;
  for (const source of parsed.value.files.slice(0, budget.remainingFiles)) {
    const next = projectDiffFile(source, budget.remainingHunks);
    files.push(next.file);
    budget.remainingHunks -= next.consumed;
    truncated ||= next.truncated;
  }
  budget.remainingFiles -= files.length;
  truncated ||= parsed.value.truncated || files.length < parsed.value.files.length;
  return {
    layer: {
      scope,
      layer: scope === "staged" ? "staged" : "worktree",
      files,
      truncated,
      totalFiles: parsed.value.totalFiles,
      totalBytes: parsed.value.totalBytes,
    },
    ...(truncated ? { omission: { aspect: "diff", scope, reason: "out-of-budget" } } : {}),
  };
}

function projectGitDiff(results: readonly RouteResult[]): {
  readonly value?: EditorAgentQueryGitDiff;
  readonly omissions: readonly QueryGitOmission[];
} {
  const projected: Partial<Record<GitEditorDiffScope, EditorAgentQueryGitDiffLayer>> = {};
  const omissions: QueryGitOmission[] = [];
  const budget: QueryGitDiffBudget = {
    remainingFiles: GIT_AGENT_CONTEXT_MAX_FILES,
    remainingHunks: GIT_AGENT_CONTEXT_MAX_HUNKS,
  };
  for (const [index, result] of results.entries()) {
    const scope = index === 0 ? "staged" : "unstaged";
    const projection = projectGitDiffLayer(scope, result, budget);
    if (projection.layer !== undefined) projected[scope] = projection.layer;
    if (projection.omission !== undefined) omissions.push(projection.omission);
  }
  return {
    ...(projected.staged === undefined && projected.unstaged === undefined
      ? {}
      : {
          value: {
            ...(projected.staged === undefined ? {} : { staged: projected.staged }),
            ...(projected.unstaged === undefined ? {} : { unstaged: projected.unstaged }),
          },
        }),
    omissions,
  };
}

function projectGitBlame(result: RouteResult): QueryGitProjection {
  const parsed = parseGitEditorBlameResponse(result.body);
  if (result.status !== 200 || !parsed.ok) {
    return {
      omission: "unavailable",
      machineReason: queryGitMachineReason(result),
    };
  }
  const lines = parsed.value.lines.slice(0, GIT_AGENT_CONTEXT_MAX_BLAME_LINES);
  const truncated = parsed.value.truncated || lines.length < parsed.value.lines.length;
  const value: EditorAgentQueryGitBlame = {
    startLine: parsed.value.startLine,
    lines,
    truncated,
    totalLines: parsed.value.totalLines,
    totalBytes: parsed.value.totalBytes,
  };
  return {
    value,
    ...(truncated ? { omission: "out-of-budget" } : {}),
  };
}

function addGitOmission(
  omissions: QueryGitOmission[],
  aspect: EditorAgentGitAspect,
  reason: QueryGitOmissionReason | undefined,
  scope?: GitEditorDiffScope,
  machineReason?: EditorAgentQueryGitMachineReason,
): void {
  if (reason === undefined) return;
  const existing = omissions.find((entry) => entry.aspect === aspect && entry.scope === scope);
  if (existing === undefined) {
    omissions.push({
      aspect,
      reason,
      ...(scope === undefined ? {} : { scope }),
      ...(machineReason === undefined ? {} : { machineReason }),
    });
  }
}

function queryGitDataBytes(data: unknown): number {
  return Buffer.byteLength(JSON.stringify(data), "utf8");
}

function enforceQueryGitResultBudget(
  path: string,
  inputAspects: Record<string, unknown>,
  omissions: QueryGitOmission[],
): EditorAgentQueryGitData {
  let aspects = { ...inputAspects };
  for (const aspect of ["blame", "diff", "status"] as const) {
    const data = queryGitData(path, aspects, omissions);
    if (queryGitDataBytes(data) <= GIT_AGENT_CONTEXT_MAX_RESULT_BYTES) return data;
    if (Object.hasOwn(aspects, aspect)) {
      aspects = Object.fromEntries(Object.entries(aspects).filter(([key]) => key !== aspect));
      addGitOmission(omissions, aspect, "out-of-budget");
    }
  }
  return queryGitData(path, aspects, omissions);
}

function queryGitData(
  path: string,
  aspects: Record<string, unknown>,
  omissions: QueryGitOmission[],
): EditorAgentQueryGitData {
  return {
    schemaVersion: EDITOR_AGENT_QUERY_GIT_SCHEMA_VERSION,
    target: { basename: basename(path), pathHash: hashRequest(path) },
    caps: {
      maxFiles: GIT_AGENT_CONTEXT_MAX_FILES,
      maxHunks: GIT_AGENT_CONTEXT_MAX_HUNKS,
      maxBlameLines: GIT_AGENT_CONTEXT_MAX_BLAME_LINES,
      maxResultBytes: GIT_AGENT_CONTEXT_MAX_RESULT_BYTES,
    },
    aspects,
    omissions,
  };
}

function queryGitSuccessResult(
  action: EditorAgentAction,
  path: string,
  aspects: Record<string, unknown>,
  omissions: QueryGitOmission[],
  deps: EditorAgentActionRouteDeps,
): RouteResult {
  const redacted = deps.redactor(enforceQueryGitResultBudget(path, aspects, omissions));
  const parsed = parseEditorAgentQueryGitData(redacted);
  if (parsed.ok) return { status: 200, body: parsed.value };
  reportQueryGitHandlerFailure(
    action,
    "status",
    [{ status: 500, body: errorBody("QUERY_GIT_INVALID", "Git context is unavailable.") }],
    deps,
  );
  return { status: 500, body: errorBody("QUERY_GIT_INVALID", "Git context is unavailable.") };
}

function queryGitDiffResults(
  request: NonNullable<EditorAgentAction["queryGit"]>,
  snapshot: EditorAgentSessionSnapshot,
  deps: EditorAgentActionRouteDeps,
  actionId: string,
): Promise<readonly RouteResult[]> | undefined {
  if (!request.aspects.includes("diff")) return undefined;
  return Promise.all(
    (["staged", "unstaged"] as const).map((scope) =>
      runGitDiffResult(snapshot.workspaceRoot, request.path, scope, deps, actionId),
    ),
  );
}

function queryGitBlameResult(
  request: NonNullable<EditorAgentAction["queryGit"]>,
  snapshot: EditorAgentSessionSnapshot,
  deps: EditorAgentActionRouteDeps,
  actionId: string,
): Promise<RouteResult> | undefined {
  return request.aspects.includes("blame")
    ? runGitBlameResult(snapshot.workspaceRoot, request.path, deps, actionId)
    : undefined;
}

async function collectQueryGitOptionalAspects(
  action: EditorAgentAction,
  request: NonNullable<EditorAgentAction["queryGit"]>,
  snapshot: EditorAgentSessionSnapshot,
  deps: EditorAgentActionRouteDeps,
  aspects: Record<string, unknown>,
  omissions: QueryGitOmission[],
  actionId: string,
): Promise<QueryGitPolicyDenial | QueryGitCancellation | undefined> {
  const [diffResults, blameResult] = await Promise.all([
    queryGitDiffResults(request, snapshot, deps, actionId),
    queryGitBlameResult(request, snapshot, deps, actionId),
  ]);
  if (queryGitWasCancelled(deps)) return { kind: "query-git-cancelled" };
  const denial = queryGitBoundaryDenial([
    ...(diffResults ?? []),
    ...(blameResult === undefined ? [] : [blameResult]),
  ]);
  if (denial !== undefined) return denial;
  if (diffResults !== undefined) {
    reportQueryGitHandlerFailure(action, "diff", diffResults, deps);
    const diff = projectGitDiff(diffResults);
    if (diff.value !== undefined) aspects.diff = diff.value;
    for (const omission of diff.omissions) {
      addGitOmission(
        omissions,
        omission.aspect,
        omission.reason,
        omission.scope,
        omission.machineReason,
      );
    }
  }
  if (blameResult !== undefined) {
    reportQueryGitHandlerFailure(action, "blame", [blameResult], deps);
    const blame = projectGitBlame(blameResult);
    if (blame.value !== undefined) aspects.blame = blame.value;
    addGitOmission(omissions, "blame", blame.omission, undefined, blame.machineReason);
  }
  return undefined;
}

function reportQueryGitHandlerFailure(
  action: EditorAgentAction,
  aspect: EditorAgentGitAspect,
  results: readonly RouteResult[],
  deps: EditorAgentActionRouteDeps,
): void {
  const operationalFailure = results.some((result) =>
    queryGitResultNeedsDiagnostic(result, aspect),
  );
  if (!operationalFailure) return;
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId: action.actionId,
      operation: `editor.agent.queryGit.${aspect}`,
      source: "editor.agent.queryGit",
      error: new Error(`The bounded ${aspect} read was unavailable.`),
      redact: () => `The bounded ${aspect} read was unavailable.`,
    }),
  );
}

function queryGitResultNeedsDiagnostic(result: RouteResult, aspect: EditorAgentGitAspect): boolean {
  if (result.status !== 200) return true;
  if (aspect === "status") {
    const validation = validateGitRepositoryStatusResponse(result.body);
    if (!validation.ok) return true;
    const status = result.body as GitRepositoryStatusResponse;
    return !status.available && status.reason !== "not-a-repository";
  }
  const parsed =
    aspect === "diff"
      ? parseGitEditorDiffResponse(result.body)
      : parseGitEditorBlameResponse(result.body);
  if (parsed.ok) return false;
  if (!isRecord(result.body)) return true;
  return result.body.reason !== "not-a-repository";
}

async function runQueryGitAction(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  deps: EditorAgentActionRouteDeps,
): Promise<RouteResult | QueryGitPolicyDenial | QueryGitCancellation> {
  const request = action.queryGit;
  if (request === undefined) throw new Error("queryGit payload is missing");
  const statusResult = await runGitStatusResult(
    snapshot.workspaceRoot,
    request.path,
    deps,
    action.actionId,
  );
  if (queryGitWasCancelled(deps)) return { kind: "query-git-cancelled" };
  const statusDenial = queryGitBoundaryDenial([statusResult]);
  if (statusDenial !== undefined) return statusDenial;
  reportQueryGitHandlerFailure(action, "status", [statusResult], deps);
  const status = projectGitStatus(statusResult, request.path);
  const aspects: Record<string, unknown> = {};
  const omissions: QueryGitOmission[] = [];
  if (request.aspects.includes("status") && status.value !== undefined) {
    aspects.status = status.value;
  }
  if (!status.repositoryAvailable) {
    for (const aspect of request.aspects) {
      addGitOmission(omissions, aspect, "unavailable", undefined, status.machineReason);
    }
    return {
      ...queryGitSuccessResult(action, request.path, aspects, omissions, deps),
    };
  }
  if (request.aspects.includes("status")) {
    addGitOmission(omissions, "status", status.omission, undefined, status.machineReason);
  }
  const optionalDenial = await collectQueryGitOptionalAspects(
    action,
    request,
    snapshot,
    deps,
    aspects,
    omissions,
    action.actionId,
  );
  if (optionalDenial !== undefined) return optionalDenial;
  return queryGitSuccessResult(action, request.path, aspects, omissions, deps);
}

function serverResolvedActionRoute(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  deps: EditorAgentActionRouteDeps,
  signal: AbortSignal,
): Promise<RouteResult | QueryGitPolicyDenial | QueryGitCancellation> {
  if (action.type === "navigateSymbol") {
    return runNavigateSymbolAction(action, snapshot, deps, signal);
  }
  if (action.type === "queryGit") return runQueryGitAction(action, snapshot, deps);
  return runSearchWorkspaceAction(action, snapshot, deps);
}

async function executeServerResolvedAction(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  deps: EditorAgentActionRouteDeps,
  signal: AbortSignal,
): Promise<RouteResult | EditorAgentActionResult | QueryGitPolicyDenial | QueryGitCancellation> {
  try {
    return await serverResolvedActionRoute(action, snapshot, deps, signal);
  } catch (error) {
    emitServerDiagnostic(
      deps.diagnostics,
      serverDiagnosticFromError({
        correlationId: action.actionId,
        operation: `editor.agent.${action.type}`,
        source: "editor.agent.serverResolvedAction",
        error,
        redact: () => "The server-resolved editor operation failed.",
      }),
    );
    return failedResult(action, "The server-resolved editor operation failed.");
  }
}

function finishServerResolvedSuccess(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  decision: EditorAgentActionPolicyDecision,
  requestHash: string,
  body: Readonly<Record<string, unknown>>,
  deps: EditorAgentActionRouteDeps,
): RouteResult {
  const succeeded: EditorAgentActionResult = {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: action.actionId,
    sessionId: action.sessionId,
    status: "succeeded",
    data: body,
  };
  const queryData = action.type === "queryGit" ? parseEditorAgentQueryGitData(body) : undefined;
  const valid = isEditorAgentActionResult(succeeded) && (queryData === undefined || queryData.ok);
  return serverResolvedFailure(
    action,
    snapshot,
    decision,
    valid ? succeeded : failedResult(action, "The bounded git context result was unavailable."),
    requestHash,
    200,
    deps.redactor,
  );
}

function finishServerResolvedRouteResult(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  decision: EditorAgentActionPolicyDecision,
  requestHash: string,
  outcome: RouteResult,
  deps: EditorAgentActionRouteDeps,
): RouteResult {
  if (outcome.status === 200 && isRecord(outcome.body)) {
    return finishServerResolvedSuccess(action, snapshot, decision, requestHash, outcome.body, deps);
  }
  const status = outcome.status === 403 ? 403 : 409;
  const code = outcome.status === 403 ? "OUT_OF_SCOPE" : "INVALID_EDITS";
  return serverResolvedFailure(
    action,
    snapshot,
    decision,
    conflict(action, code, "The editor operation was rejected."),
    requestHash,
    status,
    deps.redactor,
  );
}

function finishQueryGitCancellation(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  decision: EditorAgentActionPolicyDecision,
  deps: EditorAgentActionRouteDeps,
): RouteResult {
  const result = failedResult(action, "The bounded Git context request was cancelled.");
  auditAction(action, snapshot, decision, result, deps.redactor);
  editorAgentRegistry.reportResult(result);
  return { status: 200, body: { result } };
}

function finishQueryGitDenial(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  decision: EditorAgentActionPolicyDecision,
  outcome: QueryGitPolicyDenial,
  requestHash: string,
  deps: EditorAgentActionRouteDeps,
): RouteResult {
  const result = conflict(
    action,
    "OUT_OF_SCOPE",
    "The requested Git path is outside the workspace scope.",
  );
  return serverResolvedFailure(
    action,
    snapshot,
    denyByAuthority(decision, outcome.reason),
    result,
    requestHash,
    403,
    deps.redactor,
  );
}

function finishServerResolvedAction(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  decision: EditorAgentActionPolicyDecision,
  requestHash: string,
  outcome: RouteResult | EditorAgentActionResult | QueryGitPolicyDenial | QueryGitCancellation,
  deps: EditorAgentActionRouteDeps,
): RouteResult {
  if (isQueryGitCancellation(outcome)) {
    return finishQueryGitCancellation(action, snapshot, decision, deps);
  }
  if (isQueryGitPolicyDenial(outcome)) {
    return finishQueryGitDenial(action, snapshot, decision, outcome, requestHash, deps);
  }
  if ("body" in outcome) {
    const languageFailure = serverResolvedLanguageFailure(action, outcome);
    if (languageFailure !== null) {
      return serverResolvedFailure(
        action,
        snapshot,
        decision,
        languageFailure,
        requestHash,
        outcome.status === 403 ? 403 : 200,
        deps.redactor,
      );
    }
    return finishServerResolvedRouteResult(action, snapshot, decision, requestHash, outcome, deps);
  }
  return serverResolvedFailure(
    action,
    snapshot,
    decision,
    outcome,
    requestHash,
    200,
    deps.redactor,
  );
}

function languageFailureCode(outcome: RouteResult): EditorAgentFailureCode | undefined {
  switch (routeErrorCode(outcome)) {
    case "TIMED_OUT":
      return "TIMED_OUT";
    case "CANCELLED":
      return "CANCELLED";
    case "UNSUPPORTED_LANGUAGE":
      return "PROVIDER_UNAVAILABLE";
    case "UNSUPPORTED_OPERATION":
      return "UNSUPPORTED_OPERATION";
    case "DOCUMENT_TOO_LARGE":
      return "LIMIT_EXCEEDED";
    default:
      return undefined;
  }
}

function serverResolvedLanguageFailure(
  action: EditorAgentAction,
  outcome: RouteResult,
): EditorAgentActionResult | null {
  const code = languageFailureCode(outcome);
  if (code === undefined) return null;
  const message = "The server-resolved editor operation was not completed.";
  return {
    ...failedResult(action, message),
    failure: { code, message },
  };
}

async function resolveServerAction(
  action: EditorAgentAction,
  requestHash: string,
  snapshot: EditorAgentSessionSnapshot | undefined,
  decision: EditorAgentActionPolicyDecision,
  deps: EditorAgentActionRouteDeps,
  signal: AbortSignal,
): Promise<RouteResult> {
  if (snapshot === undefined) {
    return serverResolvedFailure(
      action,
      snapshot,
      decision,
      conflict(action, "NO_ACTIVE_SESSION", "No editor session snapshot is registered."),
      requestHash,
      409,
      deps.redactor,
    );
  }
  const rejection = rejectServerResolvedPolicy(action, snapshot, decision, requestHash, deps);
  if (rejection !== null) return rejection;
  return finishServerResolvedAction(
    action,
    snapshot,
    decision,
    requestHash,
    await executeServerResolvedAction(action, snapshot, deps, signal),
    deps,
  );
}

function rejectServerResolvedPolicy(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  baseline: EditorAgentActionPolicyDecision,
  requestHash: string,
  deps: EditorAgentActionRouteDeps,
): RouteResult | null {
  const pathRejection = rejectServerResolvedPath(action, snapshot, baseline, requestHash, deps);
  if (pathRejection !== null) return pathRejection;
  const policyConflict = policyAdmissionConflict(action, baseline);
  if (policyConflict !== null) {
    return serverResolvedFailure(
      action,
      snapshot,
      baseline,
      policyConflict,
      requestHash,
      403,
      deps.redactor,
    );
  }
  const livenessRejection = rejectServerResolvedLiveness(
    action,
    snapshot,
    baseline,
    requestHash,
    deps,
  );
  if (livenessRejection !== null) return livenessRejection;
  const reservationDenial = reserveActionAuthority(action, snapshot, baseline, deps);
  if (reservationDenial !== null) {
    return serverResolvedFailure(
      action,
      snapshot,
      reservationDenial,
      conflict(action, "POLICY_DENIED", "The action authority budget is exhausted."),
      requestHash,
      403,
      deps.redactor,
    );
  }
  return null;
}

function rejectServerResolvedPath(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  decision: EditorAgentActionPolicyDecision,
  requestHash: string,
  deps: EditorAgentActionRouteDeps,
): RouteResult | null {
  const pathIssue = serverResolvedPathIssues(action, snapshot, deps);
  return pathIssue === null
    ? null
    : serverResolvedFailure(
        action,
        snapshot,
        denyByAuthority(decision, pathIssue),
        conflict(
          action,
          "OUT_OF_SCOPE",
          "The requested editor operation is outside the workspace scope.",
        ),
        requestHash,
        403,
        deps.redactor,
      );
}

function rejectServerResolvedLiveness(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  decision: EditorAgentActionPolicyDecision,
  requestHash: string,
  deps: EditorAgentActionRouteDeps,
): RouteResult | null {
  return editorAgentRegistry.hasLiveBridge(action.sessionId)
    ? null
    : serverResolvedFailure(
        action,
        snapshot,
        decision,
        conflict(action, "NO_ACTIVE_SESSION", "No live editor session is connected."),
        requestHash,
        409,
        deps.redactor,
      );
}

type RootBoundAction =
  | { readonly ok: true; readonly action: EditorAgentAction }
  | {
      readonly ok: false;
      readonly decision: EditorAgentActionPolicyDecision;
      readonly result: EditorAgentActionResult;
    };

function actionRootPaths(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): readonly string[] {
  const paths = [
    ...resolveActionTargetPaths(action, snapshot),
    ...serverResolvedActionPaths(action).filter((path): path is string => path !== undefined),
    ...patchRootPaths(action),
  ];
  return [...new Set(paths)];
}

function patchRootPaths(action: EditorAgentAction): readonly string[] {
  const patch = action.type === "applyChangeset" ? action.changeset?.patch : action.patch;
  if (patch === undefined) return [];
  try {
    return parseUnifiedDiff(patch).files.map((file) => file.path);
  } catch {
    return [];
  }
}

function rootBoundaryDecision(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  reason: EditorAgentRootBoundaryReason,
): EditorAgentActionPolicyDecision {
  const target = governedActionTarget(action, snapshot);
  return denyByAuthority(
    classifyEditorAgentAction(action.type, { ...target, origin: action.origin }),
    reason,
  );
}

// The containment check now reports a REFUSED root (revoked lifecycle, replaced identity, an
// unfinished authority proof) with its own reason instead of borrowing the plain node port and
// failing as a path escape, so the conflict code has to follow the reason rather than assume every
// non-decompose outcome is a target outside the root (P3, PR #3381 review).
function boundaryConflictCode(reason: EditorAgentRootBoundaryReason): EditorAgentConflictCode {
  if (reason === "decompose-per-root") return "DECOMPOSE_PER_ROOT";
  return reason === "workspace-boundary-escape" ? "OUT_OF_SCOPE" : "POLICY_DENIED";
}

function boundaryConflictMessage(reason: EditorAgentRootBoundaryReason): string {
  return reason === "root-binding-invalid" || reason === "root-binding-required"
    ? "The editor action must be authorized and decomposed for one workspace root."
    : "The editor action target is outside its bound workspace root.";
}

function bindActionRoot(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  deps: EditorAgentEitherRouteDeps | undefined,
): RootBoundAction {
  const resolution = resolveEditorAgentActionRoot(snapshot, action.rootBinding, deps?.store);
  if (!resolution.ok) {
    return {
      ok: false,
      decision: rootBoundaryDecision(action, snapshot, resolution.reason),
      result: conflict(
        action,
        resolution.reason === "decompose-per-root" ? "DECOMPOSE_PER_ROOT" : "POLICY_DENIED",
        "The editor action must be authorized and decomposed for one workspace root.",
      ),
    };
  }
  const pathReason = editorAgentRootContainmentReason(
    resolution.root,
    actionRootPaths(action, snapshot),
    deps,
    actionCorrelationId(action),
  );
  if (pathReason !== null) {
    return {
      ok: false,
      decision: rootBoundaryDecision(action, snapshot, pathReason),
      result: conflict(
        action,
        boundaryConflictCode(pathReason),
        boundaryConflictMessage(pathReason),
      ),
    };
  }
  const binding = resolution.root.binding;
  return {
    ok: true,
    action: binding === undefined ? action : { ...action, rootBinding: binding },
  };
}

// The port the admission INSPECTION reads the current file contents through. A changeset keeps the
// write-capable managed resolution (`changesetWorkspaceFs`, which refuses outright rather than
// downgrading to the node port). Every OTHER write action — `applyPatch` above all — inspected
// through the plain node port, so a single-file patch inside a managed task worktree below the state
// directory's always-denied segment failed preflight as OUT_OF_SCOPE/INVALID_EDITS: exactly the
// class the boundary check was repaired for, still open on the editor-agent patch path (cursor
// review, PR #3381). It now reads through the same containment port the boundary check resolves.
// A refused port lands on the established fail-closed 403 below; `bindActionRoot` already refuses
// such a root earlier in `admitEditorAction`, so this is the floor, not the reporting seam.
function admissionInspectionFs(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
  runtimeMutation: RuntimeMutationClassification,
  deps: EditorAgentActionRouteDeps | undefined,
): WorkspaceFs | undefined {
  if (snapshot === undefined) return nodeWorkspaceFs;
  if (action.type === "applyChangeset") {
    return changesetWorkspaceFs(snapshot.workspaceRoot, runtimeMutation, deps);
  }
  const port = resolveEditorAgentContainmentPort(
    deps,
    snapshot.workspaceRoot,
    actionCorrelationId(action),
  );
  return port.ok ? port.fs : undefined;
}

function admitAndReserveAction(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
  decision: EditorAgentActionPolicyDecision,
  runtimeMutation: RuntimeMutationClassification,
  requestHash: string,
  deps: EditorAgentActionRouteDeps | undefined,
): { readonly ok: true; readonly inspection: AdmissionInspection } | RouteResult {
  const inspectionFs = admissionInspectionFs(action, snapshot, runtimeMutation, deps);
  if (inspectionFs === undefined) {
    return rejectActionRequest(
      action,
      snapshot,
      decision,
      runtimeMutationLeaseDeniedResult(action),
      requestHash,
      403,
    );
  }
  const admission = preflight(action, snapshot, inspectionFs);
  if (!admission.ok) {
    return rejectActionRequest(action, snapshot, decision, admission.result, requestHash, 409);
  }
  const policyConflict = policyAdmissionConflict(action, decision);
  if (policyConflict !== null) {
    return rejectActionRequest(action, snapshot, decision, policyConflict, requestHash, 403);
  }
  const reservationDenial =
    runtimeMutation.kind === "runtime"
      ? null
      : reserveActionAuthority(action, snapshot, decision, deps);
  if (reservationDenial !== null) {
    const result = conflict(action, "POLICY_DENIED", "The action authority budget is exhausted.");
    return rejectActionRequest(action, snapshot, reservationDenial, result, requestHash, 403);
  }
  return { ok: true, inspection: admission.inspection };
}

async function resolveOrRejectServerAction(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
  decision: EditorAgentActionPolicyDecision,
  requestHash: string,
  deps: EditorAgentActionRouteDeps | undefined,
  signal: AbortSignal,
): Promise<RouteResult> {
  if (deps === undefined) {
    return serverResolvedFailure(
      action,
      snapshot,
      decision,
      failedResult(action, "The server-resolved editor operation is unavailable."),
      requestHash,
      200,
    );
  }
  return resolveServerAction(action, requestHash, snapshot, decision, deps, signal);
}

async function admitEditorAction(
  action: EditorAgentAction,
  requestHash: string,
  deps: EditorAgentActionRouteDeps | undefined,
  signal: AbortSignal,
): Promise<RouteResult> {
  const snapshot = editorAgentRegistry.snapshotFor(action.sessionId);
  if (snapshot !== undefined) {
    const rooted = bindActionRoot(action, snapshot, deps);
    if (!rooted.ok) {
      const { decision: d, result: r } = rooted;
      return rejectActionRequest(action, snapshot, d, r, requestHash, 403);
    }
    action = rooted.action;
  }
  const runtimeMutation = classifyRuntimeMutation(action, snapshot, deps);
  const decision = decideActionPolicy(action, snapshot, deps, runtimeMutation);
  if (isServerResolvedAction(action)) {
    return resolveOrRejectServerAction(action, snapshot, decision, requestHash, deps, signal);
  }
  const admitted = admitAndReserveAction(
    action,
    snapshot,
    decision,
    runtimeMutation,
    requestHash,
    deps,
  );
  if ("status" in admitted) return admitted;
  return queueAndEmitAction(
    action,
    requestHash,
    snapshot,
    decision,
    admitted.inspection,
    runtimeMutation,
  );
}

export async function handleEditorAgentActions(
  ctx: RouteContext,
  deps?: EditorAgentEitherRouteDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_AGENT_BODY_BYTES);
  if (isRouteResult(body)) return body;
  const parsed = parseEditorAgentActionsPostBody(body);
  if (!parsed.ok) {
    return { status: 400, body: errorBody("INVALID_REQUEST", parsed.errors.join("; ")) };
  }
  if (!isEditorAgentAction(parsed.value) && parsed.value.kind === "result") {
    return handleReportedActionResult(parsed.value, deps);
  }
  const preparation = prepareEditorActionRequest(parsed.value);
  if (!preparation.ok) return preparation.response;
  const replay = replayEditorAction(
    preparation.request.action,
    preparation.request.requestHash,
    deps,
  );
  if (replay !== null) return replay;
  let { action } = preparation.request;
  if (preparation.request.bridgeSnapshot !== undefined) {
    const authorization = attachBridgeActionAuthority(
      action,
      preparation.request.bridgeSnapshot,
      deps,
    );
    if (!authorization.ok) return authorization.response;
    action = authorization.action;
  }
  const signal = actionAbortSignal(ctx);
  const actionDeps = queryGitAbortDeps(action, fullEditorActionDeps(deps), signal);
  return admitEditorAction(action, preparation.request.requestHash, actionDeps, signal);
}

function fullEditorActionDeps(
  deps: EditorAgentEitherRouteDeps | undefined,
): EditorAgentActionRouteDeps | undefined {
  return deps !== undefined && "redactor" in deps && "env" in deps ? deps : undefined;
}

function queryGitAbortDeps(
  action: EditorAgentAction,
  deps: EditorAgentActionRouteDeps | undefined,
  signal: AbortSignal,
): EditorAgentActionRouteDeps | undefined {
  if (action.type !== "queryGit" || deps === undefined) {
    return deps;
  }
  return {
    ...deps,
    gitRouteOptions: { ...deps.gitRouteOptions, abortSignal: signal },
  };
}

function failedResult(action: EditorAgentAction, message: string): EditorAgentActionResult {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: action.actionId,
    sessionId: action.sessionId,
    status: "failed",
    message,
  };
}

function queueAndEmitAction(
  action: EditorAgentAction,
  requestHash: string,
  snapshot: EditorAgentSessionSnapshot | undefined,
  decision: EditorAgentActionPolicyDecision,
  inspection: AdmissionInspection,
  runtimeMutation: RuntimeMutationClassification,
): RouteResult {
  const boundAction = snapshot === undefined ? action : bindActiveBufferTarget(action, snapshot);
  const requiresReview =
    runtimeMutation.kind === "runtime"
      ? (runtimeMutation.requiresReview ?? true)
      : decision.disposition === "review-required" || boundAction.requiresReview === true;
  const emitAction =
    snapshot === undefined
      ? null
      : buildEmitAction(boundAction, snapshot, inspection, requiresReview);
  if (emitAction === null) {
    const result = failedResult(action, "Patch could not be prepared for review.");
    rememberIdempotency(action.idempotencyKey, requestHash, result);
    auditAction(action, snapshot, decision, result);
    return { status: 409, body: { result } };
  }
  const runtimeOwned = runtimeMutation.kind === "runtime";
  const outcome = editorAgentRegistry.queueAction(boundAction, emitAction, { runtimeOwned });
  rememberIdempotency(action.idempotencyKey, requestHash, outcome.result);
  auditAction(action, snapshot, decision, outcome.result, undefined, runtimeOwned);
  if (outcome.kind === "rejected") {
    // QUEUE_FULL is backpressure (429); a duplicate in-flight actionId is a conflict (409).
    const status = outcome.result.failure?.code === "QUEUE_FULL" ? 429 : 409;
    return { status, body: { result: outcome.result } };
  }
  return { status: 202, body: { result: outcome.result } };
}

interface AuthenticatedBridgeConnection {
  readonly sessionId: string;
  readonly capabilityDigest: string;
}

type EventBridgeSelection =
  | {
      readonly ok: true;
      readonly connections: readonly AuthenticatedBridgeConnection[] | undefined;
      readonly bridgeStreamId: string | undefined;
    }
  | { readonly ok: false; readonly response: RouteResult };

function isBoundedSessionId(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= EDITOR_AGENT_SESSION_ID_MAX_BYTES;
}

function isBridgeStreamId(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
}

function eventBridgeQueryHasValidShape(
  sessionIds: readonly string[],
  capabilities: readonly string[],
): boolean {
  return (
    sessionIds.length > 0 &&
    sessionIds.length <= EDITOR_AGENT_MAX_SESSIONS &&
    capabilities.length === sessionIds.length &&
    new Set(sessionIds).size === sessionIds.length
  );
}

function authenticateBridgeConnection(
  sessionId: string,
  capability: string | undefined,
): AuthenticatedBridgeConnection | null {
  if (!isBoundedSessionId(sessionId) || !isEditorAgentBridgeDecisionCapability(capability)) {
    return null;
  }
  const capabilityDigest = bridgeCapabilityDigest(capability);
  return editorAgentRegistry.matchesBridgeDecisionCapabilityDigest(sessionId, capabilityDigest)
    ? { sessionId, capabilityDigest }
    : null;
}

function parseEventBridgeSelection(ctx: RouteContext): EventBridgeSelection {
  const sessionIds = ctx.url.searchParams.getAll("sessionId");
  const capabilities = ctx.url.searchParams.getAll("bridgeDecisionCapability");
  const bridgeStreamIds = ctx.url.searchParams.getAll("bridgeStreamId");
  if (sessionIds.length === 0 && capabilities.length === 0 && bridgeStreamIds.length === 0) {
    return { ok: true, connections: undefined, bridgeStreamId: undefined };
  }
  if (
    !eventBridgeQueryHasValidShape(sessionIds, capabilities) ||
    bridgeStreamIds.length !== 1 ||
    !isBridgeStreamId(bridgeStreamIds[0])
  ) {
    return { ok: false, response: bridgeCapabilityError() };
  }
  const connections: AuthenticatedBridgeConnection[] = [];
  for (const [index, sessionId] of sessionIds.entries()) {
    const connection = authenticateBridgeConnection(sessionId, capabilities[index]);
    if (connection === null) return { ok: false, response: bridgeCapabilityError() };
    connections.push(connection);
  }
  return { ok: true, connections, bridgeStreamId: bridgeStreamIds[0] };
}

function scrubBridgeCapabilitiesFromRequestUrl(ctx: RouteContext): void {
  ctx.url.searchParams.delete("bridgeDecisionCapability");
  ctx.url.searchParams.delete("bridgeStreamId");
  if (ctx.req.url === undefined) return;
  try {
    const sanitized = new URL(ctx.req.url, "http://127.0.0.1");
    sanitized.searchParams.delete("bridgeDecisionCapability");
    sanitized.searchParams.delete("bridgeStreamId");
    ctx.req.url = `${sanitized.pathname}${sanitized.search}`;
  } catch {
    ctx.req.url = "/api/editor/agent/events";
  }
}

export function handleEditorAgentEvents(ctx: RouteContext): HandlerOutcome {
  const selection = parseEventBridgeSelection(ctx);
  scrubBridgeCapabilitiesFromRequestUrl(ctx);
  if (!selection.ok) return selection.response;
  return openAgentSseStream(ctx, selection.connections, selection.bridgeStreamId);
}

// Issue #1395 (ADR-0062, AC4) — read-only feed of the bounded audit ledger so users can inspect what
// an agent changed or attempted. Scoped to the session when `?sessionId=` is present; otherwise a
// bounded recent-activity view across sessions. Content-free records only (no raw source, no secrets).
export function handleEditorAgentAudit(ctx: RouteContext): RouteResult {
  const sessionId = ctx.url.searchParams.get("sessionId") ?? undefined;
  return { status: 200, body: { records: listEditorAgentActionAudit(sessionId) } };
}

function connectEditorAgentSessions(
  connections: readonly AuthenticatedBridgeConnection[] | undefined,
  bridgeStreamId: string | undefined,
  subscriber: (event: EditorAgentEvent) => void,
): (() => void) | undefined {
  if (connections === undefined) return editorAgentRegistry.connect(undefined, subscriber);
  const disposers: (() => void)[] = [];
  for (const connection of connections) {
    const dispose = editorAgentRegistry.connectAuthenticated(
      connection.sessionId,
      connection.capabilityDigest,
      subscriber,
    );
    if (dispose === undefined) {
      for (const prior of disposers) prior();
      return undefined;
    }
    disposers.push(dispose);
  }
  const disposeConnections = (): void => {
    for (const dispose of disposers) dispose();
  };
  if (bridgeStreamId === undefined) {
    disposeConnections();
    return undefined;
  }
  const prior = activeBridgeStreams.get(bridgeStreamId);
  if (prior === undefined && activeBridgeStreams.size >= MAX_ACTIVE_BRIDGE_STREAMS) {
    disposeConnections();
    return undefined;
  }
  prior?.();
  let active = true;
  const disposeStream = (): void => {
    if (!active) return;
    active = false;
    if (activeBridgeStreams.get(bridgeStreamId) === disposeStream) {
      activeBridgeStreams.delete(bridgeStreamId);
    }
    disposeConnections();
  };
  activeBridgeStreams.set(bridgeStreamId, disposeStream);
  return disposeStream;
}

// Opens the SSE stream and registers the connection as either one or more session bridges (when
// `?sessionId=` is present) or a global observer. The disposer drops the subscription — and thus the
// bridge-liveness contribution — when the response closes (AC1: a dropped bridge makes the session
// unavailable again).
function openAgentSseStream(
  ctx: RouteContext,
  connections: readonly AuthenticatedBridgeConnection[] | undefined,
  bridgeStreamId: string | undefined,
): HandlerOutcome {
  const res: ServerResponse = ctx.res;
  const subscriber = (event: EditorAgentEvent): void => {
    const frame = `id: ${event.eventId}\nevent: editor-agent:${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    if (!res.write(frame)) res.destroy();
  };
  const dispose = connectEditorAgentSessions(connections, bridgeStreamId, subscriber);
  if (dispose === undefined) return bridgeCapabilityError();
  res.writeHead(200, SSE_HEADERS);
  startSseHeartbeat(res);
  res.write(readyMessage());
  ctx.req.on("close", () => {
    res.end();
  });
  res.on("close", dispose);
  return STREAMING;
}

export function _resetEditorAgentStateForTests(): void {
  for (const dispose of activeBridgeStreams.values()) dispose();
  activeBridgeStreams.clear();
  idempotency.clear();
  editorAgentPatchWriterForTests = undefined;
  editorAgentRegistry.reset();
  editorAgentAuthorityRegistry.reset();
  _resetEditorAgentAuditForTests();
}

export function _setEditorAgentPatchWriterForTests(writer: WorkspaceWriter | undefined): void {
  editorAgentPatchWriterForTests = writer;
}
