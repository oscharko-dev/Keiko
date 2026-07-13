import {
  DEFAULT_EDITOR_AGENT_SNAPSHOT_TEXT_MODE,
  EDITOR_AGENT_NAVIGATE_SYMBOL_OPERATIONS,
  EDITOR_AGENT_SCHEMA_VERSION,
  EDITOR_VERIFICATION_SCHEMA_VERSION,
  isEditorAgentAction,
  isVerificationKind,
  type EditorAgentAction,
  type EditorAgentActionQueuedResponse,
  type EditorAgentNavigateSymbolOperation,
  type EditorAgentSessionsResponse,
  type EditorAgentSearchWorkspaceMode,
  type EditorAgentGitAspect,
  type EditorAgentSnapshotResponse,
  type EditorAgentSnapshotTextMode,
  type EditorAgentVerificationResult,
  type EditorAgentVerificationRunRequest,
  type LanguageDiagnostic,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolPort,
  type VerificationKind,
} from "@oscharko-dev/keiko-contracts";
import { type EditorAgentClientError, EditorAgentHttpClient } from "./editor-agent-client.js";
import { EDITOR_AGENT_TOOL_DEFINITIONS } from "./editor-agent-schemas.js";

type AuthorityReference = NonNullable<EditorAgentAction["authorityRef"]>;
type ActionTarget = NonNullable<EditorAgentAction["target"]>;
type Selection = NonNullable<ActionTarget["selection"]>;
type Position = Selection["start"];
type DocumentVersion = NonNullable<EditorAgentAction["expectedDocumentVersion"]>;
type TextEdit = NonNullable<EditorAgentAction["textEdits"]>[number];
type Changeset = NonNullable<EditorAgentAction["changeset"]>;
type ChangesetFile = Changeset["files"][number];

export type EditorAgentToolOutput =
  | ({ readonly ok: true; readonly kind: "sessions" } & EditorAgentSessionsResponse)
  | ({ readonly ok: true; readonly kind: "snapshot" } & EditorAgentSnapshotResponse)
  | ({ readonly ok: true; readonly kind: "action-result" } & EditorAgentActionQueuedResponse)
  | {
      readonly ok: true;
      readonly kind: "verification";
      readonly result: EditorAgentVerificationResult;
    }
  | {
      readonly ok: false;
      readonly error:
        | EditorAgentClientError
        | {
            readonly kind: "invalid-arguments" | "host";
            readonly code: "INVALID_ARGUMENTS" | "HOST_FAILURE";
            readonly message: string;
          };
    };

class InvalidArgumentsError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function expectOnly(args: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(args).some((key) => !allowed.includes(key))) {
    throw new InvalidArgumentsError("Tool arguments contain unsupported properties.");
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidArgumentsError(`Missing required '${key}' argument.`);
  }
  return value;
}

function requireText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new InvalidArgumentsError(`Missing required '${key}' argument.`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidArgumentsError(`Argument '${key}' must be a non-empty string.`);
  }
  return value;
}

function requireVerificationKind(args: Record<string, unknown>, key: string): VerificationKind {
  const value = args[key];
  if (!isVerificationKind(value)) {
    throw new InvalidArgumentsError(`Argument '${key}' must be a supported verification kind.`);
  }
  return value;
}

function optionalPositiveInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new InvalidArgumentsError(`Argument '${key}' must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InvalidArgumentsError(`Argument '${key}' must be a non-negative integer.`);
  }
  return value;
}

function parsePosition(value: unknown): Position {
  if (!isRecord(value)) throw new InvalidArgumentsError("Selection position is required.");
  expectOnly(value, ["line", "character"]);
  return {
    line: nonNegativeInteger(value.line, "line"),
    character: nonNegativeInteger(value.character, "character"),
  };
}

function parseSelection(value: unknown): Selection {
  if (!isRecord(value)) throw new InvalidArgumentsError("Selection argument is required.");
  expectOnly(value, ["start", "end"]);
  return { start: parsePosition(value.start), end: parsePosition(value.end) };
}

function parseLanguageDiagnostic(value: unknown): LanguageDiagnostic {
  if (!isRecord(value)) throw new InvalidArgumentsError("Diagnostic must be an object.");
  expectOnly(value, ["range", "severity", "message", "source", "code"]);
  const severity = value.severity;
  if (
    severity !== "error" &&
    severity !== "warning" &&
    severity !== "info" &&
    severity !== "hint"
  ) {
    throw new InvalidArgumentsError("Diagnostic severity is invalid.");
  }
  return {
    range: parseSelection(value.range),
    severity,
    message: requireText(value, "message"),
    source: requireString(value, "source"),
    ...(value.code === undefined ? {} : { code: requireString(value, "code") }),
  };
}

function parseLanguageDiagnostics(value: unknown): readonly LanguageDiagnostic[] {
  if (!Array.isArray(value)) throw new InvalidArgumentsError("Diagnostics array is required.");
  return value.map(parseLanguageDiagnostic);
}

function parseDocumentVersion(value: unknown): DocumentVersion {
  if (!isRecord(value)) throw new InvalidArgumentsError("Document version must be an object.");
  expectOnly(value, ["sizeBytes", "modifiedAt", "contentHash"]);
  return {
    sizeBytes: nonNegativeInteger(value.sizeBytes, "sizeBytes"),
    modifiedAt: nonNegativeInteger(value.modifiedAt, "modifiedAt"),
    contentHash: requireString(value, "contentHash"),
  };
}

function optionalDocumentVersion(
  args: Record<string, unknown>,
  key: string,
): DocumentVersion | undefined {
  return args[key] === undefined ? undefined : parseDocumentVersion(args[key]);
}

function parseTextEdit(value: unknown): TextEdit {
  if (!isRecord(value)) throw new InvalidArgumentsError("Text edit must be an object.");
  expectOnly(value, ["range", "newText"]);
  return { range: parseSelection(value.range), newText: requireText(value, "newText") };
}

function parseTextEdits(value: unknown): readonly TextEdit[] {
  if (!isUnknownArray(value)) throw new InvalidArgumentsError("Text edits array is required.");
  return value.map(parseTextEdit);
}

function optionalStringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!isUnknownArray(value) || value.length === 0) {
    throw new InvalidArgumentsError("Selected files must be a non-empty string array.");
  }
  const strings = value.map((item) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new InvalidArgumentsError("Selected files must be a non-empty string array.");
    }
    return item;
  });
  if (new Set(strings).size !== strings.length) {
    throw new InvalidArgumentsError("Selected files must be unique.");
  }
  return strings;
}

function optionalSearchStringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!isUnknownArray(value)) {
    throw new InvalidArgumentsError("Search globs must be a string array.");
  }
  const strings = value.map((item) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new InvalidArgumentsError("Search globs must be a string array.");
    }
    return item;
  });
  if (strings.length > 32) {
    throw new InvalidArgumentsError("Search globs exceed their bound.");
  }
  return strings;
}

function parseChangesetFile(value: unknown): ChangesetFile {
  if (!isRecord(value)) throw new InvalidArgumentsError("Changeset file must be an object.");
  expectOnly(value, ["file", "expectedDocumentVersion", "expectedContentHash"]);
  const expectedDocumentVersion = optionalDocumentVersion(value, "expectedDocumentVersion");
  const expectedContentHash = optionalString(value, "expectedContentHash");
  if (expectedDocumentVersion === undefined && expectedContentHash === undefined) {
    throw new InvalidArgumentsError("Changeset file precondition is required.");
  }
  return {
    file: requireString(value, "file"),
    ...(expectedDocumentVersion === undefined ? {} : { expectedDocumentVersion }),
    ...(expectedContentHash === undefined ? {} : { expectedContentHash }),
  };
}

function parseChangesetFiles(value: unknown): readonly ChangesetFile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidArgumentsError("Changeset files array is required.");
  }
  return value.map(parseChangesetFile);
}

function snapshotTextMode(value: unknown): EditorAgentSnapshotTextMode {
  if (value === undefined) return DEFAULT_EDITOR_AGENT_SNAPSHOT_TEXT_MODE;
  if (value === "none" || value === "selection" || value === "activeFile") return value;
  throw new InvalidArgumentsError("Snapshot textMode is invalid.");
}

function validateAuthority(value: AuthorityReference): AuthorityReference {
  const authority = Object.freeze({ runId: value.runId, envelopeDigest: value.envelopeDigest });
  const action: EditorAgentAction = {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: "authority-validation",
    idempotencyKey: "authority-validation",
    sessionId: "authority-validation",
    type: "openFile",
    authorityRef: authority,
  };
  if (!isEditorAgentAction(action)) throw new Error("Editor agent authority reference is invalid.");
  return authority;
}

function generatedId(source: () => string, label: string): string {
  const value = source();
  if (value.length === 0) throw new Error(`Editor agent ${label} source returned an empty value.`);
  return value;
}

function invalidOutput(message: string): EditorAgentToolOutput {
  return {
    ok: false,
    error: { kind: "invalid-arguments", code: "INVALID_ARGUMENTS", message },
  };
}

interface ParsedNavigateSymbolArguments {
  readonly sessionId: string;
  readonly file: string;
  readonly request: NonNullable<EditorAgentAction["navigateSymbol"]>;
}

function navigateSymbolOperation(value: unknown): EditorAgentNavigateSymbolOperation {
  if (
    typeof value === "string" &&
    EDITOR_AGENT_NAVIGATE_SYMBOL_OPERATIONS.includes(value as EditorAgentNavigateSymbolOperation)
  ) {
    return value as EditorAgentNavigateSymbolOperation;
  }
  throw new InvalidArgumentsError("Symbol navigation operation is invalid.");
}

function validateNavigateSymbolExtras(
  operation: EditorAgentNavigateSymbolOperation,
  range: Selection | undefined,
  diagnostics: readonly LanguageDiagnostic[] | undefined,
): void {
  const hasExtras = range !== undefined || diagnostics !== undefined;
  switch (operation) {
    case "codeActions":
      if (range === undefined || diagnostics === undefined) {
        throw new InvalidArgumentsError("Code actions require range and diagnostics.");
      }
      return;
    case "inlayHints":
      if (range === undefined || diagnostics !== undefined) {
        throw new InvalidArgumentsError("Inlay hints require a range and no diagnostics.");
      }
      return;
    default:
      if (hasExtras) {
        throw new InvalidArgumentsError(
          "Range is only valid for code actions or inlay hints; diagnostics require code actions.",
        );
      }
  }
}

function parseNavigateSymbolArguments(
  args: Record<string, unknown>,
): ParsedNavigateSymbolArguments {
  expectOnly(args, [
    "sessionId",
    "idempotencyKey",
    "file",
    "operation",
    "position",
    "languageId",
    "text",
    "range",
    "diagnostics",
  ]);
  const operation = navigateSymbolOperation(args.operation);
  const file = requireString(args, "file");
  const position = parsePosition(args.position);
  const range = args.range === undefined ? undefined : parseSelection(args.range);
  const diagnostics =
    args.diagnostics === undefined ? undefined : parseLanguageDiagnostics(args.diagnostics);
  validateNavigateSymbolExtras(operation, range, diagnostics);
  const languageId = optionalString(args, "languageId") ?? "typescript";
  const text = args.text === undefined ? undefined : requireText(args, "text");
  return {
    sessionId: requireString(args, "sessionId"),
    file,
    request: {
      operation,
      document: { path: file, languageId, ...(text === undefined ? {} : { text }) },
      position,
      ...(range === undefined ? {} : { range }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
    },
  };
}

interface ParsedSearchWorkspaceArguments {
  readonly sessionId: string;
  readonly scopePath: string | undefined;
  readonly request: NonNullable<EditorAgentAction["searchWorkspace"]>;
}

function searchWorkspaceMode(value: unknown): EditorAgentSearchWorkspaceMode {
  if (value === "text" || value === "symbol") return value;
  throw new InvalidArgumentsError("Workspace search mode is invalid.");
}

function parseSearchWorkspaceArguments(
  args: Record<string, unknown>,
): ParsedSearchWorkspaceArguments {
  expectOnly(args, [
    "sessionId",
    "idempotencyKey",
    "query",
    "mode",
    "caseSensitive",
    "includeGlobs",
    "excludeGlobs",
    "maxResults",
    "scopePath",
  ]);
  if (args.caseSensitive !== undefined && typeof args.caseSensitive !== "boolean") {
    throw new InvalidArgumentsError("Argument 'caseSensitive' must be boolean.");
  }
  const includeGlobs = optionalSearchStringArray(args.includeGlobs);
  const excludeGlobs = optionalSearchStringArray(args.excludeGlobs);
  const maxResults = optionalPositiveInteger(args, "maxResults");
  const scopePath = optionalString(args, "scopePath");
  return {
    sessionId: requireString(args, "sessionId"),
    scopePath,
    request: {
      mode: searchWorkspaceMode(args.mode),
      query: requireString(args, "query"),
      ...(args.caseSensitive === undefined ? {} : { caseSensitive: args.caseSensitive }),
      ...(includeGlobs === undefined ? {} : { includeGlobs }),
      ...(excludeGlobs === undefined ? {} : { excludeGlobs }),
      ...(maxResults === undefined ? {} : { maxResults }),
      ...(scopePath === undefined ? {} : { scopePath }),
    },
  };
}

interface ParsedQueryGitArguments {
  readonly sessionId: string;
  readonly path: string;
  readonly request: NonNullable<EditorAgentAction["queryGit"]>;
}

function gitAspect(value: unknown): EditorAgentGitAspect {
  if (value === "status" || value === "diff" || value === "blame") return value;
  throw new InvalidArgumentsError("Git aspect is invalid.");
}

function parseGitAspects(value: unknown): readonly EditorAgentGitAspect[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidArgumentsError("Argument 'aspects' must be a non-empty array.");
  }
  const aspects = value.map(gitAspect);
  if (new Set(aspects).size !== aspects.length) {
    throw new InvalidArgumentsError("Argument 'aspects' must not contain duplicates.");
  }
  return aspects;
}

function parseQueryGitArguments(args: Record<string, unknown>): ParsedQueryGitArguments {
  expectOnly(args, ["sessionId", "idempotencyKey", "path", "aspects"]);
  const path = requireString(args, "path");
  return {
    sessionId: requireString(args, "sessionId"),
    path,
    request: {
      path,
      aspects: parseGitAspects(args.aspects),
    },
  };
}

export class EditorAgentToolHost implements ToolPort {
  private readonly client: EditorAgentHttpClient;
  private readonly authorityRef: AuthorityReference;
  private readonly nextActionId: () => string;
  private readonly now: () => number;

  constructor(deps: {
    readonly client: EditorAgentHttpClient;
    readonly authorityRef: AuthorityReference;
    readonly nextActionId: () => string;
    readonly now?: (() => number) | undefined;
  }) {
    this.client = deps.client;
    this.authorityRef = validateAuthority(deps.authorityRef);
    this.nextActionId = deps.nextActionId;
    this.now = deps.now ?? Date.now;
  }

  listTools(): typeof EDITOR_AGENT_TOOL_DEFINITIONS {
    return EDITOR_AGENT_TOOL_DEFINITIONS;
  }

  async execute(request: ToolCallRequest): Promise<ToolCallResult> {
    const startedAt = this.now();
    let output: EditorAgentToolOutput;
    try {
      output = await this.dispatch(request);
    } catch (cause) {
      output =
        cause instanceof InvalidArgumentsError
          ? invalidOutput(cause.message)
          : {
              ok: false,
              error: {
                kind: "host",
                code: "HOST_FAILURE",
                message: "The editor agent tool call could not be prepared.",
              },
            };
    }
    return {
      toolCallId: request.toolCallId,
      output: JSON.stringify(output),
      durationMs: Math.max(0, this.now() - startedAt),
    };
  }

  private dispatch(request: ToolCallRequest): Promise<EditorAgentToolOutput> {
    switch (request.toolName) {
      case "editor_list_sessions":
        return this.listSessions(request);
      case "editor_snapshot":
        return this.snapshot(request);
      case "editor_navigate":
        return this.navigate(request);
      case "editor_navigate_symbol":
        return this.navigateSymbol(request);
      case "editor_search_workspace":
        return this.searchWorkspace(request);
      case "editor_git_context":
        return this.queryGit(request);
      case "editor_propose_edit":
        return this.proposeEdit(request);
      case "editor_propose_changeset":
        return this.proposeChangeset(request);
      case "editor_request_verification":
        return this.requestVerification(request);
      default:
        throw new InvalidArgumentsError("Unknown editor agent tool.");
    }
  }

  // Issue #2214 — request a governed verification run. The tool host only validates and narrows the
  // arguments and attaches its constructor-validated authorityRef; the SERVER owns the classify →
  // compose → reserve → audit governance and the sandboxed execution, and returns a redacted result.
  private async requestVerification(request: ToolCallRequest): Promise<EditorAgentToolOutput> {
    const args = request.arguments;
    expectOnly(args, ["sessionId", "kind", "targetPath"]);
    const targetPath = optionalString(args, "targetPath");
    const kind = requireVerificationKind(args, "kind");
    if (kind === "targeted-test" && targetPath === undefined) {
      throw new InvalidArgumentsError("A targeted test requires 'targetPath'.");
    }
    if (kind !== "targeted-test" && targetPath !== undefined) {
      throw new InvalidArgumentsError("Only a targeted test may carry 'targetPath'.");
    }
    const body: EditorAgentVerificationRunRequest = {
      schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
      sessionId: requireString(args, "sessionId"),
      kind,
      ...(targetPath === undefined ? {} : { targetPath }),
      authorityRef: this.authorityRef,
    };
    const result = await this.client.requestVerification(body, request.signal);
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, kind: "verification", result: result.value };
  }

  private async listSessions(request: ToolCallRequest): Promise<EditorAgentToolOutput> {
    expectOnly(request.arguments, []);
    const result = await this.client.listSessions(request.signal);
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, kind: "sessions", sessions: result.value.sessions };
  }

  private async snapshot(request: ToolCallRequest): Promise<EditorAgentToolOutput> {
    const args = request.arguments;
    expectOnly(args, ["sessionId", "textMode", "maxBytes"]);
    const sessionId = optionalString(args, "sessionId");
    const maxBytes = optionalPositiveInteger(args, "maxBytes");
    const result = await this.client.snapshot(
      {
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        textMode: snapshotTextMode(args.textMode),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(maxBytes === undefined ? {} : { maxBytes }),
      },
      request.signal,
    );
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, kind: "snapshot", snapshot: result.value.snapshot };
  }

  private navigate(request: ToolCallRequest): Promise<EditorAgentToolOutput> {
    const args = request.arguments;
    const type = requireString(args, "type");
    const sessionId = requireString(args, "sessionId");
    let target: ActionTarget;
    if (type === "openFile" || type === "focusTab") {
      expectOnly(args, ["sessionId", "idempotencyKey", "type", "file", "paneId"]);
      const paneId = optionalString(args, "paneId");
      target = {
        file: requireString(args, "file"),
        ...(paneId === undefined ? {} : { paneId }),
      };
    } else if (type === "setSelection") {
      expectOnly(args, ["sessionId", "idempotencyKey", "type", "selection", "paneId"]);
      const paneId = optionalString(args, "paneId");
      target = {
        selection: parseSelection(args.selection),
        ...(paneId === undefined ? {} : { paneId }),
      };
    } else {
      throw new InvalidArgumentsError("Navigation type is invalid.");
    }
    return this.sendAction({ ...this.actionBase(args, sessionId, type), target }, request.signal);
  }

  private navigateSymbol(request: ToolCallRequest): Promise<EditorAgentToolOutput> {
    const args = request.arguments;
    const parsed = parseNavigateSymbolArguments(args);
    const action: EditorAgentAction = {
      ...this.actionBase(args, parsed.sessionId, "navigateSymbol"),
      type: "navigateSymbol",
      target: {
        file: parsed.file,
        selection: { start: parsed.request.position, end: parsed.request.position },
      },
      navigateSymbol: parsed.request,
    };
    return this.sendAction(action, request.signal);
  }

  private searchWorkspace(request: ToolCallRequest): Promise<EditorAgentToolOutput> {
    const args = request.arguments;
    const parsed = parseSearchWorkspaceArguments(args);
    const action: EditorAgentAction = {
      ...this.actionBase(args, parsed.sessionId, "searchWorkspace"),
      type: "searchWorkspace",
      ...(parsed.scopePath === undefined ? {} : { target: { file: parsed.scopePath } }),
      searchWorkspace: parsed.request,
    };
    return this.sendAction(action, request.signal);
  }

  private queryGit(request: ToolCallRequest): Promise<EditorAgentToolOutput> {
    const args = request.arguments;
    const parsed = parseQueryGitArguments(args);
    const action: EditorAgentAction = {
      ...this.actionBase(args, parsed.sessionId, "queryGit"),
      type: "queryGit",
      target: { file: parsed.path },
      queryGit: parsed.request,
    };
    return this.sendAction(action, request.signal);
  }

  private proposeEdit(request: ToolCallRequest): Promise<EditorAgentToolOutput> {
    const args = request.arguments;
    const type = requireString(args, "type");
    if (type === "applyTextEdits") {
      expectOnly(args, [
        "sessionId",
        "idempotencyKey",
        "type",
        "file",
        "expectedDocumentVersion",
        "expectedContentHash",
        "textEdits",
      ]);
      return this.sendAction(
        { ...this.editBase(args, type), type, textEdits: parseTextEdits(args.textEdits) },
        request.signal,
      );
    }
    if (type === "applyPatch") {
      expectOnly(args, [
        "sessionId",
        "idempotencyKey",
        "type",
        "file",
        "expectedDocumentVersion",
        "expectedContentHash",
        "patch",
      ]);
      return this.sendAction(
        { ...this.editBase(args, type), type, patch: requireText(args, "patch") },
        request.signal,
      );
    }
    throw new InvalidArgumentsError("Edit proposal type is invalid.");
  }

  private proposeChangeset(request: ToolCallRequest): Promise<EditorAgentToolOutput> {
    const args = request.arguments;
    expectOnly(args, ["sessionId", "idempotencyKey", "patch", "files", "selectedFiles"]);
    const selectedFiles = optionalStringArray(args.selectedFiles);
    const changeset: Changeset = {
      patch: requireString(args, "patch"),
      files: parseChangesetFiles(args.files),
      ...(selectedFiles === undefined ? {} : { selectedFiles }),
    };
    const action: EditorAgentAction = {
      ...this.actionBase(args, requireString(args, "sessionId"), "applyChangeset"),
      type: "applyChangeset",
      changeset,
    };
    return this.sendAction(action, request.signal);
  }

  private editBase(
    args: Record<string, unknown>,
    type: "applyTextEdits" | "applyPatch",
  ): EditorAgentAction {
    const expectedDocumentVersion = optionalDocumentVersion(args, "expectedDocumentVersion");
    const expectedContentHash = optionalString(args, "expectedContentHash");
    return {
      ...this.actionBase(args, requireString(args, "sessionId"), type),
      target: { file: requireString(args, "file") },
      ...(expectedDocumentVersion === undefined ? {} : { expectedDocumentVersion }),
      ...(expectedContentHash === undefined ? {} : { expectedContentHash }),
    };
  }

  private actionBase(
    args: Record<string, unknown>,
    sessionId: string,
    type: EditorAgentAction["type"],
  ): EditorAgentAction {
    const idempotencyKey = requireString(args, "idempotencyKey");
    return {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      actionId: generatedId(this.nextActionId, "action id"),
      idempotencyKey,
      sessionId,
      type,
      authorityRef: this.authorityRef,
    };
  }

  private async sendAction(
    action: EditorAgentAction,
    signal: AbortSignal,
  ): Promise<EditorAgentToolOutput> {
    const result = await this.client.action(action, signal);
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, kind: "action-result", result: result.value.result };
  }
}
