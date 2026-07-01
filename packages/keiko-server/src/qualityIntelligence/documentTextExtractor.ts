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
  QiDocumentTextExtractionInput,
} from "./runIngestion.js";

const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF_MEDIA_TYPE = "application/pdf";
const QI_DOCUMENT_PARSE_TIMEOUT_MS = 5_000;
const QI_DOCUMENT_PARSE_MAX_UNITS = 5_000;

function mediaTypeFor(input: QiDocumentTextExtractionInput): string {
  return input.format === "pdf" ? PDF_MEDIA_TYPE : DOCX_MEDIA_TYPE;
}

async function boundedReadDocumentBytes(
  input: QiDocumentTextExtractionInput,
): Promise<Uint8Array | undefined> {
  try {
    const stats = await stat(input.path);
    if (!stats.isFile() || stats.size > input.maxInputBytes) return undefined;
    const bytes = await readFile(input.path);
    return bytes.byteLength > input.maxInputBytes ? undefined : bytes;
  } catch {
    return undefined;
  }
}

export const extractQiDocumentText: QiAsyncDocumentTextExtractor = async (input) => {
  const bytes = await boundedReadDocumentBytes(input);
  if (bytes === undefined) return undefined;
  const extracted = await extractBoundedDocumentText(
    {
      bytes,
      extension: input.format,
      mediaType: mediaTypeFor(input),
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
  return extracted.outcome === "extracted" ? extracted.text : undefined;
};
