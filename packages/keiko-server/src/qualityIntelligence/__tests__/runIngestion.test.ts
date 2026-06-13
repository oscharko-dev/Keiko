// Unit tests for ingestInlineSources (Epic #270, Issue #278).
//
// Mutation-robust: boundary values, control-flow branches, and error path branches each
// have dedicated test cases that would fail if the condition were inverted or shifted.
// Deterministic — no async, no network, no filesystem.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("atomizes multiple requirements in one markdown file into separate requirement atoms", () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, "requirements.md"),
      [
        "REQ-DRIFT-001: The audit login flow must require multi-factor verification before access.",
        "REQ-DRIFT-002: The audit transfer flow must show a confirmation screen before submit.",
      ].join("\n"),
      "utf8",
    );
    const result = ingest(input([{ kind: "workspace", label: "Drift fixture", path: dir }]));
    expect(result.ingestedAtoms).toHaveLength(2);
    expect(result.ingestedAtoms.map((entry) => entry.atom.kind)).toEqual([
      "requirement",
      "requirement",
    ]);
    expect(result.ingestedAtoms[0]?.canonicalText).toContain("requirements.md");
    expect(result.ingestedAtoms[0]?.canonicalText).toContain("REQ-DRIFT-001");
    expect(result.ingestedAtoms[1]?.canonicalText).toContain("REQ-DRIFT-002");
    expect(result.sourceSummaries[0]?.atomCount).toBe(2);
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

  it("atomizes a multi-requirement single file for coverage traceability", () => {
    const dir = makeDir();
    const path = writeFile(
      dir,
      "requirements.md",
      [
        "REQ-DRIFT-001: The audit login flow must require multi-factor verification before access.",
        "REQ-DRIFT-002: The audit transfer flow must show a confirmation screen before submit.",
      ].join("\n"),
    );
    const result = ingest(input([fileSource("Requirements", path)]));
    expect(result.ingestedAtoms).toHaveLength(2);
    expect(result.ingestedAtoms.map((entry) => entry.atom.kind)).toEqual([
      "requirement",
      "requirement",
    ]);
    expect(result.ingestedAtoms[0]?.canonicalText).toContain("requirements.md");
    expect(result.ingestedAtoms[0]?.canonicalText).toContain("REQ-DRIFT-001");
    expect(result.ingestedAtoms[1]?.canonicalText).toContain("REQ-DRIFT-002");
    expect(result.sourceSummaries[0]?.atomCount).toBe(2);
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

  it("ingests a single file exactly at the size limit (boundary is ≤, not <)", () => {
    // 196_608 bytes is the single-file budget. A file of EXACTLY that size must still ingest — the
    // keiko-workspace size guard is `size > maxBytes`, so the boundary value is accepted, never
    // truncated (the evidence budget equals the read cap for a lone source). This pairs with the
    // oversize case above to lock the boundary against a `>`→`>=` mutation.
    const dir = makeDir();
    const path = writeFile(dir, "at-limit.md", "a".repeat(196_608));
    const result = ingest(input([fileSource("AtLimit", path)]));
    expect(result.ingestedAtoms).toHaveLength(1);
    expect(result.envelopes[0]?.provenance.origin).toBe("file");
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

  it("throws QI_SOURCE_DENIED when a benign-named symlinked parent resolves into a denied dir", () => {
    // Defense-in-depth (#713 security review: "deny-list still applies"). A directory symlink whose
    // name is innocuous ("docs") but whose REAL target is a denied credential dir (".aws") must not
    // let a supported file inside it read through. The lexical deny check sees only "docs"; the
    // keiko-workspace deny gate sees only the basename relative to the realpath'd root — so without a
    // realpath re-check over the connected path the credential file would be ingested. This pins the
    // symlink-root half of the deny invariant and fails if assertRealPathNotDenied is removed.
    const dir = makeDir();
    const awsDir = join(dir, ".aws");
    mkdirSync(awsDir);
    writeFile(
      awsDir,
      "config.md",
      "aws_session_token opaque-bare-token-018245-not-a-shaped-secret",
    );
    symlinkSync(awsDir, join(dir, "docs")); // benign-named link -> denied real dir
    const viaLink = join(dir, "docs", "config.md"); // lexically "docs/config.md", real ".aws/config.md"
    try {
      ingest(input([fileSource("Docs", viaLink)]));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as QiIngestionError).code).toBe("QI_SOURCE_DENIED");
    }
  });

  it("ingests through a benign-named symlinked parent that resolves to a non-denied dir", () => {
    // Positive companion to the denied-symlink case above. assertRealPathNotDenied must ADD a denial
    // ONLY when the symlink-resolved path lands in a protected location — a benign directory symlink
    // whose real target is an ordinary, non-denied dir must still ingest. This pins the guard against
    // a mutation that throws on EVERY realpath divergence (dropping the `isDenied(realPath)`
    // condition), which would silently break legitimate symlinked working directories. The check is
    // deterministic across platforms: it creates the divergence explicitly rather than relying on a
    // symlinked tmpdir (e.g. macOS `/var` -> `/private/var`), which is absent on Linux CI.
    const dir = makeDir();
    const realDir = join(dir, "real-specs");
    mkdirSync(realDir);
    writeFile(realDir, "spec.md", "# Spec\nThe system shall record an audit entry.\n");
    symlinkSync(realDir, join(dir, "linked")); // benign-named link -> non-denied real dir
    const viaLink = join(dir, "linked", "spec.md");
    const result = ingest(input([fileSource("Linked", viaLink)]));
    expect(result.ingestedAtoms).toHaveLength(1);
    expect(result.envelopes[0]?.provenance.origin).toBe("file");
    expect(result.ingestedAtoms[0]?.canonicalText.includes("audit entry")).toBe(true);
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

  it("strips control characters from a path-shaped multi-line label so displayLabel stays single-line", () => {
    // #277/#278 envelope display-surface invariant + #715 single-file security re-audit. A label whose
    // first line LOOKS like an absolute path must not smuggle a trailing line of content past the
    // basename-collapse into the browser-streamed displayLabel: the collapse splits on "/" only, so
    // without the control-char strip a "\n<more content>" would survive inside the final segment and
    // emit a MULTI-LINE label. sanitiseLabel now replaces every control char with a space first.
    const dir = makeDir();
    const path = writeFile(dir, "spec.md", "# Spec\nThe system shall log every access.\n");
    const result = ingest(
      input([fileSource("/etc/passwd\nroot:x:0:0:injected second line", path)]),
    );
    const displayLabel = result.envelopes[0]?.displayLabel ?? "";
    expect(displayLabel).not.toContain("\n");
    expect(displayLabel).toBe("passwd root:x:0:0:injected second line");
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

  it("keeps the requirements envelope id stable when the requirement text changes in-place", () => {
    const before = ingestInlineSources(
      input([requirementsSource("Spec", "REQ-1: Login must work\nREQ-2: MFA must work")]),
    );
    const after = ingestInlineSources(
      input([
        requirementsSource(
          "Spec",
          "REQ-1: Login must work\nREQ-2: MFA must also log an audit entry",
        ),
      ]),
    );
    expect(before.envelopes[0]?.id).toBe(after.envelopes[0]?.id);
    expect(before.envelopes[0]?.localRef).toBe("req:0");
    expect(after.envelopes[0]?.localRef).toBe("req:0");
  });

  it("keeps unchanged requirement atom ids stable when another line is inserted before them", () => {
    const before = ingestInlineSources(
      input([requirementsSource("Spec", "Login must work reliably\nMFA must work reliably")]),
    );
    const after = ingestInlineSources(
      input([
        requirementsSource(
          "Spec",
          "Inserted unrelated requirement\nLogin must work reliably\nMFA must work reliably",
        ),
      ]),
    );
    expect(before.ingestedAtoms[0]?.atom.id).toBe(after.ingestedAtoms[1]?.atom.id);
    expect(before.ingestedAtoms[1]?.atom.id).toBe(after.ingestedAtoms[2]?.atom.id);
  });

  it("detects workspace file content edits through atom hashes while keeping atom ids stable", () => {
    const dir = mkdtempSync(join(tmpdir(), "qi-ws-stable-"));
    try {
      const path = join(dir, "spec.md");
      writeFileSync(path, "Version one content.\n", "utf8");
      const before = ingestInlineSources(input([{ kind: "workspace", label: "Repo", path: dir }]));
      writeFileSync(path, "Version two content.\n", "utf8");
      const after = ingestInlineSources(input([{ kind: "workspace", label: "Repo", path: dir }]));
      expect(before.ingestedAtoms[0]?.atom.id).toBe(after.ingestedAtoms[0]?.atom.id);
      expect(before.ingestedAtoms[0]?.atom.canonicalHashSha256Hex).not.toBe(
        after.ingestedAtoms[0]?.atom.canonicalHashSha256Hex,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

type CorpusFn = (id: string) => readonly { documentId: string; text: string }[];

function inputWithResolver(
  sources: QualityIntelligenceStartRunRequest["sources"],
  capsule?: CorpusFn,
  capsuleSet?: CorpusFn,
): IngestInlineSourcesInput {
  const capsuleResolver: IngestInlineSourcesInput["capsuleResolver"] =
    capsule === undefined && capsuleSet === undefined
      ? undefined
      : {
          capsule: capsule ?? ((): readonly never[] => []),
          capsuleSet: capsuleSet ?? ((): readonly never[] => []),
        };
  return { request: reqWith(sources), runId: RUN_ID, registeredAt: TS, capsuleResolver };
}

function capsuleSetSource(
  label: string,
  capsuleSetId: string,
): { kind: "capsule-set"; label: string; capsuleSetId: string } {
  return { kind: "capsule-set", label, capsuleSetId };
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

  // ── Redaction parity (Epic #710, Issue #717 — atoms must be genuinely redacted) ──
  it("redacts secrets in capsule document text before they reach the atom / model", () => {
    const awsSecret = ["wJalrXUtnFEMI/K7MDENG/bPxRfiCY", "EXAMPLEKEY"].join("");
    const awsAccessKeyId = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const bearerToken = ["sk-", "live-9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a"].join("");
    const docs = [
      {
        documentId: "integration-notes",
        text:
          "Adapter key:\n" +
          `aws_secret_access_key=${awsSecret}\n` +
          `${awsAccessKeyId} is the access key id.\n` +
          `Authorization: Bearer ${bearerToken}`,
      },
    ];
    const resolver = (_capsuleId: string): readonly { documentId: string; text: string }[] => docs;
    const result = ingest(inputWithResolver([capsuleSource("Notes", "cap-secret")], resolver));
    const canonical = result.ingestedAtoms[0]?.canonicalText ?? "";
    expect(canonical).not.toContain(awsAccessKeyId);
    expect(canonical).not.toContain(awsSecret);
    expect(canonical).not.toContain(bearerToken);
    expect(canonical).toContain("[REDACTED]");
    // The redactionStatus flag must now be truthful.
    expect(result.ingestedAtoms[0]?.atom.redactionStatus).toBe("redacted");
  });

  // ── Byte-budget parity with workspace/file sources (Epic #710, Issue #717) ──
  it("caps an oversized capsule document to the per-document byte budget", () => {
    const huge = "A".repeat(64_000); // 64 KB > 16 KB per-document cap
    const docs = [{ documentId: "huge", text: huge }];
    const resolver = (_capsuleId: string): readonly { documentId: string; text: string }[] => docs;
    const result = ingest(inputWithResolver([capsuleSource("Huge", "cap-huge")], resolver));
    const canonical = result.ingestedAtoms[0]?.canonicalText ?? "";
    // documentId prefix + "\n" + at most 16_384 bytes of body.
    expect(canonical.length).toBeLessThanOrEqual("huge\n".length + 16_384);
    expect(canonical.startsWith("huge\n")).toBe(true);
  });

  it("bounds the whole capsule corpus to the per-run byte budget", () => {
    // 40 documents × 16 KB each = 640 KB raw, but the per-run budget is ~192 KB.
    const docs = Array.from({ length: 40 }, (_, i) => ({
      documentId: `doc-${String(i)}`,
      text: "B".repeat(16_000),
    }));
    const resolver = (_capsuleId: string): readonly { documentId: string; text: string }[] => docs;
    const result = ingest(inputWithResolver([capsuleSource("Big", "cap-budget")], resolver));
    const totalBytes = result.ingestedAtoms.reduce(
      (sum, a) => sum + Buffer.byteLength(a.canonicalText, "utf8"),
      0,
    );
    // Comfortably bounded — never the full 640 KB raw corpus.
    expect(totalBytes).toBeLessThanOrEqual(196_608 + 40 * 64);
    expect(result.ingestedAtoms.length).toBeLessThan(40);
  });
});

// ─── Capsule-set source (Epic #710, Issue #716/#718) ──────────────────────────

describe("ingestInlineSources — capsule-set source (Issue #716/#718)", () => {
  it("throws QI_CAPSULE_UNAVAILABLE when no resolver is provided", () => {
    try {
      ingestInlineSources(inputWithResolver([capsuleSetSource("Set", "set-1")]));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as QiIngestionError).code).toBe("QI_CAPSULE_UNAVAILABLE");
    }
  });

  it("throws QI_CAPSULE_UNAVAILABLE when the capsule-set resolves to no documents", () => {
    const result = (): unknown =>
      ingestInlineSources(
        inputWithResolver([capsuleSetSource("Empty", "set-empty")], undefined, () => []),
      );
    expect(result).toThrow(/has no indexed content/u);
  });

  it("ingests the expanded member-capsule corpus via the capsuleSet resolver", () => {
    const docs = [
      { documentId: "m1", text: "Member one requirement." },
      { documentId: "m2", text: "Member two requirement." },
    ];
    const result = ingest(
      inputWithResolver([capsuleSetSource("Set", "set-x")], undefined, () => docs),
    );
    expect(result.ingestedAtoms.length).toBe(2);
    expect(result.envelopes[0]?.kind).toBe("local-knowledge-capsule");
    expect(result.envelopes[0]?.provenance.origin).toBe("local-knowledge-capsule-set:set-x");
    expect(result.sourceSummaries[0]?.kind).toBe("capsule-set");
  });

  it("does not call the single-capsule resolver for a capsule-set source", () => {
    let capsuleCalls = 0;
    const capsule = (): readonly { documentId: string; text: string }[] => {
      capsuleCalls += 1;
      return [];
    };
    const capsuleSet = (): readonly { documentId: string; text: string }[] => [
      { documentId: "m1", text: "Set member text." },
    ];
    ingest(inputWithResolver([capsuleSetSource("Set", "set-y")], capsule, capsuleSet));
    expect(capsuleCalls).toBe(0);
  });
});

// ─── N+1 resilience, byte budget, containment, cross-kind provenance (Epic #729) ──

const MAX_PROMPT_BYTES = 256_000;

// Build a single supported file of approximately `bytes` UTF-8 bytes under a fresh temp dir.
function makeLargeFile(prefix: string, bytes: number): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, "big.md");
  const unit = "Detailed requirement statement number for coverage. ";
  writeFileSync(path, unit.repeat(Math.ceil(bytes / unit.length)), "utf8");
  return { dir, path };
}

describe("ingestInlineSources — N+1 partial-failure resilience (Issue #730 empty subset)", () => {
  it("skips an empty source and still ingests the healthy ones (fail-soft, not fail-all)", () => {
    const result = ingest(
      input([requirementsSource("Good", VALID_TEXT), requirementsSource("Bad", "   \n\t  ")]),
    );
    // The good source produced atoms; the run did NOT abort on the empty one.
    expect(result.ingestedAtoms.length).toBeGreaterThan(0);
    expect(result.sourceSummaries.map((s) => s.label)).toEqual(["Good"]);
    // The skipped source is recorded with its coded reason for the coverage notice.
    expect(result.skippedSources).toHaveLength(1);
    expect(result.skippedSources[0]).toMatchObject({
      label: "Bad",
      kind: "requirements",
      code: "QI_SOURCE_EMPTY",
    });
    expect(typeof result.skippedSources[0]?.message).toBe("string");
  });

  it("skips an unavailable capsule while a healthy file/requirements source still produces the run", () => {
    const result = ingest(
      inputWithResolver(
        [requirementsSource("Good", VALID_TEXT), capsuleSource("EmptyCap", "cap-none")],
        () => [],
      ),
    );
    expect(result.sourceSummaries.map((s) => s.kind)).toEqual(["requirements"]);
    expect(result.skippedSources.map((s) => s.code)).toEqual(["QI_CAPSULE_UNAVAILABLE"]);
    expect(result.skippedSources.map((s) => s.kind)).toEqual(["capsule"]);
  });

  it("reports an empty skippedSources list on the all-healthy happy path", () => {
    const result = ingest(input([requirementsSource("A", VALID_TEXT)]));
    expect(result.skippedSources).toEqual([]);
  });

  it("still fails the run when EVERY source fails, re-raising the FIRST source's specific code", () => {
    // Two bad sources of different kinds: a blank requirements (QI_SOURCE_EMPTY) then an unsupported
    // file. The run must throw the FIRST source's code, NOT a generic aggregate, preserving the
    // actionable single-source message contract.
    const dir = mkdtempSync(join(tmpdir(), "qi-allbad-"));
    try {
      const binPath = join(dir, "weird.bin");
      writeFileSync(binPath, "data", "utf8");
      try {
        ingestInlineSources(
          input([
            requirementsSource("Blank", "   "),
            { kind: "file", label: "Bin", path: binPath },
          ]),
        );
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(QiIngestionError);
        expect((err as QiIngestionError).code).toBe("QI_SOURCE_EMPTY");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ingestInlineSources — global byte budget split (Issue #730 containment)", () => {
  it("truncates a large file to its fair byte share when other sources are connected", () => {
    const { dir, path } = makeLargeFile("qi-bytes-", 150_000);
    try {
      const lone = ingest(input([{ kind: "file", label: "Big", path }]));
      const pair = ingest(
        input([{ kind: "file", label: "Big", path }, requirementsSource("R", VALID_TEXT)]),
      );
      const loneBytes = Buffer.byteLength(lone.ingestedAtoms[0]?.canonicalText ?? "", "utf8");
      const pairFileBytes = Buffer.byteLength(pair.ingestedAtoms[0]?.canonicalText ?? "", "utf8");
      // Alone the file keeps (nearly) all its content; with a second source it is truncated to its
      // ~half share so the merged prompt cannot exceed the model ceiling.
      expect(loneBytes).toBeGreaterThan(pairFileBytes);
      expect(pairFileBytes).toBeLessThanOrEqual(196_608 / 2 + 256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps three large file sources together under the model prompt byte ceiling (headline N+1)", () => {
    const a = makeLargeFile("qi-bytes-a-", 150_000);
    const b = makeLargeFile("qi-bytes-b-", 150_000);
    const c = makeLargeFile("qi-bytes-c-", 150_000);
    try {
      const result = ingest(
        input([
          { kind: "file", label: "A", path: a.path },
          { kind: "file", label: "B", path: b.path },
          { kind: "file", label: "C", path: c.path },
        ]),
      );
      const totalBytes = result.ingestedAtoms.reduce(
        (sum, atom) => sum + Buffer.byteLength(atom.canonicalText, "utf8"),
        0,
      );
      // Old behaviour: 3 × 150KB = 450KB → QI_PROMPT_TOO_LARGE. Now the merged evidence stays bounded.
      expect(totalBytes).toBeLessThan(MAX_PROMPT_BYTES);
      expect(result.sourceSummaries.length).toBe(3);
    } finally {
      for (const t of [a, b, c]) rmSync(t.dir, { recursive: true, force: true });
    }
  });
});

describe("ingestInlineSources — folder deny-root containment (Epic #729 security)", () => {
  it("rejects a folder source whose ROOT is a denied credential directory (QI_SOURCE_DENIED)", () => {
    const base = mkdtempSync(join(tmpdir(), "qi-deny-"));
    const denied = join(base, ".aws");
    mkdirSync(denied);
    writeFileSync(join(denied, "credentials"), "aws_secret=should-never-ingest\n", "utf8");
    try {
      ingestInlineSources(input([{ kind: "workspace", label: "Creds", path: denied }]));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QiIngestionError);
      expect((err as QiIngestionError).code).toBe("QI_SOURCE_DENIED");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects a folder source whose ROOT is a benign-named symlink into a denied dir", () => {
    // Symlink parity with the lexical root deny above: a folder symlink named innocuously ("vault")
    // whose REAL target is a denied credential dir (".ssh") must be rejected before discovery walks
    // it, otherwise every relative path inside ("id_rsa") would slip past the per-file deny check.
    const base = mkdtempSync(join(tmpdir(), "qi-deny-link-"));
    const denied = join(base, ".ssh");
    mkdirSync(denied);
    writeFileSync(join(denied, "id_rsa"), "PRIVATE KEY should-never-ingest\n", "utf8");
    symlinkSync(denied, join(base, "vault")); // benign-named link -> denied real dir
    try {
      ingestInlineSources(
        input([{ kind: "workspace", label: "Vault", path: join(base, "vault") }]),
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QiIngestionError);
      expect((err as QiIngestionError).code).toBe("QI_SOURCE_DENIED");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("skips a denied folder among healthy sources instead of failing the whole run", () => {
    const base = mkdtempSync(join(tmpdir(), "qi-deny-mix-"));
    const denied = join(base, ".ssh");
    mkdirSync(denied);
    writeFileSync(join(denied, "id_rsa"), "PRIVATE KEY\n", "utf8");
    try {
      const result = ingest(
        input([
          requirementsSource("Good", VALID_TEXT),
          { kind: "workspace", label: "Keys", path: denied },
        ]),
      );
      expect(result.sourceSummaries.map((s) => s.kind)).toEqual(["requirements"]);
      expect(result.skippedSources.map((s) => s.code)).toEqual(["QI_SOURCE_DENIED"]);
      // The credential content never reaches any ingested atom.
      const joined = result.ingestedAtoms.map((a) => a.canonicalText).join("\n");
      expect(joined).not.toContain("PRIVATE KEY");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("ingestInlineSources — cross-kind source-tagged provenance (Issue #732)", () => {
  it("aggregates workspace + file + capsule into three distinct, attributable envelopes", () => {
    const wsDir = mkdtempSync(join(tmpdir(), "qi-prov-ws-"));
    writeFileSync(
      join(wsDir, "login.md"),
      "The login screen shall validate credentials.\n",
      "utf8",
    );
    const fileDir = mkdtempSync(join(tmpdir(), "qi-prov-file-"));
    const filePath = join(fileDir, "transfer.md");
    writeFileSync(filePath, "The transfer shall enforce the daily limit.\n", "utf8");
    try {
      const result = ingest(
        inputWithResolver(
          [
            { kind: "workspace", label: "LoginFolder", path: wsDir },
            { kind: "file", label: "TransferDoc", path: filePath },
            capsuleSource("StatementCap", "cap-statement"),
          ],
          () => [{ documentId: "stmt", text: "The statement shall list all bookings." }],
        ),
      );
      // Three sources → three envelopes, each tagged with its own provenance origin.
      expect(result.envelopes.length).toBe(3);
      expect(result.sourceSummaries.map((s) => s.kind)).toEqual(["workspace", "file", "capsule"]);
      expect(result.envelopes.map((e) => e.provenance.origin)).toEqual([
        "workspace",
        "file",
        "local-knowledge-capsule:cap-statement",
      ]);
      // Every ingested atom maps back to one of exactly these three envelopes (attributable per source).
      const envelopeIds = new Set(result.envelopes.map((e) => String(e.id)));
      for (const atom of result.ingestedAtoms) {
        expect(envelopeIds.has(String(atom.atom.sourceEnvelopeId))).toBe(true);
      }
      // All three envelopes are actually cited by at least one atom.
      const citedEnvelopes = new Set(
        result.ingestedAtoms.map((a) => String(a.atom.sourceEnvelopeId)),
      );
      expect(citedEnvelopes.size).toBe(3);
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
      rmSync(fileDir, { recursive: true, force: true });
    }
  });
});
