// Traceability export route tests (Epic #734, Issue #740).
//
// Seeds a temp evidenceDir with a run manifest carrying a coverage matrix, then exercises the
// dedicated traceability route for CSV + Markdown, the missing-run path, and the no-coverage path.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QualityIntelligence, type QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import {
  recordQualityIntelligenceCandidates,
  recordQualityIntelligenceRun,
} from "@oscharko-dev/keiko-evidence";
import type { RouteContext } from "../../routes.js";
import type { UiHandlerDeps } from "../../deps.js";
import { handleQiTraceabilityExport } from "../traceabilityRoutes.js";

const RUN_ID = "run-trace-001";

let evidenceDir: string;

const deps = (dir: string | undefined): UiHandlerDeps =>
  ({ evidenceDir: dir }) as unknown as UiHandlerDeps;

const makeReq = (body: Record<string, unknown> | null): IncomingMessage => {
  const raw = body === null ? "" : JSON.stringify(body);
  return Readable.from(
    raw.length > 0 ? [Buffer.from(raw, "utf8")] : [],
  ) as unknown as IncomingMessage;
};

const ctx = (id: string, req: IncomingMessage): RouteContext => ({
  req,
  res: {} as RouteContext["res"],
  params: { id },
  url: new URL(`http://127.0.0.1/api/quality-intelligence/runs/${id}/traceability`),
});

function runInput(
  runId: string,
  coverageMatrix: Parameters<typeof recordQualityIntelligenceRun>[0]["coverageMatrix"],
): Parameters<typeof recordQualityIntelligenceRun>[0] {
  return {
    runId,
    planAt: "2026-06-01T10:00:00.000Z",
    completedAt: "2026-06-01T10:01:00.000Z",
    status: "succeeded",
    policyProfileIds: [],
    retentionPolicyId: "default",
    modelGatewayCallCount: 1,
    totals: { candidates: 1, findings: 0, exports: 0 },
    findings: [],
    exports: [],
    evidenceRefs: [],
    provenanceRefs: {
      envelopeIds: [],
      auditSummaryId: "qi-audit-trace" as Parameters<
        typeof recordQualityIntelligenceRun
      >[0]["provenanceRefs"]["auditSummaryId"],
    },
    ...(coverageMatrix !== undefined ? { coverageMatrix } : {}),
  };
}

const MATRIX = [
  { atomId: "atom-1", status: "covered", confidence: 0.9, coveringCandidateIds: ["tc-1"] },
  { atomId: "atom-2", status: "uncovered", confidence: 0, coveringCandidateIds: [] },
] as const;

beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "keiko-trace-test-"));
});

afterEach(() => {
  rmSync(evidenceDir, { recursive: true, force: true });
});

describe("handleQiTraceabilityExport", () => {
  it("exports the coverage matrix as CSV by default", async () => {
    recordQualityIntelligenceRun(runInput(RUN_ID, MATRIX), { evidenceDir });
    const result = await handleQiTraceabilityExport(ctx(RUN_ID, makeReq(null)), deps(evidenceDir));
    expect(result.status).toBe(200);
    const body = result.body as { format: string; body: string; contentType: string };
    expect(body.format).toBe("csv");
    expect(body.contentType).toBe("text/csv");
    expect(body.body).toContain("Requirement ID");
    expect(body.body).toContain("atom-1");
    expect(body.body).toContain("atom-2");
    expect(body.body).toContain("tc-1");
  });

  it("exports Markdown when format: 'markdown' is requested", async () => {
    recordQualityIntelligenceRun(runInput(RUN_ID, MATRIX), { evidenceDir });
    const result = await handleQiTraceabilityExport(
      ctx(RUN_ID, makeReq({ format: "markdown" })),
      deps(evidenceDir),
    );
    expect(result.status).toBe(200);
    const body = result.body as { format: string; body: string };
    expect(body.format).toBe("markdown");
    expect(body.body).toContain("| Requirement ID | Requirement (redacted excerpt) | Status |");
  });

  it("returns 404 when the run does not exist", async () => {
    const result = await handleQiTraceabilityExport(
      ctx("missing-run", makeReq(null)),
      deps(evidenceDir),
    );
    expect(result.status).toBe(404);
  });

  it("returns 409 when the run has no coverage matrix", async () => {
    recordQualityIntelligenceRun(runInput(RUN_ID, undefined), { evidenceDir });
    const result = await handleQiTraceabilityExport(ctx(RUN_ID, makeReq(null)), deps(evidenceDir));
    expect(result.status).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_NO_COVERAGE");
  });

  it("returns 500 when no evidence dir is configured", async () => {
    const result = await handleQiTraceabilityExport(ctx(RUN_ID, makeReq(null)), deps(undefined));
    expect(result.status).toBe(500);
  });
});

// --- T-A: contentType + filename (#740) -----------------------------------------

describe("handleQiTraceabilityExport — contentType and filename (T-A)", () => {
  it("returns text/markdown contentType and a .md filename for markdown format", async () => {
    // Arrange
    recordQualityIntelligenceRun(runInput(RUN_ID, MATRIX), { evidenceDir });

    // Act
    const result = await handleQiTraceabilityExport(
      ctx(RUN_ID, makeReq({ format: "markdown" })),
      deps(evidenceDir),
    );

    // Assert — RED if FORMAT_META markdown.contentType mutated to "text/csv" or ext mutated to "csv"
    expect(result.status).toBe(200);
    const body = result.body as {
      format: string;
      contentType: string;
      filename: string;
      byteLen: number;
      body: string;
    };
    expect(body.format).toBe("markdown");
    expect(body.contentType).toBe("text/markdown");
    expect(body.filename).toMatch(/\.md$/u);
    expect(body.filename).toBe(`${RUN_ID}-traceability.md`);
    expect(body.byteLen).toBe(Buffer.byteLength(body.body, "utf8"));
  });

  it("returns text/csv contentType and a .csv filename for CSV (default) format", async () => {
    // Arrange
    recordQualityIntelligenceRun(runInput(RUN_ID, MATRIX), { evidenceDir });

    // Act
    const result = await handleQiTraceabilityExport(ctx(RUN_ID, makeReq(null)), deps(evidenceDir));

    // Assert — RED if FORMAT_META csv.contentType mutated to "text/markdown" or ext mutated to "md"
    expect(result.status).toBe(200);
    const body = result.body as {
      format: string;
      contentType: string;
      filename: string;
      byteLen: number;
      body: string;
    };
    expect(body.format).toBe("csv");
    expect(body.contentType).toBe("text/csv");
    expect(body.filename).toMatch(/\.csv$/u);
    expect(body.filename).toBe(`${RUN_ID}-traceability.csv`);
    expect(body.byteLen).toBe(Buffer.byteLength(body.body, "utf8"));
  });
});

// --- T-B: empty/whitespace run id -> 400 (#740) ---------------------------------

describe("handleQiTraceabilityExport — empty id guard (T-B)", () => {
  it("returns 400 QI_BAD_REQUEST for a whitespace-only run id", async () => {
    // Arrange — whitespace id; guard fires before evidenceDir or manifest lookup
    const req = makeReq(null);

    // Act — RED if the `.trim().length === 0` clause is removed from traceabilityRoutes.ts:114
    const result = await handleQiTraceabilityExport(ctx("   ", req), deps(evidenceDir));

    // Assert
    expect(result.status).toBe(400);
    const body = result.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("QI_BAD_REQUEST");
    expect(body.error.message).toMatch(/required/iu);
  });

  it("returns 400 QI_BAD_REQUEST for an empty-string run id", async () => {
    // Arrange
    const req = makeReq(null);

    // Act — RED if id === undefined alone is kept but empty-string is not covered
    const result = await handleQiTraceabilityExport(ctx("", req), deps(evidenceDir));

    // Assert
    expect(result.status).toBe(400);
    const body = result.body as { error: { code: string } };
    expect(body.error.code).toBe("QI_BAD_REQUEST");
  });
});

// --- T-C: parseFormat robustness + DoS cap (#740) --------------------------------

/**
 * makeRawReq streams an arbitrary byte buffer as the request body without JSON.stringify.
 * Used for malformed-JSON and oversized-body cases where makeReq's serialisation is unsuitable.
 */
function makeRawReq(rawBody: string | Buffer): IncomingMessage {
  const buf = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  return Readable.from(buf.length > 0 ? [buf] : []) as unknown as IncomingMessage;
}

describe("handleQiTraceabilityExport — parseFormat robustness (T-C)", () => {
  it("falls back to csv when the request body is malformed JSON", async () => {
    // Arrange
    recordQualityIntelligenceRun(runInput(RUN_ID, MATRIX), { evidenceDir });
    // Non-JSON payload within MAX_BODY_BYTES — exercises the JSON.parse catch branch in parseFormat
    const req = makeRawReq("{not valid json");

    // Act — RED if the malformed-JSON catch branch in parseFormat is removed
    const result = await handleQiTraceabilityExport(ctx(RUN_ID, req), deps(evidenceDir));

    // Assert — route must succeed and fall back to CSV, never 500
    expect(result.status).toBe(200);
    const body = result.body as { format: string; contentType: string };
    expect(body.format).toBe("csv");
    expect(body.contentType).toBe("text/csv");
  });

  it("falls back to csv when the request body exceeds MAX_BODY_BYTES (4 KiB)", async () => {
    // Arrange
    recordQualityIntelligenceRun(runInput(RUN_ID, MATRIX), { evidenceDir });
    // Body contains format: "markdown" so that without the cap it would select markdown.
    // The cap forces readBody to reject before JSON.parse; parseFormat catches that and returns csv.
    const oversizeBody = JSON.stringify({ format: "markdown", pad: "x".repeat(5000) });
    // Confirm the payload actually exceeds 4 KiB before streaming it.
    expect(Buffer.byteLength(oversizeBody, "utf8")).toBeGreaterThan(4 * 1024);
    const req = makeRawReq(oversizeBody);

    // Act — RED if the `total > MAX_BODY_BYTES` guard is removed from readBody
    const result = await handleQiTraceabilityExport(ctx(RUN_ID, req), deps(evidenceDir));

    // Assert — cap fires → readBody rejects → parseFormat catch → csv fallback
    expect(result.status).toBe(200);
    const body = result.body as { format: string; contentType: string };
    expect(body.format).toBe("csv");
    expect(body.contentType).toBe("text/csv");
  });

  it("falls back to csv for a chunked oversized body (cap fires mid-stream)", async () => {
    // Arrange — send the oversized body across two chunks so the second data event arrives
    // after the cap fires. Without the `capped` flag, `chunks` holds the first chunk's bytes
    // until GC and `resolve()` is called from the `end` handler after `reject()` (silently
    // ignored by the Promise). With `capped`: chunks are cleared immediately and `end` is a
    // no-op. Observable assertion: parseFormat catches the rejection and falls back to csv.
    recordQualityIntelligenceRun(runInput(RUN_ID, MATRIX), { evidenceDir });
    const half = "x".repeat(3 * 1024);
    const req = Readable.from([
      Buffer.from(half, "utf8"),
      Buffer.from(half, "utf8"),
    ]) as unknown as IncomingMessage;

    // Act — exercises the multi-chunk path through readBody
    const result = await handleQiTraceabilityExport(ctx(RUN_ID, req), deps(evidenceDir));

    // Assert — cap fires on first chunk → capped=true → second chunk + end handler are no-ops
    expect(result.status).toBe(200);
    const body = result.body as { format: string; contentType: string };
    expect(body.format).toBe("csv");
    expect(body.contentType).toBe("text/csv");
  });

  it("falls back to csv for an unknown format value", async () => {
    // Arrange
    recordQualityIntelligenceRun(runInput(RUN_ID, MATRIX), { evidenceDir });

    // Act — RED if parseFormat ever passed the unknown string through as the format
    const result = await handleQiTraceabilityExport(
      ctx(RUN_ID, makeReq({ format: "xml" })),
      deps(evidenceDir),
    );

    // Assert
    expect(result.status).toBe(200);
    const body = result.body as { format: string; contentType: string };
    expect(body.format).toBe("csv");
    expect(body.contentType).toBe("text/csv");
  });
});

// --- Requirement excerpts + candidate titles (#790) ------------------------------

const READABLE_MATRIX = [
  {
    atomId: "atom-1",
    status: "covered",
    confidence: 0.9,
    coveringCandidateIds: ["tc-1"],
    requirementExcerptRedacted: "Lock the account after five failed logins.",
  },
  // Legacy row recorded before #790 carries no excerpt.
  { atomId: "atom-2", status: "uncovered", confidence: 0, coveringCandidateIds: [] },
] as const;

function makeCandidate(id: string, title: string): QI.QualityIntelligenceTestCaseCandidate {
  return {
    id: QualityIntelligence.asQualityIntelligenceTestCaseId(id),
    runId: QualityIntelligence.asQualityIntelligenceRunId(RUN_ID),
    derivedFromAtomIds: [QualityIntelligence.asQualityIntelligenceEvidenceAtomId("atom-1")],
    title,
    preconditions: [],
    steps: ["Fail login five times"],
    expectedResults: ["Account is locked"],
    priority: "P1",
    riskClass: "functional",
    tags: [],
    status: "proposed",
  };
}

describe("handleQiTraceabilityExport — readability (#790)", () => {
  it("emits the persisted requirement excerpt and joins candidate titles", async () => {
    recordQualityIntelligenceRun(runInput(RUN_ID, READABLE_MATRIX), { evidenceDir });
    recordQualityIntelligenceCandidates({
      runId: RUN_ID,
      generatedAt: "2026-06-01T10:01:00.000Z",
      candidates: [makeCandidate("tc-1", "Verify lockout engages on the fifth failed login")],
      evidenceDir,
      redact: (v: unknown): unknown => v,
    });
    const result = await handleQiTraceabilityExport(ctx(RUN_ID, makeReq(null)), deps(evidenceDir));
    expect(result.status).toBe(200);
    const body = (result.body as { body: string }).body;
    expect(body).toContain("Requirement (redacted excerpt)");
    expect(body).toContain("Lock the account after five failed logins.");
    expect(body).toContain("Verify lockout engages on the fifth failed login");
    // The legacy row degrades to the em-dash placeholder.
    expect(body).toMatch(/atom-2,—,uncovered/u);
  });

  it("still exports when the candidate artifact is absent (titles fall back to em-dash)", async () => {
    recordQualityIntelligenceRun(runInput(RUN_ID, READABLE_MATRIX), { evidenceDir });
    const result = await handleQiTraceabilityExport(ctx(RUN_ID, makeReq(null)), deps(evidenceDir));
    expect(result.status).toBe(200);
    const body = (result.body as { body: string }).body;
    expect(body).toContain("Lock the account after five failed logins.");
    expect(body).toMatch(/tc-1,—,atom-1,1/u);
  });
});
