// Coverage consistency regression test — Issue #741
// "The deliberately uncovered requirement appears as (1) a gap finding, (2) on the run card,
// and (3) in the exported traceability matrix CONSISTENTLY."
//
// This is the cross-surface identity test: ONE persisted run, ONE uncovered atom id, THREE
// assertion surfaces — all anchored to the SAME const so a mutation that drops or relabels the
// atom in any surface causes that surface's assertion to fail.
//
// Surfaces tested:
//   SURFACE 1 — gap finding persisted in the manifest (findings[] row)
//   SURFACE 2 — run-card projection via handleGetQiRun → coverageByAtom
//   SURFACE 3 — traceability CSV export via handleQiTraceabilityExport → CSV row
//
// Pattern: #728 "live chain via real route" — no mocks, real evidenceDir, real route handlers.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadQualityIntelligenceRun,
  recordQualityIntelligenceRun,
} from "@oscharko-dev/keiko-evidence";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { buildRedactor, createRunRegistry } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import type { UiHandlerDeps } from "../../deps.js";
import type { RouteContext, RouteResult } from "../../routes.js";
import { STREAMING } from "../../routes.js";
import { handleGetQiRun } from "../uiRoutes.js";
import { handleQiTraceabilityExport } from "../traceabilityRoutes.js";

// ---------------------------------------------------------------------------
// Shared identity constants — the same literal must appear in every surface.
// Using a const (not a bare string) means a mutation that changes one surface
// without updating the const causes every assertion to RED.
// ---------------------------------------------------------------------------

const RUN_ID = "run-741-coverage-consistency";
const UNCOVERED_ATOM_ID = "atom-uncovered-741";
const COVERED_ATOM_ID = "atom-covered-741";
const COVERING_CANDIDATE_ID = "tc-covered-741";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function emptyStore(): EvidenceStore {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

function deps(evidenceDir: string): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: emptyStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    evidenceDir,
  };
}

function makeReq(body: Record<string, unknown> | null): IncomingMessage {
  const raw = body === null ? "" : JSON.stringify(body);
  return Readable.from(
    raw.length > 0 ? [Buffer.from(raw, "utf8")] : [],
  ) as unknown as IncomingMessage;
}

function runCtx(path: string, params: Record<string, string>): RouteContext {
  return {
    req: {} as RouteContext["req"],
    res: {} as RouteContext["res"],
    params,
    url: new URL(`http://127.0.0.1${path}`),
  };
}

function traceCtx(id: string, req: IncomingMessage): RouteContext {
  return {
    req,
    res: {} as RouteContext["res"],
    params: { id },
    url: new URL(`http://127.0.0.1/api/quality-intelligence/runs/${id}/traceability`),
  };
}

function asResult(outcome: RouteResult | typeof STREAMING): RouteResult {
  if (outcome === STREAMING) {
    throw new Error("expected RouteResult, got STREAMING");
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Fixture: one manifest with coverageMatrix + findings containing both atoms.
//
// findings[0] is the coverage-gap row for UNCOVERED_ATOM_ID:
//   kind: "coverage-gap", severity: "high", summaryRedacted names the atom.
//
// coverageMatrix has two rows:
//   UNCOVERED_ATOM_ID → status "uncovered", confidence 0, no covering candidates
//   COVERED_ATOM_ID   → status "covered", confidence 0.9, one covering candidate
// ---------------------------------------------------------------------------

type RunInput = Parameters<typeof recordQualityIntelligenceRun>[0];

function buildRunInput(): RunInput {
  return {
    runId: RUN_ID,
    planAt: "2026-06-14T10:00:00.000Z",
    completedAt: "2026-06-14T10:01:00.000Z",
    status: "succeeded",
    policyProfileIds: [],
    retentionPolicyId: "default",
    modelGatewayCallCount: 1,
    totals: { candidates: 1, findings: 1, exports: 0 },
    findings: [
      {
        id: "qi-finding-741-gap",
        kind: "coverage-gap",
        severity: "high",
        // summaryRedacted names the uncovered atom — SURFACE 1 assertion checks this string
        summaryRedacted: `Atom ${UNCOVERED_ATOM_ID} has no tracing test (uncovered).`,
      },
    ],
    exports: [],
    evidenceRefs: [],
    provenanceRefs: {
      envelopeIds: [],
      auditSummaryId: "qi-audit-741-consistency" as RunInput["provenanceRefs"]["auditSummaryId"],
    },
    coverageMatrix: [
      {
        atomId: UNCOVERED_ATOM_ID,
        status: "uncovered",
        confidence: 0,
        coveringCandidateIds: [],
      },
      {
        atomId: COVERED_ATOM_ID,
        status: "covered",
        confidence: 0.9,
        coveringCandidateIds: [COVERING_CANDIDATE_ID],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Issue #741 — coverage consistency across all three surfaces", () => {
  let evidenceDir: string;

  beforeEach(() => {
    evidenceDir = mkdtempSync(join(tmpdir(), "keiko-741-test-"));
    // Persist ONE manifest that all three surfaces read from.
    recordQualityIntelligenceRun(buildRunInput(), { evidenceDir });
  });

  afterEach(() => {
    rmSync(evidenceDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // SURFACE 1 — gap finding in the persisted manifest
  //
  // Mutation that kills this: change findings[0].kind to "policy-violation"
  //   → assertion on kind fails (RED).
  // Mutation that kills this: set findings[0].severity to "low"
  //   → severity "high" assertion fails (RED).
  // Mutation that kills this: remove UNCOVERED_ATOM_ID from summaryRedacted
  //   → atom-id-in-summary assertion fails (RED).
  // Mutation that kills this: set COVERED_ATOM_ID finding instead
  //   → covered-atom guard assertion fails if the wrong atom is labelled uncovered.
  // -------------------------------------------------------------------------

  it("SURFACE 1: persisted manifest contains a coverage-gap finding with severity high for the uncovered atom", () => {
    // Arrange — already persisted in beforeEach

    // Act
    const manifest = loadQualityIntelligenceRun(RUN_ID, { evidenceDir });

    // Assert
    expect(manifest).toBeDefined();
    const findings = manifest?.findings ?? [];
    const gapFinding = findings.find((f) => f.kind === "coverage-gap");
    expect(gapFinding).toBeDefined();
    // Severity must be "high" for an uncovered atom (not "low" which is weakly-covered).
    expect(gapFinding?.severity).toBe("high");
    // summaryRedacted names the uncovered atom, not the covered control atom.
    expect(gapFinding?.summaryRedacted).toContain(UNCOVERED_ATOM_ID);
    expect(gapFinding?.summaryRedacted).not.toContain(COVERED_ATOM_ID);
  });

  // -------------------------------------------------------------------------
  // SURFACE 2 — run-card coverageByAtom via handleGetQiRun
  //
  // Mutation that kills this: flip UNCOVERED_ATOM_ID row status to "covered"
  //   → uncovered-status assertion fails (RED).
  // Mutation that kills this: flip COVERED_ATOM_ID row status to "uncovered"
  //   → covered-status assertion fails (RED).
  // Mutation that kills this: swap atomId values in the matrix rows
  //   → both per-atom find() calls return undefined → assertion on .status fails.
  // -------------------------------------------------------------------------

  it("SURFACE 2: handleGetQiRun coverageByAtom reports UNCOVERED_ATOM_ID as uncovered and COVERED_ATOM_ID as covered", () => {
    // Arrange — already persisted in beforeEach
    const handlerCtx = runCtx(`/api/quality-intelligence/runs/${RUN_ID}`, { id: RUN_ID });

    // Act
    const result = asResult(handleGetQiRun(handlerCtx, deps(evidenceDir)));

    // Assert
    expect(result.status).toBe(200);
    const body = result.body as {
      coverageByAtom: readonly { atomId: string; status: string }[];
    };
    const uncoveredRow = body.coverageByAtom.find((r) => r.atomId === UNCOVERED_ATOM_ID);
    const coveredRow = body.coverageByAtom.find((r) => r.atomId === COVERED_ATOM_ID);
    // Both rows must be present.
    expect(uncoveredRow).toBeDefined();
    expect(coveredRow).toBeDefined();
    // Status must be consistent with the persisted matrix.
    expect(uncoveredRow?.status).toBe("uncovered");
    expect(coveredRow?.status).toBe("covered");
    // Guard: the covered control atom must NOT be reported as uncovered.
    expect(coveredRow?.status).not.toBe("uncovered");
  });

  // -------------------------------------------------------------------------
  // SURFACE 3 — traceability CSV export via handleQiTraceabilityExport
  //
  // The CSV requirements→tests section has header row then one row per atom.
  // A data row looks like: atomId,...,status,...
  // We parse the specific row for UNCOVERED_ATOM_ID and check the status column
  // rather than using a global toContain("uncovered") — a global match would
  // survive a mutation that mislabels COVERED_ATOM_ID as uncovered instead.
  //
  // Mutation that kills this: flip the uncovered row's status to "covered"
  //   → row-status assertion for "uncovered" fails (RED).
  // Mutation that kills this: remove UNCOVERED_ATOM_ID from the matrix entirely
  //   → uncoveredRow === undefined → toBeDefined fails (RED).
  // Mutation that kills this: emit COVERED_ATOM_ID with status "uncovered"
  //   → covered-row guard (not "uncovered") fails (RED).
  // -------------------------------------------------------------------------

  it("SURFACE 3: handleQiTraceabilityExport CSV contains UNCOVERED_ATOM_ID with status uncovered and COVERED_ATOM_ID with status covered in their respective rows", async () => {
    // Arrange — already persisted in beforeEach

    // Act
    const result = await handleQiTraceabilityExport(
      traceCtx(RUN_ID, makeReq(null)),
      deps(evidenceDir),
    );

    // Assert — basic route success
    expect(result.status).toBe(200);
    const body = result.body as { format: string; body: string; contentType: string };
    expect(body.format).toBe("csv");
    const csvLines = body.body.split("\r\n");

    // Find the requirements→tests section header row (contains "Requirement ID").
    const headerIdx = csvLines.findIndex((line) => line.includes("Requirement ID"));
    expect(headerIdx).toBeGreaterThan(-1);

    // Collect data rows from the requirements section (between the header and the first blank
    // line that separates it from the tests→requirements section).
    const dataRows: string[] = [];
    for (let i = headerIdx + 1; i < csvLines.length; i++) {
      const line = csvLines[i];
      if (line === undefined || line.trim() === "") break;
      dataRows.push(line);
    }

    // Locate the row for UNCOVERED_ATOM_ID and COVERED_ATOM_ID by their atom id prefix.
    const uncoveredRow = dataRows.find((row) => row.includes(UNCOVERED_ATOM_ID));
    const coveredRow = dataRows.find((row) => row.includes(COVERED_ATOM_ID));

    // Both atoms must be present in the matrix export.
    expect(uncoveredRow).toBeDefined();
    expect(coveredRow).toBeDefined();

    // Assert the status column in each row — parse the atom-specific row so a global
    // toContain("uncovered") on the full CSV body cannot mask a per-row inversion.
    expect(uncoveredRow).toContain("uncovered");
    expect(coveredRow).toContain("covered");

    // Guard: the uncovered atom's row must NOT contain "covered" as a standalone status
    // (the word "uncovered" contains "covered" as a substring — use word-boundary regex
    // to guard against the inversion mutation).
    expect(uncoveredRow).not.toMatch(/(?<![a-z])covered(?![\w-])/u);

    // Guard: the covered control atom must NOT appear with "uncovered" status.
    expect(coveredRow).not.toContain("uncovered");
  });

  // -------------------------------------------------------------------------
  // CROSS-SURFACE identity invariant
  //
  // All three surfaces derive from the same persisted matrix. This test asserts
  // the invariant directly: the atom that appears as uncovered in the manifest
  // is the SAME atom that appears as uncovered in the run card AND in the CSV.
  // A mutation that routes different atom ids to different surfaces fails here.
  // -------------------------------------------------------------------------

  it("cross-surface: the atom id reported as uncovered is IDENTICAL across manifest, run card, and traceability CSV", async () => {
    // Arrange — already persisted in beforeEach

    // Act: load all three surfaces
    const manifest = loadQualityIntelligenceRun(RUN_ID, { evidenceDir });

    const runResult = asResult(
      handleGetQiRun(
        runCtx(`/api/quality-intelligence/runs/${RUN_ID}`, { id: RUN_ID }),
        deps(evidenceDir),
      ),
    );

    const traceResult = await handleQiTraceabilityExport(
      traceCtx(RUN_ID, makeReq(null)),
      deps(evidenceDir),
    );

    // Assert — Surface 1: manifest matrix
    const matrixRow = manifest?.coverageMatrix?.find((r) => r.status === "uncovered");
    expect(matrixRow?.atomId).toBe(UNCOVERED_ATOM_ID);

    // Assert — Surface 2: run-card coverageByAtom
    const runBody = runResult.body as {
      coverageByAtom: readonly { atomId: string; status: string }[];
    };
    const cardUncoveredRow = runBody.coverageByAtom.find((r) => r.status === "uncovered");
    expect(cardUncoveredRow?.atomId).toBe(UNCOVERED_ATOM_ID);

    // Assert — Surface 3: CSV — find the row whose status column is "uncovered"
    const traceBody = traceResult.body as { body: string };
    const csvLines = traceBody.body.split("\r\n");
    const headerIdx = csvLines.findIndex((line) => line.includes("Requirement ID"));
    const dataRows: string[] = [];
    for (let i = headerIdx + 1; i < csvLines.length; i++) {
      const line = csvLines[i];
      if (line === undefined || line.trim() === "") break;
      dataRows.push(line);
    }
    const csvUncoveredRow = dataRows.find((row) => /(?<![a-z])uncovered(?![\w-])/u.test(row));
    expect(csvUncoveredRow).toContain(UNCOVERED_ATOM_ID);

    // All three agree: the uncovered atom is UNCOVERED_ATOM_ID (not COVERED_ATOM_ID).
    expect(matrixRow?.atomId).not.toBe(COVERED_ATOM_ID);
    expect(cardUncoveredRow?.atomId).not.toBe(COVERED_ATOM_ID);
  });
});
