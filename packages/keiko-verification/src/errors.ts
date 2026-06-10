// Re-export shim: the verification error taxonomy lives in @oscharko-dev/keiko-security
// (issue #159, ADR-0019). Re-exported here so the verification package barrel exposes a single
// import site for downstream consumers.

export {
  VERIFICATION_CODES,
  VerificationError,
  EmptyPlanError,
} from "@oscharko-dev/keiko-security/errors/verification";
export type { VerificationCode } from "@oscharko-dev/keiko-security/errors/verification";
