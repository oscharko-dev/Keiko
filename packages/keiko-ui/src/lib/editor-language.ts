// Maps the deterministic language-service wire results (Issue #1198/#1201) into the editor package's
// diagnostics/hover/symbols/formatting response contracts. The host (keiko-ui) owns this seam: it
// calls the governed `POST /api/editor/language` BFF (`requestEditorDiagnostics`/`requestEditorHover`/
// `requestEditorSymbols`/`requestEditorFormatting`) and adapts the wire shapes to the editor's render
// contract. The editor package itself stays free of any BFF or contracts-wire knowledge (ADR-0042 D4).
//
// The only structural conversion is the position field name: the language-service contract uses LSP's
// zero-based `character`, while the editor uses zero-based `column` (both UTF-16 code units).

import type {
  EditorDiagnostic,
  EditorDiagnosticsResponse,
  EditorDocumentSymbol,
  EditorFormattingResponse,
  EditorHoverResponse,
  EditorRange,
  EditorRequestIdentity,
  EditorSymbolsResponse,
  EditorTextEdit,
} from "@oscharko-dev/keiko-editor";
import type {
  LanguageDiagnostic,
  LanguageDiagnosticsResult,
  LanguageDocumentSymbol,
  LanguageFormattingResult,
  LanguageHoverResult,
  LanguageRange,
  LanguageSymbolResult,
  LanguageTextEdit,
} from "./types";

/** Convert an LSP-style language-service range (line/character) to an editor range (line/column). */
function toEditorRange(range: LanguageRange): EditorRange {
  return {
    start: { line: range.start.line, column: range.start.character },
    end: { line: range.end.line, column: range.end.character },
  };
}

function toEditorDiagnostic(diagnostic: LanguageDiagnostic): EditorDiagnostic {
  return {
    range: toEditorRange(diagnostic.range),
    severity: diagnostic.severity,
    message: diagnostic.message,
    source: diagnostic.source,
    ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
  };
}

/** Adapt the diagnostics wire result into the editor diagnostics response. */
export function mapWireToEditorDiagnosticsResponse(
  request: EditorRequestIdentity,
  wire: LanguageDiagnosticsResult,
): EditorDiagnosticsResponse {
  return { request, diagnostics: wire.diagnostics.map(toEditorDiagnostic) };
}

/** Adapt the hover wire result into the editor hover response. */
export function mapWireToEditorHoverResponse(
  request: EditorRequestIdentity,
  wire: LanguageHoverResult,
): EditorHoverResponse {
  return {
    request,
    hover: {
      contents: wire.contents,
      ...(wire.range === undefined ? {} : { range: toEditorRange(wire.range) }),
    },
  };
}

function toEditorSymbol(symbol: LanguageDocumentSymbol): EditorDocumentSymbol {
  return {
    name: symbol.name,
    kind: symbol.kind,
    range: toEditorRange(symbol.range),
    ...(symbol.detail === undefined ? {} : { detail: symbol.detail }),
    ...(symbol.containerName === undefined ? {} : { containerName: symbol.containerName }),
  };
}

/** Adapt the document-symbols wire result into the editor symbols response. */
export function mapWireToEditorSymbolsResponse(
  request: EditorRequestIdentity,
  wire: LanguageSymbolResult,
): EditorSymbolsResponse {
  return { request, symbols: wire.symbols.map(toEditorSymbol) };
}

function toEditorTextEdit(edit: LanguageTextEdit): EditorTextEdit {
  return { range: toEditorRange(edit.range), newText: edit.newText };
}

/** Adapt the formatting wire result into the editor formatting response. */
export function mapWireToEditorFormattingResponse(
  request: EditorRequestIdentity,
  wire: LanguageFormattingResult,
): EditorFormattingResponse {
  return { request, edits: wire.edits.map(toEditorTextEdit) };
}
