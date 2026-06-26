import { pathToFileURL } from "node:url";
import {
  DEFAULT_LSP_PROCESS_CONFIG,
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  type LanguageCompletionItem,
  type LanguageCompletionItemKind,
  type LanguageDiagnostic,
  type LanguageDiagnosticSeverity,
  type LanguageDocumentSymbol,
  type LanguageHoverResult,
  type LanguagePosition,
  type LanguageRange,
  type LanguageServiceLimits,
  type LanguageServiceRequest,
  type LanguageSymbolKind,
  type LanguageTextEdit,
  type LspProcessConfig,
} from "@oscharko-dev/keiko-contracts";
import type { CommandRule } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { LanguageServiceOutcome } from "../languageService.js";
import {
  sanitizeCompletion,
  sanitizeDiagnostics,
  sanitizeFormatting,
  sanitizeHover,
  sanitizeSymbols,
} from "../languageSanitize.js";
import { createLspProcessManager, type LspProcessManager } from "./lspProcessManager.js";
import { LspProcessError, type LspSpawnFn } from "./lspNodeAdapter.js";
import {
  detectHostLanguageProviderDescriptors,
  HOST_LANGUAGE_PROVIDER_SPECS,
  type HostLanguageProviderSpec,
} from "./hostLanguageProviders.js";

export interface HostLanguageOperationOptions {
  readonly workspace: WorkspaceInfo;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly commandRules: readonly CommandRule[];
  readonly overlayAbsolutePath: string;
  readonly signal: AbortSignal;
  readonly limits?: LanguageServiceLimits | undefined;
  readonly now?: (() => number) | undefined;
  readonly spawn?: LspSpawnFn | undefined;
}

const MAX_HOST_LSP_OPERATIONS = 1;
let activeHostLspOperations = 0;

interface LspOperationContext {
  readonly spec: HostLanguageProviderSpec;
  readonly manager: LspProcessManager;
  readonly request: LanguageServiceRequest;
  readonly uri: string;
  readonly signal: AbortSignal;
  readonly limits: LanguageServiceLimits;
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

function makeConfig(spec: HostLanguageProviderSpec): LspProcessConfig {
  return {
    ...DEFAULT_LSP_PROCESS_CONFIG,
    managerId: spec.id,
    executableName: spec.executableName,
    executableArgs: spec.executableArgs,
    envAllowlist: spec.envAllowlist,
  };
}

function matchingAvailableProvider(
  spec: HostLanguageProviderSpec,
  options: HostLanguageOperationOptions,
): boolean {
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

function acquireHostLspSlot(): (() => void) | undefined {
  if (activeHostLspOperations >= MAX_HOST_LSP_OPERATIONS) {
    return undefined;
  }
  activeHostLspOperations += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeHostLspOperations -= 1;
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new LspProcessError("CANCELLED"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
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

function textDocumentParams(ctx: LspOperationContext): Record<string, unknown> {
  return { textDocument: { uri: ctx.uri } };
}

async function runDiagnostics(ctx: LspOperationContext): Promise<LanguageServiceOutcome> {
  let published: readonly LanguageDiagnostic[] = [];
  ctx.manager.onNotification((method, params) => {
    if (method !== "textDocument/publishDiagnostics" || !isRecord(params)) return;
    if (params.uri !== ctx.uri) return;
    published = diagnosticsFromList(params.diagnostics, ctx.spec.id);
  });
  ctx.manager.sendNotification("textDocument/didOpen", didOpenParams(ctx));
  let pulled: readonly LanguageDiagnostic[] = [];
  try {
    const result = await ctx.manager.sendRequest<unknown>(
      "textDocument/diagnostic",
      textDocumentParams(ctx),
      ctx.signal,
    );
    pulled = diagnosticsFromPullReport(result, ctx.spec.id);
  } catch {
    await delay(50, ctx.signal);
  }
  const diagnostics = pulled.length > 0 ? pulled : published;
  return successBody(
    ctx.request,
    sanitizeDiagnostics({ diagnostics, truncated: false }, ctx.limits),
  );
}

async function runCompletion(ctx: LspOperationContext): Promise<LanguageServiceOutcome> {
  const request = ctx.request as Extract<LanguageServiceRequest, { operation: "completion" }>;
  ctx.manager.sendNotification("textDocument/didOpen", didOpenParams(ctx));
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
  ctx.manager.sendNotification("textDocument/didOpen", didOpenParams(ctx));
  const result = await ctx.manager.sendRequest<unknown>(
    "textDocument/hover",
    { ...textDocumentParams(ctx), position: request.position },
    ctx.signal,
  );
  return successBody(ctx.request, sanitizeHover(mapHover(result), ctx.limits));
}

async function runSymbols(ctx: LspOperationContext): Promise<LanguageServiceOutcome> {
  ctx.manager.sendNotification("textDocument/didOpen", didOpenParams(ctx));
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
  ctx.manager.sendNotification("textDocument/didOpen", didOpenParams(ctx));
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

function didCloseParams(ctx: LspOperationContext): Record<string, unknown> {
  return { textDocument: { uri: ctx.uri } };
}

async function runLspRequest(ctx: LspOperationContext): Promise<LanguageServiceOutcome> {
  try {
    switch (ctx.request.operation) {
      case "diagnostics":
        return await runDiagnostics(ctx);
      case "completion":
        return await runCompletion(ctx);
      case "hover":
        return await runHover(ctx);
      case "symbols":
        return await runSymbols(ctx);
      case "formatting":
        return await runFormatting(ctx);
    }
  } finally {
    ctx.manager.sendNotification("textDocument/didClose", didCloseParams(ctx));
  }
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
  const releaseSlot = acquireHostLspSlot();
  if (releaseSlot === undefined) {
    return errorOutcome("TIMED_OUT", "The language provider is busy.");
  }

  const limits = options.limits ?? DEFAULT_LANGUAGE_SERVICE_LIMITS;
  const config = makeConfig(spec);
  const manager = createLspProcessManager({
    config,
    workspace: options.workspace,
    processEnv: options.processEnv,
    commandRules: options.commandRules,
    now: options.now,
    ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
  });
  try {
    if (!(await waitForReady(manager, config.initializeTimeoutMs, options.signal))) {
      return errorOutcome(
        "TIMED_OUT",
        "The language provider did not complete within the time budget.",
      );
    }
    manager.sendNotification("initialized", {});
    return await runLspRequest({
      spec,
      manager,
      request,
      uri: pathToFileURL(options.overlayAbsolutePath).href,
      signal: options.signal,
      limits,
    });
  } catch (error) {
    return mapProcessError(error);
  } finally {
    try {
      await manager.dispose();
    } finally {
      releaseSlot();
    }
  }
}
