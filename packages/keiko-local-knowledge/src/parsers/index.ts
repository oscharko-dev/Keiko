// Public surface of the parser registry + format adapters (Epic #189, Issue #266). Exposed
// from the package root via `packages/keiko-local-knowledge/src/index.ts` so callers can
// import everything as `@oscharko-dev/keiko-local-knowledge`.

export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_NESTING_DEPTH,
  DEFAULT_MAX_OBJECTS,
  DEFAULT_MAX_UNITS,
  DEFAULT_TIMEOUT_MS,
  type AsyncParserAdapter,
  PARSER_ERROR_CODES,
  type ParserAdapter,
  type ParserCapability,
  type ParserErrorCode,
  type ParserOptions,
  type ParserRegistry,
  type ParserResolution,
  type ParserSelectionInput,
} from "./types.js";
export type { ParsedUnit, ParserDiagnostic, ParserResult } from "./types.js";

export {
  buildParserOptions,
  createParserRegistry,
  registerParser,
  resolveParser,
  unsupportedParser,
} from "./registry.js";
export { textParser } from "./text-parser.js";
export { jsonParser } from "./json-parser.js";
export { csvParser } from "./csv-parser.js";
export { htmlParser } from "./html-parser.js";
export { pdfParser } from "./pdf-parser.js";
export { docxParser } from "./docx-parser.js";
export { xlsxParser } from "./xlsx-parser.js";

// Convenience: a registry pre-populated with every shipped adapter. OCR is opt-in because it
// depends on a runtime engine; text registers last because its `matches` predicate is the most
// permissive (accepts any `text/*`), so it must not shadow structured adapters.
import { csvParser } from "./csv-parser.js";
import { docxParser } from "./docx-parser.js";
import { htmlParser } from "./html-parser.js";
import { jsonParser } from "./json-parser.js";
import { pdfParser } from "./pdf-parser.js";
import { createParserRegistry, registerParser } from "./registry.js";
import { textParser } from "./text-parser.js";
import type { ParserRegistry } from "./types.js";
import { xlsxParser } from "./xlsx-parser.js";
import { createOcrPipelineParser } from "./ocr/ocr-pipeline-parser.js";
import type { OcrAdapter } from "./ocr/types.js";

export interface DefaultParserRegistryOptions {
  readonly ocrAdapter?: OcrAdapter;
}

export function createDefaultParserRegistry(
  options: DefaultParserRegistryOptions = {},
): ParserRegistry {
  let registry = createParserRegistry();
  registry = registerParser(registry, jsonParser);
  registry = registerParser(registry, csvParser);
  registry = registerParser(registry, htmlParser);
  registry = registerParser(registry, pdfParser);
  registry = registerParser(registry, docxParser);
  registry = registerParser(registry, xlsxParser);
  if (options.ocrAdapter !== undefined) {
    registry = registerParser(registry, createOcrPipelineParser(options.ocrAdapter));
  }
  // Text parser is registered last among the real adapters because its `matches` predicate
  // is the most permissive (it accepts any `text/*` media type), so it must not shadow the
  // structured adapters.
  registry = registerParser(registry, textParser);
  return registry;
}

// OCR adapter seam (Issue #202).
export {
  nullOcrAdapter,
  createOcrPipelineParser,
  createOcrAdapterFromEnv,
  createTesseractOcrAdapter,
  resolveOcrRuntimeFromEnv,
  type OcrAdapter,
  type OcrPageResult,
  type OcrPipelineAdapter,
  type OcrRuntimeEngine,
  type OcrRuntimeResolution,
  type TesseractCommandRequest,
  type TesseractCommandResult,
  type TesseractCommandRunner,
  type TesseractOcrAdapterOptions,
} from "./ocr/index.js";

// Bounded large-document ingestion parser layer (Epic #1160, Issue #1286).
export {
  runProgressiveExtraction,
  createProgressivePdfExtractor,
  syntheticStreamingSource,
  syntheticProgressiveExtractor,
  discoverExtractionCapabilities,
  probeOcrCapability,
  probeMultimodalCapability,
  nullMultimodalAdapter,
  classifyLargeDocument,
  usesProgressivePath,
  isLegacyBinaryOfficeFormat,
  legacyFormatGuidance,
  legacyFormatDiagnostic,
  largeDocumentDiagnostic,
  type ProgressiveExtractor,
  type ProgressiveExtractionSource,
  type ProgressiveExtractionWindow,
  type ProgressiveExtractionOptions,
  type ProgressiveExtractionSink,
  type ProgressiveExtractionSummary,
  type ProgressiveStopReason,
  type OcrPageFn,
  type ProgressivePdfExtractorDeps,
  type SyntheticStreamingConfig,
  type CapabilityProbeDeps,
  type MultimodalAdapter,
  type MultimodalResult,
  type PreflightInput,
} from "./large-document/index.js";
