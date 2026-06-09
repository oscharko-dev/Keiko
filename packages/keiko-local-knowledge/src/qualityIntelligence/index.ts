// Public barrel for the local-knowledge → Quality Intelligence handoff (Epic #270,
// Issue #278). Pure adapter sub-namespace; re-exports the QI capsule-envelope builder
// and the full-corpus reader added in Epic #710 (Issue #717).

export {
  buildCapsuleSourceEnvelopes,
  QiHandoffError,
  type BuildCapsuleEnvelopesInput,
  type QiHandoffErrorCode,
} from "./qiHandoff.js";

export { listCapsuleDocumentTexts, type CapsuleDocumentText } from "./capsuleCorpus.js";
