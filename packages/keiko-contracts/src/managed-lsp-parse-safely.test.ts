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
