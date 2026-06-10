// Public surface of the discovery + extraction bridge (Epic #189, Issue #194). Consumers
// import everything from `@oscharko-dev/keiko-local-knowledge`; this module is the single
// re-export point so the package barrel stays a flat list of names.

export {
  DEFAULT_DISCOVERY_OPTIONS,
  documentIdFor,
  type DiscoveredFile,
  type DiscoveryError,
  type DiscoveryErrorCode,
  type DiscoveryOptions,
  type ExtractionEvent,
  type ExtractionOutcome,
  type ExtractionResult,
} from "./types.js";

export { walkSource, type WalkYield } from "./walk.js";

export {
  extractDocument,
  type ExtractDocumentDeps,
  type ExtractDocumentParams,
} from "./extract.js";

export {
  discoverAndExtract,
  type DiscoverAndExtractDeps,
  type DiscoverAndExtractParams,
} from "./discovery-runner.js";

export { extensionOf, mediaTypeFor } from "./media-type.js";
