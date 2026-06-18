// The first deterministic language provider (Issue #1198): TypeScript/JavaScript backed by the
// TypeScript language service. Model-free and governed (ADR-0042 D4). It runs every query over the
// in-memory overlay so diagnostics reflect unsaved edits, threads the deadline/abort cancellation
// token into the service, and caps result counts so analysis stays bounded. A fresh language
// service is created per request and disposed afterwards, keeping each call stateless and
// deterministic.

import ts from "typescript";
import type {
  LanguageCompletionItem,
  LanguageCompletionItemKind,
  LanguageCompletionResult,
  LanguageDiagnostic,
  LanguageDiagnosticSeverity,
  LanguageDocumentSymbol,
  LanguageHoverResult,
  LanguagePosition,
  LanguageProviderDescriptor,
  LanguageSymbolKind,
} from "@oscharko-dev/keiko-contracts";
import {
  createContainedLanguageServiceHost,
  type ContainedHostOptions,
} from "./languageServiceHost.js";
import type {
  LanguageDiagnosticsRaw,
  LanguageProvider,
  LanguageProviderContext,
  LanguageSymbolsRaw,
} from "./languageProvider.js";
import { computeLineStarts, positionToOffset, spanToRange } from "./textOffsets.js";

const TS_LANGUAGES: readonly string[] = [
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
];

const DESCRIPTOR: LanguageProviderDescriptor = {
  id: "typescript",
  languages: TS_LANGUAGES,
  operations: ["diagnostics", "completion", "hover", "symbols"],
};

const SEVERITY_BY_CATEGORY: Readonly<Record<ts.DiagnosticCategory, LanguageDiagnosticSeverity>> = {
  [ts.DiagnosticCategory.Error]: "error",
  [ts.DiagnosticCategory.Warning]: "warning",
  [ts.DiagnosticCategory.Suggestion]: "hint",
  [ts.DiagnosticCategory.Message]: "info",
};

// Map (not an object literal) so a TypeScript element kind whose string value is "constructor"
// cannot collide with `Object.prototype.constructor`.
const COMPLETION_KIND_BY_ELEMENT = new Map<string, LanguageCompletionItemKind>([
  [ts.ScriptElementKind.functionElement, "function"],
  [ts.ScriptElementKind.localFunctionElement, "function"],
  [ts.ScriptElementKind.memberFunctionElement, "method"],
  [ts.ScriptElementKind.memberVariableElement, "property"],
  [ts.ScriptElementKind.memberGetAccessorElement, "property"],
  [ts.ScriptElementKind.memberSetAccessorElement, "property"],
  [ts.ScriptElementKind.classElement, "class"],
  [ts.ScriptElementKind.interfaceElement, "interface"],
  [ts.ScriptElementKind.enumElement, "enum"],
  [ts.ScriptElementKind.enumMemberElement, "enum"],
  [ts.ScriptElementKind.moduleElement, "module"],
  [ts.ScriptElementKind.variableElement, "variable"],
  [ts.ScriptElementKind.letElement, "variable"],
  [ts.ScriptElementKind.constElement, "constant"],
  [ts.ScriptElementKind.alias, "variable"],
  [ts.ScriptElementKind.parameterElement, "variable"],
  [ts.ScriptElementKind.typeParameterElement, "typeParameter"],
  [ts.ScriptElementKind.keyword, "keyword"],
  [ts.ScriptElementKind.constructorImplementationElement, "constructor"],
  [ts.ScriptElementKind.typeElement, "interface"],
]);

const SYMBOL_KIND_BY_ELEMENT = new Map<string, LanguageSymbolKind>([
  [ts.ScriptElementKind.moduleElement, "module"],
  [ts.ScriptElementKind.classElement, "class"],
  [ts.ScriptElementKind.interfaceElement, "interface"],
  [ts.ScriptElementKind.enumElement, "enum"],
  [ts.ScriptElementKind.enumMemberElement, "enumMember"],
  [ts.ScriptElementKind.functionElement, "function"],
  [ts.ScriptElementKind.localFunctionElement, "function"],
  [ts.ScriptElementKind.memberFunctionElement, "method"],
  [ts.ScriptElementKind.memberVariableElement, "property"],
  [ts.ScriptElementKind.memberGetAccessorElement, "property"],
  [ts.ScriptElementKind.memberSetAccessorElement, "property"],
  [ts.ScriptElementKind.constructorImplementationElement, "constructor"],
  [ts.ScriptElementKind.variableElement, "variable"],
  [ts.ScriptElementKind.letElement, "variable"],
  [ts.ScriptElementKind.constElement, "constant"],
  [ts.ScriptElementKind.typeParameterElement, "typeParameter"],
  [ts.ScriptElementKind.typeElement, "interface"],
]);

function completionKind(kind: string): LanguageCompletionItemKind {
  return COMPLETION_KIND_BY_ELEMENT.get(kind) ?? "text";
}

function symbolKind(kind: string): LanguageSymbolKind {
  return SYMBOL_KIND_BY_ELEMENT.get(kind) ?? "variable";
}

function withService<T>(ctx: LanguageProviderContext, run: (service: ts.LanguageService) => T): T {
  const hostOptions: ContainedHostOptions = {
    fs: ctx.fs,
    realRoot: ctx.root,
    overlayPath: ctx.overlayPath,
    overlayText: ctx.overlayText,
    languageId: ctx.languageId,
    cancellation: ctx.cancellation.hostToken(),
    limits: ctx.limits,
  };
  const host = createContainedLanguageServiceHost(hostOptions);
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  try {
    return run(service);
  } finally {
    service.dispose();
  }
}

function buildDiagnostics(
  ctx: LanguageProviderContext,
  service: ts.LanguageService,
): LanguageDiagnosticsRaw {
  ctx.cancellation.throwIfCancellationRequested();
  const syntactic = service.getSyntacticDiagnostics(ctx.overlayPath);
  ctx.cancellation.throwIfCancellationRequested();
  const semantic = service.getSemanticDiagnostics(ctx.overlayPath);
  const lineStarts = computeLineStarts(ctx.overlayText);
  const all = [...syntactic, ...semantic];
  const capped = all.slice(0, ctx.limits.maxDiagnostics);
  const diagnostics = capped.map((diagnostic): LanguageDiagnostic => {
    const range = spanToRange(ctx.overlayText, lineStarts, diagnostic.start, diagnostic.length);
    const severity = SEVERITY_BY_CATEGORY[diagnostic.category];
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    return { range, severity, message, source: DESCRIPTOR.id, code: String(diagnostic.code) };
  });
  return { diagnostics, truncated: all.length > capped.length };
}

function buildCompletionItem(entry: ts.CompletionEntry): LanguageCompletionItem {
  const base: LanguageCompletionItem = {
    label: entry.name,
    kind: completionKind(entry.kind),
    sortText: entry.sortText,
  };
  return entry.insertText !== undefined ? { ...base, insertText: entry.insertText } : base;
}

function buildCompletions(
  ctx: LanguageProviderContext,
  service: ts.LanguageService,
  position: LanguagePosition,
): LanguageCompletionResult {
  ctx.cancellation.throwIfCancellationRequested();
  const lineStarts = computeLineStarts(ctx.overlayText);
  const offset = positionToOffset(ctx.overlayText, lineStarts, position);
  const completions = service.getCompletionsAtPosition(ctx.overlayPath, offset, {
    includeCompletionsForModuleExports: false,
    includeCompletionsForImportStatements: false,
    includeInsertTextCompletions: true,
  });
  if (completions === undefined) {
    return { items: [], isIncomplete: false, truncated: false };
  }
  const capped = completions.entries.slice(0, ctx.limits.maxCompletionItems);
  return {
    items: capped.map(buildCompletionItem),
    isIncomplete: completions.isIncomplete ?? false,
    truncated: completions.entries.length > capped.length,
  };
}

function buildHover(
  ctx: LanguageProviderContext,
  service: ts.LanguageService,
  position: LanguagePosition,
): LanguageHoverResult {
  ctx.cancellation.throwIfCancellationRequested();
  const lineStarts = computeLineStarts(ctx.overlayText);
  const offset = positionToOffset(ctx.overlayText, lineStarts, position);
  const info = service.getQuickInfoAtPosition(ctx.overlayPath, offset);
  if (info === undefined) {
    return { contents: null };
  }
  const display = ts.displayPartsToString(info.displayParts);
  const documentation = ts.displayPartsToString(info.documentation);
  const contents = documentation.length > 0 ? `${display}\n\n${documentation}` : display;
  const range = spanToRange(ctx.overlayText, lineStarts, info.textSpan.start, info.textSpan.length);
  return { contents: contents.length > 0 ? contents : null, range };
}

function flattenSymbols(
  node: ts.NavigationTree,
  containerName: string | undefined,
  lineStarts: readonly number[],
  text: string,
  out: LanguageDocumentSymbol[],
  limit: number,
): void {
  for (const child of node.childItems ?? []) {
    if (out.length >= limit) return;
    const span = child.spans[0];
    const range = spanToRange(text, lineStarts, span?.start, span?.length);
    const symbol: LanguageDocumentSymbol = {
      name: child.text,
      kind: symbolKind(child.kind),
      range,
      ...(containerName !== undefined ? { containerName } : {}),
    };
    out.push(symbol);
    flattenSymbols(child, child.text, lineStarts, text, out, limit);
  }
}

function buildSymbols(
  ctx: LanguageProviderContext,
  service: ts.LanguageService,
): LanguageSymbolsRaw {
  ctx.cancellation.throwIfCancellationRequested();
  const tree = service.getNavigationTree(ctx.overlayPath);
  const lineStarts = computeLineStarts(ctx.overlayText);
  const out: LanguageDocumentSymbol[] = [];
  const limit = ctx.limits.maxSymbols;
  flattenSymbols(tree, undefined, lineStarts, ctx.overlayText, out, limit + 1);
  const truncated = out.length > limit;
  return { symbols: truncated ? out.slice(0, limit) : out, truncated };
}

export function createTypescriptLanguageProvider(): LanguageProvider {
  return {
    descriptor: DESCRIPTOR,
    supports: (languageId: string): boolean => TS_LANGUAGES.includes(languageId),
    getDiagnostics: (ctx): LanguageDiagnosticsRaw =>
      withService(ctx, (svc) => buildDiagnostics(ctx, svc)),
    getCompletions: (ctx, position): LanguageCompletionResult =>
      withService(ctx, (svc) => buildCompletions(ctx, svc, position)),
    getHover: (ctx, position): LanguageHoverResult =>
      withService(ctx, (svc) => buildHover(ctx, svc, position)),
    getSymbols: (ctx): LanguageSymbolsRaw => withService(ctx, (svc) => buildSymbols(ctx, svc)),
  };
}
