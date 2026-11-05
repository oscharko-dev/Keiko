// Quality Intelligence PDF/DOCX single-file text extraction.
//
// The QI ingestion layer already owns path validation, deny-list checks, symlink containment, and
// source-level byte budgets. This adapter supplies only the parser-backed text projection for
// document formats whose raw bytes cannot be treated as UTF-8 prose. It reuses Local Knowledge's
// bounded parser facade so QI does not grow a second PDF/DOCX parsing implementation.

import { readFile, stat } from "node:fs/promises";
import { extractBoundedDocumentText } from "@oscharko-dev/keiko-local-knowledge";
import type {
  QiAsyncDocumentTextExtractor,
  QiDocumentFailure,
  QiDocumentTextExtractionInput,
} from "./runIngestion.js";

const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF_MEDIA_TYPE = "application/pdf";
const HTML_MEDIA_TYPE = "text/html";
const QI_DOCUMENT_PARSE_TIMEOUT_MS = 5_000;
const QI_DOCUMENT_PARSE_MAX_UNITS = 5_000;

const MEDIA_TYPES: Readonly<Record<QiDocumentTextExtractionInput["format"], string>> = {
  pdf: PDF_MEDIA_TYPE,
  docx: DOCX_MEDIA_TYPE,
  html: HTML_MEDIA_TYPE,
};

type BoundedRead =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "failed"; readonly failure: QiDocumentFailure };

async function boundedReadDocumentBytes(
  input: QiDocumentTextExtractionInput,
): Promise<BoundedRead> {
  try {
    const stats = await stat(input.path);
    if (!stats.isFile()) return { kind: "failed", failure: "unreadable" };
    if (stats.size > input.maxInputBytes) return { kind: "failed", failure: "oversized" };
    const bytes = await readFile(input.path);
    return bytes.byteLength > input.maxInputBytes
      ? { kind: "failed", failure: "oversized" }
      : { kind: "bytes", bytes };
  } catch {
    // The caller names the closed reason ("unreadable") in the ingestion error it raises.
    return { kind: "failed", failure: "unreadable" };
  }
}

export const extractQiDocumentText: QiAsyncDocumentTextExtractor = async (input) => {
  const read = await boundedReadDocumentBytes(input);
  if (read.kind === "failed") return { failure: read.failure };
  const extracted = await extractBoundedDocumentText(
    {
      bytes: read.bytes,
      extension: input.format,
      mediaType: MEDIA_TYPES[input.format],
    },
    {
      maxInputBytes: input.maxInputBytes,
      maxOutputBytes: input.maxExtractedBytes,
      maxUnits: QI_DOCUMENT_PARSE_MAX_UNITS,
      timeoutMs: QI_DOCUMENT_PARSE_TIMEOUT_MS,
      now: () => Date.now(),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  );
  // The parser's own cut is passed on: the text is already within budget, so the ingestion byte
  // bound alone could not tell the user that part of the document is missing.
  return extracted.outcome === "extracted"
    ? { text: extracted.text, truncated: extracted.truncated }
    : { failure: extracted.outcome };
};
