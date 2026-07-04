// Cross-module GUARD for the shared redacting error base. Each per-layer taxonomy
// (gateway/audit/workspace/tools/harness/verification/promptEnhancer) extends RedactingError, so this
// test iterates ONE concrete subclass per taxonomy and asserts the shared contract holds uniformly:
//   (a) instanceof RedactingError and Error,
//   (b) redacts a known secret shape from `.message` at construction,
//   (c) `.name` is the concrete subclass name (via `new.target` in the base),
//   (d) a stable, non-empty `.code` is exposed.
// A future refactor that drops the redact-at-construction invariant, breaks the instanceof chain, or
// stops setting `.name` for ANY layer fails here instead of silently leaking a secret downstream.
//
// SecretboxError is deliberately EXCLUDED and its exemption documented below: it is a generic,
// non-redacting primitive whose message is secret-free by construction, so it does NOT (and must not)
// extend RedactingError.

import { describe, expect, it } from "vitest";
import { RedactingError } from "./base.js";
import { AuthenticationError } from "./gateway.js";
import { EvidenceWriteError } from "./audit.js";
import { PathEscapeError } from "./workspace.js";
import { CommandDeniedError } from "./tools.js";
import { HarnessModelError } from "./harness.js";
import { EmptyPlanError } from "./verification.js";
import { UnsafeCandidateError } from "./promptEnhancer.js";
import { SecretboxError } from "./secretbox.js";

// A secret shape that redact() scrubs (OpenAI-style key). Split so the literal is never contiguous in
// source, and long enough to satisfy the >= 16-char key pattern.
const SECRET = "sk-" + "test0ABC123DEF456GHI789";

interface Case {
  readonly layer: string;
  readonly make: (message: string) => RedactingError;
  readonly expectedName: string;
  readonly expectedCode: string;
}

const CASES: readonly Case[] = [
  {
    layer: "gateway",
    make: (m) => new AuthenticationError(m),
    expectedName: "AuthenticationError",
    expectedCode: "GATEWAY_AUTHENTICATION",
  },
  {
    layer: "audit",
    make: (m) => new EvidenceWriteError(m),
    expectedName: "EvidenceWriteError",
    expectedCode: "AUDIT_WRITE",
  },
  {
    layer: "workspace",
    make: (m) => new PathEscapeError(m, "../escape"),
    expectedName: "PathEscapeError",
    expectedCode: "WORKSPACE_PATH_ESCAPE",
  },
  {
    layer: "tools",
    make: (m) => new CommandDeniedError(m, "git"),
    expectedName: "CommandDeniedError",
    expectedCode: "TOOL_COMMAND_DENIED",
  },
  {
    layer: "harness",
    make: (m) => new HarnessModelError(m),
    expectedName: "HarnessModelError",
    expectedCode: "HARNESS_MODEL_ERROR",
  },
  {
    layer: "verification",
    make: (m) => new EmptyPlanError(m),
    expectedName: "EmptyPlanError",
    expectedCode: "VERIFICATION_PLAN_EMPTY",
  },
  {
    layer: "promptEnhancer",
    make: (m) => new UnsafeCandidateError(m),
    expectedName: "UnsafeCandidateError",
    expectedCode: "PROMPT_ENHANCER_UNSAFE_CANDIDATE",
  },
];

describe("RedactingError shared base — cross-module guard", () => {
  for (const { layer, make, expectedName, expectedCode } of CASES) {
    describe(`${layer} layer`, () => {
      it("(a) is instanceof RedactingError and Error", () => {
        const error = make("boom");
        expect(error).toBeInstanceOf(RedactingError);
        expect(error).toBeInstanceOf(Error);
      });

      it("(b) redacts a known secret from .message at construction", () => {
        const error = make(`leak ${SECRET} here`);
        expect(error.message).not.toContain(SECRET);
        expect(error.message).toContain("[REDACTED]");
      });

      it("(b') redacts a caller-supplied additional secret", () => {
        const error = new (class extends RedactingError {
          readonly code = "TEST";
        })("contains hunter2 value", ["hunter2"]);
        expect(error.message).not.toContain("hunter2");
      });

      it("(c) sets .name to the concrete subclass name", () => {
        expect(make("m").name).toBe(expectedName);
      });

      it("(d) exposes a stable non-empty .code", () => {
        const code = make("m").code;
        expect(code).toBe(expectedCode);
        expect(code.length).toBeGreaterThan(0);
      });
    });
  }

  it("preserves gateway-only fields on the migrated base (retryable stays a Gateway concern)", () => {
    const error = new AuthenticationError("m");
    expect(error.retryable).toBe(false);
  });

  // Documented exemption: SecretboxError is intentionally NOT a RedactingError. It is a generic
  // authenticated-encryption failure whose message never echoes key material, plaintext, or
  // ciphertext (an auth-tag mismatch and a malformed envelope both surface with a generic message by
  // design — distinguishing them would be an oracle). Because its message is secret-free by
  // construction, wrapping it in redact() would add nothing, so it keeps its own bespoke constructor.
  it("SecretboxError is EXEMPT from RedactingError (generic, non-redacting by design)", () => {
    const error = new SecretboxError("secretbox open failed");
    expect(error).not.toBeInstanceOf(RedactingError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SecretboxError");
    expect(error.code).toBe("SECRETBOX_OPEN_FAILED");
  });
});
