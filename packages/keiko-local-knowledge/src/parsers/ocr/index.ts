// OCR adapter seam — barrel for the ocr/ subdirectory (Epic #189, Issue #202).
export { nullOcrAdapter } from "./null-ocr-adapter.js";
export { createOcrPipelineParser, type OcrPipelineAdapter } from "./ocr-pipeline-parser.js";
export { type OcrAdapter, type OcrPageResult } from "./types.js";
export {
  LOCAL_KNOWLEDGE_OCR_ENGINE_ENV,
  LOCAL_KNOWLEDGE_OCR_LANG_ENV,
  LOCAL_KNOWLEDGE_OCR_MAX_BYTES_ENV,
  LOCAL_KNOWLEDGE_OCR_TESSERACT_BIN_ENV,
  LOCAL_KNOWLEDGE_OCR_TIMEOUT_MS_ENV,
  createOcrAdapterFromEnv,
  createTesseractOcrAdapter,
  resolveOcrRuntimeFromEnv,
  type OcrRuntimeEngine,
  type OcrRuntimeResolution,
  type TesseractCommandRequest,
  type TesseractCommandResult,
  type TesseractCommandRunner,
  type TesseractOcrAdapterOptions,
} from "./tesseract-ocr-adapter.js";
