// Export-evidence audit tests for handleQiTraceabilityExport (Epic #734, Issue #740).
//
// NEW file — kept separate from traceabilityRoutes.test.ts to avoid merge conflicts with
// sibling PRs that touch the original test file. Seeds a temp evidenceDir, calls the handler
// directly, and verifies that an export-evidence row is (or is not) appended to the manifest.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import {
  loadQualityIntelligenceRun,
  recordQualityIntelligenceRun,
} from "@oscharko-dev/keiko-evidence";
import type { RouteContext } from "../../routes.js";
import type { UiHandlerDeps } from "../../deps.js";
import { handleQiTraceabilityExport } from "../traceabilityRoutes.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

const RUN_ID = "run-trace-audit-001";

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
    planAt: "2026-06-14T09:00:00.000Z",
    completedAt: "2026-06-14T09:01:00.000Z",
    status: "succeeded",
    policyProfileIds: [],
    retentionPolicyId: "default",
    modelGatewayCallCount: 1,
    totals: { candidates: 0, findings: 0, exports: 0 },
    findings: [],
    exports: [],
    evidenceRefs: [],
    provenanceRefs: {
      envelopeIds: [],
      auditSummaryId: "qi-audit-trace-audit" as Parameters<
        typeof recordQualityIntelligenceRun
      >[0]["provenanceRefs"]["auditSummaryId"],
    },
    ...(coverageMatrix !== undefined ? { coverageMatrix } : {}),
  };
}

const MATRIX = [
  { atomId: "atom-a", status: "covered", confidence: 0.95, coveringCandidateIds: ["tc-a"] },
  { atomId: "atom-b", status: "uncovered", confidence: 0, coveringCandidateIds: [] },
] as const;

beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "keiko-trace-audit-test-"));
});

afterEach(() => {
  rmSync(evidenceDir, { recursive: true, force: true });
});

// ─── CSV export audit ─────────────────────────────────────────────────────────

describe("handleQiTraceabilityExport — export audit (CSV)", () => {
  it("appends exactly one export-evidence row with targetAdapter=traceability-csv after a CSV export", async () => {
    recordQualityIntelligenceRun(runInput(RUN_ID, MATRIX), { evidenceDir });

    const result = await handleQiTraceabilityExport(ctx(RUN_ID, makeReq(null)), deps(evidenceDir));
    expect(result.status).toBe(200);

    const body = (result.body as { body: string }).body;
    const manifest = loadQualityIntelligenceRun(RUN_ID, { evidenceDir });
    const exportRows = manifest?.exports ?? [];

    expect(exportRows).toHaveLength(1);
    const row = exportRows[0];
    expect(row?.targetAdapter).toBe("traceability-csv");
    expect(row?.redactionAttested).toBe(true);
    // dryRun absent or falsy — this is a materialised download, not a preview
    expect(row?.dryRun).toBeFalsy();
    // integrityHash must bind to the exact body returned by the handler
    expect(row?.integrityHash).toBe(sha256Hex(body));
  });
});

// ─── Markdown export audit ────────────────────────────────────────────────────

describe("handleQiTraceabilityExport — export audit (Markdown)", () => {
  it("appends exactly one export-evidence row with targetAdapter=traceability-markdown after a Markdown export", async () => {
    recordQualityIntelligenceRun(runInput(RUN_ID, MATRIX), { evidenceDir });

    const result = await handleQiTraceabilityExport(
      ctx(RUN_ID, makeReq({ format: "markdown" })),
      deps(evidenceDir),
    );
    expect(result.status).toBe(200);

    const manifest = loadQualityIntelligenceRun(RUN_ID, { evidenceDir });
    const exportRows = manifest?.exports ?? [];

    expect(exportRows).toHaveLength(1);
    expect(exportRows[0]?.targetAdapter).toBe("traceability-markdown");
    expect(exportRows[0]?.redactionAttested).toBe(true);
    expect(exportRows[0]?.dryRun).toBeFalsy();
  });
});

// ─── Deduplicate repeated identical export ────────────────────────────────────

describe("handleQiTraceabilityExport — export audit (dedupe)", () => {
  it("records exactly one row even when the same export is requested twice", async () => {
    recordQualityIntelligenceRun(runInput(RUN_ID, MATRIX), { evidenceDir });

    await handleQiTraceabilityExport(ctx(RUN_ID, makeReq(null)), deps(evidenceDir));
    await handleQiTraceabilityExport(ctx(RUN_ID, makeReq(null)), deps(evidenceDir));

    const manifest = loadQualityIntelligenceRun(RUN_ID, { evidenceDir });
    // appendQualityIntelligenceExportRow dedupes by (id, dryRun) — the deterministic row id is
    // derived from runId|target so a repeated export produces the same id and is skipped.
    expect(manifest?.exports).toHaveLength(1);
  });
});

// ─── Error paths record nothing ───────────────────────────────────────────────

describe("handleQiTraceabilityExport — export audit (error paths)", () => {
  it("appends NO row on a 409 response (run has no coverage matrix)", async () => {
    recordQualityIntelligenceRun(runInput(RUN_ID, undefined), { evidenceDir });

    const result = await handleQiTraceabilityExport(ctx(RUN_ID, makeReq(null)), deps(evidenceDir));
    expect(result.status).toBe(409);

    // The manifest exists but its exports array must remain empty.
    const manifest = loadQualityIntelligenceRun(RUN_ID, { evidenceDir });
    expect(manifest?.exports).toHaveLength(0);
  });

  it("appends NO row on a 404 response (run does not exist)", async () => {
    // No run is seeded — the handler returns 404 before any evidence write could occur.
    const result = await handleQiTraceabilityExport(
      ctx("missing-audit-run", makeReq(null)),
      deps(evidenceDir),
    );
    expect(result.status).toBe(404);

    // Confirm there is genuinely no manifest for this run id.
    expect(loadQualityIntelligenceRun("missing-audit-run", { evidenceDir })).toBeUndefined();
  });
});
