// Regression guard for Issue #2281's evidence contract. `docs/qa/docked-agent-managed-lsp-
// verification.md` requires a filled "Required evidence record" with one row per language,
// operation, and failure-matrix cell; this proves that filled record exists on disk rather than
// only the spec/contract that describes what it must contain.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function evidenceDoc(): string {
  return readFileSync("docs/qa/docked-agent-managed-lsp-evidence.md", "utf8");
}

function integrationSuiteSource(): string {
  return readFileSync("tests/editor-agent-managed-lsp.integration.test.ts", "utf8");
}

function countTestCases(source: string): number {
  return (source.match(/^\s*it\(/gm) ?? []).length;
}

const OPERATIONS = [
  "Diagnostics",
  "Definition",
  "References",
  "Type definition",
  "Implementation",
  "Call hierarchy",
  "Inlay hints",
  "Signature help",
  "Prepare rename",
  "Code actions",
] as const;

const FAILURE_STATES = [
  "Active",
  "Disabled",
  "Policy blocked",
  "Missing",
  "Unhealthy",
  "Unsupported operation",
  "Timeout",
  "Cancel before dispatch",
  "Cancel in flight",
  "Truncation",
  "Workspace switch",
  "Stale activation revision",
  "Stale capability snapshot",
  "Restart",
  "Malformed or oversized response",
] as const;

describe("docked-agent managed-LSP evidence record (#2281)", () => {
  it("records a row for every operation in the language and operation matrix", () => {
    const doc = evidenceDoc();
    for (const operation of OPERATIONS) {
      expect(doc).toContain(`| ${operation}`);
    }
  });

  it("records a row for every state in the effective-state and failure matrix", () => {
    const doc = evidenceDoc();
    for (const state of FAILURE_STATES) {
      expect(doc).toContain(`| ${state}`);
    }
  });

  it("cites the run header fields required by the verification contract", () => {
    const doc = evidenceDoc();
    expect(doc).toMatch(/\| Commit\s+\|/);
    expect(doc).toMatch(/\| Platform\s+\|/);
    expect(doc).toMatch(/\| Artifact\s+\|/);
    expect(doc).toMatch(/sha256:[0-9a-f]{64}/);
  });

  it("discloses gaps as explicit limitations instead of claiming full coverage", () => {
    const doc = evidenceDoc();
    expect(doc).toMatch(/shared-infra proof only/i);
    expect(doc).toContain("no docked-agent-path test");
  });

  it("claims a test count that matches the actual number of it(...) blocks in the suite", () => {
    const doc = evidenceDoc();
    const claimedCountMatch = /(\d+)\/\1 tests passed/.exec(doc);
    expect(claimedCountMatch).not.toBeNull();
    const claimedCount = Number(claimedCountMatch?.[1]);
    const actualCount = countTestCases(integrationSuiteSource());
    expect(claimedCount).toBe(actualCount);
  });
});
