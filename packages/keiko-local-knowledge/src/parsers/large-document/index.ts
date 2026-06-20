// Public surface for the bounded large-document ingestion parser layer (Epic #1160,
// Issue #1286).

export { largeDocumentDiagnostic } from "./diagnostics.js";
export type {
  ProgressiveExtractionSource,
  ProgressiveExtractionWindow,
  ProgressiveExtractionOptions,
  ProgressiveExtractor,
  ProgressiveExtractionSink,
  ProgressiveExtractionSummary,
  ProgressiveStopReason,
} from "./progressive-extraction.js";
export { runProgressiveExtraction } from "./progressive-extraction.js";
export { WindowTextBuilder } from "./window-builder.js";
export type { AddedPage } from "./window-builder.js";
export {
  createProgressivePdfExtractor,
  PROGRESSIVE_PDF_PARSER_ID,
  PROGRESSIVE_PDF_PARSER_VERSION,
  PROGRESSIVE_PDF_DEPENDENCY_VERSIONS,
} from "./progressive-pdf.js";
export type { OcrPageFn, ProgressivePdfExtractorDeps } from "./progressive-pdf.js";
export { syntheticStreamingSource, syntheticProgressiveExtractor } from "./synthetic-source.js";
export type { SyntheticStreamingConfig } from "./synthetic-source.js";
export {
  discoverExtractionCapabilities,
  probeOcrCapability,
  probeMultimodalCapability,
  nullMultimodalAdapter,
} from "./capability-discovery.js";
export type {
  CapabilityProbeDeps,
  MultimodalAdapter,
  MultimodalResult,
} from "./capability-discovery.js";
export {
  isLegacyBinaryOfficeFormat,
  legacyFormatGuidance,
  legacyFormatDiagnostic,
} from "./legacy-format.js";
export { classifyLargeDocument, usesProgressivePath } from "./preflight.js";
export type { PreflightInput } from "./preflight.js";
