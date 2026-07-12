import {
  DEFAULT_PATCH_LIMITS,
  isEditorDocumentVersion,
  isRootRelativeFileIdentifier,
  resolveWorkspaceFileIdentifier,
  type EditorDocumentVersion,
  type LanguageRange,
} from "@oscharko-dev/keiko-contracts";
import {
  EDITOR_AGENT_ACTION_ID_MAX_BYTES,
  EDITOR_AGENT_IDEMPOTENCY_KEY_MAX_BYTES,
  EDITOR_AGENT_SCHEMA_VERSION,
  EDITOR_AGENT_SESSION_ID_MAX_BYTES,
  EDITOR_AGENT_TARGET_PATH_MAX_BYTES,
  EDITOR_AGENT_WINDOW_ID_MAX_BYTES,
  isEditorAgentAction,
  isEditorAgentActionResult,
  isEditorAgentConflictCode,
  isEditorAgentSessionSnapshot,
  type EditorAgentAction,
  type EditorAgentActionQueuedResponse,
  type EditorAgentActionOrigin,
  type EditorAgentActionResult,
  type EditorAgentConflictCode,
  type EditorAgentSessionSnapshot,
} from "@oscharko-dev/keiko-contracts/editor-agent";
import {
  FILE_HEADERS_ONLY,
  createTwoFilesPatch,
  formatPatch,
  parsePatch,
  type StructuredPatch,
} from "diff";

import { ApiError, fetchEditorAgentSessions, fetchFilesContent } from "./api";

export const CHAT_EDITOR_APPLY_MAX_FILE_BYTES = 1_000_000;
export const CHAT_EDITOR_APPLY_MAX_TOTAL_CONTENT_BYTES = 4_000_000;

const MAX_LANGUAGE_CHARS = 64;
const SELECTION_DIFF_TIMEOUT_MS = 250;
const CHAT_ACTION_ID_PREFIX = "chat-apply-";
const EMPTY_CONTENT_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const PATCH_LANGUAGES = new Set(["diff", "patch", "udiff"]);

type FilesContentResponse = Awaited<ReturnType<typeof fetchFilesContent>>;
type ChatEditorActionType = "applyPatch" | "applyChangeset";
type ChatOriginEditorAgentAction = Omit<EditorAgentAction, "type"> & {
  readonly type: ChatEditorActionType;
  readonly origin: Extract<EditorAgentActionOrigin, "chat">;
};
type PatchTargetKind = "create" | "modify" | "delete";

export interface ChatEditorApplyContext {
  readonly workspaceRoot: string;
  readonly sessionId?: string | undefined;
  readonly windowId?: string | undefined;
  readonly activeFile?: string | undefined;
}

export interface ChatEditorApplyInput {
  readonly codeBlockText: string;
  readonly language?: string | undefined;
  readonly context: ChatEditorApplyContext;
}

export interface ChatEditorApplyDependencies {
  readonly fetchSessions: typeof fetchEditorAgentSessions;
  readonly fetchFileContent: typeof fetchFilesContent;
  readonly queueAction: (action: EditorAgentAction) => Promise<EditorAgentActionQueuedResponse>;
  readonly createNonce: () => string;
}

export type ChatEditorApplyRejectionCode =
  | "AMBIGUOUS_SESSION"
  | "AMBIGUOUS_TARGET"
  | "FILE_UNAVAILABLE"
  | "INVALID_BLOCK"
  | "INVALID_PATCH"
  | "LIMIT_EXCEEDED"
  | "NO_CHANGES"
  | "QUEUE_FAILED"
  | "QUEUE_REJECTED";

export type ChatEditorApplyOutcome =
  | {
      readonly kind: "queued";
      readonly actionType: ChatEditorActionType;
      readonly result: EditorAgentActionResult;
    }
  | {
      readonly kind: "conflict";
      readonly code: EditorAgentConflictCode;
      readonly message: string;
      readonly result?: EditorAgentActionResult | undefined;
    }
  | {
      readonly kind: "rejected";
      readonly code: ChatEditorApplyRejectionCode;
      readonly message: string;
      readonly result?: EditorAgentActionResult | undefined;
    }
  | {
      readonly kind: "outcome-unknown";
      readonly actionType: ChatEditorActionType;
      readonly message: string;
    };

interface PatchTarget {
  readonly file: string;
  readonly kind: PatchTargetKind;
}

interface ParsedPatch {
  readonly patch: string;
  readonly targets: readonly PatchTarget[];
}

interface FileRevision {
  readonly content: string;
  readonly contentBytes: number;
  readonly version: EditorDocumentVersion;
}

interface LoadedPatchTarget extends PatchTarget {
  readonly revision?: FileRevision | undefined;
}

interface PreparedSubmission {
  readonly patch: string;
  readonly targets: readonly LoadedPatchTarget[];
  readonly actionType: ChatEditorActionType;
}

type Step<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly outcome: ChatEditorApplyOutcome };

const DEFAULT_DEPENDENCIES: ChatEditorApplyDependencies = {
  fetchSessions: fetchEditorAgentSessions,
  fetchFileContent: fetchFilesContent,
  queueAction: () => Promise.reject(new Error("The editor bridge is unavailable.")),
  createNonce: secureNonce,
};

function rejected(
  code: ChatEditorApplyRejectionCode,
  message: string,
  result?: EditorAgentActionResult,
): ChatEditorApplyOutcome {
  return { kind: "rejected", code, message, ...(result === undefined ? {} : { result }) };
}

function conflict(
  code: EditorAgentConflictCode,
  message: string,
  result?: EditorAgentActionResult,
): ChatEditorApplyOutcome {
  return { kind: "conflict", code, message, ...(result === undefined ? {} : { result }) };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isBoundedUtf8Identifier(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && utf8Bytes(value) <= maxBytes;
}

function secureNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalWorkspacePath(root: string, candidate: string | undefined): string | null {
  if (candidate === undefined || utf8Bytes(candidate) > EDITOR_AGENT_TARGET_PATH_MAX_BYTES) {
    return null;
  }
  if (/[\u0000\t\r\n]/u.test(candidate)) return null;
  const resolution = resolveWorkspaceFileIdentifier(root, candidate);
  if (resolution.kind !== "relative") return null;
  const path = resolution.path
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
  return utf8Bytes(path) <= EDITOR_AGENT_TARGET_PATH_MAX_BYTES && isRootRelativeFileIdentifier(path)
    ? path
    : null;
}

function validateContext(context: ChatEditorApplyContext): ChatEditorApplyOutcome | null {
  if (typeof context.workspaceRoot !== "string" || context.workspaceRoot.trim().length === 0) {
    return rejected("AMBIGUOUS_SESSION", "Workspace context is required.");
  }
  if (
    (context.sessionId !== undefined &&
      !isBoundedUtf8Identifier(context.sessionId, EDITOR_AGENT_SESSION_ID_MAX_BYTES)) ||
    (context.windowId !== undefined &&
      !isBoundedUtf8Identifier(context.windowId, EDITOR_AGENT_WINDOW_ID_MAX_BYTES))
  ) {
    return rejected("AMBIGUOUS_SESSION", "Session context is invalid.");
  }
  if (
    context.activeFile !== undefined &&
    (typeof context.activeFile !== "string" ||
      canonicalWorkspacePath(context.workspaceRoot, context.activeFile) === null)
  ) {
    return rejected("AMBIGUOUS_TARGET", "Active-file context is invalid.");
  }
  return null;
}

function patchHeaderPath(root: string, candidate: string): string | null {
  if (candidate === "/dev/null") return candidate;
  const withoutGitPrefix =
    candidate.startsWith("a/") || candidate.startsWith("b/") ? candidate.slice(2) : candidate;
  if (!isRootRelativeFileIdentifier(withoutGitPrefix)) return null;
  return canonicalWorkspacePath(root, withoutGitPrefix);
}

function patchTarget(root: string, patch: StructuredPatch): PatchTarget | null {
  if (patch.isBinary === true || patch.isRename === true || patch.isCopy === true) return null;
  if (patch.hunks.length === 0) return null;
  if (patch.oldFileName === undefined || patch.newFileName === undefined) return null;
  const oldPath = patchHeaderPath(root, patch.oldFileName);
  const newPath = patchHeaderPath(root, patch.newFileName);
  if (oldPath === null || newPath === null) return null;
  if (oldPath === "/dev/null" && newPath === "/dev/null") return null;
  if (oldPath === "/dev/null") return { file: newPath, kind: "create" };
  if (newPath === "/dev/null") return { file: oldPath, kind: "delete" };
  return oldPath === newPath ? { file: newPath, kind: "modify" } : null;
}

function changedLineCount(patches: readonly StructuredPatch[]): number {
  return patches.reduce(
    (total, patch) =>
      total +
      patch.hunks.reduce(
        (fileTotal, hunk) =>
          fileTotal +
          hunk.lines.filter((line) => line.startsWith("+") || line.startsWith("-")).length,
        0,
      ),
    0,
  );
}

function sanitizedPatch(patch: StructuredPatch, target: PatchTarget): StructuredPatch {
  return {
    oldFileName: target.kind === "create" ? "/dev/null" : `a/${target.file}`,
    newFileName: target.kind === "delete" ? "/dev/null" : `b/${target.file}`,
    oldHeader: undefined,
    newHeader: undefined,
    hunks: patch.hunks.map((hunk) => ({ ...hunk, lines: [...hunk.lines] })),
  };
}

function parsePatchEntries(text: string): Step<readonly StructuredPatch[]> {
  try {
    const entries = parsePatch(text.startsWith("\uFEFF") ? text.slice(1) : text);
    if (entries.length === 0) {
      return { ok: false, outcome: rejected("INVALID_PATCH", "The patch has no file changes.") };
    }
    if (entries.length > DEFAULT_PATCH_LIMITS.maxFilesChanged) {
      return {
        ok: false,
        outcome: rejected("LIMIT_EXCEEDED", "The patch exceeds the file-count limit."),
      };
    }
    return { ok: true, value: entries };
  } catch {
    return { ok: false, outcome: rejected("INVALID_PATCH", "The patch is malformed.") };
  }
}

function normalizePatch(root: string, text: string): Step<ParsedPatch> {
  const parsed = parsePatchEntries(text);
  if (!parsed.ok) return parsed;
  const targets = parsed.value.map((entry) => patchTarget(root, entry));
  if (targets.some((target) => target === null)) {
    return { ok: false, outcome: rejected("INVALID_PATCH", "The patch target is unsupported.") };
  }
  const safeTargets = targets as readonly PatchTarget[];
  if (new Set(safeTargets.map((target) => target.file)).size !== safeTargets.length) {
    return { ok: false, outcome: rejected("AMBIGUOUS_TARGET", "Patch targets are ambiguous.") };
  }
  const changedLines = changedLineCount(parsed.value);
  if (changedLines === 0) {
    return { ok: false, outcome: rejected("NO_CHANGES", "The patch contains no text changes.") };
  }
  if (changedLines > DEFAULT_PATCH_LIMITS.maxChangedLines) {
    return {
      ok: false,
      outcome: rejected("LIMIT_EXCEEDED", "The patch exceeds the changed-line limit."),
    };
  }
  const patch = formatPatch(
    parsed.value.map((entry, index) => sanitizedPatch(entry, safeTargets[index]!)),
    FILE_HEADERS_ONLY,
  );
  return utf8Bytes(patch) <= DEFAULT_PATCH_LIMITS.maxPatchBytes
    ? { ok: true, value: { patch, targets: safeTargets } }
    : { ok: false, outcome: rejected("LIMIT_EXCEEDED", "The patch exceeds the byte limit.") };
}

function blockIsPatch(input: ChatEditorApplyInput): boolean {
  const language = input.language?.trim().toLowerCase() ?? "";
  if (PATCH_LANGUAGES.has(language)) return true;
  const lines = input.codeBlockText.slice(0, 2_048).split(/\r?\n/u);
  return lines.some((rawLine, index) => {
    const line = rawLine.trimStart();
    if (line.startsWith("diff --git ") || line.startsWith("@@ -")) return true;
    return line.startsWith("--- ") && lines[index + 1]?.trimStart().startsWith("+++ ") === true;
  });
}

function validateBlock(input: ChatEditorApplyInput): ChatEditorApplyOutcome | null {
  if (input.codeBlockText.length === 0) {
    return rejected("INVALID_BLOCK", "The assistant code block is empty.");
  }
  if ((input.language?.length ?? 0) > MAX_LANGUAGE_CHARS) {
    return rejected("INVALID_BLOCK", "The code-block language label is too long.");
  }
  if (input.codeBlockText.includes("\u0000")) {
    return rejected("INVALID_BLOCK", "The assistant code block contains unsupported data.");
  }
  return utf8Bytes(input.codeBlockText) > DEFAULT_PATCH_LIMITS.maxPatchBytes
    ? rejected("LIMIT_EXCEEDED", "The assistant code block exceeds the byte limit.")
    : null;
}

function contextMatchesSession(
  context: ChatEditorApplyContext,
  expectedActiveFile: string | null,
  session: EditorAgentSessionSnapshot,
): boolean {
  if (session.workspaceRoot !== context.workspaceRoot) return false;
  if (context.sessionId !== undefined && session.sessionId !== context.sessionId) return false;
  if (context.windowId !== undefined && session.windowId !== context.windowId) return false;
  if (expectedActiveFile === null) return true;
  return (
    canonicalWorkspacePath(session.workspaceRoot, session.activeFile ?? undefined) ===
    expectedActiveFile
  );
}

function selectSession(
  context: ChatEditorApplyContext,
  response: unknown,
): Step<EditorAgentSessionSnapshot> {
  if (!isRecord(response) || !Array.isArray(response.sessions)) {
    return { ok: false, outcome: rejected("AMBIGUOUS_SESSION", "Session data is invalid.") };
  }
  if (!response.sessions.every(isEditorAgentSessionSnapshot)) {
    return { ok: false, outcome: rejected("AMBIGUOUS_SESSION", "Session data is invalid.") };
  }
  const activeFile =
    context.activeFile === undefined
      ? null
      : canonicalWorkspacePath(context.workspaceRoot, context.activeFile);
  if (context.activeFile !== undefined && activeFile === null) {
    return { ok: false, outcome: rejected("AMBIGUOUS_TARGET", "Active-file context is invalid.") };
  }
  const matches = response.sessions.filter((session) =>
    contextMatchesSession(context, activeFile, session),
  );
  if (matches.length === 0) {
    return {
      ok: false,
      outcome: conflict("NO_ACTIVE_SESSION", "No matching editor session exists."),
    };
  }
  return matches.length === 1
    ? { ok: true, value: matches[0]! }
    : {
        ok: false,
        outcome: rejected("AMBIGUOUS_SESSION", "Editor session selection is ambiguous."),
      };
}

function parseFileRevision(
  value: unknown,
  workspaceRoot: string,
  targetFile: string,
): Step<FileRevision> {
  if (!isRecord(value) || !isRecord(value.session)) {
    return { ok: false, outcome: rejected("FILE_UNAVAILABLE", "File revision data is invalid.") };
  }
  const response = value as unknown as FilesContentResponse;
  const responsePath = canonicalWorkspacePath(workspaceRoot, response.path);
  if (response.root !== workspaceRoot || responsePath !== targetFile) {
    return {
      ok: false,
      outcome: rejected("AMBIGUOUS_TARGET", "File response target is ambiguous."),
    };
  }
  const version = response.session.version;
  if (!isEditorDocumentVersion(version) || typeof response.content !== "string") {
    return {
      ok: false,
      outcome: conflict("PRECONDITION_REQUIRED", "File revision data is incomplete."),
    };
  }
  const contentBytes = utf8Bytes(response.content);
  const metadataMatches =
    version.sizeBytes === response.sizeBytes &&
    version.modifiedAt === response.modifiedAt &&
    contentBytes === response.sizeBytes &&
    response.sizeBytes <= response.maxBytes;
  if (!metadataMatches) {
    return {
      ok: false,
      outcome: conflict("PRECONDITION_REQUIRED", "File revision data is incomplete."),
    };
  }
  if (contentBytes > CHAT_EDITOR_APPLY_MAX_FILE_BYTES) {
    return {
      ok: false,
      outcome: rejected("LIMIT_EXCEEDED", "A target file exceeds the content limit."),
    };
  }
  return { ok: true, value: { content: response.content, contentBytes, version } };
}

function documentVersionsEqual(left: EditorDocumentVersion, right: EditorDocumentVersion): boolean {
  return (
    left.sizeBytes === right.sizeBytes &&
    left.modifiedAt === right.modifiedAt &&
    left.contentHash === right.contentHash
  );
}

function activeRevisionConflict(
  session: EditorAgentSessionSnapshot,
  target: LoadedPatchTarget,
): ChatEditorApplyOutcome | null {
  const activeFile = canonicalWorkspacePath(session.workspaceRoot, session.activeFile ?? undefined);
  if (activeFile !== target.file) return null;
  if (target.revision === undefined || session.documentVersion === undefined) {
    return conflict("PRECONDITION_REQUIRED", "The active editor revision cannot be verified.");
  }
  if (!documentVersionsEqual(session.documentVersion, target.revision.version)) {
    return conflict("VERSION_MISMATCH", "The active editor document version changed.");
  }
  if (session.activeFileContentHash === undefined) {
    return conflict("PRECONDITION_REQUIRED", "The active editor content hash cannot be verified.");
  }
  return session.activeFileContentHash === target.revision.version.contentHash
    ? null
    : conflict("CONTENT_HASH_MISMATCH", "The active editor content hash changed.");
}

function dirtyTargetConflict(
  session: EditorAgentSessionSnapshot,
  targets: readonly PatchTarget[],
): ChatEditorApplyOutcome | null {
  const dirty = new Set(
    session.dirtyFiles
      .map((file) => canonicalWorkspacePath(session.workspaceRoot, file))
      .filter((file): file is string => file !== null),
  );
  return targets.some((target) => dirty.has(target.file))
    ? conflict("DIRTY", "A target editor buffer has unsaved changes.")
    : null;
}

function fileReadIsOutOfScope(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.code === "DENIED");
}

async function loadCreateTarget(
  session: EditorAgentSessionSnapshot,
  target: PatchTarget,
  dependencies: ChatEditorApplyDependencies,
): Promise<Step<LoadedPatchTarget>> {
  try {
    await dependencies.fetchFileContent(session.workspaceRoot, target.file);
    return {
      ok: false,
      outcome: conflict("CONTENT_HASH_MISMATCH", "A create target already exists."),
    };
  } catch (error) {
    if (fileReadIsOutOfScope(error)) {
      return { ok: false, outcome: conflict("OUT_OF_SCOPE", "A target file is outside policy.") };
    }
    return error instanceof ApiError && error.status === 404
      ? { ok: true, value: target }
      : { ok: false, outcome: rejected("FILE_UNAVAILABLE", "A target file could not be read.") };
  }
}

async function loadExistingTarget(
  session: EditorAgentSessionSnapshot,
  target: PatchTarget,
  dependencies: ChatEditorApplyDependencies,
): Promise<Step<LoadedPatchTarget>> {
  try {
    const raw: unknown = await dependencies.fetchFileContent(session.workspaceRoot, target.file);
    const revision = parseFileRevision(raw, session.workspaceRoot, target.file);
    if (!revision.ok) return revision;
    const loaded = { ...target, revision: revision.value };
    const activeConflict = activeRevisionConflict(session, loaded);
    return activeConflict === null
      ? { ok: true, value: loaded }
      : { ok: false, outcome: activeConflict };
  } catch (error) {
    if (fileReadIsOutOfScope(error)) {
      return { ok: false, outcome: conflict("OUT_OF_SCOPE", "A target file is outside policy.") };
    }
    return error instanceof ApiError && error.status === 404
      ? {
          ok: false,
          outcome: conflict("PRECONDITION_REQUIRED", "A target file revision cannot be verified."),
        }
      : { ok: false, outcome: rejected("FILE_UNAVAILABLE", "A target file could not be read.") };
  }
}

async function loadPatchTargets(
  session: EditorAgentSessionSnapshot,
  targets: readonly PatchTarget[],
  dependencies: ChatEditorApplyDependencies,
): Promise<Step<readonly LoadedPatchTarget[]>> {
  const dirtyConflict = dirtyTargetConflict(session, targets);
  if (dirtyConflict !== null) return { ok: false, outcome: dirtyConflict };
  const loaded: LoadedPatchTarget[] = [];
  let totalContentBytes = 0;
  for (const target of targets) {
    const result =
      target.kind === "create"
        ? await loadCreateTarget(session, target, dependencies)
        : await loadExistingTarget(session, target, dependencies);
    if (!result.ok) return result;
    totalContentBytes += result.value.revision?.contentBytes ?? 0;
    if (totalContentBytes > CHAT_EDITOR_APPLY_MAX_TOTAL_CONTENT_BYTES) {
      return {
        ok: false,
        outcome: rejected("LIMIT_EXCEEDED", "Target files exceed the total content limit."),
      };
    }
    loaded.push(result.value);
  }
  return { ok: true, value: loaded };
}

function positionOffset(text: string, position: LanguageRange["start"]): number | null {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  const start = starts[position.line];
  if (start === undefined) return null;
  const next = starts[position.line + 1];
  let end = next === undefined ? text.length : next - 1;
  if (end > start && text.charCodeAt(end - 1) === 13) end -= 1;
  return position.character <= end - start ? start + position.character : null;
}

function replaceSelection(
  content: string,
  selection: LanguageRange,
  replacement: string,
): Step<string> {
  const start = positionOffset(content, selection.start);
  const end = positionOffset(content, selection.end);
  if (start === null || end === null || start >= end) {
    return {
      ok: false,
      outcome: rejected("AMBIGUOUS_TARGET", "A non-empty selection is required."),
    };
  }
  const modified = `${content.slice(0, start)}${replacement}${content.slice(end)}`;
  return modified === content
    ? {
        ok: false,
        outcome: rejected("NO_CHANGES", "The suggestion matches the current selection."),
      }
    : { ok: true, value: modified };
}

function singleActiveModify(
  session: EditorAgentSessionSnapshot,
  targets: readonly PatchTarget[],
): boolean {
  if (targets.length !== 1 || targets[0]?.kind !== "modify") return false;
  const activeFile = canonicalWorkspacePath(session.workspaceRoot, session.activeFile ?? undefined);
  return activeFile !== null && targets[0].file === activeFile;
}

async function preparePatchSubmission(
  text: string,
  session: EditorAgentSessionSnapshot,
  dependencies: ChatEditorApplyDependencies,
): Promise<Step<PreparedSubmission>> {
  const parsed = normalizePatch(session.workspaceRoot, text);
  if (!parsed.ok) return parsed;
  const loaded = await loadPatchTargets(session, parsed.value.targets, dependencies);
  if (!loaded.ok) return loaded;
  return {
    ok: true,
    value: {
      patch: parsed.value.patch,
      targets: loaded.value,
      actionType: singleActiveModify(session, parsed.value.targets)
        ? "applyPatch"
        : "applyChangeset",
    },
  };
}

async function prepareSelectionSubmission(
  input: ChatEditorApplyInput,
  session: EditorAgentSessionSnapshot,
  dependencies: ChatEditorApplyDependencies,
): Promise<Step<PreparedSubmission>> {
  const file = canonicalWorkspacePath(session.workspaceRoot, session.activeFile ?? undefined);
  if (file === null || session.selection === null) {
    return {
      ok: false,
      outcome: rejected("AMBIGUOUS_TARGET", "A non-empty selection is required."),
    };
  }
  const loaded = await loadPatchTargets(session, [{ file, kind: "modify" }], dependencies);
  if (!loaded.ok) return loaded;
  const target = loaded.value[0];
  if (target?.revision === undefined) {
    return {
      ok: false,
      outcome: conflict("PRECONDITION_REQUIRED", "File revision data is incomplete."),
    };
  }
  const modified = replaceSelection(
    target.revision.content,
    session.selection,
    input.codeBlockText,
  );
  if (!modified.ok) return modified;
  const generated = createTwoFilesPatch(
    `a/${file}`,
    `b/${file}`,
    target.revision.content,
    modified.value,
    undefined,
    undefined,
    { context: 3, headerOptions: FILE_HEADERS_ONLY, timeout: SELECTION_DIFF_TIMEOUT_MS },
  );
  if (generated === undefined) {
    return {
      ok: false,
      outcome: rejected("LIMIT_EXCEEDED", "Selection diff generation exceeded its limit."),
    };
  }
  const parsed = normalizePatch(session.workspaceRoot, generated);
  if (!parsed.ok) return parsed;
  return parsed.value.targets.length === 1 && parsed.value.targets[0]?.file === file
    ? {
        ok: true,
        value: { patch: parsed.value.patch, targets: loaded.value, actionType: "applyPatch" },
      }
    : { ok: false, outcome: rejected("AMBIGUOUS_TARGET", "Generated patch target is ambiguous.") };
}

async function prepareSubmission(
  input: ChatEditorApplyInput,
  session: EditorAgentSessionSnapshot,
  dependencies: ChatEditorApplyDependencies,
): Promise<Step<PreparedSubmission>> {
  try {
    return blockIsPatch(input)
      ? await preparePatchSubmission(input.codeBlockText, session, dependencies)
      : await prepareSelectionSubmission(input, session, dependencies);
  } catch {
    return {
      ok: false,
      outcome: rejected("INVALID_BLOCK", "The assistant suggestion could not be prepared."),
    };
  }
}

function actionIdentity(dependencies: ChatEditorApplyDependencies): Step<{
  readonly actionId: string;
  readonly idempotencyKey: string;
}> {
  try {
    const nonce: unknown = dependencies.createNonce();
    if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{8,}$/u.test(nonce)) {
      return {
        ok: false,
        outcome: rejected("QUEUE_FAILED", "Secure action identity is unavailable."),
      };
    }
    const actionId = `${CHAT_ACTION_ID_PREFIX}${nonce}`;
    const idempotencyKey = `${CHAT_ACTION_ID_PREFIX}${nonce}`;
    if (
      !isBoundedUtf8Identifier(actionId, EDITOR_AGENT_ACTION_ID_MAX_BYTES) ||
      !isBoundedUtf8Identifier(idempotencyKey, EDITOR_AGENT_IDEMPOTENCY_KEY_MAX_BYTES)
    ) {
      return {
        ok: false,
        outcome: rejected("QUEUE_FAILED", "Secure action identity is unavailable."),
      };
    }
    return {
      ok: true,
      value: { actionId, idempotencyKey },
    };
  } catch {
    return {
      ok: false,
      outcome: rejected("QUEUE_FAILED", "Secure action identity is unavailable."),
    };
  }
}

function changesetFiles(
  targets: readonly LoadedPatchTarget[],
): NonNullable<EditorAgentAction["changeset"]>["files"] {
  return targets.map((target) =>
    target.revision === undefined
      ? { file: target.file, expectedContentHash: EMPTY_CONTENT_SHA256 }
      : {
          file: target.file,
          expectedDocumentVersion: target.revision.version,
          expectedContentHash: target.revision.version.contentHash,
        },
  );
}

function buildAction(
  session: EditorAgentSessionSnapshot,
  prepared: PreparedSubmission,
  identity: { readonly actionId: string; readonly idempotencyKey: string },
): ChatOriginEditorAgentAction {
  const base = {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    sessionId: session.sessionId,
    actionId: identity.actionId,
    idempotencyKey: identity.idempotencyKey,
    origin: "chat" as const,
  };
  if (prepared.actionType === "applyChangeset") {
    return {
      ...base,
      type: "applyChangeset",
      changeset: { patch: prepared.patch, files: changesetFiles(prepared.targets) },
    };
  }
  const target = prepared.targets[0];
  if (target?.revision === undefined) throw new Error("applyPatch target lacks a revision");
  return {
    ...base,
    type: "applyPatch",
    target: {
      file: target.file,
      ...(session.activePaneId === null ? {} : { paneId: session.activePaneId }),
    },
    expectedDocumentVersion: target.revision.version,
    expectedContentHash: target.revision.version.contentHash,
    patch: prepared.patch,
  };
}

function shouldReplayStructuredError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 409 || error.status === 429);
}

function isUncertainQueueError(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 408 || error.status >= 500;
}

type QueueResponseClassification =
  | { readonly kind: "terminal"; readonly outcome: ChatEditorApplyOutcome }
  | { readonly kind: "uncertain" };

function queueOutcome(
  action: ChatOriginEditorAgentAction,
  response: unknown,
): QueueResponseClassification {
  if (!isRecord(response) || !isEditorAgentActionResult(response.result)) {
    return { kind: "uncertain" };
  }
  const result = response.result;
  if (result.actionId !== action.actionId || result.sessionId !== action.sessionId) {
    return { kind: "uncertain" };
  }
  if (result.status === "conflict" && result.conflict !== undefined) {
    return {
      kind: "terminal",
      outcome: conflict(result.conflict.code, result.conflict.message, result),
    };
  }
  if (result.status === "queued" || result.status === "succeeded") {
    return { kind: "terminal", outcome: { kind: "queued", actionType: action.type, result } };
  }
  return {
    kind: "terminal",
    outcome: rejected("QUEUE_REJECTED", "The editor action was not queued.", result),
  };
}

function queueErrorOutcome(error: unknown): ChatEditorApplyOutcome {
  if (error instanceof ApiError && isEditorAgentConflictCode(error.code)) {
    return conflict(error.code, error.message);
  }
  return rejected("QUEUE_FAILED", "The editor action could not be queued.");
}

function unknownQueueOutcome(action: ChatOriginEditorAgentAction): ChatEditorApplyOutcome {
  return {
    kind: "outcome-unknown",
    actionType: action.type,
    message: "The editor action outcome is unknown. Check the editor.",
  };
}

interface QueueReplayState {
  readonly replayedStructuredError: boolean;
  readonly replayedUncertainOutcome: boolean;
}

type QueueAttemptResolution =
  | { readonly kind: "return"; readonly outcome: ChatEditorApplyOutcome }
  | { readonly kind: "retry"; readonly replayState: QueueReplayState };

function resolveQueueSuccess(
  action: ChatOriginEditorAgentAction,
  response: unknown,
  replayState: QueueReplayState,
): QueueAttemptResolution {
  const classified = queueOutcome(action, response);
  if (classified.kind === "terminal") {
    return { kind: "return", outcome: classified.outcome };
  }
  if (replayState.replayedUncertainOutcome) {
    return { kind: "return", outcome: unknownQueueOutcome(action) };
  }
  return { kind: "retry", replayState: { ...replayState, replayedUncertainOutcome: true } };
}

function resolveQueueError(
  action: ChatOriginEditorAgentAction,
  error: unknown,
  replayState: QueueReplayState,
): QueueAttemptResolution {
  if (shouldReplayStructuredError(error) && !replayState.replayedStructuredError) {
    return { kind: "retry", replayState: { ...replayState, replayedStructuredError: true } };
  }
  if (isUncertainQueueError(error) && !replayState.replayedUncertainOutcome) {
    return { kind: "retry", replayState: { ...replayState, replayedUncertainOutcome: true } };
  }
  return {
    kind: "return",
    outcome: isUncertainQueueError(error) ? unknownQueueOutcome(action) : queueErrorOutcome(error),
  };
}

async function attemptQueueOnce(
  action: ChatOriginEditorAgentAction,
  dependencies: ChatEditorApplyDependencies,
  replayState: QueueReplayState,
): Promise<QueueAttemptResolution> {
  try {
    const response = await dependencies.queueAction(action);
    return resolveQueueSuccess(action, response, replayState);
  } catch (error) {
    return resolveQueueError(action, error, replayState);
  }
}

async function queueWithIdempotentReplay(
  action: ChatOriginEditorAgentAction,
  dependencies: ChatEditorApplyDependencies,
): Promise<ChatEditorApplyOutcome> {
  let replayState: QueueReplayState = {
    replayedStructuredError: false,
    replayedUncertainOutcome: false,
  };
  for (;;) {
    const resolution = await attemptQueueOnce(action, dependencies, replayState);
    if (resolution.kind === "return") return resolution.outcome;
    replayState = resolution.replayState;
  }
}

async function fetchSelectedSession(
  context: ChatEditorApplyContext,
  dependencies: ChatEditorApplyDependencies,
): Promise<Step<EditorAgentSessionSnapshot>> {
  try {
    const response: unknown = await dependencies.fetchSessions();
    return selectSession(context, response);
  } catch {
    return {
      ok: false,
      outcome: rejected("AMBIGUOUS_SESSION", "Editor sessions are unavailable."),
    };
  }
}

export async function queueChatEditorApply(
  input: ChatEditorApplyInput,
  overrides: Partial<ChatEditorApplyDependencies> = {},
): Promise<ChatEditorApplyOutcome> {
  const invalidBlock = validateBlock(input);
  if (invalidBlock !== null) return invalidBlock;
  const invalidContext = validateContext(input.context);
  if (invalidContext !== null) return invalidContext;
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const selected = await fetchSelectedSession(input.context, dependencies);
  if (!selected.ok) return selected.outcome;
  const identity = actionIdentity(dependencies);
  if (!identity.ok) return identity.outcome;
  const prepared = await prepareSubmission(input, selected.value, dependencies);
  if (!prepared.ok) return prepared.outcome;
  let action: ChatOriginEditorAgentAction;
  try {
    action = buildAction(selected.value, prepared.value, identity.value);
  } catch {
    return rejected("QUEUE_FAILED", "The editor action could not be constructed.");
  }
  if (!isEditorAgentAction(action)) {
    return rejected("QUEUE_FAILED", "The editor action could not be constructed.");
  }
  return queueWithIdempotentReplay(action, dependencies);
}
