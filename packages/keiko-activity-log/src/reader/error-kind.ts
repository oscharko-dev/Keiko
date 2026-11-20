import { SafeArtifactFileError } from "@oscharko-dev/keiko-security/fs-hardening";
import { thrownErrorFields } from "../error-classification.js";

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Returns a closed, content-free error diagnosis without reading an error message. */
export function describeErrorKind(error: unknown): string {
  if (error instanceof SafeArtifactFileError) return error.kind;
  const code = thrownErrorFields(error)?.code;
  if (typeof code === "string" && ERROR_CODE_PATTERN.test(code)) return code;
  return error instanceof Error ? error.constructor.name : "Error";
}
