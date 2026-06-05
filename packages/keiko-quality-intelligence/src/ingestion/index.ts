// Public barrel for the Quality Intelligence ingestion sub-namespace (Epic #270, Issue #278).
//
// Pure-domain helpers that prepare structured + free-text inputs for the QI pipeline.
// No IO. No network. No `node:fs`. All functions operate on contract types from
// @oscharko-dev/keiko-contracts.

export {
  normaliseUntrustedContent,
  UNTRUSTED_CONTENT_DEFAULT_MAX_BYTES,
  type NormaliseUntrustedContentOptions,
  type NormaliseUntrustedContentResult,
} from "./untrustedContentNormalisation.js";

export {
  parseAdfDocument,
  AdfParserError,
  ADF_PARSER_DEFAULTS,
  type AdfParserErrorCode,
  type AdfParserOptions,
  type IngestedBlock,
  type IngestedDocument,
  type IngestedTextRun,
} from "./adfParser.js";

export {
  planSourceMix,
  SOURCE_KIND_PRIORITY,
  type SourceMixPlan,
  type SourceMixPlanEntry,
  type SourceMixPlanOptions,
} from "./sourceMixPlanning.js";

export {
  reconcileSourceGroups,
  type ProvenanceEntry,
  type ReconciledSourceSet,
  type SourceGroup,
} from "./sourceReconciliation.js";

export {
  buildWorkspaceSourceEnvelopes,
  workspaceSourceMixPolicy,
  WorkspaceAdapterError,
  type BuildWorkspaceEnvelopesInput,
  type WorkspaceAdapterErrorCode,
} from "./workspaceAdapter.js";
