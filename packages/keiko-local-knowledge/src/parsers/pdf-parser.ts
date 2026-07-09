import type {
  PageRecord,
  ParsedUnit,
  ParserDiagnostic,
  ParserResult,
} from "@oscharko-dev/keiko-contracts";
import { LOCAL_KNOWLEDGE_PDF_FILE_EXTENSIONS } from "@oscharko-dev/keiko-contracts";

import {
  diagnostic,
  emptyResult,
  objectLimitDiagnostic,
  oversizeDiagnostic,
  parserIdentity,
  shouldStop,
} from "./_internal.js";
import type {
  AsyncParserAdapter,
  InternalParserResult,
  ParserAdapter,
  ParserCapability,
  ParserOptions,
  ParserSelectionInput,
} from "./types.js";
import { WindowTextBuilder } from "./large-document/window-builder.js";

const PARSER_ID = "pdf";
const PARSER_VERSION = "1";
const DEPENDENCY_VERSIONS = Object.freeze([
  Object.freeze({ packageName: "pdfjs-dist", version: "6.0.227" }),
  Object.freeze({ packageName: "@napi-rs/canvas", version: "1.0.0" }),
]);
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] as const;
const PDF_EXTENSIONS: ReadonlySet<string> = new Set(LOCAL_KNOWLEDGE_PDF_FILE_EXTENSIONS);

export interface PdfTextItem {
  readonly str?: string;
  readonly transform?: readonly number[];
  readonly width?: number;
  readonly height?: number;
  readonly hasEOL?: boolean;
}

export interface PdfTextContentChunk {
  readonly items: readonly PdfTextItem[];
}

export interface PdfPageLike {
  readonly streamTextContent: () => ReadableStream<PdfTextContentChunk>;
}

export interface PdfDocumentLike {
  readonly numPages: number;
  readonly getPage: (pageNumber: number) => Promise<PdfPageLike>;
  readonly getPageLabels?: () => Promise<readonly (string | null)[] | null>;
}

interface PdfLoadingTaskLike {
  readonly promise: Promise<PdfDocumentLike>;
}

export interface PdfDocumentSource {
  readonly totalBytes: number;
  readonly loadFullBuffer?: () => Promise<Uint8Array>;
  readonly readWindow?: (startByte: number, length: number) => Promise<Uint8Array>;
}

interface PdfRangeTransportInstance {
  readonly onDataRange: (begin: number, chunk: Uint8Array) => void;
}

type PdfDataRangeTransportCtor = new (
  length: number,
  initialData?: Uint8Array,
  progressiveDone?: boolean,
) => PdfRangeTransportInstance;

interface PdfJsModule {
  readonly getDocument: (params: {
    readonly data?: Uint8Array;
    readonly range?: PdfRangeTransportInstance;
    readonly rangeChunkSize?: number;
    readonly disableAutoFetch?: boolean;
    readonly disableStream?: boolean;
    readonly useWorkerFetch: false;
    readonly verbosity: 0;
  }) => PdfLoadingTaskLike;
  readonly PDFDataRangeTransport: PdfDataRangeTransportCtor;
}

function pdfMatrixValue(
  init: readonly number[] | undefined,
  index: number,
  fallback: number,
): number {
  return init?.length === 6 ? (init[index] ?? fallback) : fallback;
}

class PdfTextDomMatrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
  readonly is2D = true;
  readonly isIdentity: boolean;
  readonly m11: number;
  readonly m12 = 0;
  readonly m13 = 0;
  readonly m14 = 0;
  readonly m21 = 0;
  readonly m22: number;
  readonly m23 = 0;
  readonly m24 = 0;
  readonly m31 = 0;
  readonly m32 = 0;
  readonly m33 = 1;
  readonly m34 = 0;
  readonly m41: number;
  readonly m42: number;
  readonly m43 = 0;
  readonly m44 = 1;

  constructor(init?: readonly number[]) {
    this.a = pdfMatrixValue(init, 0, 1);
    this.b = pdfMatrixValue(init, 1, 0);
    this.c = pdfMatrixValue(init, 2, 0);
    this.d = pdfMatrixValue(init, 3, 1);
    this.e = pdfMatrixValue(init, 4, 0);
    this.f = pdfMatrixValue(init, 5, 0);
    this.m11 = this.a;
    this.m22 = this.d;
    this.m41 = this.e;
    this.m42 = this.f;
    this.isIdentity =
      this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }

  multiplySelf(): this {
    return this;
  }

  preMultiplySelf(): this {
    return this;
  }

  translateSelf(): this {
    return this;
  }

  scaleSelf(): this {
    return this;
  }

  rotateSelf(): this {
    return this;
  }

  invertSelf(): this {
    return this;
  }

  transformPoint(point: { readonly x?: number; readonly y?: number } = {}): {
    readonly x: number;
    readonly y: number;
  } {
    return { x: point.x ?? 0, y: point.y ?? 0 };
  }

  toFloat32Array(): Float32Array {
    return new Float32Array([
      this.a,
      this.b,
      0,
      0,
      this.c,
      this.d,
      0,
      0,
      0,
      0,
      1,
      0,
      this.e,
      this.f,
      0,
      1,
    ]);
  }

  toFloat64Array(): Float64Array {
    return new Float64Array(this.toFloat32Array());
  }
}

class PdfTextImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;

  constructor(dataOrWidth: Uint8ClampedArray | number, width?: number, height?: number) {
    if (dataOrWidth instanceof Uint8ClampedArray) {
      this.data = dataOrWidth;
      this.width = width ?? 0;
      this.height = height ?? 0;
      return;
    }
    this.width = dataOrWidth;
    this.height = width ?? 0;
    this.data = new Uint8ClampedArray(this.width * this.height * 4);
  }
}

function installPdfTextExtractionDomPolyfills(): void {
  const target = globalThis as {
    DOMMatrix?: unknown;
    ImageData?: unknown;
    Path2D?: unknown;
  };
  target.DOMMatrix ??= PdfTextDomMatrix;
  target.ImageData ??= PdfTextImageData;
  target.Path2D ??= function PdfTextPath2D(): void {
    return undefined;
  };
}

function hasPdfMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) {
    if (bytes[i] !== PDF_MAGIC[i]) return false;
  }
  return true;
}

function isPdf(input: ParserSelectionInput): boolean {
  return (
    PDF_EXTENSIONS.has(input.extension.toLowerCase()) ||
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
  return (input, options) => {
    return emptyResult(
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
      [unsupportedMediaUnit(input.documentId, "pdf-async-required")],
    );
  };
}

export async function loadPdfDocument(bytes: Uint8Array): Promise<PdfDocumentLike> {
  // pdfjs-dist imports browser geometry constructors even for text-layer extraction.
  // Keiko does not render PDFs here, so minimal no-op constructors are sufficient.
  installPdfTextExtractionDomPolyfills();
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJsModule;
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    useWorkerFetch: false,
    verbosity: 0,
  });
  return task.promise;
}

const PDF_RANGE_CHUNK_BYTES = 256 * 1024;

function createRangeTransport(
  Transport: PdfDataRangeTransportCtor,
  source: Required<Pick<PdfDocumentSource, "totalBytes" | "readWindow">>,
): PdfRangeTransportInstance {
  class WorkspacePdfRangeTransport extends Transport {
    requestDataRange(begin: number, end: number): void {
      const start = Math.max(0, Math.floor(begin));
      const length = Math.max(0, Math.floor(end) - start);
      void source
        .readWindow(start, length)
        .then((chunk) => {
          this.onDataRange(start, chunk);
        })
        .catch(() => {
          this.onDataRange(start, new Uint8Array(0));
        });
    }
  }
  return new WorkspacePdfRangeTransport(source.totalBytes, new Uint8Array(0), false);
}

export async function loadPdfDocumentFromSource(
  source: PdfDocumentSource,
): Promise<PdfDocumentLike> {
  if (source.loadFullBuffer !== undefined) {
    return loadPdfDocument(await source.loadFullBuffer());
  }
  if (source.readWindow === undefined) {
    throw new Error("pdf source does not support range reads");
  }
  installPdfTextExtractionDomPolyfills();
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJsModule;
  const task = pdfjs.getDocument({
    range: createRangeTransport(pdfjs.PDFDataRangeTransport, {
      totalBytes: source.totalBytes,
      readWindow: source.readWindow,
    }),
    rangeChunkSize: PDF_RANGE_CHUNK_BYTES,
    disableAutoFetch: true,
    disableStream: true,
    useWorkerFetch: false,
    verbosity: 0,
  });
  return task.promise;
}

function unsupportedMediaUnit(
  documentId: ParserSelectionInput["documentId"],
  reason: string,
): ParsedUnit {
  return { kind: "unsupported-media", documentId, reason };
}

export interface PageTextReadState {
  readonly input: ParserSelectionInput;
  readonly options: ParserOptions;
  readonly startedAt: number;
  readonly emittedUnits: number;
  readonly scannedObjects: number;
}

export interface PageTextReadResult {
  readonly text: string;
  readonly scannedObjects: number;
  readonly diagnostic?: ParserDiagnostic;
}

function limitDiagnostic(
  input: ParserSelectionInput,
  limit: ReturnType<typeof shouldStop>,
): ParserDiagnostic | undefined {
  if (!limit.stop || limit.code === undefined || limit.message === undefined) {
    return undefined;
  }
  return diagnostic(limit.code, limit.message, input.documentId, "info");
}

function pageTextStopDiagnostic(state: PageTextReadState): ParserDiagnostic | undefined {
  if (state.scannedObjects >= state.options.maxObjectsPerDocument) {
    return objectLimitDiagnostic(state.input.documentId, state.options.maxObjectsPerDocument);
  }
  return limitDiagnostic(
    state.input,
    shouldStop(state.startedAt, state.options, state.emittedUnits),
  );
}

function appendPdfTextItems(
  itemsOut: PdfTextItem[],
  items: readonly PdfTextItem[],
  state: PageTextReadState,
): { readonly state: PageTextReadState; readonly diagnostic?: ParserDiagnostic } {
  let next = state;
  for (const item of items) {
    const stopped = pageTextStopDiagnostic(next);
    if (stopped !== undefined) {
      return { state: next, diagnostic: stopped };
    }
    next = { ...next, scannedObjects: next.scannedObjects + 1 };
    const value = normalizePdfText(item.str ?? "").trim();
    if (value.length > 0) {
      itemsOut.push({ ...item, str: value });
    }
  }
  return { state: next };
}

function normalizePdfText(value: string): string {
  return value
    .replaceAll("\ufb00", "ff")
    .replaceAll("\ufb01", "fi")
    .replaceAll("\ufb02", "fl")
    .replaceAll("\ufb03", "ffi")
    .replaceAll("\ufb04", "ffl");
}

interface PositionedLine {
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

function itemX(item: PdfTextItem): number {
  return item.transform?.[4] ?? 0;
}

function itemY(item: PdfTextItem): number {
  return item.transform?.[5] ?? 0;
}

function hasPosition(item: PdfTextItem): boolean {
  return item.transform !== undefined && item.transform.length >= 6;
}

function lineForItem(
  lines: readonly {
    readonly x: number;
    readonly y: number;
    readonly items: readonly PdfTextItem[];
  }[],
  item: PdfTextItem,
): number {
  const y = itemY(item);
  const x = itemX(item);
  const index = lines.findIndex((line) => Math.abs(line.y - y) <= 3 && Math.abs(line.x - x) <= 180);
  return index;
}

function positionedLines(items: readonly PdfTextItem[]): readonly PositionedLine[] {
  const mutable: { text: string; x: number; y: number; items: PdfTextItem[] }[] = [];
  for (const item of items) {
    const existing = lineForItem(mutable, item);
    if (existing >= 0) {
      mutable[existing]?.items.push(item);
      continue;
    }
    mutable.push({ text: "", x: itemX(item), y: itemY(item), items: [item] });
  }
  return mutable.map((line) => {
    const ordered = [...line.items].sort((a, b) => itemX(a) - itemX(b));
    return {
      text: ordered
        .map((item) => item.str ?? "")
        .join(" ")
        .trim(),
      x: Math.min(...ordered.map(itemX)),
      y: line.y,
    };
  });
}

function largestColumnGap(lines: readonly PositionedLine[]): {
  readonly index: number;
  readonly gap: number;
} {
  const ordered = [...lines].sort((a, b) => a.x - b.x);
  let best = { index: -1, gap: 0 };
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const gap = (ordered[i + 1]?.x ?? 0) - (ordered[i]?.x ?? 0);
    if (gap > best.gap) best = { index: i, gap };
  }
  return best;
}

function orderedPositionedText(items: readonly PdfTextItem[]): string {
  const lines = positionedLines(items).filter((line) => line.text.length > 0);
  if (lines.length === 0) return "";
  const gap = largestColumnGap(lines);
  if (gap.index >= 0 && gap.gap >= 80) {
    const orderedByX = [...lines].sort((a, b) => a.x - b.x);
    const splitX = ((orderedByX[gap.index]?.x ?? 0) + (orderedByX[gap.index + 1]?.x ?? 0)) / 2;
    const left = lines.filter((line) => line.x <= splitX).sort((a, b) => b.y - a.y || a.x - b.x);
    const right = lines.filter((line) => line.x > splitX).sort((a, b) => b.y - a.y || a.x - b.x);
    return [...left, ...right]
      .map((line) => line.text)
      .join("\n")
      .trim();
  }
  return [...lines]
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .map((line) => line.text)
    .join("\n")
    .trim();
}

function itemsText(items: readonly PdfTextItem[]): string {
  if (items.some(hasPosition)) return orderedPositionedText(items);
  return items
    .map((item) => item.str?.trim() ?? "")
    .filter((value) => value.length > 0)
    .join(" ")
    .trim();
}

export async function readPageText(
  page: PdfPageLike,
  state: PageTextReadState,
): Promise<PageTextReadResult> {
  const reader = page.streamTextContent().getReader();
  const items: PdfTextItem[] = [];
  let next = state;
  try {
    for (;;) {
      const stopped = pageTextStopDiagnostic(next);
      if (stopped !== undefined) {
        return {
          text: itemsText(items),
          scannedObjects: next.scannedObjects,
          diagnostic: stopped,
        };
      }
      const read = await reader.read();
      if (read.done) {
        return { text: itemsText(items), scannedObjects: next.scannedObjects };
      }
      const chunk = read.value;
      const appended = appendPdfTextItems(items, chunk.items, next);
      next = appended.state;
      if (appended.diagnostic !== undefined) {
        return {
          text: itemsText(items),
          scannedObjects: next.scannedObjects,
          diagnostic: appended.diagnostic,
        };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function noTextResult(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
  diagnostics: readonly ParserDiagnostic[] = [],
): ParserResult {
  if (diagnostics.length > 0) {
    return emptyResult(capability, input.documentId, options, diagnostics);
  }
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
    [unsupportedMediaUnit(input.documentId, "pdf-no-text-layer")],
  );
}

async function pageLabelsFor(doc: PdfDocumentLike): Promise<readonly (string | null)[]> {
  try {
    return (await doc.getPageLabels?.()) ?? [];
  } catch {
    return [];
  }
}

function pageLabelFor(labels: readonly (string | null)[], pageNumber: number): string | undefined {
  return labels[pageNumber - 1] ?? undefined;
}

function pageFailureDiagnostic(
  input: ParserSelectionInput,
  pageNumber: number,
  code: "PAGE_PARSE_FAILED" | "PAGE_TEXT_UNREADABLE",
  message: string,
): ParserDiagnostic {
  return { code, message, documentId: input.documentId, severity: "warning", pageNumber };
}

function pdfLoadFailureDiagnostic(input: ParserSelectionInput, cause: unknown): ParserDiagnostic {
  const name =
    cause instanceof Error
      ? `${cause.name} ${cause.message}`.toLowerCase()
      : String(cause).toLowerCase();
  if (name.includes("password") || name.includes("encrypted")) {
    return {
      code: "ENCRYPTED_PDF",
      message: "pdf parser rejected encrypted document",
      documentId: input.documentId,
      severity: "error",
    };
  }
  return {
    code: "MALFORMED_INPUT",
    message: "pdf parser rejected malformed or unsupported document",
    documentId: input.documentId,
    severity: "error",
  };
}

interface PageExtractionStepResult {
  readonly scannedObjects: number;
  readonly stopAfterPage: boolean;
}

interface PdfPageStepArgs {
  readonly builder: WindowTextBuilder;
  readonly diagnostics: ParserDiagnostic[];
  readonly doc: PdfDocumentLike;
  readonly input: ParserSelectionInput;
  readonly options: ParserOptions;
  readonly pageLabel: string | undefined;
  readonly pageNumber: number;
  readonly scannedObjects: number;
  readonly startedAt: number;
}

function addEmptyPdfPage(
  builder: WindowTextBuilder,
  diagnostics: ParserDiagnostic[],
  input: ParserSelectionInput,
  pageNumber: number,
  pageLabel: string | undefined,
  code: "PAGE_PARSE_FAILED" | "PAGE_TEXT_UNREADABLE",
  message: string,
): void {
  diagnostics.push(pageFailureDiagnostic(input, pageNumber, code, message));
  builder.addPage(pageNumber, "", pageLabel);
}

async function readPdfPageTextStep(
  page: PdfPageLike,
  args: PdfPageStepArgs,
): Promise<PageExtractionStepResult> {
  try {
    const result = await readPageText(page, {
      input: args.input,
      options: args.options,
      startedAt: args.startedAt,
      emittedUnits: args.builder.pageCount,
      scannedObjects: args.scannedObjects,
    });
    args.builder.addPage(args.pageNumber, result.text, args.pageLabel);
    if (result.diagnostic !== undefined) args.diagnostics.push(result.diagnostic);
    return {
      scannedObjects: result.scannedObjects,
      stopAfterPage: result.diagnostic !== undefined,
    };
  } catch {
    addEmptyPdfPage(
      args.builder,
      args.diagnostics,
      args.input,
      args.pageNumber,
      args.pageLabel,
      "PAGE_TEXT_UNREADABLE",
      "pdf parser could not read page text; indexed page provenance without text",
    );
    return { scannedObjects: args.scannedObjects, stopAfterPage: false };
  }
}

async function extractPdfPageStep(args: PdfPageStepArgs): Promise<PageExtractionStepResult> {
  let page: PdfPageLike;
  try {
    page = await args.doc.getPage(args.pageNumber);
  } catch {
    addEmptyPdfPage(
      args.builder,
      args.diagnostics,
      args.input,
      args.pageNumber,
      args.pageLabel,
      "PAGE_PARSE_FAILED",
      "pdf parser could not load page; indexed page provenance without text",
    );
    return { scannedObjects: args.scannedObjects, stopAfterPage: false };
  }
  return readPdfPageTextStep(page, args);
}

export async function extractPages(
  doc: PdfDocumentLike,
  input: ParserSelectionInput,
  options: ParserOptions,
  startedAt: number,
): Promise<{
  readonly diagnostics: readonly ParserDiagnostic[];
  readonly pages: readonly PageRecord[];
  readonly units: readonly ParsedUnit[];
  readonly normalizedText?: string;
}> {
  const diagnostics: ParserDiagnostic[] = [];
  const builder = new WindowTextBuilder(input.documentId, 0, false);
  const pageLabels = await pageLabelsFor(doc);
  let scannedObjects = 0;

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const limit = shouldStop(startedAt, options, builder.pageCount);
    if (limit.stop) {
      if (limit.code !== undefined && limit.message !== undefined) {
        diagnostics.push(diagnostic(limit.code, limit.message, input.documentId, "info"));
      }
      break;
    }

    const pageLabel = pageLabelFor(pageLabels, pageNumber);
    const step = await extractPdfPageStep({
      builder,
      diagnostics,
      doc,
      input,
      options,
      pageLabel,
      pageNumber,
      scannedObjects,
      startedAt,
    });
    scannedObjects = step.scannedObjects;
    if (step.stopAfterPage) break;
  }

  const normalizedText = builder.text();
  return {
    diagnostics,
    pages: builder.snapshotPages(),
    units: builder.snapshotUnits(),
    ...(normalizedText.length > 0 ? { normalizedText } : {}),
  };
}

async function asyncParse(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
): Promise<InternalParserResult> {
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
    const doc = await loadPdfDocument(input.bytes);
    const { diagnostics, pages, units, normalizedText } = await extractPages(
      doc,
      input,
      options,
      startedAt,
    );

    if (isAborted(options.signal)) {
      return cancelled(capability, input, options);
    }
    if (pages.length === 0) {
      return noTextResult(capability, input, options, diagnostics);
    }

    return {
      documentId: input.documentId,
      parser: parserIdentity(capability),
      pages,
      sections: [],
      units,
      diagnostics,
      extractedAt: options.now(),
      ...(normalizedText !== undefined ? { normalizedText } : {}),
    } satisfies InternalParserResult;
  } catch (cause) {
    return emptyResult(capability, input.documentId, options, [
      pdfLoadFailureDiagnostic(input, cause),
    ]);
  }
}

const capability: ParserCapability = Object.freeze({
  parserId: PARSER_ID,
  parserVersion: PARSER_VERSION,
  dependencyVersions: DEPENDENCY_VERSIONS,
  matches: isPdf,
});

export const pdfParser: AsyncParserAdapter = Object.freeze({
  capability,
  parse: syncFallback(capability),
  parseAsync: (input: ParserSelectionInput, options: ParserOptions) =>
    asyncParse(capability, input, options),
});
