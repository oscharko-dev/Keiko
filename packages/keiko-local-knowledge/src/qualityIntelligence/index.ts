// Public barrel for the local-knowledge → Quality Intelligence handoff (Epic #270,
// Issue #278). Pure adapter sub-namespace; re-exports the QI capsule-envelope builder
// and the full-corpus reader added in Epic #710 (Issue #717).

export {
  buildCapsuleSourceEnvelopes,
  QiHandoffError,
  type BuildCapsuleEnvelopesInput,
  type QiHandoffErrorCode,
} from "./qiHandoff.js";

export {
  listCapsuleDocumentTexts,
  listCapsuleSetDocumentTexts,
  type CapsuleDocumentText,
} from "./capsuleCorpus.js";

// Complete, bounded document read of an already-resolved scope (#4179).
export {
  SCOPE_DOCUMENT_CHARS_MAX,
  SCOPE_DOCUMENTS_MAX,
  SCOPE_TOTAL_CHARS_MAX,
  readScopeDocuments,
  referenceForSpan,
  unionSections,
  type ScopeDocument,
  type ScopeDocumentLimits,
  type ScopeDocumentRead,
  type ScopeDocumentScope,
  type ScopeDocumentSection,
  type ScopeSpan,
} from "./scopeDocuments.js";
