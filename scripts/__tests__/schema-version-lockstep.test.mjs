import { describe, expect, it } from "vitest";
import {
  schemaVersionLiteral,
  schemaVersionLockstepFailures,
} from "../lib/schema-version-lockstep.mjs";

// Issue #2489 (Finding 8) — direct, in-process unit tests of the pure comparison logic behind
// check-contract-boundaries.mjs's schema-version-lockstep check (no subprocess, no fixture files).
// check-contract-boundaries.test.mjs still covers the end-to-end CLI behavior via spawnSync; these
// tests exist because spawnSync execution is invisible to v8/Istanbul coverage on the parent
// (vitest) process, so the comparison logic needs its own directly-imported unit tests to get
// real line coverage.
describe("schemaVersionLiteral", () => {
  it("extracts the literal from a matching export", () => {
    expect(
      schemaVersionLiteral(
        'export const EDITOR_AGENT_SCHEMA_VERSION = "1" as const;',
        "EDITOR_AGENT_SCHEMA_VERSION",
      ),
    ).toBe("1");
  });

  it("returns undefined when the export is not present", () => {
    expect(
      schemaVersionLiteral("export const OTHER = 1;", "EDITOR_AGENT_SCHEMA_VERSION"),
    ).toBeUndefined();
  });
});

describe("schemaVersionLockstepFailures", () => {
  it("returns no failures when both ladders match", () => {
    expect(
      schemaVersionLockstepFailures(
        'export const EDITOR_AGENT_SCHEMA_VERSION = "1" as const;',
        'export const EDITOR_VERIFICATION_SCHEMA_VERSION = "1" as const;',
      ),
    ).toEqual([]);
  });

  it("reports drift between the two ladders", () => {
    expect(
      schemaVersionLockstepFailures(
        'export const EDITOR_AGENT_SCHEMA_VERSION = "1" as const;',
        'export const EDITOR_VERIFICATION_SCHEMA_VERSION = "2" as const;',
      ),
    ).toEqual([
      'EDITOR_AGENT_SCHEMA_VERSION ("1") and EDITOR_VERIFICATION_SCHEMA_VERSION ("2") have drifted ' +
        "out of lockstep.",
    ]);
  });

  it("reports a missing constant on either side instead of drift", () => {
    expect(
      schemaVersionLockstepFailures(
        "export const OTHER = 1;",
        'export const EDITOR_VERIFICATION_SCHEMA_VERSION = "1" as const;',
      ),
    ).toEqual([
      "packages/keiko-contracts/src/editor-agent.ts: could not find EDITOR_AGENT_SCHEMA_VERSION " +
        "to check schema-version lockstep.",
    ]);
    expect(
      schemaVersionLockstepFailures(
        'export const EDITOR_AGENT_SCHEMA_VERSION = "1" as const;',
        "export const OTHER = 1;",
      ),
    ).toEqual([
      "packages/keiko-contracts/src/editor-verification.ts: could not find " +
        "EDITOR_VERIFICATION_SCHEMA_VERSION to check schema-version lockstep.",
    ]);
  });
});
