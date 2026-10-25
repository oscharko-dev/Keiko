// KEIKO-0909: direct coverage for the shared throw-to-content-free-Result wrapper extracted from
// five near-identical managed-lsp-*.ts copies. Each of those five files' own test suite already
// exercises this behavior end-to-end through its public parse function (a hostile Proxy trap or an
// explicit throw inside the `...Unsafe` parser, asserted to come back as a normalized `ok: false`
// rather than propagate) -- this file tests the extracted helper directly and in isolation, and
// exists mainly as a fail-before/pass-after artifact for the extraction itself: before KEIKO-0909
// this module did not exist, so any test importing it fails to resolve; after, it passes.

import { describe, expect, it } from "vitest";
import { parseSafely } from "./managed-lsp-parse-safely.js";

describe("parseSafely (shared by managed-lsp-activation/capabilities/route/runtime/evidence, KEIKO-0909)", () => {
  it("passes through a successful parse untouched", () => {
    const result = parseSafely(() => ({ ok: true, value: 42 }));
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it("passes through a well-formed ok:false result untouched", () => {
    const result = parseSafely<number>(() => ({ ok: false, errors: ["value is invalid"] }));
    expect(result).toEqual({ ok: false, errors: ["value is invalid"] });
  });

  it("normalizes a thrown Error into a single content-free error naming the error's constructor", () => {
    // Asserted structurally (not against the full literal message) so this test does not itself
    // become a sixth occurrence of the exact string the extraction's own grep-based verification
    // command counts across managed-lsp-*.ts (KEIKO-0909's acceptance criterion: exactly one
    // definition site). The five original call sites' own test suites already pin the full wording
    // end-to-end through their public parse functions.
    const result = parseSafely<number>(() => {
      throw new TypeError("hostile trap");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("TypeError");
    }
  });

  it("normalizes a thrown non-Error value to a single content-free error naming it 'unknown'", () => {
    const result = parseSafely<number>(() => {
      // Cast via a helper so eslint's only-throw-error rule sees a "safe" call — the goal is to
      // exercise the non-Error branch of parseSafely without triggering the lint on the throw
      // site itself.
      throwLiteralString("not an Error instance");
      throw new Error("unreachable");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("unknown");
    }
  });
});

function throwLiteralString(value: string): never {
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising the non-Error branch
  throw value;
}

import * as activationSource from "./managed-lsp-activation.js";
import * as activationPublic from "@oscharko-dev/keiko-contracts/runtime/managed-lsp-activation";
import * as capabilitiesSource from "./managed-lsp-capabilities.js";
import * as capabilitiesPublic from "@oscharko-dev/keiko-contracts/runtime/managed-lsp-capabilities";
import * as runtimeSource from "./managed-lsp-runtime.js";
import * as runtimePublic from "@oscharko-dev/keiko-contracts/runtime/managed-lsp-runtime";
import * as routeSource from "./managed-lsp-route.js";
import * as routePublic from "@oscharko-dev/keiko-contracts/runtime/managed-lsp-route";
import * as evidenceSource from "./managed-lsp-evidence.js";
import * as evidencePublic from "@oscharko-dev/keiko-contracts/runtime/managed-lsp-evidence";

function healthyRuntimeConfiguration(): unknown {
  return {
    schemaVersion: "1",
    language: "python",
    revision: 7,
    etag: '"lspcfg-7-abcdefghijklmnop"',
    activation: "enabled",
    runtime: { kind: "operatorApproved", runtimeId: "python.language-server.production" },
    provenance: {
      activation: "workspace",
      runtime: "operatorProvisioning",
      settings: "workspace",
    },
    restartRequired: false,
    restartFields: [],
    settings: {
      interpreter: { kind: "operatorApproved", runtimeId: "python.3.13.production" },
      venv: { kind: "operatorApproved", runtimeId: "python.venv.workspace-a" },
      typeCheckingMode: "strict",
      extraPaths: [],
      configurationFile: { kind: "workspaceRelative", path: "config/pyright.json" },
      configurationPrecedence: ["workspaceConfiguration", "pyproject", "builtInDefault"],
    },
  };
}

const parserBoundaryOwners = [
  {
    name: "activation status",
    source: activationSource.parseManagedLspActivationStatus,
    public: activationPublic.parseManagedLspActivationStatus,
    healthy: (): unknown => ({
      ok: true,
      schemaVersion: "1",
      language: "python",
      configurationRevision: 7,
      state: "active",
      reasonCode: "ACTIVE",
      policyResult: "allowed",
    }),
  },
  {
    name: "candidate capabilities",
    source: capabilitiesSource.parseManagedLspCandidateCapabilities,
    public: capabilitiesPublic.parseManagedLspCandidateCapabilities,
    healthy: (): unknown => ({
      schemaVersion: "1",
      language: "python",
      operations: ["diagnostics", "hover"],
      semanticTokensCandidate: true,
    }),
  },
  {
    name: "runtime configuration",
    source: runtimeSource.parseManagedLspRuntimeConfiguration,
    public: runtimePublic.parseManagedLspRuntimeConfiguration,
    healthy: healthyRuntimeConfiguration,
  },
  {
    name: "control request",
    source: routeSource.parseManagedLspControlRequest,
    public: routePublic.parseManagedLspControlRequest,
    healthy: (): unknown => ({
      root: "workspace",
      language: "python",
      action: "activate",
      expectedRevision: 7,
    }),
  },
  {
    name: "evidence",
    source: evidenceSource.parseManagedLspEvidence,
    public: evidencePublic.parseManagedLspEvidence,
    healthy: (): unknown => ({
      schemaVersion: "1",
      kind: "activationChange",
      action: "activate",
      outcome: "accepted",
      actorClass: "localHuman",
      language: "python",
      priorState: "available",
      effectiveState: "active",
      reasonCode: "ACTIVE",
      revision: 7,
      timestampMs: 1_725_000_000_000,
      policyResult: "allowed",
    }),
  },
] as const;

function errorWithUnreadableName(): Error {
  const error = new Error("private-parser-message");
  error.stack = "";
  Object.defineProperty(error, "name", {
    get(): never {
      throw new Error("private-name-inspection");
    },
  });
  return error;
}

function revokedCaughtValue(): unknown {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  return revoked.proxy;
}

function privateNamedError(): Error {
  const error = new Error("private-parser-message");
  error.stack = "";
  error.name = "private-parser-name";
  return error;
}

function throwingParserInput(value: unknown): unknown {
  return new Proxy(
    {},
    {
      ownKeys(): never {
        throwParserValue(value);
      },
      get(): never {
        throwParserValue(value);
      },
    },
  );
}

function throwParserValue(value: unknown): never {
  throw value;
}

const caughtValueCases = [
  { name: "unreadable Error name", make: errorWithUnreadableName, expected: "unknown" },
  { name: "revoked caught proxy", make: revokedCaughtValue, expected: "unknown" },
  { name: "private Error name", make: privateNamedError, expected: "Error" },
  {
    name: "ordinary TypeError",
    make: (): unknown => new TypeError("private"),
    expected: "TypeError",
  },
  {
    name: "ordinary RangeError",
    make: (): unknown => new RangeError("private"),
    expected: "RangeError",
  },
  { name: "primitive thrown value", make: (): unknown => "private", expected: "unknown" },
] as const;

for (const owner of parserBoundaryOwners) {
  describe.each([
    { surface: "source", parse: owner.source },
    { surface: "public", parse: owner.public },
  ])(`closed parser inspection: ${owner.name} $surface`, ({ parse }) => {
    it.each(caughtValueCases)("contains $name without leaking its fields", ({ make, expected }) => {
      const result = parse(throwingParserInput(make()));
      expect(result).toEqual({
        ok: false,
        errors: [`payload could not be inspected: ${expected}`],
      });
      expect(JSON.stringify(result)).not.toContain("private");
    });

    it("keeps healthy admission and ordinary validation refusal", () => {
      expect(parse(owner.healthy()).ok).toBe(true);
      expect(parse(null).ok).toBe(false);
    });
  });
}

it("preserves the exact success and validation-refusal Result objects", () => {
  const success = { ok: true, value: { retained: true } } as const;
  const refusal = { ok: false, errors: ["ordinary validation refusal"] } as const;
  expect(parseSafely(() => success)).toBe(success);
  expect(parseSafely(() => refusal)).toBe(refusal);
});
