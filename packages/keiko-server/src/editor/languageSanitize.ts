// Browser-display sanitisation for language-service results (Issue #1198 AC: "results are capped and
// sanitized for browser display"). Every string that crosses to the browser is stripped of bidi,
// zero-width, and control characters (reusing the contracts text-safety primitive) and clipped to
// the per-field length cap, so a hostile or pathological buffer cannot smuggle terminal escapes,
// direction overrides, or unbounded payloads into the editor. Redaction of secret-shaped strings is
// applied separately by the BFF live-payload redactor.

import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/text-safety";
import type {
  LanguageCompletionItem,
  LanguageCompletionResult,
  LanguageDiagnostic,
  LanguageDiagnosticsResult,
  LanguageDocumentSymbol,
  LanguageFormattingResult,
  LanguageHoverResult,
  LanguageServiceLimits,
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
// user's own code (for example characters inside a string literal) when they format. The only bounds
// are the edit-count cap and a defensive per-edit length ceiling (the document-size envelope); an
// over-long edit is dropped rather than clipped, since clipping a reformat edit would corrupt the
// buffer, and the edits are non-overlapping so dropping one leaves the rest valid. The BFF's
// live-payload redactor still runs over the response, exactly as it does for completion insert text.
export function sanitizeFormatting(
  raw: LanguageFormattingRaw,
  limits: LanguageServiceLimits,
): LanguageFormattingResult {
  const capped = raw.edits.slice(0, limits.maxFormattingEdits);
  // Measure UTF-8 bytes so the per-edit ceiling matches the `maxDocumentBytes` byte budget rather
  // than UTF-16 code units (which would under-count multi-byte content).
  const withinLength = capped.filter(
    (edit) => Buffer.byteLength(edit.newText, "utf8") <= limits.maxDocumentBytes,
  );
  return {
    edits: withinLength,
    truncated:
      raw.truncated || raw.edits.length > capped.length || withinLength.length < capped.length,
  };
}
