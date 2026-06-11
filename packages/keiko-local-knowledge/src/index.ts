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
  createCapsule,
  deleteCapsule,
  getCapsule,
  listCapsules,
  updateCapsuleState,
  updateCapsuleDetails,
  type CapsuleDetailsPatch,
  type CreateCapsuleInput,
} from "./capsule-lifecycle.js";
export {
  addSourceToCapsule,
  listCapsuleSources,
  removeSourceFromCapsule,
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
  type AsyncParserAdapter,
  type ParserAdapter,
  type ParserCapability,
  type ParserErrorCode,
  type ParserOptions,
  type ParserRegistry,
  type ParserResolution,
  type ParserSelectionInput,
} from "./parsers/index.js";

// OCR adapter seam (Issue #202).
export {
  createOcrPipelineParser,
  nullOcrAdapter,
  type OcrAdapter,
  type OcrPageResult,
  type OcrPipelineAdapter,
} from "./parsers/ocr/index.js";

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
export * from "./privacy/index.js";
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
