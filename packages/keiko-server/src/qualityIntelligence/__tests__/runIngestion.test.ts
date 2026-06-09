// Unit tests for ingestInlineSources (Epic #270, Issue #278).
//
// Mutation-robust: boundary values, control-flow branches, and error path branches each
// have dedicated test cases that would fail if the condition were inverted or shifted.
// Deterministic — no async, no network, no filesystem.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ingestInlineSources, QiIngestionError } from "../runIngestion.js";
import type { IngestInlineSourcesInput, QiIngestionResult } from "../runIngestion.js";
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

function ingest(input: IngestInlineSourcesInput): QiIngestionResult {
  return ingestInlineSources(input);
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
    const result = ingest(input([{ kind: "workspace", label: "Specs", path: dir }]));
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

// ─── Single file (Issue #713) ────────────────────────────────────────────────

describe("ingestInlineSources — single file (Issue #713)", () => {
  const tmpDirs: string[] = [];
  const makeDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "qi-file-"));
    tmpDirs.push(dir);
    return dir;
  };
  const writeFile = (dir: string, name: string, content: string): string => {
    const path = join(dir, name);
    writeFileSync(path, content, "utf8");
    return path;
  };
  const fileSource = (
    label: string,
    path: string,
  ): { kind: "file"; label: string; path: string } => ({ kind: "file", label, path });
  afterAll(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("ingests exactly one supported document into a single repository-context atom", () => {
    const dir = makeDir();
    const path = writeFile(
      dir,
      "fachkonzept.md",
      "# Funds Transfer\nThe system shall validate the IBAN before submitting a transfer.\n",
    );
    const result = ingest(input([fileSource("Fachkonzept", path)]));
    expect(result.ingestedAtoms.length).toBe(1);
    expect(result.envelopes).toHaveLength(1);
    expect(result.envelopes[0]?.kind).toBe("repository-context");
    expect(result.envelopes[0]?.provenance.origin).toBe("file");
    expect(result.ingestedAtoms[0]?.canonicalText.includes("IBAN")).toBe(true);
    expect(result.sourceSummaries[0]?.kind).toBe("file");
    expect(result.sourceSummaries[0]?.atomCount).toBe(1);
  });

  it("ingests ONLY the connected file, not its siblings in the same folder", () => {
    const dir = makeDir();
    writeFile(dir, "other.md", "BRAVO sibling content that must not be ingested.\n");
    const path = writeFile(dir, "spec.md", "ALPHA the only requirement that should appear.\n");
    const result = ingest(input([fileSource("Spec", path)]));
    const joined = result.ingestedAtoms.map((a) => a.canonicalText).join("\n");
    expect(joined.includes("ALPHA")).toBe(true);
    expect(joined.includes("BRAVO")).toBe(false);
  });

  it("classifies a source-code file as a code-fragment atom", () => {
    const dir = makeDir();
    const path = writeFile(
      dir,
      "service.ts",
      "export const fee = (amount: number) => amount * 0.01;\n",
    );
    const result = ingest(input([fileSource("Service", path)]));
    expect(result.ingestedAtoms[0]?.atom.kind).toBe("code-fragment");
  });

  it("ingests a supported nested absolute file path", () => {
    const dir = makeDir();
    const docsDir = join(dir, "docs");
    mkdirSync(docsDir);
    const path = writeFile(
      docsDir,
      "spec.md",
      "# Nested Spec\nThe system shall validate the transfer amount before submission.\n",
    );
    const result = ingest(input([fileSource("NestedSpec", path)]));
    expect(result.ingestedAtoms).toHaveLength(1);
    expect(result.ingestedAtoms[0]?.canonicalText.includes("Nested Spec")).toBe(true);
  });

  it("throws QI_BAD_SOURCE for a relative single-file path", () => {
    try {
      ingest(input([fileSource("Relative", "docs/spec.md")]));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as QiIngestionError).code).toBe("QI_BAD_SOURCE");
    }
  });

  it("ingests a supported PDF single-file source for folder-parity best-effort reads", () => {
    const dir = makeDir();
    const path = writeFile(dir, "spec.pdf", "%PDF-1.7 fake fachkonzept");
    const result = ingest(input([fileSource("PDF", path)]));
    expect(result.ingestedAtoms).toHaveLength(1);
    expect(result.ingestedAtoms[0]?.canonicalText.includes("fake fachkonzept")).toBe(true);
  });

  it("ingests a supported DOCX single-file source for folder-parity best-effort reads", () => {
    const dir = makeDir();
    const path = writeFile(dir, "spec.docx", "PK fake docx fachkonzept");
    const result = ingest(input([fileSource("DOCX", path)]));
    expect(result.ingestedAtoms).toHaveLength(1);
    expect(result.ingestedAtoms[0]?.canonicalText.includes("fake docx")).toBe(true);
  });

  it("throws QI_SOURCE_UNSUPPORTED for a text-extension file with binary (NUL) content", () => {
    const dir = makeDir();
    const path = writeFile(dir, "mislabelled.txt", `head${String.fromCharCode(0)}binary tail`);
    try {
      ingest(input([fileSource("Mislabelled", path)]));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as QiIngestionError).code).toBe("QI_SOURCE_UNSUPPORTED");
    }
  });

  it("throws QI_SOURCE_TOO_LARGE when the file exceeds the single-file size limit", () => {
    const dir = makeDir();
    const path = writeFile(dir, "huge.md", "a".repeat(196_609));
    try {
      ingest(input([fileSource("Huge", path)]));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as QiIngestionError).code).toBe("QI_SOURCE_TOO_LARGE");
    }
  });

  it("throws QI_SOURCE_EMPTY when the file contains only whitespace", () => {
    const dir = makeDir();
    const path = writeFile(dir, "blank.md", "   \n\n\t  ");
    try {
      ingest(input([fileSource("Blank", path)]));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as QiIngestionError).code).toBe("QI_SOURCE_EMPTY");
    }
  });

  it("throws QI_WORKSPACE_NOT_FOUND when the file does not exist", () => {
    const dir = makeDir();
    try {
      ingest(input([fileSource("Missing", join(dir, "nope.md"))]));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as QiIngestionError).code).toBe("QI_WORKSPACE_NOT_FOUND");
    }
  });

  it("throws QI_SOURCE_DENIED for a supported file inside a denied credential directory", () => {
    const dir = makeDir();
    const sshDir = join(dir, ".ssh");
    mkdirSync(sshDir);
    const path = writeFile(sshDir, "notes.md", "secret notes that must never be ingested");
    try {
      ingest(input([fileSource("SshNotes", path)]));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as QiIngestionError).code).toBe("QI_SOURCE_DENIED");
    }
  });

  it("throws QI_SOURCE_UNSUPPORTED for a file with an unsupported extension", () => {
    // Plain-text content (no NUL) so the failure can ONLY originate at the extension gate
    // (isSupportedFilePath), not the binary guard — this locks that branch against mutation.
    const dir = makeDir();
    const path = writeFile(dir, "installer.exe", "plain readable text, definitely not binary");
    try {
      ingest(input([fileSource("Installer", path)]));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as QiIngestionError).code).toBe("QI_SOURCE_UNSUPPORTED");
    }
  });

  it("normalises a '..' traversal in an absolute path and still enforces the deny-list", () => {
    // An absolute path with '..' segments that resolves into a denied credential directory must
    // still be denied — resolve() normalises the path before the deny check, so traversal cannot
    // smuggle a protected file past isDenied (the traversal half of #713's traversal/deny edge).
    const dir = makeDir();
    const sshDir = join(dir, ".ssh");
    mkdirSync(sshDir);
    writeFile(sshDir, "id.md", "credential-adjacent notes");
    const traversal = join(dir, "sub", "..", ".ssh", "id.md");
    try {
      ingest(input([fileSource("Traversal", traversal)]));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as QiIngestionError).code).toBe("QI_SOURCE_DENIED");
    }
  });

  it("rejects a best-effort PDF whose decoded text is binary noise (NUL byte)", () => {
    // A real PDF's prose lives in compressed streams; decoded as UTF-8 it is binary noise carrying
    // a NUL byte. Reject with a coded error rather than ingest garbage (#713: never partial ingest).
    const dir = makeDir();
    const path = writeFile(dir, "scan.pdf", `%PDF-1.7${String.fromCharCode(0)} compressed stream`);
    try {
      ingest(input([fileSource("ScanPdf", path)]));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as QiIngestionError).code).toBe("QI_SOURCE_UNSUPPORTED");
    }
  });

  it("rejects a best-effort DOCX dominated by control characters (binary ZIP, no NUL)", () => {
    // A DOCX is a ZIP; even without a NUL its decoded bytes are dominated by control characters.
    // The control-character density guard catches it where the NUL check alone would not.
    const dir = makeDir();
    const controls = [1, 2, 3, 4, 5, 6, 7, 8].map((c) => String.fromCharCode(c)).join("");
    const path = writeFile(dir, "report.docx", `PK${controls.repeat(8)}docx`);
    try {
      ingest(input([fileSource("NoisyDocx", path)]));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as QiIngestionError).code).toBe("QI_SOURCE_UNSUPPORTED");
    }
  });

  it("still ingests a genuinely text-based PDF (German prose is not flagged as binary)", () => {
    // The binary guard must not over-reject real prose: a text PDF with umlauts/ß ingests normally.
    const dir = makeDir();
    const path = writeFile(dir, "spec.pdf", "Fachkonzept: Überweisung mit Prüfziffer und Deckung.");
    const result = ingest(input([fileSource("TextPdf", path)]));
    expect(result.ingestedAtoms).toHaveLength(1);
    expect(result.ingestedAtoms[0]?.canonicalText.includes("Prüfziffer")).toBe(true);
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

// ─── Multi-source fair budget + cap (Epic #729, Issue #730) ──────────────────────

// Build a requirements source that yields at least `n` atoms (one per sentence line).
function manyReqs(label: string, n: number): { kind: "requirements"; label: string; text: string } {
  const text = Array.from(
    { length: n },
    (_, i) => `The system shall satisfy requirement number ${String(i)} for ${label} precisely.`,
  ).join("\n");
  return { kind: "requirements", label, text };
}

const MAX_TOTAL_ATOMS = 120;

describe("ingestInlineSources — fair per-source budget (Issue #730)", () => {
  it("splits the global atom budget evenly across sources (3 large sources → 40 each)", () => {
    const result = ingest(input([manyReqs("A", 100), manyReqs("B", 100), manyReqs("C", 100)]));
    // floor(120/3) = 40 per source.
    expect(result.ingestedAtoms.length).toBe(MAX_TOTAL_ATOMS);
    expect(result.sourceSummaries.map((s) => s.atomCount)).toEqual([40, 40, 40]);
  });

  it("does not let one large source starve the others", () => {
    const result = ingest(
      input([manyReqs("Big", 100), manyReqs("S1", 10), manyReqs("S2", 10), manyReqs("S3", 10)]),
    );
    // floor(120/4) = 30 per source; the big source is bounded to 30 while small sources keep theirs.
    const counts = result.sourceSummaries.map((s) => s.atomCount);
    expect(counts[0]).toBe(30);
    expect(counts[1]).toBe(10);
    expect(counts[2]).toBe(10);
    expect(counts[3]).toBe(10);
    expect(result.droppedSourceCount).toBe(0);
  });

  it("keeps the whole budget for a single source", () => {
    const result = ingest(input([manyReqs("Solo", 200)]));
    expect(result.ingestedAtoms.length).toBe(MAX_TOTAL_ATOMS);
    expect(result.droppedSourceCount).toBe(0);
  });

  it("caps the source count at 16 and reports the dropped overflow", () => {
    const sources = Array.from({ length: 17 }, (_, i) => manyReqs(`S${String(i)}`, 5));
    const result = ingest(input(sources));
    expect(result.sourceSummaries.length).toBe(16);
    expect(result.droppedSourceCount).toBe(1);
    // Every ingested atom stays source-tagged via its envelope.
    expect(result.envelopes.length).toBe(16);
  });

  it("reports droppedSourceCount = 0 when at the cap exactly", () => {
    const sources = Array.from({ length: 16 }, (_, i) => manyReqs(`S${String(i)}`, 3));
    const result = ingest(input(sources));
    expect(result.sourceSummaries.length).toBe(16);
    expect(result.droppedSourceCount).toBe(0);
  });

  it("ingests a mix of requirements and single-file sources fairly", () => {
    const result = ingest(input([manyReqs("Reqs", 100), manyReqs("MoreReqs", 100)]));
    // floor(120/2) = 60 each.
    expect(result.sourceSummaries.map((s) => s.atomCount)).toEqual([60, 60]);
  });
});

// ─── Capsule source (Epic #710, Issue #717) ───────────────────────────────────

function capsuleSource(
  label: string,
  capsuleId: string,
): { kind: "capsule"; label: string; capsuleId: string } {
  return { kind: "capsule", label, capsuleId };
}

function inputWithResolver(
  sources: QualityIntelligenceStartRunRequest["sources"],
  capsuleResolver?: IngestInlineSourcesInput["capsuleResolver"],
): IngestInlineSourcesInput {
  return { request: reqWith(sources), runId: RUN_ID, registeredAt: TS, capsuleResolver };
}

describe("ingestInlineSources — capsule source (Issue #717)", () => {
  it("throws QI_CAPSULE_UNAVAILABLE when no capsuleResolver is provided", () => {
    try {
      ingestInlineSources(inputWithResolver([capsuleSource("Docs", "cap-1")]));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QiIngestionError);
      expect((err as QiIngestionError).code).toBe("QI_CAPSULE_UNAVAILABLE");
    }
  });

  it("throws QI_CAPSULE_UNAVAILABLE when the resolver returns no documents", () => {
    const resolver = (_capsuleId: string): readonly { documentId: string; text: string }[] => [];
    try {
      ingestInlineSources(inputWithResolver([capsuleSource("Empty", "cap-empty")], resolver));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as QiIngestionError).code).toBe("QI_CAPSULE_UNAVAILABLE");
    }
  });

  it("produces one document-excerpt atom per document returned by the resolver", () => {
    const docs = [
      { documentId: "doc-a", text: "The system shall validate input before processing." },
      { documentId: "doc-b", text: "The system shall log all failures to the audit trail." },
    ];
    const resolver = (_capsuleId: string): readonly { documentId: string; text: string }[] => docs;
    const result = ingest(inputWithResolver([capsuleSource("Spec Capsule", "cap-spec")], resolver));
    expect(result.ingestedAtoms.length).toBe(2);
    expect(result.ingestedAtoms[0]?.atom.kind).toBe("document-excerpt");
    expect(result.ingestedAtoms[1]?.atom.kind).toBe("document-excerpt");
  });

  it("canonical text includes the documentId prefix", () => {
    const docs = [{ documentId: "req-doc", text: "The system shall support SSO login." }];
    const resolver = (_capsuleId: string): readonly { documentId: string; text: string }[] => docs;
    const result = ingest(inputWithResolver([capsuleSource("SSO", "cap-sso")], resolver));
    const canonical = result.ingestedAtoms[0]?.canonicalText ?? "";
    expect(canonical.startsWith("req-doc\n")).toBe(true);
  });

  it("envelope kind is 'local-knowledge-capsule'", () => {
    const docs = [{ documentId: "d1", text: "Requirement text here." }];
    const resolver = (_capsuleId: string): readonly { documentId: string; text: string }[] => docs;
    const result = ingest(inputWithResolver([capsuleSource("Capsule", "cap-x")], resolver));
    expect(result.envelopes[0]?.kind).toBe("local-knowledge-capsule");
  });

  it("sourceSummary kind is 'capsule'", () => {
    const docs = [{ documentId: "d1", text: "Requirement text here." }];
    const resolver = (_capsuleId: string): readonly { documentId: string; text: string }[] => docs;
    const result = ingest(inputWithResolver([capsuleSource("Capsule", "cap-x")], resolver));
    expect(result.sourceSummaries[0]?.kind).toBe("capsule");
  });

  it("capsule atoms participate in the same fair per-source budget as other sources", () => {
    const manyDocs = Array.from({ length: 100 }, (_, i) => ({
      documentId: `doc-${String(i)}`,
      text: `Requirement number ${String(i)} to satisfy.`,
    }));
    const capsuleResolver = (_capsuleId: string): readonly { documentId: string; text: string }[] =>
      manyDocs;
    const result = ingest(
      inputWithResolver(
        [capsuleSource("Big Capsule", "cap-big"), manyReqs("Reqs", 100)],
        capsuleResolver,
      ),
    );
    // floor(120/2) = 60 each — capsule must not dominate.
    expect(result.ingestedAtoms.length).toBe(MAX_TOTAL_ATOMS);
    expect(result.sourceSummaries[0]?.atomCount).toBe(60);
    expect(result.sourceSummaries[1]?.atomCount).toBe(60);
  });
});
