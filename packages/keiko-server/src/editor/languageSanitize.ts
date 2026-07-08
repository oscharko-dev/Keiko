// Browser-display sanitisation for language-service results (Issue #1198 AC: "results are capped and
// sanitized for browser display"). Every string that crosses to the browser is stripped of bidi,
// zero-width, and control characters (reusing the contracts text-safety primitive) and clipped to
// the per-field length cap, so a hostile or pathological buffer cannot smuggle terminal escapes,
// direction overrides, or unbounded payloads into the editor. Redaction of secret-shaped strings is
// applied separately by the BFF live-payload redactor.

import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/text-safety";
import type {
  LanguageCodeAction,
  LanguageCodeActionsResult,
  LanguageCompletionItem,
  LanguageCompletionResult,
  LanguageDefinitionResult,
  LanguageDiagnostic,
  LanguageDiagnosticsResult,
  LanguageDocumentSymbol,
  LanguageFormattingResult,
  LanguageHoverResult,
  LanguageLocation,
  LanguageReferencesResult,
  LanguageRenameApplyResult,
  LanguageRenameChangesetFile,
  LanguageRenamePrepareResult,
  LanguageServiceLimits,
  LanguageSignatureHelpResult,
  LanguageSignatureInformation,
  LanguageSignatureParameterInformation,
  LanguageSymbolResult,
} from "@oscharko-dev/keiko-contracts";
import type {
  LanguageDiagnosticsRaw,
  LanguageFormattingRaw,
  LanguageSymbolsRaw,
} from "./languageProvider.js";

function clip(value: string, max: number): string {
  const safe = stripUnsafeFormatChars(value);
  return safe.length > max ? safe.slice(0, max) : safe;
}

function sanitizeDiagnostic(
  diagnostic: LanguageDiagnostic,
  limits: LanguageServiceLimits,
): LanguageDiagnostic {
  return {
    range: diagnostic.range,
    severity: diagnostic.severity,
    message: clip(diagnostic.message, limits.maxMessageChars),
    source: clip(diagnostic.source, limits.maxLabelChars),
    ...(diagnostic.code !== undefined ? { code: clip(diagnostic.code, limits.maxLabelChars) } : {}),
  };
}

export function sanitizeDiagnostics(
  raw: LanguageDiagnosticsRaw,
  limits: LanguageServiceLimits,
): LanguageDiagnosticsResult {
  const capped = raw.diagnostics.slice(0, limits.maxDiagnostics);
  return {
    diagnostics: capped.map((diagnostic) => sanitizeDiagnostic(diagnostic, limits)),
    truncated: raw.truncated || raw.diagnostics.length > capped.length,
  };
}

function sanitizeCompletionItem(
  item: LanguageCompletionItem,
  limits: LanguageServiceLimits,
): LanguageCompletionItem {
  return {
    label: clip(item.label, limits.maxLabelChars),
    kind: item.kind,
    ...(item.detail !== undefined ? { detail: clip(item.detail, limits.maxDetailChars) } : {}),
    ...(item.documentation !== undefined
      ? { documentation: clip(item.documentation, limits.maxDocumentationChars) }
      : {}),
    // insertText can carry a full snippet (for example an auto-import edit), so it uses the more
    // permissive detail cap rather than the short label cap.
    ...(item.insertText !== undefined
      ? { insertText: clip(item.insertText, limits.maxDetailChars) }
      : {}),
    ...(item.sortText !== undefined ? { sortText: clip(item.sortText, limits.maxLabelChars) } : {}),
  };
}

export function sanitizeCompletion(
  result: LanguageCompletionResult,
  limits: LanguageServiceLimits,
): LanguageCompletionResult {
  const capped = result.items.slice(0, limits.maxCompletionItems);
  return {
    items: capped.map((item) => sanitizeCompletionItem(item, limits)),
    isIncomplete: result.isIncomplete,
    truncated: result.truncated || result.items.length > capped.length,
  };
}

export function sanitizeHover(
  result: LanguageHoverResult,
  limits: LanguageServiceLimits,
): LanguageHoverResult {
  const contents = result.contents === null ? null : clip(result.contents, limits.maxHoverChars);
  return {
    contents,
    ...(result.range !== undefined ? { range: result.range } : {}),
  };
}

function sanitizeSymbol(
  symbol: LanguageDocumentSymbol,
  limits: LanguageServiceLimits,
): LanguageDocumentSymbol {
  return {
    name: clip(symbol.name, limits.maxLabelChars),
    kind: symbol.kind,
    range: symbol.range,
    ...(symbol.detail !== undefined ? { detail: clip(symbol.detail, limits.maxDetailChars) } : {}),
    ...(symbol.containerName !== undefined
      ? { containerName: clip(symbol.containerName, limits.maxLabelChars) }
      : {}),
  };
}

export function sanitizeSymbols(
  raw: LanguageSymbolsRaw,
  limits: LanguageServiceLimits,
): LanguageSymbolResult {
  const capped = raw.symbols.slice(0, limits.maxSymbols);
  return {
    symbols: capped.map((symbol) => sanitizeSymbol(symbol, limits)),
    truncated: raw.truncated || raw.symbols.length > capped.length,
  };
}

// Formatting edits are APPLIED to the buffer, not rendered, so — unlike the display surfaces above —
// their `newText` is left byte-faithful: stripping format characters would silently mutate the
// user's own code (for example characters inside a string literal) when they format. The bounds are
// the edit-count cap plus defensive per-edit and aggregate byte ceilings (the document-size
// envelope); over-budget edits are dropped rather than clipped, since clipping a reformat edit would
// corrupt the buffer, and the edits are non-overlapping so dropping one leaves the rest valid.
export function sanitizeFormatting(
  raw: LanguageFormattingRaw,
  limits: LanguageServiceLimits,
): LanguageFormattingResult {
  const capped = raw.edits.slice(0, limits.maxFormattingEdits);
  // Measure UTF-8 bytes so the per-edit ceiling matches the `maxDocumentBytes` byte budget rather
  // than UTF-16 code units (which would under-count multi-byte content).
  const withinLength: typeof capped = [];
  let totalBytes = 0;
  for (const edit of capped) {
    const byteLength = Buffer.byteLength(edit.newText, "utf8");
    if (byteLength > limits.maxDocumentBytes || totalBytes + byteLength > limits.maxDocumentBytes) {
      continue;
    }
    withinLength.push(edit);
    totalBytes += byteLength;
  }
  return {
    edits: withinLength,
    truncated:
      raw.truncated || raw.edits.length > capped.length || withinLength.length < capped.length,
  };
}

function sanitizeLocation(
  location: LanguageLocation,
  limits: LanguageServiceLimits,
): LanguageLocation {
  return { path: clip(location.path, limits.maxDetailChars), range: location.range };
}

export function sanitizeDefinition(
  raw: LanguageDefinitionResult,
  limits: LanguageServiceLimits,
): LanguageDefinitionResult {
  const capped = raw.locations.slice(0, limits.maxDefinitionLocations);
  return {
    locations: capped.map((location) => sanitizeLocation(location, limits)),
    truncated: raw.truncated || raw.locations.length > capped.length,
  };
}

export function sanitizeReferences(
  raw: LanguageReferencesResult,
  limits: LanguageServiceLimits,
): LanguageReferencesResult {
  const capped = raw.locations.slice(0, limits.maxReferenceLocations);
  return {
    locations: capped.map((location) => sanitizeLocation(location, limits)),
    includesDeclaration: raw.includesDeclaration,
    truncated: raw.truncated || raw.locations.length > capped.length,
  };
}

export function sanitizeRenamePrepare(
  raw: LanguageRenamePrepareResult,
  limits: LanguageServiceLimits,
): LanguageRenamePrepareResult {
  if (raw.range === null) {
    return { range: null, reason: clip(raw.reason, limits.maxMessageChars) };
  }
  return { range: raw.range, placeholder: clip(raw.placeholder, limits.maxLabelChars) };
}

function boundedRenameFile(
  file: LanguageRenameChangesetFile,
  remainingEdits: number,
): LanguageRenameChangesetFile {
  return {
    path: file.path,
    expectedContentHash: file.expectedContentHash,
    edits: file.edits.slice(0, remainingEdits),
  };
}

export function sanitizeRenameApply(
  raw: LanguageRenameApplyResult,
  limits: LanguageServiceLimits,
): LanguageRenameApplyResult {
  const files: LanguageRenameChangesetFile[] = [];
  let returnedEditCount = 0;
  for (const file of raw.files.slice(0, limits.maxRenameChangesetFiles)) {
    if (returnedEditCount >= limits.maxRenameChangesetEdits) break;
    const bounded = boundedRenameFile(file, limits.maxRenameChangesetEdits - returnedEditCount);
    if (bounded.edits.length === 0) continue;
    returnedEditCount += bounded.edits.length;
    files.push(bounded);
  }
  return {
    schemaVersion: raw.schemaVersion,
    files,
    truncated: raw.truncated || returnedEditCount < raw.totalEditCount,
    filesTruncated: raw.filesTruncated || files.length < raw.totalFileCount,
    returnedFileCount: files.length,
    totalFileCount: raw.totalFileCount,
    returnedEditCount,
    totalEditCount: raw.totalEditCount,
  };
}

function sanitizeCodeAction(
  action: LanguageCodeAction,
  limits: LanguageServiceLimits,
): LanguageCodeAction {
  return {
    title: clip(action.title, limits.maxLabelChars),
    kind: action.kind,
    edits: action.edits,
  };
}

export function sanitizeCodeActions(
  raw: LanguageCodeActionsResult,
  limits: LanguageServiceLimits,
): LanguageCodeActionsResult {
  const capped = raw.actions.slice(0, limits.maxCodeActions);
  return {
    actions: capped.map((action) => sanitizeCodeAction(action, limits)),
    truncated: raw.truncated || raw.actions.length > capped.length,
    returnedCount: capped.length,
    totalCount: raw.totalCount,
  };
}

function sanitizeSignatureParameter(
  parameter: LanguageSignatureParameterInformation,
  limits: LanguageServiceLimits,
): LanguageSignatureParameterInformation {
  return { label: clip(parameter.label, limits.maxLabelChars) };
}

function sanitizeSignature(
  signature: LanguageSignatureInformation,
  limits: LanguageServiceLimits,
): LanguageSignatureInformation {
  return {
    label: clip(signature.label, limits.maxDetailChars),
    ...(signature.documentation !== undefined
      ? { documentation: clip(signature.documentation, limits.maxDocumentationChars) }
      : {}),
    parameters: signature.parameters.map((parameter) =>
      sanitizeSignatureParameter(parameter, limits),
    ),
  };
}

export function sanitizeSignatureHelp(
  raw: LanguageSignatureHelpResult,
  limits: LanguageServiceLimits,
): LanguageSignatureHelpResult {
  const capped = raw.signatures.slice(0, limits.maxSignatures);
  return {
    signatures: capped.map((signature) => sanitizeSignature(signature, limits)),
    activeSignature:
      raw.activeSignature !== null && raw.activeSignature < capped.length
        ? raw.activeSignature
        : null,
    activeParameter: raw.activeParameter,
    truncated: raw.truncated || raw.signatures.length > capped.length,
    returnedCount: capped.length,
    totalCount: raw.totalCount,
  };
}
