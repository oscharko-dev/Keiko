// Re-export shim: the harness error taxonomy lives in @oscharko-dev/keiko-security
// (issue #159, ADR-0019). This shim is independent of the @oscharko-dev/keiko-harness
// extraction (issue #164): security has been the canonical source since issue #159,
// and the direct-from-security form keeps the type graph shallow for downstream
// consumers. The harness package barrel itself re-exports the same names so callers
// can choose either entry point.

export {
  HARNESS_CODES,
  HarnessError,
  LimitExceededError,
  HarnessModelError,
  HarnessToolError,
  HarnessInternalError,
  toFailure,
} from "@oscharko-dev/keiko-security/errors/harness";
export type { HarnessCode } from "@oscharko-dev/keiko-security/errors/harness";
