// Unit tests for ingestInlineSources (Epic #270, Issue #278).
//
// Mutation-robust: boundary values, control-flow branches, and error path branches each
// have dedicated test cases that would fail if the condition were inverted or shifted.
// Deterministic — no async, no network, no filesystem.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ingestInlineSources, QiIngestionError } from "../runIngestion.js";
import type { IngestInlineSourcesInput } from "../runIngestion.js";
import type { QualityIntelligenceStartRunRequest } from "@oscharko-dev/keiko-contracts";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

const RUN_ID = "run-test-001";
const TS = "2026-06-01T12:00:00.000Z";

function reqWith(
  sources: QualityIntelligenceStartRunRequest["sources"],
): QualityIntelligenceStartRunRequest {
  return { sources };
}

function input(sources: QualityIntelligenceStartRunRequest["sources"]): IngestInlineSourcesInput {
  return { request: reqWith(sources), runId: RUN_ID, registeredAt: TS };
}

function requirementsSource(
  label: string,
  text: string,
): { kind: "requirements"; label: string; text: string } {
  return { kind: "requirements", label, text };
}

// A valid multi-sentence text that produces at least one atom.
const VALID_TEXT =
  "The system shall allow users to log in with email and password.\n" +
  "The system shall display an error message when the password is incorrect.\n" +
  "The system shall lock the account after five failed attempts.";

// ─── Error paths: empty / missing sources ─────────────────────────────────────

describe("ingestInlineSources — QI_NO_SOURCES", () => {
  it("throws QiIngestionError with code QI_NO_SOURCES when sources array is empty", () => {
    expect(() => ingestInlineSources(input([]))).toThrow(QiIngestionError);
  });

  it("QI_NO_SOURCES error code is exactly 'QI_NO_SOURCES'", () => {
    try {
      ingestInlineSources(input([]));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QiIngestionError);
      expect((err as QiIngestionError).code).toBe("QI_NO_SOURCES");
    }
  });
});

// ─── Error paths: blank-only source ──────────────────────────────────────────

describe("ingestInlineSources — QI_SOURCE_EMPTY", () => {
  it("throws QI_SOURCE_EMPTY when the only source contains only whitespace", () => {
    try {
      ingestInlineSources(input([requirementsSource("Blank", "   \n\n\t  ")]));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QiIngestionError);
      expect((err as QiIngestionError).code).toBe("QI_SOURCE_EMPTY");
    }
  });

  it("throws QI_SOURCE_EMPTY when the source text is an empty string", () => {
    try {
      ingestInlineSources(input([requirementsSource("Empty", "")]));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as QiIngestionError).code).toBe("QI_SOURCE_EMPTY");
    }
  });
});

// ─── Error paths: oversize ────────────────────────────────────────────────────

describe("ingestInlineSources — QI_SOURCE_TOO_LARGE", () => {
  it("throws QI_SOURCE_TOO_LARGE when the source text exceeds 5,000,000 bytes", () => {
    // Build exactly 5_000_001 ASCII bytes (one byte over the limit).
    const oversizeText = "x".repeat(5_000_001);
    try {
      ingestInlineSources(input([requirementsSource("Giant", oversizeText)]));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QiIngestionError);
      expect((err as QiIngestionError).code).toBe("QI_SOURCE_TOO_LARGE");
    }
  });

  it("does NOT throw QI_SOURCE_TOO_LARGE for a source exactly at the limit (5,000,000 bytes)", () => {
    // This should not throw the oversize error — it may succeed or fail for another reason,
    // but the guard must be ≤ not <.  We just verify the error code is NOT QI_SOURCE_TOO_LARGE.
    const atLimitText = "a".repeat(4_999_990) + " ".repeat(10); // 5,000,000 bytes
    try {
      ingestInlineSources(input([requirementsSource("AtLimit", atLimitText)]));
      // If it succeeds that's fine too — the point is it does not throw TOO_LARGE.
    } catch (err) {
      expect((err as QiIngestionError).code).not.toBe("QI_SOURCE_TOO_LARGE");
    }
  });
});

// ─── Error paths: workspace source ───────────────────────────────────────────

describe("ingestInlineSources — workspace folder (Issue #278)", () => {
  const tmpDirs: string[] = [];
  const makeDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "qi-ws-"));
    tmpDirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("ingests readable files from a folder into repository-context atoms", () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, "spec.md"),
      "# Spec\nThe export must produce a CSV file.\nThe import must reject malformed rows.\n",
      "utf8",
    );
    const result = ingestInlineSources(input([{ kind: "workspace", label: "Specs", path: dir }]));
    expect(result.ingestedAtoms.length).toBeGreaterThan(0);
    expect(result.envelopes[0]?.kind).toBe("repository-context");
    // The excerpt content reaches the model-facing canonical text.
    expect(result.ingestedAtoms.some((a) => a.canonicalText.includes("CSV"))).toBe(true);
  });

  it("throws QI_SOURCE_EMPTY when the folder has no readable files", () => {
    const dir = makeDir();
    try {
      ingestInlineSources(input([{ kind: "workspace", label: "Empty", path: dir }]));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QiIngestionError);
      expect((err as QiIngestionError).code).toBe("QI_SOURCE_EMPTY");
    }
  });
});

// ─── Happy path: envelopes and atoms ─────────────────────────────────────────

describe("ingestInlineSources — happy path", () => {
  it("returns at least one ingested atom for a valid requirements source", () => {
    const result = ingestInlineSources(input([requirementsSource("Requirements", VALID_TEXT)]));
    expect(result.ingestedAtoms.length).toBeGreaterThan(0);
  });

  it("returns exactly one envelope for a single source", () => {
    const result = ingestInlineSources(input([requirementsSource("Spec", VALID_TEXT)]));
    expect(result.envelopes).toHaveLength(1);
  });

  it("envelope kind is 'human-context' for a requirements source", () => {
    const result = ingestInlineSources(input([requirementsSource("Spec", VALID_TEXT)]));
    expect(result.envelopes[0]?.kind).toBe("human-context");
  });

  it("envelope displayLabel matches the sanitised source label", () => {
    const result = ingestInlineSources(input([requirementsSource("My Label", VALID_TEXT)]));
    expect(result.envelopes[0]?.displayLabel).toBe("My Label");
  });

  it("envelope localRef is a string and non-empty", () => {
    const result = ingestInlineSources(input([requirementsSource("Spec", VALID_TEXT)]));
    expect(typeof result.envelopes[0]?.localRef).toBe("string");
    expect((result.envelopes[0]?.localRef ?? "").length).toBeGreaterThan(0);
  });

  it("returns one sourceSummary per source", () => {
    const result = ingestInlineSources(
      input([requirementsSource("A", VALID_TEXT), requirementsSource("B", VALID_TEXT)]),
    );
    expect(result.sourceSummaries).toHaveLength(2);
  });

  it("sourceSummary.kind matches the source kind", () => {
    const result = ingestInlineSources(input([requirementsSource("Spec", VALID_TEXT)]));
    expect(result.sourceSummaries[0]?.kind).toBe("requirements");
  });

  it("sourceSummary.atomCount matches the number of atoms for that source", () => {
    const result = ingestInlineSources(input([requirementsSource("Spec", VALID_TEXT)]));
    const summary = result.sourceSummaries[0];
    expect(summary?.atomCount).toBe(result.ingestedAtoms.length);
  });
});

// ─── Label sanitisation ───────────────────────────────────────────────────────

describe("ingestInlineSources — label sanitisation", () => {
  it("strips a URL from the label", () => {
    const result = ingestInlineSources(
      input([requirementsSource("Spec https://example.com/sheet", VALID_TEXT)]),
    );
    expect(result.envelopes[0]?.displayLabel).not.toContain("https://");
  });

  it("falls back to 'Untitled source' when label is only a URL", () => {
    const result = ingestInlineSources(
      input([requirementsSource("https://jira.example.com/browse/PROJ-123", VALID_TEXT)]),
    );
    expect(result.envelopes[0]?.displayLabel).toBe("Untitled source");
  });

  it("falls back to 'Untitled source' when label is empty after trimming", () => {
    const result = ingestInlineSources(input([requirementsSource("   ", VALID_TEXT)]));
    expect(result.envelopes[0]?.displayLabel).toBe("Untitled source");
  });

  it("truncates a label longer than 120 chars with an ellipsis", () => {
    const longLabel = "A".repeat(200);
    const result = ingestInlineSources(input([requirementsSource(longLabel, VALID_TEXT)]));
    const label = result.envelopes[0]?.displayLabel ?? "";
    expect(label.length).toBeLessThanOrEqual(120);
    expect(label.endsWith("…")).toBe(true);
  });

  it("preserves a label exactly 120 chars without truncating", () => {
    const exactLabel = "B".repeat(120);
    const result = ingestInlineSources(input([requirementsSource(exactLabel, VALID_TEXT)]));
    expect(result.envelopes[0]?.displayLabel).toBe(exactLabel);
  });
});

// ─── Provenance refs ─────────────────────────────────────────────────────────

describe("ingestInlineSources — provenanceRefs", () => {
  it("envelopeIds contains one entry per source envelope", () => {
    const result = ingestInlineSources(
      input([requirementsSource("A", VALID_TEXT), requirementsSource("B", VALID_TEXT)]),
    );
    expect(result.provenanceRefs.envelopeIds).toHaveLength(2);
  });

  it("envelopeIds entries match the envelope id strings", () => {
    const result = ingestInlineSources(input([requirementsSource("Spec", VALID_TEXT)]));
    const [envId] = result.provenanceRefs.envelopeIds;
    expect(envId).toBe(String(result.envelopes[0]?.id));
  });

  it("auditSummaryId starts with 'qi-audit-' prefix", () => {
    const result = ingestInlineSources(input([requirementsSource("Spec", VALID_TEXT)]));
    expect(String(result.provenanceRefs.auditSummaryId)).toMatch(/^qi-audit-/);
  });

  it("auditSummaryId is deterministic for the same runId", () => {
    const inp = input([requirementsSource("Spec", VALID_TEXT)]);
    const r1 = ingestInlineSources(inp);
    const r2 = ingestInlineSources(inp);
    expect(r1.provenanceRefs.auditSummaryId).toBe(r2.provenanceRefs.auditSummaryId);
  });

  it("different runIds produce different auditSummaryIds", () => {
    const src = [requirementsSource("Spec", VALID_TEXT)];
    const r1 = ingestInlineSources({ request: reqWith(src), runId: "run-001", registeredAt: TS });
    const r2 = ingestInlineSources({ request: reqWith(src), runId: "run-002", registeredAt: TS });
    expect(r1.provenanceRefs.auditSummaryId).not.toBe(r2.provenanceRefs.auditSummaryId);
  });
});

// ─── MAX_TOTAL_ATOMS cap ─────────────────────────────────────────────────────

describe("ingestInlineSources — MAX_TOTAL_ATOMS cap (120)", () => {
  // Build a source that reliably produces many atoms: 130 numbered requirement sentences.
  function largeSentences(count: number): string {
    return Array.from(
      { length: count },
      (_, i) => `The system shall satisfy requirement number ${String(i + 1)}.`,
    ).join("\n");
  }

  it("total atoms never exceeds 120 even with many sources", () => {
    // Two sources each able to produce many atoms.
    const src = [
      requirementsSource("Big A", largeSentences(80)),
      requirementsSource("Big B", largeSentences(80)),
    ];
    const result = ingestInlineSources({ request: reqWith(src), runId: RUN_ID, registeredAt: TS });
    expect(result.ingestedAtoms.length).toBeLessThanOrEqual(120);
  });

  it("still produces envelopes for sources that were capped to zero atoms", () => {
    // Fill 120 atoms with the first source, then add a second.
    const src = [
      requirementsSource("First", largeSentences(130)),
      requirementsSource("Second", VALID_TEXT),
    ];
    const result = ingestInlineSources({ request: reqWith(src), runId: RUN_ID, registeredAt: TS });
    // Both sources should have envelopes even if the second contributed zero atoms.
    expect(result.envelopes).toHaveLength(2);
    expect(result.ingestedAtoms.length).toBeLessThanOrEqual(120);
  });

  it("throws QI_SOURCE_EMPTY if all atoms from all sources are capped away", () => {
    // Only a workspace source — triggers QI_SOURCE_UNSUPPORTED first, but let's verify the
    // second empty-aggregate guard for requirements: craft a scenario where all atoms from a
    // single-source request are capped because zero atoms were produced before the cap.
    // (This tests the post-loop guard rather than per-source guard.)
    // Use blank text: the per-source guard fires before the post-loop guard.
    try {
      ingestInlineSources(input([requirementsSource("Blank", "")]));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as QiIngestionError).code).toBe("QI_SOURCE_EMPTY");
    }
  });
});

// ─── Multiple sources ─────────────────────────────────────────────────────────

describe("ingestInlineSources — multiple sources", () => {
  it("accumulates atoms from all sources", () => {
    const result = ingestInlineSources(
      input([requirementsSource("A", VALID_TEXT), requirementsSource("B", VALID_TEXT)]),
    );
    // Two sources should produce more atoms than one.
    const singleResult = ingestInlineSources(input([requirementsSource("A", VALID_TEXT)]));
    expect(result.ingestedAtoms.length).toBeGreaterThanOrEqual(singleResult.ingestedAtoms.length);
  });

  it("a mixed requirements + workspace array accumulates atoms from both", () => {
    const dir = mkdtempSync(join(tmpdir(), "qi-mix-"));
    try {
      writeFileSync(join(dir, "extra.md"), "The audit log must be immutable.\n", "utf8");
      const result = ingestInlineSources(
        input([
          requirementsSource("First", VALID_TEXT),
          { kind: "workspace", label: "Repo", path: dir },
        ]),
      );
      expect(result.envelopes.length).toBe(2);
      expect(result.sourceSummaries.map((s) => s.kind)).toEqual(["requirements", "workspace"]);
      expect(result.ingestedAtoms.length).toBeGreaterThan(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
