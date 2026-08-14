import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_LSP_PROCESS_CONFIG,
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  LANGUAGE_RENAME_CHANGESET_SCHEMA_VERSION,
  MANAGED_LSP_LANGUAGES,
  isManagedLspOperationNegotiated,
  type LanguageCodeAction,
  type LanguageCallHierarchyIncomingCall,
  type LanguageCallHierarchyItem,
  type LanguageCallHierarchyOutgoingCall,
  type LanguageCallHierarchyRoot,
  type LanguageCompletionItem,
  type LanguageCompletionItemKind,
  type LanguageDiagnostic,
  type LanguageDiagnosticSeverity,
  type LanguageDocumentSymbol,
  type LanguageHoverResult,
  type LanguageInlayHint,
  type LanguageLocation,
  type LanguagePosition,
  type LanguageRange,
  type LanguageRenameApplyResult,
  type LanguageRenamePrepareResult,
  type LanguageSignatureInformation,
  type LanguageSignatureParameterInformation,
  type LanguageServiceLimits,
  type LanguageServiceRequest,
  type LanguageSymbolKind,
  type LanguageTextEdit,
  type LspProcessConfig,
  type ManagedLspLanguage,
  type ManagedLspProcessHealthSnapshot,
  type ManagedLspSemanticTokenData,
  type ManagedLspSemanticTokenLegend,
} from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type { CommandRule } from "@oscharko-dev/keiko-tools";
import { isWithinWorkspace } from "@oscharko-dev/keiko-workspace";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { LanguageServiceOutcome } from "../languageService.js";
import {
  sanitizeCompletion,
  sanitizeCodeActions,
  sanitizeCallHierarchy,
  sanitizeDefinition,
  sanitizeDiagnostics,
  sanitizeFormatting,
  sanitizeHover,
  sanitizeInlayHints,
  sanitizeReferences,
  sanitizeRenameApply,
  sanitizeRenamePrepare,
  sanitizeSignatureHelp,
  sanitizeSymbols,
} from "../languageSanitize.js";
import {
  createLspProcessManager,
  type LspProcessManager,
  type LspProcessManagerDeps,
  type LspProcessProtocolConfig,
  type LspRuntimeResourceBudget,
} from "./lspProcessManager.js";
import { LspProcessError, type LspSpawnFn } from "./lspNodeAdapter.js";
import {
  detectHostLanguageProviderDescriptors,
  HOST_LANGUAGE_PROVIDER_SPECS,
  isHostLanguageProviderProvisioned,
  type HostLanguageProviderSpec,
} from "./hostLanguageProviders.js";
import { sanitizeSemanticTokenResponse } from "./lspSemanticTokens.js";

export interface HostLanguageOperationOptions {
  readonly workspace: WorkspaceInfo;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly commandRules: readonly CommandRule[];
  readonly overlayAbsolutePath: string;
  readonly signal: AbortSignal;
  readonly limits?: LanguageServiceLimits | undefined;
  /** Test-only timeout/resource seam; production keeps DEFAULT_LSP_PROCESS_CONFIG. */
  readonly lspProcessConfig?:
    Partial<Omit<LspProcessConfig, "managerId" | "executableName">> | undefined;
  readonly now?: (() => number) | undefined;
  readonly spawn?: LspSpawnFn | undefined;
  /** Test seam paired with the injected spawn; production callers leave this undefined. */
  readonly prepareSpawn?: LspProcessManagerDeps["prepareSpawn"] | undefined;
  readonly privateRuntimeStateRoot?: string | undefined;
  readonly activationAuthorized?: boolean | undefined;
  /** Server-owned final trust recheck immediately before a managed pool entry can be acquired. */
  readonly activationStillAuthorized?: (() => boolean) | undefined;
  readonly protocolConfiguration?:
    | {
        readonly revision: number;
        readonly settings: Readonly<Record<string, unknown>>;
        readonly initializationOptions?: Readonly<Record<string, unknown>> | undefined;
        readonly resourceBudget?:
          | {
              readonly maxFiles: number;
              readonly maxBytes: number;
              readonly maxMemoryMb?: number | undefined;
              readonly indexDeadlineMs?: number | undefined;
            }
          | undefined;
      }
    | undefined;
}

export interface HostSemanticTokenDocument {
  readonly path: string;
  readonly languageId: string;
  readonly text: string;
  readonly version: number;
}

export interface HostSemanticTokenResult {
  readonly legend: ManagedLspSemanticTokenLegend;
  readonly data: ManagedLspSemanticTokenData;
}

// GEN-PERF-EDITOR-007: the host LSP path used to (a) gate ALL host-LSP work behind a single
// process-wide slot so a second concurrent op returned TIMED_OUT "busy", and (b) spawn a
// fresh LSP child, run one op, then kill it — per request. Both are replaced here by a
// module-level pool of WARM LSP processes keyed by (workspace root, languageId): a process is
// spawned once, reused across ops via didChange overlay updates, serialized per-manager (a
// queue) so concurrent ops queue instead of failing busy, and shut down after an idle window.
// Spawn-per-request survives only as the degraded fallback when a warm process cannot be
// obtained. Governance (commandRules preflight, root containment, availability detection) is
// unchanged and still runs before any pooling decision.
const LSP_POOL_IDLE_TIMEOUT_MS = 60_000;

interface LspOperationContext {
  readonly spec: HostLanguageProviderSpec;
  readonly manager: LspProcessManager;
  readonly request: LanguageServiceRequest;
  readonly workspaceRoot: string;
  readonly uri: string;
  readonly signal: AbortSignal;
  readonly limits: LanguageServiceLimits;
  // Documents already opened on this (reused) manager: the first op for a URI sends didOpen,
  // later ops send didChange with a bumped version so a warm server keeps a coherent view.
  readonly openDocuments: Map<string, OpenDocumentState>;
}

interface OpenDocumentState {
  readonly childGeneration: number;
  readonly version: number;
  readonly text: string;
}

interface PooledLspEntry {
  readonly manager: LspProcessManager;
  readonly spawn: LspSpawnFn | undefined;
  readonly openDocuments: Map<string, OpenDocumentState>;
  readonly configurationRevision: number;
  // Per-manager serialization: each op chains onto this promise so concurrent ops queue on the
  // one warm process rather than racing its single stdio channel.
  queue: Promise<unknown>;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  disposed: boolean;
}

const LSP_PROCESS_POOL = new Map<string, PooledLspEntry>();

function poolKey(root: string, languageId: string): string {
  return `${root}\0${languageId}`;
}

function sameSpawn(a: LspSpawnFn | undefined, b: LspSpawnFn | undefined): boolean {
  // Prod always uses the default spawn (undefined). Tests inject a spawn fn; a different fn
  // reference must not silently reuse a process wired to the old one — evict and re-pool.
  return a === b;
}

function clearIdleTimer(entry: PooledLspEntry): void {
  if (entry.idleTimer !== undefined) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
}

function scheduleIdleShutdown(key: string, entry: PooledLspEntry): void {
  clearIdleTimer(entry);
  entry.idleTimer = setTimeout(() => {
    void evictPooledEntry(key, entry);
  }, LSP_POOL_IDLE_TIMEOUT_MS);
  // Do not keep the event loop alive purely for an idle LSP process.
  entry.idleTimer.unref();
}

async function evictPooledEntry(key: string, entry: PooledLspEntry): Promise<void> {
  if (entry.disposed) return;
  entry.disposed = true;
  clearIdleTimer(entry);
  if (LSP_PROCESS_POOL.get(key) === entry) {
    LSP_PROCESS_POOL.delete(key);
  }
  closeOpenDocuments(entry);
  try {
    await entry.manager.dispose();
  } catch {
    // Best-effort shutdown; a manager that fails to dispose is already being discarded.
  }
}

function closeOpenDocuments(entry: PooledLspEntry): void {
  const childGeneration = entry.manager.getChildGeneration();
  for (const [uri, document] of entry.openDocuments) {
    if (document.childGeneration === childGeneration) {
      entry.manager.sendNotification("textDocument/didClose", { textDocument: { uri } });
    }
  }
  entry.openDocuments.clear();
}

// Test/shutdown hook: dispose every pooled LSP process. Exposed so tests can guarantee a
// clean slate and a server shutdown can release warm children without touching DI wiring.
export async function shutdownHostLspPool(): Promise<void> {
  const entries = [...LSP_PROCESS_POOL.entries()];
  LSP_PROCESS_POOL.clear();
  await Promise.all(entries.map(async ([, entry]) => evictPooledEntry("", entry)));
}

export function listHostLspHealthSnapshots(): readonly ManagedLspProcessHealthSnapshot[] {
  return [...LSP_PROCESS_POOL.values()].flatMap((entry) => {
    const snapshot = entry.manager.getHealthSnapshot();
    return snapshot === undefined ? [] : [snapshot];
  });
}

export function listHostLspHealthSnapshotsForRoot(
  workspaceRoot: string,
): readonly ManagedLspProcessHealthSnapshot[] {
  const prefix = `${workspaceRoot}\0`;
  return [...LSP_PROCESS_POOL.entries()].flatMap(([key, entry]) => {
    if (!key.startsWith(prefix)) return [];
    const snapshot = entry.manager.getHealthSnapshot();
    return snapshot === undefined ? [] : [snapshot];
  });
}

// Path-segment-safe "candidate is deletedPath itself, or nested under it" check. A raw string
// prefix (`candidate.startsWith(deletedPath)`) would wrongly match "/root/pkg-sibling/x" against
// deleted directory "/root/pkg"; `relative` compares whole path segments instead.
function isUnderOrEqual(deletedPath: string, candidate: string): boolean {
  const rel = relative(deletedPath, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// A Deleted watched-file event (file OR directory) must stop the pool from treating the removed
// path's overlay(s) as still open BEFORE the watched-file notification is published — otherwise
// the next op for that URI reaches syncDocument with the entry still present and sends
// textDocument/didChange instead of didOpen, so diagnostics/symbols keep serving the deleted (or,
// for a rename, renamed-away) path's stale content until the pooled process is next idle-evicted.
// Mirrors the didClose/removal seam closeOpenDocuments already uses on full eviction, scoped to
// exactly the deleted URI plus, for a directory delete, every overlay nested under it.
function closeDeletedOverlayDocuments(entry: PooledLspEntry, deletedAbsolutePath: string): void {
  const childGeneration = entry.manager.getChildGeneration();
  for (const [uri, document] of entry.openDocuments) {
    let absolutePath: string;
    try {
      absolutePath = fileURLToPath(uri);
    } catch {
      continue;
    }
    if (!isUnderOrEqual(deletedAbsolutePath, absolutePath)) continue;
    if (document.childGeneration === childGeneration) {
      entry.manager.sendNotification("textDocument/didClose", { textDocument: { uri } });
    }
    entry.openDocuments.delete(uri);
  }
}

// FileChangeType per the LSP spec: Created=1, Changed=2, Deleted=3. Defaults to Changed so the
// existing content-save call site (files.ts writeFilesContentRoute) needs no change.
export function notifyHostLspWorkspaceFileChanged(
  workspaceRoot: string,
  absolutePath: string,
  changeType: 1 | 2 | 3 = 2,
): void {
  if (!isWithinWorkspace(workspaceRoot, absolutePath)) return;
  const prefix = `${workspaceRoot}\0`;
  const params = { changes: [{ uri: pathToFileURL(absolutePath).href, type: changeType }] };
  for (const [key, entry] of LSP_PROCESS_POOL) {
    if (!key.startsWith(prefix) || entry.disposed) continue;
    if (changeType === 3) closeDeletedOverlayDocuments(entry, absolutePath);
    entry.manager.sendNotification("workspace/didChangeWatchedFiles", params);
  }
}

// Activation/configuration changes invalidate exactly one governed process. Removing the entry from
// the map before awaiting disposal guarantees subsequent work cannot reuse stale configuration even
// when the child needs forceful shutdown; unrelated workspace/language entries remain warm.
export async function disposeHostLspPoolEntry(
  workspaceRoot: string,
  languageId: string,
): Promise<void> {
  const spec = findSpec(languageId);
  const key = poolKey(workspaceRoot, spec === undefined ? languageId : poolLanguageAxis(spec));
  const entry = LSP_PROCESS_POOL.get(key);
  if (entry === undefined) return;
  LSP_PROCESS_POOL.delete(key);
  await evictPooledEntry(key, entry);
}

function successBody(
  request: LanguageServiceRequest,
  result: Exclude<LanguageServiceOutcome, { kind: "error" }>["result"],
): LanguageServiceOutcome {
  return { kind: request.operation, result } as Exclude<LanguageServiceOutcome, { kind: "error" }>;
}

function errorOutcome(
  code: Extract<LanguageServiceOutcome, { kind: "error" }>["code"],
  message: string,
): LanguageServiceOutcome {
  return { kind: "error", code, message };
}

function findSpec(languageId: string): HostLanguageProviderSpec | undefined {
  return HOST_LANGUAGE_PROVIDER_SPECS.find((spec) => spec.languages.includes(languageId));
}

function makeConfig(
  spec: HostLanguageProviderSpec,
  resourceBudget: LspRuntimeResourceBudget | undefined,
  overrides: Partial<Omit<LspProcessConfig, "managerId" | "executableName">> | undefined,
): LspProcessConfig {
  return {
    ...DEFAULT_LSP_PROCESS_CONFIG,
    ...overrides,
    managerId: spec.id,
    executableName: spec.executableName,
    executableArgs: spec.executableArgs,
    envAllowlist: spec.envAllowlist,
    ...(spec.networkPolicy === undefined ? {} : { networkPolicy: spec.networkPolicy }),
    ...(resourceBudget?.indexDeadlineMs === undefined
      ? {}
      : { initializeTimeoutMs: resourceBudget.indexDeadlineMs }),
  };
}

function matchingAvailableProvider(
  spec: HostLanguageProviderSpec,
  options: HostLanguageOperationOptions,
): boolean {
  if (options.activationAuthorized === true) {
    if (options.activationStillAuthorized?.() !== true) return false;
    return isHostLanguageProviderProvisioned(spec.languages[0] ?? "", {
      workspace: options.workspace,
      processEnv: options.processEnv,
      commandRules: options.commandRules,
    });
  }
  const [descriptor] = detectHostLanguageProviderDescriptors({
    workspace: options.workspace,
    processEnv: options.processEnv,
    commandRules: options.commandRules,
    specs: [spec],
  });
  return descriptor?.availability === "available";
}

function mapProcessError(error: unknown): LanguageServiceOutcome {
  if (error instanceof LspProcessError) {
    if (error.code === "CANCELLED") {
      return errorOutcome("CANCELLED", "The request was cancelled.");
    }
    return errorOutcome(
      "TIMED_OUT",
      "The language provider did not complete within the time budget.",
    );
  }
  return errorOutcome(
    "TIMED_OUT",
    "The language provider did not complete within the time budget.",
  );
}

// Send the overlay to the server: didOpen the FIRST time this URI is seen on the manager,
// didChange (with a bumped version) on every reuse. A warm pooled process therefore tracks
// the live buffer across ops exactly as the LSP protocol intends, instead of the old
// didOpen→…→didClose churn that discarded server-side document state each request.
function syncDocument(ctx: LspOperationContext): void {
  const childGeneration = ctx.manager.getChildGeneration();
  const prior = ctx.openDocuments.get(ctx.uri);
  if (prior?.childGeneration !== childGeneration) {
    ctx.openDocuments.set(ctx.uri, {
      childGeneration,
      version: 1,
      text: ctx.request.document.text,
    });
    ctx.manager.sendNotification("textDocument/didOpen", didOpenParams(ctx));
    return;
  }
  const next = {
    childGeneration,
    version: prior.version + 1,
    text: ctx.request.document.text,
  };
  ctx.openDocuments.set(ctx.uri, next);
  ctx.manager.sendNotification("textDocument/didChange", didChangeParams(ctx, prior, next.version));
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new LspProcessError("CANCELLED"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new LspProcessError("CANCELLED"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForReady(
  manager: LspProcessManager,
  initializeTimeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + initializeTimeoutMs;
  while (Date.now() <= deadline) {
    const status = manager.getLspProcessStatus();
    if (status === "READY") return true;
    if (
      status === "EXECUTABLE_NOT_FOUND" ||
      status === "SPAWN_FAILED" ||
      status === "INITIALIZE_TIMEOUT" ||
      status === "RESTART_THROTTLED" ||
      status === "CRASHED"
    ) {
      return false;
    }
    await delay(20, signal);
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is LanguagePosition {
  if (!isRecord(value)) return false;
  return Number.isInteger(value.line) && Number.isInteger(value.character);
}

function isRange(value: unknown): value is LanguageRange {
  if (!isRecord(value)) return false;
  return isPosition(value.start) && isPosition(value.end);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const COMPLETION_KIND_BY_LSP: Readonly<Record<number, LanguageCompletionItemKind>> = {
  1: "text",
  2: "method",
  3: "function",
  4: "constructor",
  5: "field",
  6: "variable",
  7: "class",
  8: "interface",
  9: "module",
  10: "property",
  12: "value",
  13: "enum",
  14: "keyword",
  15: "snippet",
  21: "constant",
  22: "struct",
  25: "typeParameter",
};

const SYMBOL_KIND_BY_LSP: Readonly<Record<number, LanguageSymbolKind>> = {
  1: "file",
  2: "module",
  3: "namespace",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  23: "struct",
  22: "enumMember",
  26: "typeParameter",
};

function diagnosticSeverity(value: unknown): LanguageDiagnosticSeverity {
  if (value === 1) return "error";
  if (value === 2) return "warning";
  if (value === 4) return "hint";
  return "info";
}

function diagnosticCode(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function mapDiagnostic(value: unknown, source: string): LanguageDiagnostic | undefined {
  if (!isRecord(value) || !isRange(value.range) || typeof value.message !== "string") {
    return undefined;
  }
  const code = diagnosticCode(value.code);
  return {
    range: value.range,
    severity: diagnosticSeverity(value.severity),
    message: value.message,
    source: stringValue(value.source) ?? source,
    ...(code !== undefined ? { code } : {}),
  };
}

function diagnosticsFromList(value: unknown, source: string): readonly LanguageDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const diagnostic = mapDiagnostic(entry, source);
    return diagnostic === undefined ? [] : [diagnostic];
  });
}

function diagnosticsFromPullReport(value: unknown, source: string): readonly LanguageDiagnostic[] {
  if (!isRecord(value)) return [];
  const direct = diagnosticsFromList(value.items, source);
  if (direct.length > 0) return direct;
  if (!Array.isArray(value.items)) return [];
  return value.items.flatMap((item) =>
    isRecord(item) ? diagnosticsFromList(item.items, source) : [],
  );
}

function completionDocumentation(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.value === "string") return value.value;
  return undefined;
}

function completionItems(value: unknown): { items: readonly unknown[]; isIncomplete: boolean } {
  if (Array.isArray(value)) return { items: value, isIncomplete: false };
  if (isRecord(value) && Array.isArray(value.items)) {
    return { items: value.items, isIncomplete: value.isIncomplete === true };
  }
  return { items: [], isIncomplete: false };
}

function completionKind(value: unknown): LanguageCompletionItemKind {
  return typeof value === "number" ? (COMPLETION_KIND_BY_LSP[value] ?? "text") : "text";
}

function completionInsertText(value: Record<string, unknown>): string | undefined {
  const textEdit = isRecord(value.textEdit) ? stringValue(value.textEdit.newText) : undefined;
  return stringValue(value.insertText) ?? textEdit;
}

function mapCompletionItem(value: unknown): LanguageCompletionItem | undefined {
  if (!isRecord(value) || typeof value.label !== "string") return undefined;
  const insertText = completionInsertText(value);
  const detail = stringValue(value.detail);
  const documentation = completionDocumentation(value.documentation);
  const sortText = stringValue(value.sortText);
  return {
    label: value.label,
    kind: completionKind(value.kind),
    ...(detail !== undefined ? { detail } : {}),
    ...(documentation !== undefined ? { documentation } : {}),
    ...(insertText !== undefined ? { insertText } : {}),
    ...(sortText !== undefined ? { sortText } : {}),
  };
}

function hoverContents(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(hoverContents).filter(Boolean).join("\n\n") || null;
  if (isRecord(value) && typeof value.value === "string") return value.value;
  return null;
}

function mapHover(value: unknown): LanguageHoverResult {
  if (!isRecord(value)) return { contents: null };
  return {
    contents: hoverContents(value.contents),
    ...(isRange(value.range) ? { range: value.range } : {}),
  };
}

function symbolKind(value: unknown): LanguageSymbolKind {
  return typeof value === "number" ? (SYMBOL_KIND_BY_LSP[value] ?? "variable") : "variable";
}

function mapDocumentSymbol(
  value: unknown,
  containerName?: string,
): readonly LanguageDocumentSymbol[] {
  if (!isRecord(value) || typeof value.name !== "string") return [];
  if (!isRange(value.range)) return [];
  const name = value.name;
  const detail = stringValue(value.detail);
  const current: LanguageDocumentSymbol = {
    name,
    kind: symbolKind(value.kind),
    range: value.range,
    ...(detail !== undefined ? { detail } : {}),
    ...(containerName !== undefined ? { containerName } : {}),
  };
  const children = Array.isArray(value.children)
    ? value.children.flatMap((child) => mapDocumentSymbol(child, name))
    : [];
  return [current, ...children];
}

function mapSymbolInformation(value: unknown): readonly LanguageDocumentSymbol[] {
  if (!isRecord(value) || typeof value.name !== "string" || !isRecord(value.location)) return [];
  const range = isRange(value.location.range) ? value.location.range : undefined;
  if (range === undefined) return [];
  const containerName = stringValue(value.containerName);
  return [
    {
      name: value.name,
      kind: symbolKind(value.kind),
      range,
      ...(containerName !== undefined ? { containerName } : {}),
    },
  ];
}

function symbolsFromResult(value: unknown): readonly LanguageDocumentSymbol[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const documentSymbols = mapDocumentSymbol(entry);
    return documentSymbols.length > 0 ? documentSymbols : mapSymbolInformation(entry);
  });
}

function textEditsFromResult(value: unknown): readonly LanguageTextEdit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || !isRange(entry.range) || typeof entry.newText !== "string") return [];
    return [{ range: entry.range, newText: entry.newText }];
  });
}

function normalizeSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

function relativePathFromUri(workspaceRoot: string, uri: unknown): string | undefined {
  if (typeof uri !== "string") return undefined;
  try {
    const absolutePath = fileURLToPath(uri);
    if (!isWithinWorkspace(workspaceRoot, absolutePath)) return undefined;
    return normalizeSlashes(relative(workspaceRoot, absolutePath));
  } catch {
    return undefined;
  }
}

function locationFromResult(
  ctx: LspOperationContext,
  value: unknown,
): LanguageLocation | undefined {
  if (!isRecord(value)) return undefined;
  const path = relativePathFromUri(ctx.workspaceRoot, value.uri ?? value.targetUri);
  const rangeValue = value.range ?? value.targetSelectionRange ?? value.targetRange;
  if (path === undefined || !isRange(rangeValue)) return undefined;
  return { path, range: rangeValue };
}

function locationsFromResult(
  ctx: LspOperationContext,
  value: unknown,
): readonly LanguageLocation[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => {
    const location = locationFromResult(ctx, entry);
    return location === undefined ? [] : [location];
  });
}

function codeActionKind(value: unknown): LanguageCodeAction["kind"] {
  if (typeof value !== "string") return "quickfix";
  if (value.startsWith("refactor")) return "refactor";
  if (value.startsWith("source")) return "source";
  return "quickfix";
}

function overlayEditsFromWorkspaceEdit(
  ctx: LspOperationContext,
  edit: unknown,
): readonly LanguageTextEdit[] | null {
  if (!isRecord(edit)) return null;
  const edits = isRecord(edit.changes) ? edit.changes[ctx.uri] : undefined;
  if (Array.isArray(edits)) return textEditsFromResult(edits);
  if (!Array.isArray(edit.documentChanges)) return null;
  const overlay = edit.documentChanges
    .filter(isTextDocumentEdit)
    .find((change) => change.textDocument.uri === ctx.uri);
  return overlay === undefined ? null : textEditsFromResult(overlay.edits);
}

function codeActionsFromResult(
  ctx: LspOperationContext,
  value: unknown,
): readonly LanguageCodeAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): readonly LanguageCodeAction[] => {
    if (!isRecord(entry) || typeof entry.title !== "string") return [];
    return [
      {
        title: entry.title,
        kind: codeActionKind(entry.kind),
        edits: overlayEditsFromWorkspaceEdit(ctx, entry.edit),
      },
    ];
  });
}

interface LspTextDocumentEdit {
  readonly textDocument: Record<string, unknown>;
  readonly edits: readonly unknown[];
}

function isTextDocumentEdit(value: unknown): value is LspTextDocumentEdit {
  return isRecord(value) && isRecord(value.textDocument) && Array.isArray(value.edits);
}

function workspaceEditCounts(
  ctx: LspOperationContext,
  edit: unknown,
): {
  readonly totalFileCount: number;
  readonly totalEditCount: number;
  readonly overlayEdits: readonly LanguageTextEdit[];
} {
  if (!isRecord(edit)) return { totalFileCount: 0, totalEditCount: 0, overlayEdits: [] };
  if (isRecord(edit.changes)) {
    const entries = Object.entries(edit.changes).filter(([, edits]) => Array.isArray(edits));
    const overlayEdits = textEditsFromResult(edit.changes[ctx.uri]);
    const totalEditCount = entries.reduce((sum, [, edits]) => sum + (edits as unknown[]).length, 0);
    return { totalFileCount: entries.length, totalEditCount, overlayEdits };
  }
  if (!Array.isArray(edit.documentChanges))
    return { totalFileCount: 0, totalEditCount: 0, overlayEdits: [] };
  const textEdits = edit.documentChanges.filter(isTextDocumentEdit);
  const overlay = textEdits.find((change) => change.textDocument.uri === ctx.uri);
  return {
    totalFileCount: textEdits.length,
    totalEditCount: textEdits.reduce((sum, change) => sum + (change.edits as unknown[]).length, 0),
    overlayEdits: isRecord(overlay) ? textEditsFromResult(overlay.edits) : [],
  };
}

function renamePrepareFromResult(value: unknown): LanguageRenamePrepareResult {
  if (isRange(value)) return { range: value, placeholder: "" };
  if (isRecord(value) && isRange(value.range)) {
    return { range: value.range, placeholder: stringValue(value.placeholder) ?? "" };
  }
  return { range: null, reason: "No renameable symbol is available at this position." };
}

function renameChangesetFromResult(
  ctx: LspOperationContext,
  value: unknown,
): LanguageRenameApplyResult {
  const counts = workspaceEditCounts(ctx, value);
  const files =
    counts.overlayEdits.length === 0
      ? []
      : [
          {
            path: normalizeSlashes(relative(ctx.workspaceRoot, fileURLToPath(ctx.uri))),
            edits: counts.overlayEdits,
            expectedContentHash: sha256Hex(ctx.request.document.text),
          },
        ];
  return {
    schemaVersion: LANGUAGE_RENAME_CHANGESET_SCHEMA_VERSION,
    files,
    truncated: counts.overlayEdits.length < counts.totalEditCount,
    filesTruncated: files.length < counts.totalFileCount,
    returnedFileCount: files.length,
    totalFileCount: counts.totalFileCount,
    returnedEditCount: counts.overlayEdits.length,
    totalEditCount: counts.totalEditCount,
    // An LSP workspace edit carries the edits themselves, so nothing is dropped for being
    // unreadable: every non-overlay document is dropped by this bridge's overlay-only scope, which
    // `filesTruncated`/`totalFileCount` already report.
    unreadableFileCount: 0,
  };
}

function signatureParameter(value: unknown): LanguageSignatureParameterInformation | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.label === "string") return { label: value.label };
  if (Array.isArray(value.label)) return { label: value.label.join(",") };
  return undefined;
}

function signatureInformation(value: unknown): LanguageSignatureInformation | undefined {
  if (!isRecord(value) || typeof value.label !== "string") return undefined;
  const parameters = Array.isArray(value.parameters)
    ? value.parameters.flatMap((entry) => {
        const parameter = signatureParameter(entry);
        return parameter === undefined ? [] : [parameter];
      })
    : [];
  const documentation = completionDocumentation(value.documentation);
  return {
    label: value.label,
    ...(documentation !== undefined ? { documentation } : {}),
    parameters,
  };
}

function numericIndex(value: unknown): number | null {
  return Number.isInteger(value) ? (value as number) : null;
}

function textDocumentParams(ctx: LspOperationContext): Record<string, unknown> {
  return { textDocument: { uri: ctx.uri } };
}

async function runDiagnostics(ctx: LspOperationContext): Promise<LanguageServiceOutcome> {
  let published: readonly LanguageDiagnostic[] = [];
  let resolvePublished = (): void => undefined;
  const publishedReady = new Promise<void>((resolve) => {
    resolvePublished = resolve;
  });
  const unsubscribe = ctx.manager.onNotification((method, params) => {
    if (method !== "textDocument/publishDiagnostics" || !isRecord(params)) return;
    if (params.uri !== ctx.uri) return;
    published = diagnosticsFromList(params.diagnostics, ctx.spec.id);
    resolvePublished();
  });
  syncDocument(ctx);
  let pulled: readonly LanguageDiagnostic[] = [];
  try {
    const result = await ctx.manager.sendRequest<unknown>(
      "textDocument/diagnostic",
      textDocumentParams(ctx),
      ctx.signal,
    );
    pulled = diagnosticsFromPullReport(result, ctx.spec.id);
  } catch {
    await Promise.race([publishedReady, delay(1_000, ctx.signal)]);
  } finally {
    unsubscribe();
  }
  const diagnostics = pulled.length > 0 ? pulled : published;
  return successBody(
    ctx.request,
    sanitizeDiagnostics({ diagnostics, truncated: false }, ctx.limits),
  );
}

async function runCompletion(ctx: LspOperationContext): Promise<LanguageServiceOutcome> {
  const request = ctx.request as Extract<LanguageServiceRequest, { operation: "completion" }>;
  syncDocument(ctx);
  const result = await ctx.manager.sendRequest<unknown>(
    "textDocument/completion",
    { ...textDocumentParams(ctx), position: request.position, context: { triggerKind: 1 } },
    ctx.signal,
  );
  const completion = completionItems(result);
  return successBody(
    ctx.request,
    sanitizeCompletion(
      {
        items: completion.items.flatMap((entry) => {
          const item = mapCompletionItem(entry);
          return item === undefined ? [] : [item];
        }),
        isIncomplete: completion.isIncomplete,
        truncated: false,
      },
      ctx.limits,
    ),
  );
}

async function runHover(ctx: LspOperationContext): Promise<LanguageServiceOutcome> {
  const request = ctx.request as Extract<LanguageServiceRequest, { operation: "hover" }>;
  syncDocument(ctx);
  const result = await ctx.manager.sendRequest<unknown>(
    "textDocument/hover",
    { ...textDocumentParams(ctx), position: request.position },
    ctx.signal,
  );
  return successBody(ctx.request, sanitizeHover(mapHover(result), ctx.limits));
}

async function runSymbols(ctx: LspOperationContext): Promise<LanguageServiceOutcome> {
  syncDocument(ctx);
  const result = await ctx.manager.sendRequest<unknown>(
    "textDocument/documentSymbol",
    textDocumentParams(ctx),
    ctx.signal,
  );
  return successBody(
    ctx.request,
    sanitizeSymbols({ symbols: symbolsFromResult(result), truncated: false }, ctx.limits),
  );
}

async function runFormatting(ctx: LspOperationContext): Promise<LanguageServiceOutcome> {
  const request = ctx.request as Extract<LanguageServiceRequest, { operation: "formatting" }>;
  syncDocument(ctx);
  const options = request.options ?? {};
  const result = await ctx.manager.sendRequest<unknown>(
    "textDocument/formatting",
    {
      ...textDocumentParams(ctx),
      options: { tabSize: options.tabSize ?? 2, insertSpaces: options.insertSpaces ?? true },
    },
    ctx.signal,
  );
  return successBody(
    ctx.request,
    sanitizeFormatting({ edits: textEditsFromResult(result), truncated: false }, ctx.limits),
  );
}

async function runDefinition(ctx: LspOperationContext): Promise<LanguageServiceOutcome> {
  const request = ctx.request as Extract<LanguageServiceRequest, { operation: "definition" }>;
  syncDocument(ctx);
  const result = await ctx.manager.sendRequest<unknown>(
    "textDocument/definition",
    { ...textDocumentParams(ctx), position: request.position },
    ctx.signal,
  );
  const locations = locationsFromResult(ctx, result);
  return successBody(ctx.request, sanitizeDefinition({ locations, truncated: false }, ctx.limits));
}

async function runRelatedDefinition(
  ctx: LspOperationContext,
  method: "textDocument/typeDefinition" | "textDocument/implementation",
): Promise<LanguageServiceOutcome> {
  const request = ctx.request as Extract<
    LanguageServiceRequest,
    { operation: "typeDefinition" | "implementation" }
  >;
  syncDocument(ctx);
  const result = await ctx.manager.sendRequest<unknown>(
    method,
    { ...textDocumentParams(ctx), position: request.position },
    ctx.signal,
  );
  const locations = locationsFromResult(ctx, result);
  return successBody(ctx.request, sanitizeDefinition({ locations, truncated: false }, ctx.limits));
}

function callHierarchyItem(
  ctx: LspOperationContext,
  value: unknown,
): LanguageCallHierarchyItem | undefined {
  if (!isRecord(value) || typeof value.name !== "string") return undefined;
  const path = relativePathFromUri(ctx.workspaceRoot, value.uri);
  if (path === undefined || !isRange(value.range) || !isRange(value.selectionRange)) {
    return undefined;
  }
  const containerName = stringValue(value.detail);
  return {
    name: value.name,
    kind: symbolKind(value.kind),
    path,
    range: value.range,
    selectionRange: value.selectionRange,
    ...(containerName === undefined ? {} : { containerName }),
  };
}

function callRanges(value: unknown): readonly LanguageRange[] {
  return Array.isArray(value) ? value.filter(isRange) : [];
}

function incomingCalls(
  ctx: LspOperationContext,
  value: unknown,
): readonly LanguageCallHierarchyIncomingCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const item = callHierarchyItem(ctx, entry.from);
    return item === undefined ? [] : [{ item, fromRanges: callRanges(entry.fromRanges) }];
  });
}

function outgoingCalls(
  ctx: LspOperationContext,
  value: unknown,
): readonly LanguageCallHierarchyOutgoingCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const item = callHierarchyItem(ctx, entry.to);
    return item === undefined ? [] : [{ item, fromRanges: callRanges(entry.fromRanges) }];
  });
}

async function callHierarchyRoot(
  ctx: LspOperationContext,
  rawItem: unknown,
): Promise<LanguageCallHierarchyRoot | undefined> {
  const item = callHierarchyItem(ctx, rawItem);
  if (item === undefined) return undefined;
  const params = { item: rawItem };
  const [incoming, outgoing] = await Promise.all([
    ctx.manager.sendRequest<unknown>("callHierarchy/incomingCalls", params, ctx.signal),
    ctx.manager.sendRequest<unknown>("callHierarchy/outgoingCalls", params, ctx.signal),
  ]);
  return {
    item,
    incomingCalls: incomingCalls(ctx, incoming),
    outgoingCalls: outgoingCalls(ctx, outgoing),
  };
}

async function runCallHierarchy(ctx: LspOperationContext): Promise<LanguageServiceOutcome> {
  const request = ctx.request as Extract<LanguageServiceRequest, { operation: "callHierarchy" }>;
  syncDocument(ctx);
  const prepared = await ctx.manager.sendRequest<unknown>(
    "textDocument/prepareCallHierarchy",
    { ...textDocumentParams(ctx), position: request.position },
    ctx.signal,
  );
  const preparedRoots = Array.isArray(prepared) ? prepared : [];
  const rawRoots = preparedRoots.slice(0, ctx.limits.maxCallHierarchyItems);
  const roots = (await Promise.all(rawRoots.map((item) => callHierarchyRoot(ctx, item)))).filter(
    (root): root is LanguageCallHierarchyRoot => root !== undefined,
  );
  return successBody(
    ctx.request,
    sanitizeCallHierarchy({ roots, truncated: rawRoots.length < preparedRoots.length }, ctx.limits),
  );
}

function inlayHintLabel(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((part) =>
    isRecord(part) && typeof part.value === "string" ? [part.value] : [],
  );
  return parts.length === value.length ? parts.join("") : undefined;
}

function inlayHint(value: unknown): LanguageInlayHint | undefined {
  if (!isRecord(value) || !isPosition(value.position)) return undefined;
  const label = inlayHintLabel(value.label);
  if (label === undefined) return undefined;
  return {
    position: value.position,
    label,
    kind: value.kind === 2 ? "parameter" : "type",
    ...(typeof value.paddingLeft === "boolean" ? { paddingLeft: value.paddingLeft } : {}),
    ...(typeof value.paddingRight === "boolean" ? { paddingRight: value.paddingRight } : {}),
  };
}

async function runInlayHints(ctx: LspOperationContext): Promise<LanguageServiceOutcome> {
  const request = ctx.request as Extract<LanguageServiceRequest, { operation: "inlayHints" }>;
  syncDocument(ctx);
  const result = await ctx.manager.sendRequest<unknown>(
    "textDocument/inlayHint",
    { ...textDocumentParams(ctx), range: request.range },
    ctx.signal,
  );
  const hints = Array.isArray(result)
    ? result.flatMap((entry) => {
        const mapped = inlayHint(entry);
        return mapped === undefined ? [] : [mapped];
      })
    : [];
  return successBody(ctx.request, sanitizeInlayHints({ hints, truncated: false }, ctx.limits));
}

async function runReferences(ctx: LspOperationContext): Promise<LanguageServiceOutcome> {
  const request = ctx.request as Extract<LanguageServiceRequest, { operation: "references" }>;
  syncDocument(ctx);
  const result = await ctx.manager.sendRequest<unknown>(
    "textDocument/references",
    {
      ...textDocumentParams(ctx),
      position: request.position,
      context: { includeDeclaration: true },
    },
    ctx.signal,
  );
  const locations = locationsFromResult(ctx, result);
  return successBody(
    ctx.request,
    sanitizeReferences({ locations, includesDeclaration: true, truncated: false }, ctx.limits),
  );
}

async function runRenamePrepare(ctx: LspOperationContext): Promise<LanguageServiceOutcome> {
  const request = ctx.request as Extract<LanguageServiceRequest, { operation: "renamePrepare" }>;
  syncDocument(ctx);
  const result = await ctx.manager.sendRequest<unknown>(
    "textDocument/prepareRename",
    { ...textDocumentParams(ctx), position: request.position },
    ctx.signal,
  );
  return successBody(
    ctx.request,
    sanitizeRenamePrepare(renamePrepareFromResult(result), ctx.limits),
  );
}

async function runRenameApply(ctx: LspOperationContext): Promise<LanguageServiceOutcome> {
  const request = ctx.request as Extract<LanguageServiceRequest, { operation: "renameApply" }>;
  syncDocument(ctx);
  const result = await ctx.manager.sendRequest<unknown>(
    "textDocument/rename",
    { ...textDocumentParams(ctx), position: request.position, newName: request.newName },
    ctx.signal,
  );
  return successBody(
    ctx.request,
    sanitizeRenameApply(renameChangesetFromResult(ctx, result), ctx.limits),
  );
}

async function runCodeActions(ctx: LspOperationContext): Promise<LanguageServiceOutcome> {
  const request = ctx.request as Extract<LanguageServiceRequest, { operation: "codeActions" }>;
  syncDocument(ctx);
  const result = await ctx.manager.sendRequest<unknown>(
    "textDocument/codeAction",
    {
      ...textDocumentParams(ctx),
      range: request.range,
      context: { diagnostics: request.diagnostics },
    },
    ctx.signal,
  );
  const actions = codeActionsFromResult(ctx, result);
  return successBody(
    ctx.request,
    sanitizeCodeActions(
      { actions, truncated: false, returnedCount: actions.length, totalCount: actions.length },
      ctx.limits,
    ),
  );
}

async function runSignatureHelp(ctx: LspOperationContext): Promise<LanguageServiceOutcome> {
  const request = ctx.request as Extract<LanguageServiceRequest, { operation: "signatureHelp" }>;
  syncDocument(ctx);
  const result = await ctx.manager.sendRequest<unknown>(
    "textDocument/signatureHelp",
    { ...textDocumentParams(ctx), position: request.position },
    ctx.signal,
  );
  const signatures =
    isRecord(result) && Array.isArray(result.signatures)
      ? result.signatures.flatMap((entry) => {
          const signature = signatureInformation(entry);
          return signature === undefined ? [] : [signature];
        })
      : [];
  return successBody(
    ctx.request,
    sanitizeSignatureHelp(
      {
        signatures,
        activeSignature: isRecord(result) ? numericIndex(result.activeSignature) : null,
        activeParameter: isRecord(result) ? numericIndex(result.activeParameter) : null,
        truncated: false,
        returnedCount: signatures.length,
        totalCount: signatures.length,
      },
      ctx.limits,
    ),
  );
}

function didOpenParams(ctx: LspOperationContext): Record<string, unknown> {
  return {
    textDocument: {
      uri: ctx.uri,
      languageId: ctx.request.document.languageId,
      version: 1,
      text: ctx.request.document.text,
    },
  };
}

function didChangeParams(
  ctx: LspOperationContext,
  prior: OpenDocumentState,
  version: number,
): Record<string, unknown> {
  const sync = ctx.manager.getNegotiatedCapabilities()?.textSync ?? "none";
  const change =
    sync === "incremental"
      ? {
          range: fullDocumentRange(prior.text),
          rangeLength: prior.text.length,
          text: ctx.request.document.text,
        }
      : { text: ctx.request.document.text };
  return {
    textDocument: { uri: ctx.uri, version },
    contentChanges: [change],
  };
}

function fullDocumentRange(text: string): LanguageRange {
  const lines = text.split("\n");
  return {
    start: { line: 0, character: 0 },
    end: { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 },
  };
}

type CoreLanguageServiceRequest = Extract<
  LanguageServiceRequest,
  { operation: "diagnostics" | "completion" | "hover" | "symbols" | "formatting" }
>;

type ExtendedLanguageServiceRequest = Exclude<LanguageServiceRequest, CoreLanguageServiceRequest>;
type NavigationLanguageServiceRequest = Extract<
  ExtendedLanguageServiceRequest,
  { operation: "typeDefinition" | "implementation" | "callHierarchy" | "inlayHints" }
>;
const CORE_OPERATIONS = new Set<string>([
  "diagnostics",
  "completion",
  "hover",
  "symbols",
  "formatting",
]);

function isCoreRequest(request: LanguageServiceRequest): request is CoreLanguageServiceRequest {
  return CORE_OPERATIONS.has(request.operation);
}

async function runCoreLspRequest(
  ctx: LspOperationContext & { readonly request: CoreLanguageServiceRequest },
): Promise<LanguageServiceOutcome> {
  switch (ctx.request.operation) {
    case "diagnostics":
      return runDiagnostics(ctx);
    case "completion":
      return runCompletion(ctx);
    case "hover":
      return runHover(ctx);
    case "symbols":
      return runSymbols(ctx);
    case "formatting":
      return runFormatting(ctx);
  }
}

async function runExtendedLspRequest(
  ctx: LspOperationContext & { readonly request: ExtendedLanguageServiceRequest },
): Promise<LanguageServiceOutcome> {
  if (isNavigationRequest(ctx.request)) {
    return runNavigationLspRequest({ ...ctx, request: ctx.request });
  }
  switch (ctx.request.operation) {
    case "definition":
      return runDefinition(ctx);
    case "references":
      return runReferences(ctx);
    case "renamePrepare":
      return runRenamePrepare(ctx);
    case "renameApply":
      return runRenameApply(ctx);
    case "codeActions":
      return runCodeActions(ctx);
    case "signatureHelp":
      return runSignatureHelp(ctx);
  }
}

function isNavigationRequest(
  request: ExtendedLanguageServiceRequest,
): request is NavigationLanguageServiceRequest {
  return ["typeDefinition", "implementation", "callHierarchy", "inlayHints"].includes(
    request.operation,
  );
}

async function runNavigationLspRequest(
  ctx: LspOperationContext & { readonly request: NavigationLanguageServiceRequest },
): Promise<LanguageServiceOutcome> {
  switch (ctx.request.operation) {
    case "typeDefinition":
      return runRelatedDefinition(ctx, "textDocument/typeDefinition");
    case "implementation":
      return runRelatedDefinition(ctx, "textDocument/implementation");
    case "callHierarchy":
      return runCallHierarchy(ctx);
    case "inlayHints":
      return runInlayHints(ctx);
  }
}

async function runLspRequest(ctx: LspOperationContext): Promise<LanguageServiceOutcome> {
  // No per-op didClose: the pooled process keeps the document OPEN across ops (didChange keeps
  // it in sync). didClose fires only when the pooled process is evicted (idle/shutdown), via
  // manager.dispose. This is what lets a warm server reuse its parsed/analyzed document state.
  return isCoreRequest(ctx.request)
    ? runCoreLspRequest({ ...ctx, request: ctx.request })
    : runExtendedLspRequest({ ...ctx, request: ctx.request });
}

function createPooledEntry(
  spec: HostLanguageProviderSpec,
  options: HostLanguageOperationOptions,
): PooledLspEntry {
  const config = makeConfig(
    spec,
    options.protocolConfiguration?.resourceBudget,
    options.lspProcessConfig,
  );
  const manager = createLspProcessManager({
    config,
    workspace: options.workspace,
    processEnv: options.processEnv,
    commandRules: options.commandRules,
    now: options.now,
    protocol: managerProtocol(spec, options),
    ...managerOverrides(spec, options),
  });
  return {
    manager,
    spawn: options.spawn,
    openDocuments: new Map<string, OpenDocumentState>(),
    configurationRevision: options.protocolConfiguration?.revision ?? 0,
    queue: Promise.resolve(),
    idleTimer: undefined,
    disposed: false,
  };
}

function managerProtocol(
  spec: HostLanguageProviderSpec,
  options: HostLanguageOperationOptions,
): LspProcessProtocolConfig {
  const configuration = options.protocolConfiguration;
  return {
    language: managedLanguageForSpec(spec),
    candidateOperations: spec.operations,
    semanticTokensCandidate: spec.semanticTokensCandidate,
    configurationRevision: configuration?.revision ?? 0,
    configuration: configuration?.settings ?? {},
    initializationOptions: configuration?.initializationOptions ?? {},
    resourceBudget: configuration?.resourceBudget,
  };
}

function managerOverrides(
  spec: HostLanguageProviderSpec,
  options: HostLanguageOperationOptions,
): Pick<
  LspProcessManagerDeps,
  "approvedDescendantExecutables" | "fixedEnv" | "prepareSpawn" | "spawn"
> {
  const prepareSpawn = options.prepareSpawn ?? spec.prepareSpawn;
  return {
    ...(spec.approvedDescendantExecutables === undefined
      ? {}
      : { approvedDescendantExecutables: spec.approvedDescendantExecutables }),
    ...(spec.fixedEnv === undefined ? {} : { fixedEnv: spec.fixedEnv }),
    ...(prepareSpawn === undefined
      ? {}
      : {
          prepareSpawn: (input) =>
            prepareSpawn({
              ...input,
              privateRuntimeStateRoot: options.privateRuntimeStateRoot,
            }),
        }),
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
  };
}

function managedLanguageForSpec(spec: HostLanguageProviderSpec): ManagedLspLanguage {
  const language = spec.languages[0];
  return language !== undefined && MANAGED_LSP_LANGUAGES.includes(language as ManagedLspLanguage)
    ? (language as ManagedLspLanguage)
    : "python";
}

// A pooled process is only reusable while its status is one of the pre-READY/READY states.
// A crashed/failed/throttled process is discarded so the next request re-spawns (the degraded
// spawn-per-request fallback), never serving requests against a dead child.
function isReusableStatus(manager: LspProcessManager): boolean {
  const status = manager.getLspProcessStatus();
  return status === "READY" || status === "STARTING" || status === "INITIALIZING";
}

function providerUnhealthyOutcome(): LanguageServiceOutcome {
  return errorOutcome(
    "TIMED_OUT",
    "The language provider did not complete within the time budget.",
  );
}

function acquirePooledEntry(
  spec: HostLanguageProviderSpec,
  options: HostLanguageOperationOptions,
): PooledLspEntry {
  const key = poolKey(options.workspace.root, poolLanguageAxis(spec));
  const existing = LSP_PROCESS_POOL.get(key);
  if (
    existing !== undefined &&
    !existing.disposed &&
    sameSpawn(existing.spawn, options.spawn) &&
    existing.configurationRevision === (options.protocolConfiguration?.revision ?? 0) &&
    isReusableStatus(existing.manager)
  ) {
    clearIdleTimer(existing);
    return existing;
  }
  // Claim the slot SYNCHRONOUSLY (no intervening await) so two concurrent first-requests for
  // the same key cannot each create a manager and leak one. A stale/unreusable prior entry is
  // disposed in the background — its own generation guards keep that shutdown independent.
  const entry = createPooledEntry(spec, options);
  LSP_PROCESS_POOL.set(key, entry);
  if (existing !== undefined && !existing.disposed) {
    void evictStaleEntry(existing);
  }
  return entry;
}

// Dispose a superseded entry WITHOUT touching the pool map (the map already points at the
// replacement). Used when a fresh entry has already claimed the key synchronously.
async function evictStaleEntry(entry: PooledLspEntry): Promise<void> {
  if (entry.disposed) return;
  entry.disposed = true;
  clearIdleTimer(entry);
  closeOpenDocuments(entry);
  try {
    await entry.manager.dispose();
  } catch {
    // Best-effort shutdown of a discarded manager.
  }
}

// The spec serves a fixed language set; the pool key uses the spec id as the language axis so
// all languages a single server handles share one warm process per root.
function poolLanguageAxis(spec: HostLanguageProviderSpec): string {
  return spec.id;
}

async function runPooledOperation(
  entry: PooledLspEntry,
  spec: HostLanguageProviderSpec,
  request: LanguageServiceRequest,
  options: HostLanguageOperationOptions,
): Promise<LanguageServiceOutcome> {
  const config = makeConfig(
    spec,
    options.protocolConfiguration?.resourceBudget,
    options.lspProcessConfig,
  );
  if (!(await waitForReady(entry.manager, config.initializeTimeoutMs, options.signal))) {
    return providerUnhealthyOutcome();
  }
  if (entry.manager.getLspProcessStatus() !== "READY") {
    return providerUnhealthyOutcome();
  }
  const negotiated = entry.manager.getNegotiatedCapabilities();
  if (negotiated === undefined || !isManagedLspOperationNegotiated(negotiated, request.operation)) {
    return errorOutcome("UNSUPPORTED_OPERATION", "The provider did not negotiate this operation.");
  }
  if (negotiated.textSync === "none") {
    return errorOutcome("UNSUPPORTED_OPERATION", "The provider did not negotiate document sync.");
  }
  return runLspRequest({
    spec,
    manager: entry.manager,
    request,
    workspaceRoot: options.workspace.root,
    uri: pathToFileURL(options.overlayAbsolutePath).href,
    signal: options.signal,
    limits: options.limits ?? DEFAULT_LANGUAGE_SERVICE_LIMITS,
    openDocuments: entry.openDocuments,
  });
}

export async function runHostLanguageOperation(
  request: LanguageServiceRequest,
  options: HostLanguageOperationOptions,
): Promise<LanguageServiceOutcome | undefined> {
  const spec = findSpec(request.document.languageId);
  if (spec === undefined) return undefined;
  if (!spec.operations.includes(request.operation)) {
    return errorOutcome("UNSUPPORTED_OPERATION", "The provider does not serve this operation.");
  }
  if (!matchingAvailableProvider(spec, options)) return undefined;

  const key = poolKey(options.workspace.root, poolLanguageAxis(spec));
  const entry = acquirePooledEntry(spec, options);

  // Serialize onto the entry's queue: a concurrent second op chains after the first and runs
  // on the same warm process (it QUEUES and resolves) rather than being rejected as busy.
  const run = entry.queue.then(async () => {
    try {
      return await runPooledOperation(entry, spec, request, options);
    } catch (error) {
      return mapProcessError(error);
    }
  });
  // Keep the queue chain alive regardless of this op's success so later ops still serialize.
  entry.queue = run.catch(() => undefined);

  const outcome = await run;

  // Post-op lifecycle: a process that died mid-op is evicted (next call re-spawns — degraded
  // fallback); a healthy process is kept warm with a fresh idle-shutdown timer.
  await finalizePooledEntry(key, entry);
  return outcome;
}

async function finalizePooledEntry(key: string, entry: PooledLspEntry): Promise<void> {
  if (entry.disposed) return;
  if (!isReusableStatus(entry.manager)) {
    await evictPooledEntry(key, entry);
    return;
  }
  scheduleIdleShutdown(key, entry);
}

// The managed capability route uses this initialization-only path after explicit activation. It
// starts the same governed pooled manager and waits for the real initialize negotiation, but opens no
// document and executes no language operation. This prevents static candidate arrays from being
// advertised while also avoiding a UI deadlock where no operation can run until one is advertised.
export async function initializeHostLanguageProvider(
  languageId: string,
  options: HostLanguageOperationOptions,
): Promise<ManagedLspProcessHealthSnapshot | undefined> {
  const spec = findSpec(languageId);
  if (spec === undefined || !matchingAvailableProvider(spec, options)) return undefined;
  const key = poolKey(options.workspace.root, poolLanguageAxis(spec));
  const entry = acquirePooledEntry(spec, options);
  const config = makeConfig(
    spec,
    options.protocolConfiguration?.resourceBudget,
    options.lspProcessConfig,
  );
  try {
    await waitForReady(entry.manager, config.initializeTimeoutMs, options.signal);
    return entry.manager.getHealthSnapshot();
  } finally {
    await finalizePooledEntry(key, entry);
  }
}

function syncSemanticDocument(
  entry: PooledLspEntry,
  uri: string,
  document: HostSemanticTokenDocument,
): void {
  const childGeneration = entry.manager.getChildGeneration();
  const prior = entry.openDocuments.get(uri);
  const boundPrior = prior?.childGeneration === childGeneration ? prior : undefined;
  const version = (boundPrior?.version ?? 0) + 1;
  entry.openDocuments.set(uri, { childGeneration, version, text: document.text });
  if (boundPrior === undefined) {
    entry.manager.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: document.languageId, version, text: document.text },
    });
  } else {
    entry.manager.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text: document.text }],
    });
  }
}

async function requestSemanticTokens(
  entry: PooledLspEntry,
  spec: HostLanguageProviderSpec,
  document: HostSemanticTokenDocument,
  options: HostLanguageOperationOptions,
): Promise<HostSemanticTokenResult | undefined> {
  const config = makeConfig(
    spec,
    options.protocolConfiguration?.resourceBudget,
    options.lspProcessConfig,
  );
  if (!(await waitForReady(entry.manager, config.initializeTimeoutMs, options.signal))) return;
  const negotiation = entry.manager.getSemanticTokenNegotiation();
  if (negotiation === undefined) return;
  const uri = pathToFileURL(options.overlayAbsolutePath).href;
  syncSemanticDocument(entry, uri, document);
  const response = await entry.manager.sendRequest<unknown>(
    "textDocument/semanticTokens/full",
    { textDocument: { uri } },
    options.signal,
  );
  const data = sanitizeSemanticTokenResponse(
    response,
    document.text,
    document.version,
    negotiation,
  );
  return data === undefined ? undefined : { legend: negotiation.legend, data };
}

export async function runHostLanguageSemanticTokens(
  document: HostSemanticTokenDocument,
  options: HostLanguageOperationOptions,
): Promise<HostSemanticTokenResult | undefined> {
  // Rust is the only language with measured conformance/budget evidence for semantic tokens
  // (ADR-0132 D18). Enabling another language here requires new evidence, not just this check.
  if (document.languageId !== "rust") return undefined;
  const spec = findSpec(document.languageId);
  if (spec === undefined || !matchingAvailableProvider(spec, options)) return undefined;
  const key = poolKey(options.workspace.root, poolLanguageAxis(spec));
  const entry = acquirePooledEntry(spec, options);
  const run = entry.queue.then(async () => {
    try {
      return await requestSemanticTokens(entry, spec, document, options);
    } catch {
      return undefined;
    }
  });
  entry.queue = run.catch(() => undefined);
  const result = await run;
  await finalizePooledEntry(key, entry);
  return result;
}
