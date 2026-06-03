// Public-surface pin test, mirroring keiko-contracts/src/index.test.ts. Every symbol that lives on
// the package's main entry point is touched here so a future refactor that accidentally drops a
// named export — or downgrades a value to a type-only re-export — fails this test instead of
// silently breaking a downstream caller. The trust-boundary nature of this package makes the
// "stable public surface" guarantee load-bearing.

import { describe, it, expect } from "vitest";
import {
  KEIKO_SECURITY_VERSION,
  redact,
  createAuditRedactor,
  deepRedactStrings,
  assertValidRunId,
  isKeikoApiKeyEnvName,
  keikoApiKeySecretValues,
  canonicalise,
  sha256Hex,
  sha256Base64,
  ERROR_CODES,
  GatewayError,
  AUDIT_CODES,
  AuditError,
  InvalidRunIdError,
  WORKSPACE_CODES,
  WorkspaceError,
  TOOL_CODES,
  ToolError,
  HARNESS_CODES,
  HarnessError,
  VERIFICATION_CODES,
  VerificationError,
  toFailure,
} from "./index.js";

describe("keiko-security package surface", () => {
  it("exposes the version constant pinned at 0.1.0", () => {
    expect(KEIKO_SECURITY_VERSION).toBe("0.1.0");
  });

  it("exposes the redaction primitives as callable functions", () => {
    expect(typeof redact).toBe("function");
    expect(typeof createAuditRedactor).toBe("function");
    expect(typeof deepRedactStrings).toBe("function");
  });

  it("exposes the runId validator as a callable function", () => {
    expect(typeof assertValidRunId).toBe("function");
  });

  it("exposes the secret-collection helpers as callable functions", () => {
    expect(typeof isKeikoApiKeyEnvName).toBe("function");
    expect(typeof keikoApiKeySecretValues).toBe("function");
  });

  it("exposes the hashing primitives as callable functions", () => {
    expect(typeof canonicalise).toBe("function");
    expect(typeof sha256Hex).toBe("function");
    expect(typeof sha256Base64).toBe("function");
  });

  it("ERROR_CODES.AUTHENTICATION is the canonical gateway code string", () => {
    expect(ERROR_CODES.AUTHENTICATION).toBe("GATEWAY_AUTHENTICATION");
  });

  it("AUDIT_CODES.INVALID_RUN_ID is the canonical audit code string", () => {
    expect(AUDIT_CODES.INVALID_RUN_ID).toBe("AUDIT_INVALID_RUN_ID");
  });

  it("WORKSPACE_CODES.PATH_ESCAPE is the canonical workspace code string", () => {
    expect(WORKSPACE_CODES.PATH_ESCAPE).toBe("WORKSPACE_PATH_ESCAPE");
  });

  it("TOOL_CODES.COMMAND_DENIED is the canonical tool code string", () => {
    expect(TOOL_CODES.COMMAND_DENIED).toBe("TOOL_COMMAND_DENIED");
  });

  it("HARNESS_CODES.MODEL_ERROR is exposed via the security barrel", () => {
    expect(HARNESS_CODES.MODEL_ERROR).toBe("HARNESS_MODEL_ERROR");
  });

  it("VERIFICATION_CODES.PLAN_EMPTY is the canonical verification code string", () => {
    expect(VERIFICATION_CODES.PLAN_EMPTY).toBe("VERIFICATION_PLAN_EMPTY");
  });

  it("each safe-error abstract class is exported as a constructor", () => {
    expect(typeof GatewayError).toBe("function");
    expect(typeof AuditError).toBe("function");
    expect(typeof WorkspaceError).toBe("function");
    expect(typeof ToolError).toBe("function");
    expect(typeof HarnessError).toBe("function");
    expect(typeof VerificationError).toBe("function");
  });

  it("InvalidRunIdError is reachable from the main barrel", () => {
    expect(new InvalidRunIdError("m")).toBeInstanceOf(AuditError);
  });

  it("toFailure is exposed via the security barrel", () => {
    expect(typeof toFailure).toBe("function");
  });
});
