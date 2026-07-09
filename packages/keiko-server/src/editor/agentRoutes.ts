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
import { createHash } from "node:crypto";
import {
  EDITOR_AGENT_SCHEMA_VERSION,
  EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS,
  classifyEditorAgentAction,
  editorAgentWritePreconditionError,
  isContainedAgentPath,
  isEditorAgentAction,
  isEditorAgentWriteActionType,
  parseEditorAgentActionsPostBody,
  parseEditorAgentSnapshotRequest,
  validateAgentTextEdits,
  type EditorAgentAction,
  type EditorAgentActionPolicyDecision,
  type EditorAgentActionResult,
  type EditorAgentConflictCode,
  type EditorAgentEvent,
  type EditorAgentSessionSnapshot,
  type EditorAgentSnapshotTextMode,
  type LanguageRange,
} from "@oscharko-dev/keiko-contracts";
import {
  PatchApplyError,
  PatchValidationError,
  applyPatch,
  computeFileContent,
  projectValidatedPatch,
  validatePatch,
  type PatchFileChange,
  type PatchValidation,
  type WorkspaceWriter,
} from "@oscharko-dev/keiko-tools";
import {
  isDenied,
  resolveWithinWorkspace,
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
import { editorAgentRegistry } from "./agentSessionRegistry.js";
import {
  _resetEditorAgentAuditForTests,
  listEditorAgentActionAudit,
  recordEditorAgentActionAudit,
} from "./agentActionAudit.js";

const MAX_AGENT_BODY_BYTES = 1_048_576;
const DEFAULT_SNAPSHOT_TEXT_BUDGET_BYTES = 64 * 1024;

type Changeset = NonNullable<EditorAgentAction["changeset"]>;
type ChangesetFile = Changeset["files"][number];
type PreparedChangeset = NonNullable<Changeset["prepared"]>;
type PreparedFile = PreparedChangeset["files"][number];
type PreparedTextEdit = PreparedFile["textEdits"][number];
type ChangesetFileResult = NonNullable<EditorAgentActionResult["files"]>[number];
type DocumentVersion = NonNullable<ChangesetFile["expectedDocumentVersion"]>;

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

function hashRequest(body: string): string {
  return createHash("sha256").update(body).digest("hex");
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

interface DiskFileState {
  readonly contentHash: string;
  readonly version?: DocumentVersion | undefined;
}

interface ChangesetInspection {
  readonly validation: PatchValidation;
  readonly prepared: PreparedChangeset | null;
  readonly result: EditorAgentActionResult | null;
}

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

function readDiskFileState(workspaceRoot: string, file: string): DiskFileState {
  const absolute = resolveWithinWorkspace(workspaceRoot, file);
  if (!nodeWorkspaceFs.exists(absolute)) return { contentHash: hashRequest("") };
  const content = nodeWorkspaceFs.readFileUtf8(absolute);
  const stat = nodeWorkspaceFs.stat(absolute);
  const version =
    stat.mtimeMs === undefined
      ? undefined
      : { sizeBytes: stat.size, modifiedAt: stat.mtimeMs, contentHash: hashRequest(content) };
  return { contentHash: hashRequest(content), ...(version === undefined ? {} : { version }) };
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
  state: DiskFileState,
  snapshot: EditorAgentSessionSnapshot,
): ChangesetIssue | null {
  const expected = file.expectedDocumentVersion;
  if (expected === undefined) return null;
  if (state.version === undefined) {
    return {
      code: "PRECONDITION_REQUIRED",
      message: "The declared document version cannot be verified for this file.",
      file: normalizeWorkspaceRelativePath(file.file),
    };
  }
  const activeVersion = changesetFileIsActive(file.file, snapshot)
    ? snapshot.documentVersion
    : undefined;
  return documentVersionsMatch(expected, state.version) &&
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
  state: DiskFileState,
  snapshot: EditorAgentSessionSnapshot,
): ChangesetIssue | null {
  const expected = file.expectedContentHash;
  if (expected === undefined) return null;
  const activeHash = changesetFileIsActive(file.file, snapshot)
    ? snapshot.activeFileContentHash
    : undefined;
  return expected === state.contentHash && (activeHash === undefined || expected === activeHash)
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
): ChangesetIssue | null {
  try {
    const state = readDiskFileState(snapshot.workspaceRoot, file.file);
    return (
      versionPreconditionIssue(file, state, snapshot) ??
      hashPreconditionIssue(file, state, snapshot) ??
      (file.expectedDocumentVersion === undefined && file.expectedContentHash === undefined
        ? {
            code: "PRECONDITION_REQUIRED",
            message: "Every changeset file requires a verifiable precondition.",
            file: normalizeWorkspaceRelativePath(file.file),
          }
        : null)
    );
  } catch {
    return {
      code: "PRECONDITION_REQUIRED",
      message: "The changeset file precondition could not be verified.",
      file: normalizeWorkspaceRelativePath(file.file),
    };
  }
}

function changesetPreconditionIssues(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): readonly ChangesetIssue[] {
  const issues: ChangesetIssue[] = [];
  for (const file of action.changeset?.files ?? []) {
    const issue = changesetPreconditionIssue(file, snapshot);
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
  validation: PatchValidation,
): readonly ChangesetIssue[] {
  const groups = [
    patchScopeIssues(validation),
    changesetShapeIssues(action, validation),
    dirtyChangesetIssues(action, snapshot),
    changesetPreconditionIssues(action, snapshot),
    patchEditIssues(validation),
  ];
  return groups.find((group) => group.length > 0) ?? [];
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
  const validation = validatePatch(
    workspaceInfoFromRoot(snapshot.workspaceRoot),
    action.changeset?.patch ?? "",
    { fs: nodeWorkspaceFs },
  );
  const issues = firstChangesetIssueGroup(action, snapshot, validation);
  if (issues.length > 0) {
    return { validation, prepared: null, result: changesetConflict(action, issues) };
  }
  const prepared = derivePreparedChangeset(action, validation, snapshot);
  if (prepared === null) {
    const issue = { code: "INVALID_EDITS" as const, message: "Changeset preview is not bounded." };
    return { validation, prepared: null, result: changesetConflict(action, [issue]) };
  }
  return { validation, prepared, result: null };
}

function derivePreparedFile(
  file: PatchFileChange,
  snapshot: EditorAgentSessionSnapshot,
): PreparedFile | null {
  const absolute = resolveWithinWorkspace(snapshot.workspaceRoot, file.path);
  const exists = nodeWorkspaceFs.exists(absolute);
  const currentContent = exists ? nodeWorkspaceFs.readFileUtf8(absolute) : "";
  const outcome = computeFileContent(file, exists ? currentContent : undefined);
  if (outcome.conflicts.length > 0) return null;
  const textEdit: PreparedTextEdit = wholeDocumentReplaceEdit(
    currentContent,
    outcome.content ?? "",
  );
  return {
    file: normalizeWorkspaceRelativePath(file.path),
    kind: file.kind,
    textEdits: [textEdit],
  };
}

function derivePreparedChangeset(
  action: EditorAgentAction,
  validation: PatchValidation,
  snapshot: EditorAgentSessionSnapshot,
): PreparedChangeset | null {
  if (!validation.ok || validation.files.length === 0) return null;
  try {
    const files: PreparedFile[] = [];
    for (const file of validation.files) {
      const preparedFile = derivePreparedFile(file, snapshot);
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
  snapshot: EditorAgentSessionSnapshot,
): EditorAgentActionResult | null {
  if (action.type !== "applyPatch") return null;
  const validation = validatePatch(
    workspaceInfoFromRoot(snapshot.workspaceRoot),
    action.patch ?? "",
    {
      fs: nodeWorkspaceFs,
    },
  );
  return mapPatchValidation(action, validation);
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

function deriveSingleFilePostImage(
  file: PatchFileChange,
  snapshot: EditorAgentSessionSnapshot,
): AgentTextEdit | null {
  const absolute = resolveWithinWorkspace(snapshot.workspaceRoot, file.path);
  const exists = nodeWorkspaceFs.exists(absolute);
  const currentContent = exists ? nodeWorkspaceFs.readFileUtf8(absolute) : "";
  const outcome = computeFileContent(file, exists ? currentContent : undefined);
  if (outcome.content === null || outcome.conflicts.length > 0) return null;
  return wholeDocumentReplaceEdit(currentContent, outcome.content);
}

// Translates a queued, preflight-validated single-file applyPatch into the contract textEdits the
// browser reviews and applies. Computing the post-image with keiko-tools' tested single-file apply
// logic against the current on-disk content guarantees the cross-cutting invariant
// applyTextEditsToText(currentContent, edits) === patchedSingleFileContent. Returns null when the
// patch is not the expected single-file shape or its post-image cannot be derived (including any
// filesystem/path error), so the caller fails the action rather than emitting an un-appliable one.
// keiko-tools strips a/ b/ git prefixes; both the patch path and snapshot.activeFile are
// workspace-relative POSIX paths. Normalize a leading ./ and backslashes so a legitimately
// matching same-file patch is not rejected on a cosmetic difference.
function normalizeWorkspaceRelativePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function deriveAgentPatchTextEdits(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): readonly AgentTextEdit[] | null {
  // Intentional re-validation: preflight already validated this patch, but validatePatch is
  // deterministic and pure over (workspace, patch, fs), so deriving here keeps this function
  // self-contained without threading mutable validation state through the queue path.
  const validation = validatePatch(
    workspaceInfoFromRoot(snapshot.workspaceRoot),
    action.patch ?? "",
    { fs: nodeWorkspaceFs },
  );
  const file = validation.files.at(0);
  if (!validation.ok || validation.files.length !== 1 || file === undefined) return null;
  // The post-image is derived from the patch's file content but the browser applies it to the
  // open buffer. Refuse to apply a patch that targets a different file than the open buffer.
  if (
    snapshot.activeFile === null ||
    normalizeWorkspaceRelativePath(file.path) !==
      normalizeWorkspaceRelativePath(snapshot.activeFile)
  ) {
    return null;
  }
  try {
    const edit = deriveSingleFilePostImage(file, snapshot);
    return edit === null ? null : [edit];
  } catch (error) {
    // GEN-SYNTH-COVERAGE-004 / W8 observability: a filesystem/derivation failure here previously
    // vanished into a bare `catch {}` — the action failed with an opaque "patch could not be prepared"
    // and the operator had no trace. Route the (redacted) cause to the diagnostic sink, keyed by the
    // actionId, before failing the action. Never rethrows: derivation failure must still fail closed.
    emitServerDiagnostic(
      undefined,
      serverDiagnosticFromError({
        correlationId: action.actionId,
        operation: `editor.agent.applyPatch ${normalizeWorkspaceRelativePath(file.path)}`,
        source: "editor.agent.derivePatch",
        error,
        redact: (message) => message,
      }),
    );
    return null;
  }
}

// Builds the action envelope to broadcast to the bridge. For applyPatch the contract textEdits are
// derived (whole-document replace) so the browser reviews a concrete edit; null means the patch could
// not be prepared and the action must be failed rather than queued. Every other action type is
// broadcast unchanged.
function buildEmitAction(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): EditorAgentAction | null {
  if (action.type === "applyChangeset") {
    const inspection = inspectChangeset(action, snapshot);
    if (
      inspection.result !== null ||
      inspection.prepared === null ||
      action.changeset === undefined
    ) {
      return null;
    }
    return {
      ...action,
      changeset: { ...action.changeset, prepared: inspection.prepared },
    };
  }
  if (action.type !== "applyPatch") return action;
  const textEdits = deriveAgentPatchTextEdits(action, snapshot);
  if (textEdits === null) return null;
  return { ...action, textEdits };
}

function targetFile(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): string | null {
  return action.target?.file ?? snapshot.activeFile;
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
function structuralWriteConflict(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): EditorAgentActionResult | null {
  if (!isEditorAgentWriteActionType(action.type)) return null;
  if (action.type === "applyChangeset") return inspectChangeset(action, snapshot).result;
  return (
    dirtyBufferConflict(action, snapshot) ??
    documentVersionConflict(action, snapshot) ??
    contentHashConflict(action, snapshot) ??
    containmentConflict(action, snapshot) ??
    sensitivePathConflict(action, snapshot) ??
    textEditsConflict(action) ??
    patchValidationConflict(action, snapshot) ??
    preconditionConflict(action, snapshot)
  );
}

// Returns a structured conflict result when the action must not be admitted to the queue, or null when
// it is clear to enqueue. The structural gates run first (above); the Issue #1392 liveness gate runs
// last so any otherwise-valid action for a session with no live bridge is answered with the structured
// NO_ACTIVE_BRIDGE conflict (AC1) rather than queued where it could never be executed.
function preflight(action: EditorAgentAction): EditorAgentActionResult | null {
  const snapshot = editorAgentRegistry.snapshotFor(action.sessionId);
  if (snapshot === undefined) {
    return conflict(action, "NO_ACTIVE_SESSION", "No active browser bridge is registered.");
  }
  const structural = structuralWriteConflict(action, snapshot);
  if (structural !== null) return structural;
  if (!editorAgentRegistry.hasLiveBridge(action.sessionId)) {
    return conflict(
      action,
      "NO_ACTIVE_BRIDGE",
      "No live browser bridge is connected for this session.",
    );
  }
  return null;
}

export function handleEditorAgentSessions(): RouteResult {
  return { status: 200, body: { sessions: editorAgentRegistry.listSessions() } };
}

export async function handleEditorAgentSnapshot(ctx: RouteContext): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_AGENT_BODY_BYTES);
  if (isRouteResult(body)) return body;
  const parsed = parseEditorAgentSnapshotRequest(body);
  if (!parsed.ok) {
    return { status: 400, body: errorBody("INVALID_REQUEST", parsed.errors.join("; ")) };
  }
  if ("kind" in parsed.value) {
    editorAgentRegistry.registerSnapshot(parsed.value.snapshot);
    return { status: 200, body: { snapshot: parsed.value.snapshot } };
  }
  const selected = editorAgentRegistry.selectSnapshot(parsed.value.sessionId);
  if (selected === undefined) return { status: 200, body: { snapshot: null } };
  const maxBytes = parsed.value.maxBytes ?? DEFAULT_SNAPSHOT_TEXT_BUDGET_BYTES;
  return {
    status: 200,
    body: { snapshot: shapeSnapshot(selected, parsed.value.textMode, maxBytes) },
  };
}

// Issue #1395 (ADR-0062) — the workspace-relative target path an action governs, or null when it has
// no file target. Used both for the policy decision and the (content-free) audit record.
function resolveActionTargetPath(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
): string | null {
  return action.target?.file ?? snapshot?.activeFile ?? null;
}

// Deterministic policy classification (AC2). Containment reuses the contract guard; sensitivity reuses
// the always-on workspace deny-list (a keiko-workspace concern the leaf classifier cannot reach, so
// the boolean is resolved here). Only meaningful for write actions; navigation/layout always allow.
function decideActionPolicy(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot | undefined,
): EditorAgentActionPolicyDecision {
  const targetPath = resolveActionTargetPath(action, snapshot);
  const targetSensitive =
    targetPath !== null && isContainedAgentPath(targetPath) && isDenied(targetPath);
  return classifyEditorAgentAction(action.type, { targetPath, targetSensitive });
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
    targetPath: resolveActionTargetPath(action, snapshot),
    editCount: action.type === "applyTextEdits" ? action.textEdits?.length : undefined,
    patchByteLength: actionPatchByteLength(action),
  });
}

function actionPatchByteLength(action: EditorAgentAction): number | undefined {
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
): RouteResult {
  auditAction(action, snapshot, decideActionPolicy(action, snapshot), result);
  editorAgentRegistry.reportResult(result);
  return { status: 200, body: { result } };
}

function handleChangesetResult(
  action: EditorAgentAction,
  reported: EditorAgentActionResult,
): RouteResult {
  const snapshot = editorAgentRegistry.snapshotFor(action.sessionId);
  if (reported.status !== "succeeded") {
    const failed = changesetTerminalResult(
      action,
      selectedChangesetPaths(action),
      "failed",
      "The browser rejected the changeset.",
    );
    return finishChangesetResult(action, snapshot, failed);
  }
  if (snapshot === undefined) {
    const result = changesetConflict(action, [
      { code: "NO_ACTIVE_SESSION", message: "The browser session is no longer available." },
    ]);
    return finishChangesetResult(action, snapshot, result);
  }
  const inspection = inspectChangeset(action, snapshot);
  if (inspection.result !== null) {
    return finishChangesetResult(action, snapshot, inspection.result);
  }
  const projection = projectChangeset(action, snapshot, inspection.validation);
  const result =
    projection.kind === "conflict"
      ? projection.result
      : applyChangeset(action, snapshot, projection);
  return finishChangesetResult(action, snapshot, result);
}

function handleReportedActionResult(result: EditorAgentActionResult): RouteResult {
  const action = editorAgentRegistry.takePendingAction(result.sessionId, result.actionId);
  if (action === undefined && result.status === "succeeded") {
    return {
      status: 409,
      body: errorBody(
        "ACTION_RESULT_NOT_PENDING",
        "No pending action matches this successful result.",
      ),
    };
  }
  if (action?.type === "applyChangeset") return handleChangesetResult(action, result);
  editorAgentRegistry.reportResult(result);
  return { status: 200, body: { result } };
}

export async function handleEditorAgentActions(ctx: RouteContext): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_AGENT_BODY_BYTES);
  if (isRouteResult(body)) return body;
  const parsed = parseEditorAgentActionsPostBody(body);
  if (!parsed.ok) {
    return { status: 400, body: errorBody("INVALID_REQUEST", parsed.errors.join("; ")) };
  }
  if (!isEditorAgentAction(parsed.value)) {
    return handleReportedActionResult(parsed.value.result);
  }
  const action = parsed.value;
  const requestHash = hashRequest(JSON.stringify(action));
  const replay = idempotency.get(action.idempotencyKey);
  if (replay !== undefined) {
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
  const snapshot = editorAgentRegistry.snapshotFor(action.sessionId);
  const decision = decideActionPolicy(action, snapshot);
  const failed = preflight(action);
  if (failed !== null) {
    rememberIdempotency(action.idempotencyKey, requestHash, failed);
    auditAction(action, snapshot, decision, failed);
    editorAgentRegistry.reportResult(failed);
    return { status: 409, body: { result: failed } };
  }
  return queueAndEmitAction(action, requestHash, snapshot, decision);
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
): RouteResult {
  const emitAction = snapshot === undefined ? null : buildEmitAction(action, snapshot);
  if (emitAction === null) {
    const result = failedResult(action, "Patch could not be prepared for review.");
    rememberIdempotency(action.idempotencyKey, requestHash, result);
    auditAction(action, snapshot, decision, result);
    return { status: 409, body: { result } };
  }
  const outcome = editorAgentRegistry.queueAction(action, emitAction);
  rememberIdempotency(action.idempotencyKey, requestHash, outcome.result);
  auditAction(action, snapshot, decision, outcome.result);
  if (outcome.kind === "rejected") {
    // QUEUE_FULL is backpressure (429); a duplicate in-flight actionId is a conflict (409).
    const status = outcome.result.failure?.code === "QUEUE_FULL" ? 429 : 409;
    return { status, body: { result: outcome.result } };
  }
  return { status: 202, body: { result: outcome.result } };
}

export function handleEditorAgentEvents(ctx: RouteContext): HandlerOutcome {
  const sessionIds = ctx.url.searchParams
    .getAll("sessionId")
    .map((sessionId) => sessionId.trim())
    .filter((sessionId) => sessionId.length > 0);
  openAgentSseStream(ctx, sessionIds.length === 0 ? undefined : sessionIds);
  return STREAMING;
}

// Issue #1395 (ADR-0062, AC4) — read-only feed of the bounded audit ledger so users can inspect what
// an agent changed or attempted. Scoped to the session when `?sessionId=` is present; otherwise a
// bounded recent-activity view across sessions. Content-free records only (no raw source, no secrets).
export function handleEditorAgentAudit(ctx: RouteContext): RouteResult {
  const sessionId = ctx.url.searchParams.get("sessionId") ?? undefined;
  return { status: 200, body: { records: listEditorAgentActionAudit(sessionId) } };
}

function connectEditorAgentSessions(
  sessionIds: readonly string[] | undefined,
  subscriber: (event: EditorAgentEvent) => void,
): () => void {
  if (sessionIds === undefined) return editorAgentRegistry.connect(undefined, subscriber);
  const disposers = [...new Set(sessionIds)].map((sessionId) =>
    editorAgentRegistry.connect(sessionId, subscriber),
  );
  return (): void => {
    for (const dispose of disposers) dispose();
  };
}

// Opens the SSE stream and registers the connection as either one or more session bridges (when
// `?sessionId=` is present) or a global observer. The disposer drops the subscription — and thus the
// bridge-liveness contribution — when the response closes (AC1: a dropped bridge makes the session
// unavailable again).
function openAgentSseStream(ctx: RouteContext, sessionIds: readonly string[] | undefined): void {
  const res: ServerResponse = ctx.res;
  res.writeHead(200, SSE_HEADERS);
  startSseHeartbeat(res);
  const subscriber = (event: EditorAgentEvent): void => {
    const frame = `id: ${event.eventId}\nevent: editor-agent:${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    if (!res.write(frame)) res.destroy();
  };
  const dispose = connectEditorAgentSessions(sessionIds, subscriber);
  res.write(readyMessage());
  ctx.req.on("close", () => {
    res.end();
  });
  res.on("close", dispose);
}

export function _resetEditorAgentStateForTests(): void {
  idempotency.clear();
  editorAgentPatchWriterForTests = undefined;
  editorAgentRegistry.reset();
  _resetEditorAgentAuditForTests();
}

export function _setEditorAgentPatchWriterForTests(writer: WorkspaceWriter | undefined): void {
  editorAgentPatchWriterForTests = writer;
}
