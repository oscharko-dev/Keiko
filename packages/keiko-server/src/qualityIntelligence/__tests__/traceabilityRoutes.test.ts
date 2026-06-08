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
import { recordQualityIntelligenceRun } from "@oscharko-dev/keiko-evidence";
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
    expect(body.body).toContain("| Requirement ID | Status |");
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
