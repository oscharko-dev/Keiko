import { pathToFileURL } from "node:url";

import type { LanguageRange, LanguageServiceRequest } from "@oscharko-dev/keiko-contracts";

export const PROVIDER_CONFORMANCE_RANGE: LanguageRange = Object.freeze({
  start: { line: 0, character: 0 },
  end: { line: 0, character: 5 },
});

export interface ProviderConformanceDocument {
  readonly root: string;
  readonly path: string;
  readonly languageId: string;
  readonly text: string;
  readonly includeFormatting: boolean;
}

export function providerConformanceRequests(
  fixture: ProviderConformanceDocument,
): readonly LanguageServiceRequest[] {
  const { root, path, languageId, text } = fixture;
  const document = { path, languageId, text };
  const position = { line: 0, character: 4 };
  return [
    { operation: "diagnostics", root, document },
    { operation: "completion", root, document, position },
    { operation: "hover", root, document, position },
    { operation: "symbols", root, document },
    ...(fixture.includeFormatting ? ([{ operation: "formatting", root, document }] as const) : []),
    { operation: "definition", root, document, position },
    { operation: "typeDefinition", root, document, position },
    { operation: "implementation", root, document, position },
    { operation: "references", root, document, position },
    { operation: "callHierarchy", root, document, position },
    { operation: "inlayHints", root, document, range: PROVIDER_CONFORMANCE_RANGE },
    { operation: "renamePrepare", root, document, position },
    { operation: "renameApply", root, document, position, newName: "renamed" },
    {
      operation: "codeActions",
      root,
      document,
      range: PROVIDER_CONFORMANCE_RANGE,
      diagnostics: [],
    },
    { operation: "signatureHelp", root, document, position },
  ];
}

export function providerConformanceCapabilities(includeFormatting: boolean): unknown {
  return {
    capabilities: {
      textDocumentSync: 2,
      diagnosticProvider: true,
      completionProvider: {},
      hoverProvider: true,
      documentSymbolProvider: true,
      ...(includeFormatting ? { documentFormattingProvider: true } : {}),
      definitionProvider: true,
      typeDefinitionProvider: true,
      implementationProvider: true,
      referencesProvider: true,
      callHierarchyProvider: true,
      inlayHintProvider: true,
      renameProvider: { prepareProvider: true },
      codeActionProvider: true,
      signatureHelpProvider: {},
    },
  };
}

export function providerConformanceResults(
  absolutePath: string,
  includeFormatting: boolean,
): Readonly<Record<string, unknown>> {
  const uri = pathToFileURL(absolutePath).href;
  const range = PROVIDER_CONFORMANCE_RANGE;
  const item = { name: "value", kind: 12, uri, range, selectionRange: range };
  const edit = { changes: { [uri]: [{ range, newText: "renamed" }] } };
  return {
    "textDocument/diagnostic": { kind: "full", items: [] },
    "textDocument/completion": [{ label: "value", kind: 3 }],
    "textDocument/hover": { contents: "fixture symbol", range },
    "textDocument/documentSymbol": [{ name: "value", kind: 12, range }],
    ...(includeFormatting ? { "textDocument/formatting": [{ range, newText: "formatted" }] } : {}),
    "textDocument/definition": [{ uri, range }],
    "textDocument/typeDefinition": [{ uri, range }],
    "textDocument/implementation": [{ uri, range }],
    "textDocument/references": [{ uri, range }],
    "textDocument/prepareCallHierarchy": [item],
    "callHierarchy/incomingCalls": [{ from: item, fromRanges: [range] }],
    "callHierarchy/outgoingCalls": [{ to: item, fromRanges: [range] }],
    "textDocument/inlayHint": [{ position: range.end, label: ": type", kind: 1 }],
    "textDocument/prepareRename": { range, placeholder: "value" },
    "textDocument/rename": edit,
    "textDocument/codeAction": [{ title: "Review change", kind: "refactor", edit }],
    "textDocument/signatureHelp": { signatures: [{ label: "value()" }] },
  };
}
