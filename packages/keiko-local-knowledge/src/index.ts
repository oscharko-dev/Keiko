// Public surface of @oscharko-dev/keiko-local-knowledge (Epic #189, Issues #193, #266, #194).
// Composes the #265 schema with a node:sqlite runtime, exposes typed CRUD for
// capsules/sources/sets, the parser registry (#266), and the discovery + extraction
// bridge (#194) that walks a KnowledgeSourceScope via the workspace `WorkspaceFs` port and
// persists documents/pages/sections/parsed_units/parser_diagnostics rows.
//
// No retrieval, no embedding generation, no HTTP — those ship in #196 (indexing
// orchestrator), #199 (retrieval), and #197/#198 (UI surfaces). ADR-0019 direction rule
// 3e allows this package to depend on `@oscharko-dev/keiko-contracts` and
// `@oscharko-dev/keiko-workspace` only — the workspace dep was added at issue #194 so the
// discovery layer can route all file IO through the boundary-checked WorkspaceFs port.

export { KEIKO_LOCAL_KNOWLEDGE_VERSION } from "./version.js";
export { KnowledgeStoreError, KnowledgePathError, KnowledgeNotFoundError } from "./errors.js";
export { resolveKnowledgeStorePath, type ResolveKnowledgeStorePathOptions } from "./store-paths.js";
export {
  openKnowledgeStore,
  type KnowledgeStore,
  type OpenKnowledgeStoreOptions,
} from "./store.js";
export {
  createCapsule,
  deleteCapsule,
  getCapsule,
  listCapsules,
  updateCapsuleState,
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
  DEFAULT_MAX_UNITS,
  DEFAULT_TIMEOUT_MS,
  PARSER_ERROR_CODES,
  buildParserOptions,
  createDefaultParserRegistry,
  createParserRegistry,
  csvParser,
  htmlParser,
  jsonParser,
  registerParser,
  resolveParser,
  textParser,
  unsupportedParser,
  type ParserAdapter,
  type ParserCapability,
  type ParserErrorCode,
  type ParserOptions,
  type ParserRegistry,
  type ParserResolution,
  type ParserSelectionInput,
} from "./parsers/index.js";

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
