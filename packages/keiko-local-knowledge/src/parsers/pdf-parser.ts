import type {
  PageRecord,
  ParsedUnit,
  ParserDiagnostic,
  ParserResult,
} from "@oscharko-dev/keiko-contracts";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

import { diagnostic, emptyResult, oversizeDiagnostic, shouldStop } from "./_internal.js";
import type {
  AsyncParserAdapter,
  ParserAdapter,
  ParserCapability,
  ParserOptions,
  ParserSelectionInput,
} from "./types.js";

const PARSER_ID = "pdf";
const PARSER_VERSION = "1";
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] as const;

function hasPdfMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) {
    if (bytes[i] !== PDF_MAGIC[i]) return false;
  }
  return true;
}

function isPdf(input: ParserSelectionInput): boolean {
  return (
    input.extension.toLowerCase() === "pdf" ||
    input.mediaType.toLowerCase() === "application/pdf" ||
    hasPdfMagic(input.bytes)
  );
}

function cancelled(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
): ParserResult {
  return emptyResult(capability, input.documentId, options, [
    diagnostic("PARSER_CANCELLED", "caller aborted parser", input.documentId, "info"),
  ]);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function syncFallback(capability: ParserCapability): ParserAdapter["parse"] {
  return (input, options) =>
    emptyResult(
      capability,
      input.documentId,
      options,
      [
        diagnostic(
          "UNSUPPORTED_FORMAT",
          "pdf parser requires async caller; use parseAsync via discovery",
          input.documentId,
          "info",
        ),
      ],
      [{ kind: "unsupported-media", documentId: input.documentId, reason: "pdf-async-required" }],
    );
}

function normalisePageText(items: readonly { readonly str?: string }[]): string {
  const tokens: string[] = [];
  for (const item of items) {
    const value = item.str?.trim();
    if (value !== undefined && value.length > 0) {
      tokens.push(value);
    }
  }
  return tokens.join(" ").trim();
}

async function asyncParse(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
): Promise<ParserResult> {
  if (input.bytes.byteLength > options.maxBytes) {
    return emptyResult(capability, input.documentId, options, [
      oversizeDiagnostic(input.documentId, input.bytes.byteLength, options.maxBytes),
    ]);
  }
  if (options.signal?.aborted === true) {
    return cancelled(capability, input, options);
  }

  const startedAt = options.now();
  try {
    const task = pdfjs.getDocument({
      data: input.bytes,
      useWorkerFetch: false,
      verbosity: 0,
    });
    const doc = await task.promise;
    const diagnostics: ParserDiagnostic[] = [];
    const pages: PageRecord[] = [];
    const units: ParsedUnit[] = [];
    let cursor = 0;
    let extractedPageCount = 0;

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const limit = shouldStop(startedAt, options, units.length);
      if (limit.stop) {
        if (limit.code !== undefined && limit.message !== undefined) {
          diagnostics.push(diagnostic(limit.code, limit.message, input.documentId, "info"));
        }
        break;
      }

      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = normalisePageText(content.items as readonly { readonly str?: string }[]);
      if (text.length === 0) {
        continue;
      }
      const pageStart = cursor;
      const pageEnd = cursor + text.length;
      const pageLabel = String(pageNumber);
      pages.push({
        documentId: input.documentId,
        pageNumber,
        pageLabel,
        characterStart: pageStart,
        characterEnd: pageEnd,
      });
      units.push({
        kind: "page",
        documentId: input.documentId,
        pageNumber,
        pageLabel,
        characterStart: pageStart,
        characterEnd: pageEnd,
      });
      cursor = pageEnd + 2;
      extractedPageCount += 1;
    }

    if (isAborted(options.signal)) {
      return cancelled(capability, input, options);
    }
    if (extractedPageCount === 0) {
      return emptyResult(
        capability,
        input.documentId,
        options,
        [
          diagnostic(
            "UNSUPPORTED_FORMAT",
            "pdf has no extractable text layer",
            input.documentId,
            "info",
          ),
        ],
        [{ kind: "unsupported-media", documentId: input.documentId, reason: "pdf-no-text-layer" }],
      );
    }

    return {
      documentId: input.documentId,
      parser: { parserId: capability.parserId, parserVersion: capability.parserVersion },
      pages,
      sections: [],
      units,
      diagnostics,
      extractedAt: options.now(),
    };
  } catch (error) {
    return emptyResult(capability, input.documentId, options, [
      diagnostic(
        "MALFORMED_INPUT",
        error instanceof Error ? error.message : "failed to parse pdf",
        input.documentId,
        "error",
      ),
    ]);
  }
}

const capability: ParserCapability = Object.freeze({
  parserId: PARSER_ID,
  parserVersion: PARSER_VERSION,
  matches: isPdf,
});

export const pdfParser: AsyncParserAdapter = Object.freeze({
  capability,
  parse: syncFallback(capability),
  parseAsync: (input: ParserSelectionInput, options: ParserOptions) =>
    asyncParse(capability, input, options),
});
