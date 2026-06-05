// Public barrel for the local-knowledge → Quality Intelligence handoff (Epic #270,
// Issue #278). Pure adapter sub-namespace; re-exports the QI capsule-envelope builder.

export {
  buildCapsuleSourceEnvelopes,
  QiHandoffError,
  type BuildCapsuleEnvelopesInput,
  type QiHandoffErrorCode,
} from "./qiHandoff.js";
