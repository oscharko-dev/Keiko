// Controlled legacy-format handling (Epic #1160, Issue #1286).
//
// Legacy binary office formats (.doc, .ppt, .xls) predate the OOXML containers the docx/xlsx
// parsers handle. Keiko does not bundle a converter for them. Rather than crashing or emitting a
// generic "unknown format" signal, the large-document path reports a stable CONVERTER_UNAVAILABLE
// diagnostic with actionable, content-free guidance, leaving the indexing job stable.

import type { DocumentId, ParserDiagnostic } from "@oscharko-dev/keiko-contracts";
import { LARGE_DOCUMENT_DIAGNOSTIC_CODES } from "@oscharko-dev/keiko-contracts";

import { largeDocumentDiagnostic } from "./diagnostics.js";

const LEGACY_FORMAT_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  doc: "Legacy Microsoft Word (.doc) is not supported; re-save the file as .docx or PDF and reindex.",
  ppt: "Legacy Microsoft PowerPoint (.ppt) is not supported; re-save the file as .pptx or PDF and reindex.",
  xls: "Legacy Microsoft Excel (.xls) is not supported; re-save the file as .xlsx or CSV and reindex.",
});

export function isLegacyBinaryOfficeFormat(extension: string): boolean {
  return extension.toLowerCase() in LEGACY_FORMAT_GUIDANCE;
}

export function legacyFormatGuidance(extension: string): string | undefined {
  return LEGACY_FORMAT_GUIDANCE[extension.toLowerCase()];
}

export function legacyFormatDiagnostic(
  extension: string,
  documentId: DocumentId,
): ParserDiagnostic | undefined {
  const guidance = legacyFormatGuidance(extension);
  if (guidance === undefined) return undefined;
  return largeDocumentDiagnostic(
    LARGE_DOCUMENT_DIAGNOSTIC_CODES.CONVERTER_UNAVAILABLE,
    guidance,
    documentId,
    "warning",
  );
}
