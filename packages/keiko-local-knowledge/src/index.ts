// Public surface of @oscharko-dev/keiko-local-knowledge (Epic #189, Issues #193, #263, #266,
// #194, #196, #199). Composes the #265 schema with a node:sqlite runtime, exposes typed
// CRUD for capsules/sources/sets, the parser registry (#266), the discovery +
// extraction bridge (#194), the indexing orchestrator (#196), and the retrieval
// orchestrator (#199) that turns a `ComposedRetrievalScope` + query into a ranked list
// of `RetrievalReference` + a `LocalKnowledgeGroundedContextPack`.
//
// The HTTP / UI wiring is OUT OF SCOPE for this package (lands in #200 Conversation
// Center integration). ADR-0019 direction rule 3e allows this package to depend on
// `@oscharko-dev/keiko-contracts`, `@oscharko-dev/keiko-workspace`, and
// `@oscharko-dev/keiko-model-gateway` — the model-gateway dep was added at #196 so the
// indexing + retrieval layers can call the OpenAI-compatible embeddings adapter
// through the same boundary the rest of the codebase uses.

export { KEIKO_LOCAL_KNOWLEDGE_VERSION } from "./version.js";
export { KnowledgeStoreError, KnowledgePathError, KnowledgeNotFoundError } from "./errors.js";
export { resolveKnowledgeStorePath, type ResolveKnowledgeStorePathOptions } from "./store-paths.js";
export {
  openKnowledgeStore,
  type KnowledgeStoreKeyProvider,
  type KnowledgeStoreKeyProviderContext,
  type KnowledgeStoreProtectionOptions,
  type KnowledgeStore,
  type OpenKnowledgeStoreOptions,
} from "./store.js";
export {
  MAX_PDF_DOCUMENT_BLOB_BYTES,
  PDF_DOCUMENT_BLOB_MEDIA_TYPE,
  persistPdfDocumentBlobInTransaction,
  readPdfDocumentBlob,
  readPdfDocumentBlobByContentHash,
  writePdfDocumentBlob,
  type PdfDocumentBlobInput,
  type PdfDocumentBlobMetadata,
  type PdfDocumentBlobReadResult,
  type PdfDocumentBlobRecord,
  type PdfDocumentBlobWriteResult,
} from "./document-blob-store.js";
export {
  createCapsule,
  deleteCapsule,
  getCapsule,
  listCapsules,
  updateCapsuleEmbeddingModelIdentity,
  updateCapsuleState,
  updateCapsuleDetails,
  type CapsuleDetailsPatch,
  type CreateCapsuleInput,
} from "./capsule-lifecycle.js";
export {
  addSourceToCapsule,
  listCapsuleSources,
  removeSourceFromCapsule,
  updateSourceScopeInCapsule,
  type AddCapsuleSourceInput,
} from "./source-lifecycle.js";
export {
  createCapsuleSet,
  deleteCapsuleSet,
  getCapsuleSet,
  listCapsuleSets,
  type CreateCapsuleSetInput,
} from "./capsule-set-lifecycle.js";

export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_NESTING_DEPTH,
  DEFAULT_MAX_OBJECTS,
  DEFAULT_MAX_UNITS,
  DEFAULT_TIMEOUT_MS,
  PARSER_ERROR_CODES,
  buildParserOptions,
  createDefaultParserRegistry,
  createParserRegistry,
  csvParser,
  docxParser,
  htmlParser,
  jsonParser,
  pdfParser,
  registerParser,
  resolveParser,
  textParser,
  unsupportedParser,
  xlsxParser,
  type AsyncParserAdapter,
  type ParserAdapter,
  type ParserCapability,
  type ParserErrorCode,
  type ParserOptions,
  type ParserRegistry,
  type ParserResolution,
  type ParserSelectionInput,
} from "./parsers/index.js";

export {
  createProgressivePdfExtractor,
  discoverExtractionCapabilities,
  probeMultimodalCapability,
  probeOcrCapability,
  type CapabilityProbeDeps,
  type MultimodalAdapter,
  type MultimodalResult,
  type OcrPageFn,
  type ProgressivePdfExtractorDeps,
} from "./parsers/large-document/index.js";

// OCR adapter seam (Issue #202).
export {
  createOcrPipelineParser,
  createOcrAdapterFromEnv,
  createTesseractOcrAdapter,
  nullOcrAdapter,
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
} from "./parsers/ocr/index.js";

// Bounded request-local small-document text extraction for Repository Search (Issue #1285).
// Reuses the shipped DOCX/XLSX/PDF parser adapters as a pure, byte-capped text projection.
export {
  extractBoundedDocumentText,
  type BoundedDocumentExtractionInput,
  type BoundedDocumentExtractionOptions,
  type BoundedDocumentExtractionOutcome,
  type BoundedDocumentExtractionResult,
  type BoundedDocumentFormat,
} from "./bounded-document-extraction.js";

export {
  DEFAULT_DISCOVERY_OPTIONS,
  discoverAndExtract,
  documentIdFor,
  extensionOf,
  extractDocument,
  mediaTypeFor,
  walkSource,
  type DiscoverAndExtractDeps,
  type DiscoverAndExtractParams,
  type DiscoveredFile,
  type DiscoveryError,
  type DiscoveryErrorCode,
  type DiscoveryOptions,
  type ExtractDocumentDeps,
  type ExtractDocumentParams,
  type ExtractionEvent,
  type ExtractionOutcome,
  type ExtractionResult,
  type WalkYield,
} from "./discovery/index.js";
export * from "./indexing/index.js";
export * from "./retrieval/index.js";
export * from "./evaluations/index.js";
export * from "./conversation/index.js";
export { readCitationExcerpt } from "./conversation/citation-excerpts.js";
export {
  lookupCitationPreviewSnapshot,
  lookupCitationPreviewSnapshotForStoredCitation,
  type CitationPreviewSnapshotLookup,
} from "./citation-preview-snapshot.js";
export * from "./privacy/index.js";
export {
  isScopeModelUseOperationAllowed,
  resolveCapsuleModelUsePolicy,
  resolveScopeModelUsePolicy,
  type ScopeModelUsePolicy,
} from "./model-use-policy.js";
// Slice 4 (Issue #189) — non-destructive capsule-set composition exposed to the BFF.
export {
  addSourcesToCapsule,
  buildComposedRetrievalScope,
  composeCapsules,
  CompositionError,
  describeRetrievalScope,
  listCapsuleMembershipChanges,
} from "./composition.js";
export type {
  AddSourcesToCapsuleResult,
  CapsuleMembershipChange,
  CapsuleMembershipChangeKind,
  ComposedRetrievalScope,
  ComposeCapsulesOptions,
  CompositionErrorCode,
  RetrievalCapsuleSummary,
  RetrievalScopeDisclosure,
  RetrievalSourceSummary,
} from "./composition.js";
export {
  buildKnowledgePodSetSummary,
  buildKnowledgePodSummary,
  listKnowledgePodSummaries,
} from "./knowledge-pods.js";
export {
  SourceRoutingValidationError,
  validateAlwaysQuery,
  validateGlobPatterns,
  validateRoutingInstructionsScope,
  validateSourceRoutingForCapsule,
} from "./source-routing-validation.js";
export type { SourceRoutingValidationCode } from "./source-routing-validation.js";

// ─── Quality Intelligence handoff (Issue #278) ─────────────────────────────────
// Pure adapter that converts a local-knowledge RetrievalReference list into a list of
// `QualityIntelligenceLocalKnowledgeCapsuleEnvelope` instances for QI ingestion. No
// new retrieval logic; consumes only existing local-knowledge / contract types.
export * as QualityIntelligenceHandoff from "./qualityIntelligence/index.js";

// ─── Static HTML manual crawl (Epic #1853, Issues #1872/#1873) ─────────────────
// Pure, egress-free link-graph crawler + scope guard. Turns an approved `HtmlManualSource`
// into a bounded page set for the existing indexing pipeline; byte retrieval is delegated to
// an injected `ManualCrawlFetcher` (ADR-0019 trust-9).
export {
  crawlManual,
  createInMemoryManualFetcher,
  createWorkspaceFsManualFetcher,
  evaluateManualCrawlLink,
  extractManualLinks,
  extractManualTitle,
  type CrawledManualPage,
  type CrawlLinkDecision,
  type EvaluateManualCrawlLinkInput,
  type InMemoryManualPage,
  type ManualCrawlDenyReason,
  type ManualCrawlDeps,
  type ManualCrawlEvent,
  type ManualCrawlFetcher,
  type ManualCrawlResult,
  type ManualCrawlStatus,
  type ManualFetchResult,
  type ManualFetchTarget,
  type WorkspaceFsManualFetcherDeps,
} from "./crawl/index.js";
export { createManualPageWorkspaceFs } from "./crawl/index.js";

// ─── HTML manual → Knowledge Pod integration (Epic #1853, Issue #1874) ─────────
// Reuses createCapsule + addSourceToCapsule + runIndexingJob + buildKnowledgePodSummary end to
// end; adds no second store or retrieval path. Byte retrieval is injected (trust-9).
export {
  createHtmlManualPod,
  type CreateHtmlManualPodDeps,
  type CreateHtmlManualPodResult,
} from "./manual-pod.js";
// Explicit refresh over an existing manual pod (Epic #1856, Issues #1891/#1892). Reuses the same
// crawl + indexing lifecycle; adds a redacted change summary. No second crawl/retrieval path.
export {
  refreshHtmlManualPod,
  type RefreshHtmlManualPodDeps,
  type RefreshHtmlManualPodResult,
} from "./manual-pod-refresh.js";
export {
  computeManualRefreshChangeSummary,
  type ManualRefreshChangeInput,
} from "./manual-refresh-change-summary.js";
export {
  persistHtmlManualSourceMetadata,
  readHtmlManualSourceMetadata,
  updateHtmlManualRefreshState,
  resolveHtmlManualCitationTarget,
  type HtmlManualCitationTargetFailureReason,
  type HtmlManualCitationTargetResolution,
  type HtmlManualRefreshState,
  type HtmlManualSourceMetadata,
  type ResolveHtmlManualCitationTargetInput,
} from "./manual-source-metadata.js";
export {
  computeManualPageFingerprint,
  computeManualCrawlRunFingerprint,
  readManualPageFingerprints,
  replaceManualPageFingerprints,
  type ManualPageFingerprint,
} from "./manual-page-fingerprints.js";
export {
  buildHtmlManualIndexingProgress,
  type HtmlManualIndexingProgress,
  type ManualCrawlProgress,
  type ManualIndexingCounts,
  type ManualIndexingPhase,
  type ManualRemediation,
} from "./manual-pod-progress.js";
