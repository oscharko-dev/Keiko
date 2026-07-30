// Maps the deterministic language-service wire results (Issue #1198/#1201) into the editor package's
// diagnostics/hover/symbols/formatting response contracts. The host (keiko-ui) owns this seam: it
// calls the governed `POST /api/editor/language` BFF (`requestEditorDiagnostics`/`requestEditorHover`/
// `requestEditorSymbols`/`requestEditorFormatting`) and adapts the wire shapes to the editor's render
// contract. The editor package itself stays free of any BFF or contracts-wire knowledge (ADR-0042 D4).
//
// The only structural conversion is the position field name: the language-service contract uses LSP's
// zero-based `character`, while the editor uses zero-based `column` (both UTF-16 code units).
//
// The wire results carry a `truncated` flag (set when the server caps diagnostics/symbols/formatting
// edits/locations/actions at the configured bounds). It IS threaded into the editor render contracts.
// It used to be dropped here as "server-side evidence only", on the reasoning that the caps are
// defensive ceilings a legitimate document does not reach — but dropping it makes a capped result
// pixel-identical to a complete one, so on the day a cap does bind, the editor silently claims the
// partial list is the whole answer. The editor's shared outcome seam classifies a `truncated` result
// as `capped` and the status bar labels it; hover has no cap (a single string) and therefore no flag.
//
// Labelling is the floor for a RENDER surface, and is deliberately not the whole treatment for a
// result the host then applies to a buffer or to disk: a capped mutation silently performs part of an
// operation the user asked for in full, so a label is not enough. The rename path therefore carries
// its own bounding facts through to the review surface and refuses Accept while they are present
// (`renameChangesetTruncation`, `keiko-editor`) instead of mapping through this seam. Any future
// mapper here that feeds an apply path needs that stricter treatment, not just the `capped` label.

import type {
  EditorCodeAction,
  EditorCallHierarchyCall,
  EditorCallHierarchyItem,
  EditorCallHierarchyResponse,
  EditorCodeActionsResponse,
  EditorDefinitionResponse,
  EditorDiagnostic,
  EditorDiagnosticsResponse,
  EditorDocumentSymbol,
  EditorFormattingResponse,
  EditorHoverResponse,
  EditorInlayHintsResponse,
  EditorLocation,
  EditorRange,
  EditorReferencesResponse,
  EditorRequestIdentity,
  EditorSignatureHelpResponse,
  EditorSignatureInformation,
  EditorSymbolsResponse,
  EditorTextEdit,
} from "@oscharko-dev/keiko-editor";
import type {
  LanguageCallHierarchyIncomingCall,
  LanguageCallHierarchyItem,
  LanguageCallHierarchyOutgoingCall,
  LanguageCallHierarchyResult,
  LanguageInlayHintsResult,
} from "@oscharko-dev/keiko-contracts";
import type {
  LanguageCodeAction,
  LanguageCodeActionsResult,
  LanguageDiagnostic,
  LanguageDefinitionResult,
  LanguageDiagnosticsResult,
  LanguageDocumentSymbol,
  LanguageFormattingResult,
  LanguageHoverResult,
  LanguageLocation,
  LanguageRange,
  LanguageReferencesResult,
  LanguageSignatureHelpResult,
  LanguageSignatureInformation,
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
  return {
    request,
    diagnostics: wire.diagnostics.map(toEditorDiagnostic),
    truncated: wire.truncated,
  };
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
  return { request, symbols: wire.symbols.map(toEditorSymbol), truncated: wire.truncated };
}

function toEditorTextEdit(edit: LanguageTextEdit): EditorTextEdit {
  return { range: toEditorRange(edit.range), newText: edit.newText };
}

/** Adapt the formatting wire result into the editor formatting response. */
export function mapWireToEditorFormattingResponse(
  request: EditorRequestIdentity,
  wire: LanguageFormattingResult,
): EditorFormattingResponse {
  return { request, edits: wire.edits.map(toEditorTextEdit), truncated: wire.truncated };
}

function toEditorLocation(location: LanguageLocation): EditorLocation {
  return { path: location.path, range: toEditorRange(location.range) };
}

/** Adapt the definition wire result into the editor definition response. */
export function mapWireToEditorDefinitionResponse(
  request: EditorRequestIdentity,
  wire: LanguageDefinitionResult,
): EditorDefinitionResponse {
  return { request, locations: wire.locations.map(toEditorLocation), truncated: wire.truncated };
}

function toEditorCallHierarchyItem(item: LanguageCallHierarchyItem): EditorCallHierarchyItem {
  return {
    name: item.name,
    kind: item.kind,
    path: item.path,
    range: toEditorRange(item.range),
    selectionRange: toEditorRange(item.selectionRange),
    ...(item.containerName === undefined ? {} : { containerName: item.containerName }),
  };
}

function toEditorCallHierarchyCall(
  call: LanguageCallHierarchyIncomingCall | LanguageCallHierarchyOutgoingCall,
): EditorCallHierarchyCall {
  return {
    item: toEditorCallHierarchyItem(call.item),
    fromRanges: call.fromRanges.map(toEditorRange),
  };
}

export function mapWireToEditorCallHierarchyResponse(
  request: EditorRequestIdentity,
  wire: LanguageCallHierarchyResult,
): EditorCallHierarchyResponse {
  return {
    request,
    roots: wire.roots.map((root) => ({
      item: toEditorCallHierarchyItem(root.item),
      incomingCalls: root.incomingCalls.map(toEditorCallHierarchyCall),
      outgoingCalls: root.outgoingCalls.map(toEditorCallHierarchyCall),
    })),
    truncated: wire.truncated,
  };
}

export function mapWireToEditorInlayHintsResponse(
  request: EditorRequestIdentity,
  wire: LanguageInlayHintsResult,
): EditorInlayHintsResponse {
  return {
    request,
    hints: wire.hints.map((hint) => ({
      position: { line: hint.position.line, column: hint.position.character },
      label: hint.label,
      kind: hint.kind,
      ...(hint.paddingLeft === undefined ? {} : { paddingLeft: hint.paddingLeft }),
      ...(hint.paddingRight === undefined ? {} : { paddingRight: hint.paddingRight }),
    })),
    truncated: wire.truncated,
  };
}

/** Adapt the references wire result into the editor references response. */
export function mapWireToEditorReferencesResponse(
  request: EditorRequestIdentity,
  wire: LanguageReferencesResult,
): EditorReferencesResponse {
  return {
    request,
    locations: wire.locations.map(toEditorLocation),
    includesDeclaration: wire.includesDeclaration,
    truncated: wire.truncated,
  };
}

function toEditorCodeAction(action: LanguageCodeAction): EditorCodeAction {
  return {
    title: action.title,
    kind: action.kind,
    edits: action.edits === null ? null : action.edits.map(toEditorTextEdit),
  };
}

/** Adapt the code-action wire result into the editor code-action response. */
export function mapWireToEditorCodeActionsResponse(
  request: EditorRequestIdentity,
  wire: LanguageCodeActionsResult,
): EditorCodeActionsResponse {
  return { request, actions: wire.actions.map(toEditorCodeAction), truncated: wire.truncated };
}

function toEditorSignature(signature: LanguageSignatureInformation): EditorSignatureInformation {
  return {
    label: signature.label,
    ...(signature.documentation === undefined ? {} : { documentation: signature.documentation }),
    parameters: signature.parameters.map((parameter) => ({ label: parameter.label })),
  };
}

/** Adapt the signature-help wire result into the editor signature-help response. */
export function mapWireToEditorSignatureHelpResponse(
  request: EditorRequestIdentity,
  wire: LanguageSignatureHelpResult,
): EditorSignatureHelpResponse {
  return {
    request,
    signatures: wire.signatures.map(toEditorSignature),
    activeSignature: wire.activeSignature,
    activeParameter: wire.activeParameter,
    truncated: wire.truncated,
  };
}
