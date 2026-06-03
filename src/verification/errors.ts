// Re-export shim: the verification error taxonomy now lives in @oscharko-dev/keiko-security
// (issue #159, ADR-0019). All existing import sites (`from "./errors.js"`) keep resolving
// unchanged via this barrel.

export {
  VERIFICATION_CODES,
  VerificationError,
  EmptyPlanError,
} from "@oscharko-dev/keiko-security/errors/verification";
export type { VerificationCode } from "@oscharko-dev/keiko-security/errors/verification";
