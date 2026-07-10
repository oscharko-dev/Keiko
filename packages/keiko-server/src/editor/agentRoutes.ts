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

import type { ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  EDITOR_AGENT_BRIDGE_DECISION_CAPABILITY_BYTES,
  EDITOR_AGENT_ACTION_APPROVAL_RISK,
  EDITOR_AGENT_WORKBENCH_ACTION_CLASS,
  EDITOR_AGENT_SCHEMA_VERSION,
  EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS,
  EDITOR_AGENT_SESSION_ID_MAX_BYTES,
  EDITOR_AGENT_SNAPSHOT_TEXT_MAX_BYTES,
  EDITOR_AGENT_NAVIGATION_DOCUMENT_MAX_BYTES,
  classifyEditorAgentAction,
  composeEditorAgentActionPolicyDecision,
  editorAgentWritePreconditionError,
  isContainedAgentPath,
  isEditorAgentAction,
  isEditorAgentActiveBufferActionType,
  isEditorAgentBridgeDecisionCapability,
  isEditorAgentWriteActionType,
  parseEditorAgentActionsPostBody,
  parseEditorAgentSnapshotRequest,
  validateCodingWorkbenchAuthorityEnvelope,
  validateAgentTextEdits,
  type EditorAgentAction,
  type EditorAgentActionDenyReason,
  type EditorAgentActionPolicyDecision,
  type EditorAgentActionResult,
  type EditorAgentActionResultRequest,
  type EditorAgentBridgeActionRequest,
  type EditorAgentBridgeSnapshotRequest,
  type EditorAgentConflictCode,
  type EditorAgentEvent,
  type EditorAgentSessionSnapshot,
  type EditorAgentSnapshotTextMode,
  type CodingWorkbenchMode,
  type LanguageRange,
} from "@oscharko-dev/keiko-contracts";
import {
  PatchApplyError,
  PatchValidationError,
  applyPatch,
  inspectPatch,
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
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
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
import type { UiHandlerDeps } from "../deps.js";
import { handleEditorLanguage } from "./languageRoutes.js";
import {
  handleEditorWorkspaceSearch,
  handleEditorWorkspaceSymbols,
} from "./workspaceSearchRoutes.js";
import type { AutonomousDeliveryConfirmation } from "../coding-runtime/autonomousDeliveryPolicy.js";
import {
  editorAgentAuthorityRegistry,
  type EditorAgentAuthorityResolution,
} from "./agentAuthorityRegistry.js";
import { EDITOR_AGENT_MAX_SESSIONS, editorAgentRegistry } from "./agentSessionRegistry.js";
import {
  _resetEditorAgentAuditForTests,
  listEditorAgentActionAudit,
  recordEditorAgentActionAudit,
} from "./agentActionAudit.js";

type EditorAgentRouteDeps = Pick<
  UiHandlerDeps,
  "autonomousDeliveryApprovalStore" | "autonomousDeliveryDeploymentCeiling"
>;

type EditorAgentActionRouteDeps = UiHandlerDeps;

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
  return action.type === "navigateSymbol" || action.type === "searchWorkspace";
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
  const shapedSnapshot =
    snapshot.diagnosticsDetail === undefined
      ? snapshot
      : { ...snapshot, diagnosticsDetail: shapeDiagnosticsDetail(snapshot.diagnosticsDetail) };
  if (textMode === "none" || shapedSnapshot.text === undefined) {
    const { text, textTruncated, ...rest } = shapedSnapshot;
    void text;
    void textTruncated;
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
): ChangesetInspection {
  const inspection = inspectPatch(
    workspaceInfoFromRoot(snapshot.workspaceRoot),
    action.changeset?.patch ?? "",
    { fs: nodeWorkspaceFs },
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
    .replace(/\\/gu, "/")
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
): AdmissionInspection {
  if (action.type === "applyChangeset") {
    return { changeset: inspectChangeset(action, snapshot) };
  }
  if (action.type === "applyPatch") {
    return {
      patch: inspectPatch(workspaceInfoFromRoot(snapshot.workspaceRoot), action.patch ?? "", {
        fs: nodeWorkspaceFs,
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
): PreflightOutcome {
  if (snapshot === undefined) {
    return {
      ok: false,
      result: conflict(action, "NO_ACTIVE_SESSION", "No active browser bridge is registered."),
    };
  }
  const targetConflict = activeBufferTargetConflict(action, snapshot);
  if (targetConflict !== null) return { ok: false, result: targetConflict };
  const inspection = inspectAdmissionAction(action, snapshot);
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

export function handleEditorAgentSessions(): RouteResult {
  const sessions = editorAgentRegistry
    .listSessions()
    .filter((snapshot) => editorAgentRegistry.hasLiveBridge(snapshot.sessionId))
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

function registerBridgeSnapshot(request: EditorAgentBridgeSnapshotRequest): RouteResult {
  const existing = editorAgentRegistry.snapshotFor(request.snapshot.sessionId);
  const supplied = request.bridgeDecisionCapability;
  if (
    existing !== undefined &&
    supplied !== undefined &&
    editorAgentRegistry.refreshSnapshot(request.snapshot, bridgeCapabilityDigest(supplied))
  ) {
    return { status: 200, body: { snapshot: request.snapshot } };
  }
  const capability = issueBridgeDecisionCapability();
  const digest = bridgeCapabilityDigest(capability);
  const registered =
    existing === undefined
      ? editorAgentRegistry.registerSnapshot(request.snapshot, digest)
      : editorAgentRegistry.rotateSnapshotCapability(request.snapshot, digest);
  return registered
    ? { status: 200, body: { snapshot: request.snapshot, bridgeDecisionCapability: capability } }
    : bridgeCapabilityError();
}

export async function handleEditorAgentSnapshot(ctx: RouteContext): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_AGENT_BODY_BYTES);
  if (isRouteResult(body)) return body;
  const parsed = parseEditorAgentSnapshotRequest(body);
  if (!parsed.ok) {
    return { status: 400, body: errorBody("INVALID_REQUEST", parsed.errors.join("; ")) };
  }
  if ("kind" in parsed.value) {
    return registerBridgeSnapshot(parsed.value);
  }
  const selected = editorAgentRegistry.selectSnapshot(parsed.value.sessionId);
  if (selected === undefined) return { status: 200, body: { snapshot: null } };
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
  return resolveNonMutationTargetPath(action, snapshot);
}

function serverResolvedActionPaths(action: EditorAgentAction): readonly (string | undefined)[] {
  if (action.type === "navigateSymbol") {
    return [action.navigateSymbol?.document.path, action.target?.file];
  }
  return [
    action.searchWorkspace?.scopePath,
    action.target?.file,
    ...(action.searchWorkspace?.includeGlobs ?? []),
    ...(action.searchWorkspace?.excludeGlobs ?? []),
  ];
}

function serverResolvedPathIssue(path: string): EditorAgentActionDenyReason | null {
  if (!isContainedAgentPath(path)) return "workspace-boundary-escape";
  return isDenied(path) ? "denied-sensitive-path" : null;
}

function serverResolvedPathIssues(action: EditorAgentAction): EditorAgentActionDenyReason | null {
  const paths = serverResolvedActionPaths(action);
  for (const path of paths) {
    if (path === undefined) continue;
    const issue = serverResolvedPathIssue(path);
    if (issue !== null) return issue;
  }
  return null;
}

function serverActionContext(body: unknown, path: string): RouteContext {
  const req = Readable.from([
    Buffer.from(JSON.stringify(body), "utf8"),
  ]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  const res = {
    writableEnded: false,
    on: (): typeof res => res,
  } as unknown as ServerResponse;
  return { req, res, params: {}, url: new URL(`http://127.0.0.1${path}`) };
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

function authorityDenyReason(
  resolution: Extract<EditorAgentAuthorityResolution, { readonly ok: false }>,
): EditorAgentActionDenyReason {
  if (resolution.reason === "expired") return "authority-expired";
  return resolution.reason === "budget-exceeded"
    ? "authority-budget-exceeded"
    : "authority-invalid";
}

// Deterministic policy classification (AC2). Containment reuses the contract guard; sensitivity reuses
// the always-on workspace deny-list (a keiko-workspace concern the leaf classifier cannot reach, so
// the boolean is resolved here). Only meaningful for write actions; navigation/layout always allow.
function decideActionPolicy(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
  deps?: EditorAgentRouteDeps,
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

// Issue #1395 (AC1) — record one content-free audit entry for this action at its admission decision.
// Best-effort: the ledger filters to mutating/denied actions and never throws. `editCount`/
// `patchByteLength` are counts only, never edit or patch content.
function auditAction(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
  decision: EditorAgentActionPolicyDecision,
  result: EditorAgentActionResult,
): void {
  recordEditorAgentActionAudit({
    occurredAt: Date.now(),
    sessionId: action.sessionId,
    actionId: action.actionId,
    actionType: action.type,
    decision,
    outcome: result.status,
    conflictCode: result.conflict?.code,
    failureCode: result.failure?.code,
    targetPath: governedActionTarget(action, snapshot).targetPath,
    editCount: action.type === "applyTextEdits" ? action.textEdits?.length : undefined,
    patchByteLength: actionPatchByteLength(action),
  });
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
): ChangesetProjectionOutcome {
  const selectedPaths = selectedChangesetPaths(action);
  try {
    const diff = projectValidatedPatch(validation, selectedPaths);
    const projected = projectedAction(action, diff, selectedPaths);
    const projectedValidation = validatePatch(workspaceInfoFromRoot(snapshot.workspaceRoot), diff, {
      fs: nodeWorkspaceFs,
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

function applyChangeset(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  projection: ChangesetProjection,
): EditorAgentActionResult {
  try {
    applyPatch(workspaceInfoFromRoot(snapshot.workspaceRoot), projection.diff, {
      applyEnabled: true,
      signal: new AbortController().signal,
      fs: nodeWorkspaceFs,
      ...(editorAgentPatchWriterForTests === undefined
        ? {}
        : { writer: editorAgentPatchWriterForTests }),
    });
    return changesetTerminalResult(action, projection.selectedPaths, "succeeded");
  } catch (error) {
    const message =
      error instanceof PatchApplyError
        ? "The changeset write failed and was rolled back."
        : error instanceof PatchValidationError
          ? "The selected changeset no longer passes patch validation."
          : "The changeset could not be applied atomically.";
    emitChangesetDiagnostic(action, "editor.agent.commitChangeset", error, message);
    return changesetTerminalResult(action, projection.selectedPaths, "failed", message);
  }
}

function finishChangesetResult(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
  result: EditorAgentActionResult,
  deps: EditorAgentRouteDeps | undefined,
  decision = decideActionPolicy(action, snapshot, deps),
): RouteResult {
  auditAction(action, snapshot, decision, result);
  editorAgentRegistry.reportResult(result);
  return { status: 200, body: { result } };
}

function handleChangesetResult(
  action: EditorAgentAction,
  reported: EditorAgentActionResult,
  deps?: EditorAgentRouteDeps,
): RouteResult {
  const snapshot = editorAgentRegistry.snapshotFor(action.sessionId);
  if (reported.status !== "succeeded") {
    const failed = changesetTerminalResult(
      action,
      selectedChangesetPaths(action),
      "failed",
      "The browser rejected the changeset.",
    );
    return finishChangesetResult(action, snapshot, failed, deps);
  }
  if (snapshot === undefined) {
    const result = changesetConflict(action, [
      { code: "NO_ACTIVE_SESSION", message: "The browser session is no longer available." },
    ]);
    return finishChangesetResult(action, snapshot, result, deps);
  }
  const decision = decideActionPolicy(action, snapshot, deps);
  const policyConflict = policyAdmissionConflict(action, decision);
  if (policyConflict !== null) {
    return finishChangesetResult(action, snapshot, policyConflict, deps, decision);
  }
  const inspection = inspectChangeset(action, snapshot);
  if (inspection.result !== null) {
    return finishChangesetResult(action, snapshot, inspection.result, deps, decision);
  }
  const projection = projectChangeset(action, snapshot, inspection.validation);
  const result =
    projection.kind === "conflict"
      ? projection.result
      : applyChangeset(action, snapshot, projection);
  return finishChangesetResult(action, snapshot, result, deps, decision);
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

function finishBrowserActionResult(result: EditorAgentActionResult): RouteResult {
  editorAgentRegistry.reportResult(result);
  return { status: 200, body: { result } };
}

function handlePatchResult(
  action: EditorAgentAction,
  reported: EditorAgentActionResult,
  deps?: EditorAgentRouteDeps,
): RouteResult {
  if (reported.status !== "succeeded") return finishBrowserActionResult(reported);
  const snapshot = editorAgentRegistry.snapshotFor(action.sessionId);
  const decision = decideActionPolicy(action, snapshot, deps);
  const policyConflict = policyAdmissionConflict(action, decision);
  if (policyConflict !== null) return finishBrowserActionResult(policyConflict);
  const admission = preflight(action, snapshot);
  return finishBrowserActionResult(admission.ok ? reported : admission.result);
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
  return finishBrowserActionResult(result);
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
  rememberIdempotency(action.idempotencyKey, requestHash, result);
  auditAction(action, snapshot, decision, result);
  editorAgentRegistry.reportResult(result);
  return { status, body: { result } };
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

function prepareEditorActionRequest(
  value: EditorAgentAction | EditorAgentBridgeActionRequest,
): EditorActionRequestPreparation {
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

function replayEditorAction(action: EditorAgentAction, requestHash: string): RouteResult | null {
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
  return { status: 200, body: { result: replay.result } };
}

function serverResolvedFailure(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
  decision: EditorAgentActionPolicyDecision,
  result: EditorAgentActionResult,
  requestHash: string,
  status: 200 | 403 | 409,
): RouteResult {
  rememberIdempotency(action.idempotencyKey, requestHash, result);
  auditAction(action, snapshot, decision, result);
  editorAgentRegistry.reportResult(result);
  return { status, body: { result } };
}

async function runNavigateSymbolAction(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  deps: EditorAgentActionRouteDeps,
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
    ),
    deps,
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
      serverActionContext(
        {
          root: snapshot.workspaceRoot,
          query: request.query,
          maxResults: request.maxResults ?? 50,
          ...(request.scopePath === undefined ? {} : { scopePath: request.scopePath }),
        },
        "/api/editor/workspace-symbols",
      ),
      deps,
    );
  }
  return handleEditorWorkspaceSearch(
    serverActionContext(
      {
        root: snapshot.workspaceRoot,
        query: request.query,
        mode: "literal",
        caseSensitive: request.caseSensitive ?? false,
        includeGlobs: request.includeGlobs ?? [],
        excludeGlobs: request.excludeGlobs ?? [],
        maxResults: request.maxResults ?? 50,
      },
      "/api/editor/workspace-search",
    ),
    deps,
  );
}

function serverResolvedActionRoute(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  deps: EditorAgentActionRouteDeps,
): Promise<RouteResult> {
  return action.type === "navigateSymbol"
    ? runNavigateSymbolAction(action, snapshot, deps)
    : runSearchWorkspaceAction(action, snapshot, deps);
}

async function executeServerResolvedAction(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  deps: EditorAgentActionRouteDeps,
): Promise<RouteResult | EditorAgentActionResult> {
  try {
    return await serverResolvedActionRoute(action, snapshot, deps);
  } catch (error) {
    emitServerDiagnostic(
      undefined,
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

function finishServerResolvedAction(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
  decision: EditorAgentActionPolicyDecision,
  requestHash: string,
  outcome: RouteResult | EditorAgentActionResult,
): RouteResult {
  if ("status" in outcome && typeof outcome.status === "number") {
    if (outcome.status === 200 && isRecord(outcome.body)) {
      return serverResolvedFailure(
        action,
        snapshot,
        decision,
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          actionId: action.actionId,
          sessionId: action.sessionId,
          status: "succeeded",
          data: outcome.body,
        },
        requestHash,
        200,
      );
    }
    return serverResolvedFailure(
      action,
      snapshot,
      decision,
      conflict(
        action,
        outcome.status === 403 ? "OUT_OF_SCOPE" : "INVALID_EDITS",
        "The editor operation was rejected.",
      ),
      requestHash,
      outcome.status === 403 ? 403 : 409,
    );
  }
  return serverResolvedFailure(action, snapshot, decision, outcome, requestHash, 200);
}

async function resolveServerAction(
  action: EditorAgentAction,
  requestHash: string,
  snapshot: EditorAgentSessionSnapshot | undefined,
  deps: EditorAgentActionRouteDeps,
): Promise<RouteResult> {
  const baseline = decideActionPolicy(action, snapshot, deps);
  if (snapshot === undefined) {
    return serverResolvedFailure(
      action,
      snapshot,
      baseline,
      conflict(action, "NO_ACTIVE_SESSION", "No editor session snapshot is registered."),
      requestHash,
      409,
    );
  }
  const pathIssue = serverResolvedPathIssues(action);
  if (pathIssue !== null) {
    return serverResolvedFailure(
      action,
      snapshot,
      denyByAuthority(baseline, pathIssue),
      conflict(
        action,
        "OUT_OF_SCOPE",
        "The requested editor operation is outside the workspace scope.",
      ),
      requestHash,
      403,
    );
  }
  return finishServerResolvedAction(
    action,
    snapshot,
    baseline,
    requestHash,
    await executeServerResolvedAction(action, snapshot, deps),
  );
}

async function admitEditorAction(
  action: EditorAgentAction,
  requestHash: string,
  deps: EditorAgentActionRouteDeps | undefined,
): Promise<RouteResult> {
  const snapshot = editorAgentRegistry.snapshotFor(action.sessionId);
  const decision = decideActionPolicy(action, snapshot, deps);
  if (isServerResolvedAction(action)) {
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
    return resolveServerAction(action, requestHash, snapshot, deps);
  }
  const admission = preflight(action, snapshot);
  if (!admission.ok) {
    return rejectActionRequest(action, snapshot, decision, admission.result, requestHash, 409);
  }
  const policyConflict = policyAdmissionConflict(action, decision);
  if (policyConflict !== null) {
    return rejectActionRequest(action, snapshot, decision, policyConflict, requestHash, 403);
  }
  const reservationDenial = reserveActionAuthority(action, snapshot, decision, deps);
  if (reservationDenial !== null) {
    const result = conflict(action, "POLICY_DENIED", "The action authority budget is exhausted.");
    return rejectActionRequest(action, snapshot, reservationDenial, result, requestHash, 403);
  }
  return queueAndEmitAction(action, requestHash, snapshot, decision, admission.inspection);
}

export async function handleEditorAgentActions(
  ctx: RouteContext,
  deps?: EditorAgentActionRouteDeps,
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
  const replay = replayEditorAction(preparation.request.action, preparation.request.requestHash);
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
  return admitEditorAction(action, preparation.request.requestHash, deps);
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
): RouteResult {
  const boundAction = snapshot === undefined ? action : bindActiveBufferTarget(action, snapshot);
  const requiresReview =
    decision.disposition === "review-required" || boundAction.requiresReview === true;
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
  const outcome = editorAgentRegistry.queueAction(boundAction, emitAction);
  rememberIdempotency(action.idempotencyKey, requestHash, outcome.result);
  auditAction(action, snapshot, decision, outcome.result);
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
