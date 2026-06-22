// Content-free diagnostic builders for the bounded large-document ingestion path
// (Epic #1160, Issue #1286). The contract `ParserDiagnostic.code` is a free `string`, so the
// large-document codes (PARTIAL_COVERAGE, OCR_CAPABILITY_UNAVAILABLE, ...) coexist with the
// closed `ParserErrorCode` union the existing adapters use. These diagnostics are never
// error-severity for capability/coverage limits, so downstream layers do not treat a missing
// optional capability as a hard document failure.

import type {
  DocumentId,
  LargeDocumentDiagnosticCode,
  ParserDiagnostic,
  ParserDiagnosticSeverity,
} from "@oscharko-dev/keiko-contracts";

export function largeDocumentDiagnostic(
  code: LargeDocumentDiagnosticCode,
  message: string,
  documentId: DocumentId,
  severity: ParserDiagnosticSeverity = "warning",
  pageNumber?: number,
): ParserDiagnostic {
  return pageNumber === undefined
    ? { severity, code, message, documentId }
    : { severity, code, message, documentId, pageNumber };
}
