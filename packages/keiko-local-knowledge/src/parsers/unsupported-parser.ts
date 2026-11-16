// Unsupported-format parser (Epic #189, Issue #266). Emits a single
// `unsupported-media` ParsedUnit plus a typed `UNSUPPORTED_FORMAT` diagnostic so
// downstream layers (chunker #195, indexer #196, UI #198) can render a stable signal
// without sniffing the bytes themselves.
//
// CRITICAL: archives (.zip / .tar / .gz / .tar.gz) hit THIS adapter unchanged. We never
// open them — zip-bomb protection lives in not-decompressing, not in size caps.

import type { ParserAdapter, ParserOptions, ParserSelectionInput } from "./types.js";
import { diagnostic, emptyResult, signatureReason } from "./_internal.js";

const PARSER_ID = "unsupported";
const PARSER_VERSION = "2";

// Extensions we recognise but cannot handle in this PR. Each maps to a stable reason string
// so UI surfaces can render distinct guidance (e.g. "PDF — extract via OCR adapter").
const UNSUPPORTED_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  pdf: "pdf-not-implemented",
  docx: "docx-not-implemented",
  doc: "legacy-doc-not-implemented",
  png: "image-not-supported",
  jpg: "image-not-supported",
  jpeg: "image-not-supported",
  gif: "image-not-supported",
  bmp: "image-not-supported",
  tif: "image-not-supported",
  tiff: "image-not-supported",
  webp: "image-not-supported",
  mp3: "audio-not-supported",
  wav: "audio-not-supported",
  flac: "audio-not-supported",
  ogg: "audio-not-supported",
  mp4: "video-not-supported",
  mov: "video-not-supported",
  mkv: "video-not-supported",
  avi: "video-not-supported",
  webm: "video-not-supported",
  zip: "archive-not-decompressed",
  tar: "archive-not-decompressed",
  gz: "archive-not-decompressed",
  tgz: "archive-not-decompressed",
  bz2: "archive-not-decompressed",
  "7z": "archive-not-decompressed",
  rar: "archive-not-decompressed",
  exe: "binary-not-supported",
  dll: "binary-not-supported",
  bin: "binary-not-supported",
  so: "binary-not-supported",
  dylib: "binary-not-supported",
});

export function classifyUnsupported(input: ParserSelectionInput): string | undefined {
  // Extension table is checked first so that known formats (e.g. .docx, which IS a ZIP) get
  // the specific reason string rather than the generic magic-byte fallback.
  const lower = input.extension.toLowerCase();
  if (lower in UNSUPPORTED_EXTENSIONS) {
    return UNSUPPORTED_EXTENSIONS[lower];
  }
  // Fall back to signature sniffing for files with unknown/absent extensions. A bare two-letter
  // prefix is not a signature (see `hasImageSignature`).
  return signatureReason(input.bytes);
}

export const unsupportedParser: ParserAdapter = Object.freeze({
  capability: Object.freeze({
    parserId: PARSER_ID,
    parserVersion: PARSER_VERSION,
    matches: (input: ParserSelectionInput): boolean => classifyUnsupported(input) !== undefined,
  }),
  parse: (input: ParserSelectionInput, options: ParserOptions) => {
    const reason = classifyUnsupported(input) ?? "unknown-format";
    return emptyResult(
      unsupportedParser.capability,
      input.documentId,
      options,
      [
        diagnostic(
          "UNSUPPORTED_FORMAT",
          `format not parseable in this build (${reason})`,
          input.documentId,
          "info",
        ),
      ],
      [{ kind: "unsupported-media", documentId: input.documentId, reason }],
    );
  },
});
