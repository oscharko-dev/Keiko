// Public runtime subpath for features that instantiate the TypeScript compiler. Kept separate
// from the workspace root barrel so lightweight Node consumers do not pay that startup and memory
// cost merely to use workspace discovery, path, or search primitives.

export {
  buildCodeIntelligenceIndex,
  lookupCodeIntelligenceAtoms,
  queryCodeIntelligenceIndex,
  type ApiContractEdge,
  type ApiEndpoint,
  type CodeCallEdge,
  type CodeImportEdge,
  type CodeIntelligenceIndex,
  type CodeLanguage,
  type CodeParserCoverage,
  type CodeParserKind,
  type CodeReferenceEdge,
  type CodeSymbol,
  type CodeSymbolKind,
  type DtoContractEdge,
} from "./codeIntelligence.js";
export { importGraphAdapter } from "./importGraph.js";
export { testSourcePairingAdapter } from "./testSourcePairing.js";
export type {
  StructuralAdapterRequestContext,
  StructuralAdapterRequestContextDeps,
  StructuralRequestContextDiagnostics,
  StructuralRequestSearchDeps,
} from "./structuralAdapterRequestContext.js";
export { createStructuralAdapterRequestContext } from "./structuralAdapterRequestContext.js";
export type {
  AdapterError,
  RunAllResult,
  StructuralAdapter,
  StructuralAdapterDeps,
  StructuralAdapterRegistry,
  StructuralAdapterRegistryOptions,
  StructuralCoverageDiagnostics,
  StructuralParserCoverage,
} from "./structuralAdapters.js";
export {
  createDefaultStructuralRegistry,
  createEcosystemStructureAdapters,
  runStructuralAdapters,
} from "./structuralAdapters.js";
