// Deterministic synthetic streaming source + extractor for the bounded-RSS regression
// (Epic #1160, Issue #1286).
//
// The issue allows demonstrating bounded peak memory with "an equivalent synthetic streaming
// fixture" instead of committing a one-gigabyte binary document. This source never materializes
// the whole document: `readWindow` generates exactly the requested bytes on the fly via a pure
// position function, so a 1 GiB-class document can be driven through the progressive pipeline
// while only one page window of text is resident at a time.
//
// The byte layout is `totalPages` pages of `pageChars` ASCII letters each, separated by "\n\n"
// (matching the progressive PDF separator), so the synthetic extractor produces the same window
// shape as the real PDF strategy and exercises the identical persistence/checkpoint path.

import type { DocumentId } from "@oscharko-dev/keiko-contracts";

import type {
  ProgressiveExtractionOptions,
  ProgressiveExtractionSource,
  ProgressiveExtractionWindow,
  ProgressiveExtractor,
} from "./progressive-extraction.js";
import { WindowTextBuilder } from "./window-builder.js";

export interface SyntheticStreamingConfig {
  readonly totalPages: number;
  readonly pageChars: number;
  readonly pagesPerWindow: number;
}

const SEPARATOR_BYTES = 2; // "\n\n"
const NEWLINE = 0x0a;

function strideBytes(pageChars: number): number {
  return pageChars + SEPARATOR_BYTES;
}

// Deterministic, pure body byte for page `pageNumber` at intra-page index `k`. A-Z so every page
// differs and the produced text chunks are distinct.
function pageBodyByte(pageNumber: number, k: number): number {
  return 0x41 + ((pageNumber + k) % 26);
}

function byteAt(pos: number, pageChars: number): number {
  const stride = strideBytes(pageChars);
  const within = pos % stride;
  if (within < pageChars) {
    const pageNumber = Math.floor(pos / stride) + 1;
    return pageBodyByte(pageNumber, within);
  }
  return NEWLINE;
}

export function syntheticStreamingSource(
  config: SyntheticStreamingConfig,
): ProgressiveExtractionSource {
  const stride = strideBytes(config.pageChars);
  const totalBytes = config.totalPages * stride - SEPARATOR_BYTES;
  return {
    totalBytes,
    // Generates exactly `length` bytes; never allocates the whole document.
    readWindow: (startByte: number, length: number): Promise<Uint8Array> => {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) {
        out[i] = byteAt(startByte + i, config.pageChars);
      }
      return Promise.resolve(out);
    },
  };
}

function pageByteStart(pageNumber: number, pageChars: number): number {
  return (pageNumber - 1) * strideBytes(pageChars);
}

interface SyntheticState {
  cursor: number;
  anyPageEmitted: boolean;
  objectCursor: number;
  windowIndex: number;
}

async function syntheticWindow(
  readWindow: (startByte: number, length: number) => Promise<Uint8Array>,
  decoder: TextDecoder,
  documentId: DocumentId,
  config: SyntheticStreamingConfig,
  firstPage: number,
  lastPage: number,
  state: SyntheticState,
): Promise<ProgressiveExtractionWindow> {
  const builder = new WindowTextBuilder(documentId, state.cursor, state.anyPageEmitted);
  for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
    const bytes = await readWindow(pageByteStart(pageNumber, config.pageChars), config.pageChars);
    builder.addPage(pageNumber, decoder.decode(bytes));
    state.objectCursor += config.pageChars;
  }
  state.cursor = builder.nextCursor;
  state.anyPageEmitted = builder.hasEmittedAnyPage;
  const window: ProgressiveExtractionWindow = {
    windowIndex: state.windowIndex,
    pages: builder.snapshotPages(),
    units: builder.snapshotUnits(),
    text: builder.text(),
    characterStart: builder.characterStart,
    objectCursor: state.objectCursor,
    lastPageNumber: lastPage,
    diagnostics: [],
  };
  state.windowIndex += 1;
  return window;
}

async function* syntheticExtractWindows(
  config: SyntheticStreamingConfig,
  source: ProgressiveExtractionSource,
  options: ProgressiveExtractionOptions,
): AsyncIterable<ProgressiveExtractionWindow> {
  const readWindow = source.readWindow;
  if (readWindow === undefined) return;
  const decoder = new TextDecoder("utf-8");
  const resumeFromPage = options.resumeFromPage ?? 0;
  const state: SyntheticState = {
    cursor: options.resumeCharacterStart ?? 0,
    anyPageEmitted: resumeFromPage > 0,
    objectCursor: 0,
    windowIndex: 0,
  };
  for (
    let firstPage = resumeFromPage + 1;
    firstPage <= config.totalPages;
    firstPage += config.pagesPerWindow
  ) {
    if (options.signal?.aborted === true) return;
    const lastPage = Math.min(firstPage + config.pagesPerWindow - 1, config.totalPages);
    yield syntheticWindow(
      readWindow,
      decoder,
      options.documentId,
      config,
      firstPage,
      lastPage,
      state,
    );
  }
}

// A ProgressiveExtractor that reads page bytes from the streaming source one window at a time.
// `parserVersion` is configurable so resume-compatibility tests can simulate a parser upgrade.
export function syntheticProgressiveExtractor(
  config: SyntheticStreamingConfig,
  parserVersion = "synthetic@1",
): ProgressiveExtractor {
  return {
    strategyId: "progressive-pdf",
    parserVersion,
    matches: (input) => input.extension === "synthetic",
    extractWindows: (source, options) => syntheticExtractWindows(config, source, options),
  };
}
