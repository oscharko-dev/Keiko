// Approved-only scope tests for handleQiTraceabilityExport (0.3.0 release audit).
//
// The QI export bar renders "Exports approved test cases only." above the traceability formats and
// ships the same "Approved only" checkbox it shows for every other local adapter. Before this
// suite the traceability route serialised the WHOLE persisted coverage matrix regardless of the
// review state, so the downloaded compliance artifact contained rejected and never-reviewed test
// cases while the UI asserted the opposite.
//
// These tests pin the scope contract at the route: the exported matrix contains only approved
// tests in BOTH directions, a requirement left with no approved covering test can never keep a
// "covered" verdict, the review-integrity failure fails closed instead of falling back to an
// unscoped export, and the export-evidence row records which scope produced the artifact.

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadQualityIntelligenceRun,
  recordQualityIntelligenceCandidates,
  recordQualityIntelligenceRun,
} from "@oscharko-dev/keiko-evidence";
import type { RouteContext } from "../../routes.js";
import type { UiHandlerDeps } from "../../deps.js";
import { handleQiTraceabilityExport } from "../traceabilityRoutes.js";
import { applyReviewDecision } from "../reviewStore.js";

const RUN_ID = "run-trace-scope-001";

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
  correlationId: undefined,
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
    planAt: "2026-07-01T09:00:00.000Z",
    completedAt: "2026-07-01T09:01:00.000Z",
    status: "succeeded",
    policyProfileIds: ["qi:regression-default"],
    retentionPolicyId: "qi:short-30d",
    modelGatewayCallCount: 1,
    totals: { candidates: 3, findings: 0, exports: 0 },
    findings: [],
    exports: [],
    evidenceRefs: [],
    provenanceRefs: {
      envelopeIds: [],
      auditSummaryId: "qi-audit-trace-scope" as Parameters<
        typeof recordQualityIntelligenceRun
      >[0]["provenanceRefs"]["auditSummaryId"],
    },
    ...(coverageMatrix !== undefined ? { coverageMatrix } : {}),
  };
}

// atom-1 is covered by an approved AND a rejected test; atom-2 only by a never-reviewed test.
const MATRIX = [
  {
    atomId: "atom-1",
    status: "covered",
    confidence: 0.9,
    coveringCandidateIds: ["tc-approved", "tc-rejected"],
  },
  {
    atomId: "atom-2",
    status: "covered",
    confidence: 0.85,
    coveringCandidateIds: ["tc-open"],
  },
] as const;

function candidate(
  id: string,
  title: string,
  status: "proposed" | "needs-review" = "proposed",
): {
  readonly id: string;
  readonly runId: string;
  readonly derivedFromAtomIds: readonly string[];
  readonly title: string;
  readonly preconditions: readonly string[];
  readonly steps: readonly string[];
  readonly expectedResults: readonly string[];
  readonly priority: "P1";
  readonly riskClass: "functional";
  readonly tags: readonly string[];
  readonly status: "proposed" | "needs-review";
} {
  return {
    id,
    runId: RUN_ID,
    derivedFromAtomIds: ["atom-1"],
    title,
    preconditions: [],
    steps: ["do the thing"],
    expectedResults: ["it happened"],
    priority: "P1",
    riskClass: "functional",
    tags: [],
    status,
  };
}

function seedRun(): void {
  recordQualityIntelligenceRun(runInput(RUN_ID, MATRIX), { evidenceDir });
  recordQualityIntelligenceCandidates({
    runId: RUN_ID,
    generatedAt: "2026-07-01T09:01:00.000Z",
    candidates: [
      candidate("tc-approved", "Approved case"),
      candidate("tc-rejected", "Rejected case"),
      candidate("tc-open", "Never reviewed case"),
    ] as unknown as Parameters<typeof recordQualityIntelligenceCandidates>[0]["candidates"],
    evidenceDir,
    redact: (value: unknown): unknown => value,
  });
}

function decide(action: "approve" | "reject", candidateId: string): void {
  applyReviewDecision({
    runId: RUN_ID,
    evidenceDir,
    action,
    scope: "candidate",
    candidateId,
    reviewerLabel: "auditor",
    now: new Date().toISOString(),
    redact: (v: unknown): unknown => v,
  });
}

const bodyOf = (result: { readonly body: unknown }): string =>
  (result.body as { readonly body: string }).body;

beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "keiko-trace-scope-test-"));
});

afterEach(() => {
  rmSync(evidenceDir, { recursive: true, force: true });
});

describe("handleQiTraceabilityExport — approvedOnly scope (CSV)", () => {
  it.each([false, true])(
    "withholds a needs-review test and reclassifies its sole requirement (approvedOnly=%s)",
    async (approvedOnly) => {
      const runId = `run-trace-quality-${String(approvedOnly)}`;
      recordQualityIntelligenceRun(
        runInput(runId, [
          {
            atomId: "atom-quality",
            status: "covered",
            confidence: 0.91,
            coveringCandidateIds: ["tc-needs-review"],
          },
        ]),
        { evidenceDir },
      );
      recordQualityIntelligenceCandidates({
        runId,
        generatedAt: "2026-07-01T09:01:00.000Z",
        candidates: [
          { ...candidate("tc-needs-review", "Unverified case", "needs-review"), runId },
        ] as unknown as Parameters<typeof recordQualityIntelligenceCandidates>[0]["candidates"],
        evidenceDir,
        redact: (value: unknown): unknown => value,
      });
      if (approvedOnly) {
        applyReviewDecision({
          runId,
          evidenceDir,
          action: "approve",
          scope: "candidate",
          candidateId: "tc-needs-review",
          reviewerLabel: "auditor",
          now: "2026-07-01T09:02:00.000Z",
          redact: (value: unknown): unknown => value,
        });
      }

      const result = await handleQiTraceabilityExport(
        ctx(runId, makeReq({ format: "markdown", approvedOnly })),
        deps(evidenceDir),
      );

      expect(result.status).toBe(200);
      const body = bodyOf(result);
      expect(body).not.toContain("tc-needs-review");
      const atomRow = body.split("\n").find((line) => line.startsWith("| atom-quality |"));
      expect(atomRow).toBeDefined();
      const cells = (atomRow ?? "").split("|").map((cell) => cell.trim());
      expect(cells[3]).toBe("uncovered");
      expect(cells[6]).toBe("0");
    },
  );

  it("omits rejected and never-reviewed tests from both matrix directions", async () => {
    seedRun();
    decide("approve", "tc-approved");
    decide("reject", "tc-rejected");

    const result = await handleQiTraceabilityExport(
      ctx(RUN_ID, makeReq({ format: "csv", approvedOnly: true })),
      deps(evidenceDir),
    );

    expect(result.status).toBe(200);
    const body = bodyOf(result);
    expect(body).toContain("tc-approved");
    expect(body).not.toContain("tc-rejected");
    expect(body).not.toContain("tc-open");
    // The redacted titles must not leak the excluded cases either.
    expect(body).not.toContain("Rejected case");
    expect(body).not.toContain("Never reviewed case");
  });

  it("never reports a requirement as covered once its only covering tests are out of scope", async () => {
    seedRun();
    decide("approve", "tc-approved");
    decide("reject", "tc-rejected");

    const result = await handleQiTraceabilityExport(
      ctx(RUN_ID, makeReq({ format: "markdown", approvedOnly: true })),
      deps(evidenceDir),
    );

    expect(result.status).toBe(200);
    // atom-2's only covering test (tc-open) is unapproved: the row must read uncovered with a zero
    // confidence and an empty test list, never "covered" beside an em-dash test cell.
    const atom2Row = bodyOf(result)
      .split("\n")
      .find((line) => line.startsWith("| atom-2 |"));
    expect(atom2Row).toBeDefined();
    // | Requirement ID | Excerpt | Status | Confidence | Covering Tests | Test Count |
    const cells = (atom2Row ?? "").split("|").map((cell) => cell.trim());
    expect(cells[3]).toBe("uncovered");
    expect(cells[4]).toBe("0.00");
    expect(cells[6]).toBe("0");
  });

  it("keeps every requirement row so an approved-only export still shows coverage gaps", async () => {
    seedRun();
    decide("approve", "tc-approved");

    const result = await handleQiTraceabilityExport(
      ctx(RUN_ID, makeReq({ format: "csv", approvedOnly: true })),
      deps(evidenceDir),
    );

    expect(result.status).toBe(200);
    expect(bodyOf(result)).toContain("atom-1");
    expect(bodyOf(result)).toContain("atom-2");
  });

  it("treats a run-level approval as an approval of every covering test", async () => {
    seedRun();
    applyReviewDecision({
      runId: RUN_ID,
      evidenceDir,
      action: "approve",
      scope: "run",
      reviewerLabel: "auditor",
      now: new Date().toISOString(),
      redact: (v: unknown): unknown => v,
    });

    const result = await handleQiTraceabilityExport(
      ctx(RUN_ID, makeReq({ format: "csv", approvedOnly: true })),
      deps(evidenceDir),
    );

    expect(result.status).toBe(200);
    const body = bodyOf(result);
    expect(body).toContain("tc-approved");
    expect(body).toContain("tc-rejected");
    expect(body).toContain("tc-open");
  });

  it("withholds persistently rejected tests even when approvedOnly is not requested", async () => {
    seedRun();
    decide("approve", "tc-approved");
    decide("reject", "tc-rejected");

    const result = await handleQiTraceabilityExport(
      ctx(RUN_ID, makeReq({ format: "csv" })),
      deps(evidenceDir),
    );

    expect(result.status).toBe(200);
    expect(bodyOf(result)).not.toContain("tc-rejected");
    expect(bodyOf(result)).toContain("tc-approved");
    expect(bodyOf(result)).toContain("tc-open");
  });

  it("rejects a non-boolean approvedOnly instead of silently widening the scope", async () => {
    seedRun();

    const result = await handleQiTraceabilityExport(
      ctx(RUN_ID, makeReq({ format: "csv", approvedOnly: "yes" })),
      deps(evidenceDir),
    );

    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });

  it("returns 409 rather than an unscoped export when the review artifact fails integrity", async () => {
    seedRun();
    decide("approve", "tc-approved");
    const reviewPath = join(evidenceDir, "qi", `${RUN_ID}.review.json`);
    const artifact = JSON.parse(readFileSync(reviewPath, "utf8")) as Record<string, unknown>;
    const audit = artifact.auditLog as { entryHash: string }[];
    const firstEntry = audit[0];
    if (firstEntry === undefined) throw new Error("expected a seeded review audit entry");
    firstEntry.entryHash = "0".repeat(64);
    writeFileSync(reviewPath, JSON.stringify(artifact), "utf8");

    const result = await handleQiTraceabilityExport(
      ctx(RUN_ID, makeReq({ format: "csv", approvedOnly: true })),
      deps(evidenceDir),
    );

    expect(result.status).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_REVIEW_TAMPERED");
  });
});

describe("handleQiTraceabilityExport — approvedOnly export evidence", () => {
  it("records the exported scope on the export-evidence row", async () => {
    seedRun();
    decide("approve", "tc-approved");

    await handleQiTraceabilityExport(
      ctx(RUN_ID, makeReq({ format: "csv", approvedOnly: true })),
      deps(evidenceDir),
    );

    const row = loadQualityIntelligenceRun(RUN_ID, { evidenceDir })?.exports[0];
    expect(row?.targetAdapter).toBe("traceability-csv");
    expect(row?.approvedOnly).toBe(true);
  });

  it("records an unscoped traceability export as approvedOnly=false", async () => {
    seedRun();

    await handleQiTraceabilityExport(
      ctx(RUN_ID, makeReq({ format: "markdown" })),
      deps(evidenceDir),
    );

    const row = loadQualityIntelligenceRun(RUN_ID, { evidenceDir })?.exports[0];
    expect(row?.targetAdapter).toBe("traceability-markdown");
    expect(row?.approvedOnly).toBe(false);
  });
});
