// Coverage Intelligence live-proof — Epic #734 Definition of Done (D4, with D1/D2/D3 end-to-end).
//
// The Epic DoD demands LIVE PROOF: "a run with a deliberately uncovered requirement shows the gap
// as a finding AND in the matrix — consistently across surfaces." Prior tests pin this only
// PIECEWISE, on either side of the persistence boundary:
//   - modelRoutedTestDesign.test.ts drives a REAL run, but persists to an IN-MEMORY local store
//     that shares no state with the on-disk store the server read routes consume.
//   - coverageConsistency.test.ts (#741) reads through the REAL routes, but from a HAND-BUILT
//     manifest fixture, never from a real workflow run.
// Neither chains a real workflow run THROUGH the real server read routes, so the write->read
// junction (what executeQiRun persists vs what handleGetQiRun / handleQiTraceabilityExport load)
// is only type-guarded, never behaviourally proven. This suite closes that junction end to end:
// a real executeQiRun against a real on-disk evidenceDir, read back exclusively through the real
// route handlers. No hand-built manifest.
//
// Surfaces asserted from ONE real run:
//   SURFACE 1 — persisted manifest: coverage-gap finding + coverageMatrix row (keiko-evidence)
//   SURFACE 2 — run card: handleGetQiRun -> coverageByAtom + coveragePercentage (D1)
//   SURFACE 3 — traceability CSV export: handleQiTraceabilityExport (D3)
//   SURFACE 4 — traceability Markdown export: handleQiTraceabilityExport (D3, not covered by #741)
// Both the uncovered (high-severity) and weakly-covered (low-severity) gap classes are proven (D2).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  GatewayRequest,
  ModelCapability,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { loadQualityIntelligenceRun } from "@oscharko-dev/keiko-evidence";
import type { QualityIntelligenceStartRunRequest } from "@oscharko-dev/keiko-contracts";
import { buildRedactor, createRunRegistry } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import type { UiHandlerDeps } from "../../deps.js";
import type { RouteContext, RouteResult } from "../../routes.js";
import { STREAMING } from "../../routes.js";
import { executeQiRun } from "../runExecution.js";
import type { ExecuteQiRunInput } from "../runExecution.js";
import { handleGetQiRun } from "../uiRoutes.js";
import { handleQiTraceabilityExport } from "../traceabilityRoutes.js";

const MODEL_ID = "test-chat-model";

// A standalone Status-column token (word boundary), not a row substring. Atom/candidate ids embed
// the status words ("atom-uncovered-…"), so a bare toContain would survive a mutation that drops or
// relabels the column. `[\w-]` excludes the hyphenated id occurrences. (Mirrors #741.)
const UNCOVERED_TOKEN = /(?<![a-z])uncovered(?![\w-])/u;
const COVERED_TOKEN = /(?<![a-z])covered(?![\w-])/u;
const WEAKLY_TOKEN = /(?<![a-z])weakly-covered(?![\w-])/u;

// ── Fake model port + gateway config (mirrors runExecution.test.ts) ───────────

function usageMeta(): NormalizedResponse["usage"] {
  return {
    requestId: "req-live-proof",
    promptTokens: 100,
    completionTokens: 50,
    latencyMs: 1,
    costClass: "medium",
  };
}

/** A fake ModelPort that returns the same canned JSON for every call. */
function fakeChatPort(content: string): ModelPort {
  return {
    call: (req: GatewayRequest, _signal: AbortSignal): Promise<NormalizedResponse> =>
      Promise.resolve({
        content,
        modelId: req.modelId,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: usageMeta(),
      }),
  };
}

function chatCapability(modelId: string): ModelCapability {
  return {
    id: modelId,
    kind: "chat",
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test",
    preferredUseCases: ["Chat"],
    knownLimitations: [],
  };
}

function buildConfig(): ReturnType<typeof parseGatewayConfig> {
  const capability = chatCapability(MODEL_ID);
  return parseGatewayConfig(
    {
      providers: [
        {
          modelId: capability.id,
          baseUrl: "https://fake.example.com/v1",
          apiKey: "fake-key",
          capability,
        },
      ],
    },
    {},
  );
}

function emptyStore(): EvidenceStore {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

function buildDeps(evidenceDir: string, modelPort: ModelPort): UiHandlerDeps {
  const config = buildConfig();
  return {
    config,
    configPresent: true,
    evidenceStore: emptyStore(),
    env: {},
    redactor: buildRedactor({}, config),
    registry: createRunRegistry(),
    modelPortFactory: (): ModelPort => modelPort,
    store: createInMemoryUiStore(),
    evidenceDir,
  };
}

// ── Route context helpers (mirrors coverageConsistency.test.ts) ───────────────

function makeReq(body: Record<string, unknown> | null): IncomingMessage {
  const raw = body === null ? "" : JSON.stringify(body);
  return Readable.from(
    raw.length > 0 ? [Buffer.from(raw, "utf8")] : [],
  ) as unknown as IncomingMessage;
}

function runCtx(id: string): RouteContext {
  return {
    req: {} as RouteContext["req"],
    res: {} as RouteContext["res"],
    params: { id },
    url: new URL(`http://127.0.0.1/api/quality-intelligence/runs/${id}`),
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

// ── Real run driver ───────────────────────────────────────────────────────────

/** Write a requirements file to a real workspace source dir and run executeQiRun against it. */
async function runWithRequirements(args: {
  readonly evidenceDir: string;
  readonly runId: string;
  readonly requirements: readonly string[];
  /** Canned model output (the generated test cases + their derivedFromEvidenceIndexes). */
  readonly modelOutput: string;
}): Promise<void> {
  const { evidenceDir, runId, requirements, modelOutput } = args;
  const sourceDir = join(evidenceDir, "source");
  mkdirSync(sourceDir);
  writeFileSync(join(sourceDir, "requirements.md"), requirements.join("\n"), "utf8");

  const request: QualityIntelligenceStartRunRequest = {
    sources: [{ kind: "workspace", label: "Live-proof fixture", path: sourceDir }],
    modelId: MODEL_ID,
  };
  const input: ExecuteQiRunInput = {
    request,
    runId,
    deps: buildDeps(evidenceDir, fakeChatPort(modelOutput)),
    registeredAt: "2026-06-14T10:00:00.000Z",
    signal: new AbortController().signal,
    onEvent: vi.fn(),
    onAccepted: vi.fn(),
  };
  await executeQiRun(input);
}

/** One generated test case deriving from the given 1-based evidence indexes. */
function testCase(title: string, derivedFromEvidenceIndexes: readonly number[]): unknown {
  return {
    title,
    preconditions: ["A registered audit user exists."],
    steps: ["Exercise the requirement."],
    expectedResults: ["The requirement holds."],
    priority: "P1",
    riskClass: "compliance",
    derivedFromEvidenceIndexes,
    tags: ["live-proof"],
  };
}

/** Extract the requirements->tests data rows of the CSV (between header and the blank separator). */
function csvRequirementRows(csv: string): readonly string[] {
  const lines = csv.split("\r\n");
  const headerIdx = lines.findIndex((line) => line.includes("Requirement ID"));
  expect(headerIdx).toBeGreaterThan(-1);
  const rows: string[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") break;
    rows.push(line);
  }
  return rows;
}

/** Narrow `T | undefined` to `T`, failing the test with a clear message instead of a non-null `!`. */
function defined<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

type LoadedManifest = NonNullable<ReturnType<typeof loadQualityIntelligenceRun>>;
interface RunBody {
  coverageByAtom: readonly { atomId: string; status: string }[];
  coveragePercentage: number;
}
interface ExportBody {
  format: string;
  body: string;
}

describe("Epic #734 — Coverage Intelligence live proof (real run -> real routes)", () => {
  // One real executeQiRun per scenario (beforeAll), then each surface is asserted in its own test so
  // the persisted manifest is read back EXCLUSIVELY through the real route handlers.
  describe("a deliberately uncovered requirement", () => {
    const runId = "run-liveproof-uncovered";
    let evidenceDir: string;
    let readDeps: UiHandlerDeps;
    let manifest: LoadedManifest;
    let coveredAtomId: string;
    let uncoveredAtomId: string;

    beforeAll(async () => {
      evidenceDir = mkdtempSync(join(tmpdir(), "keiko-734-liveproof-unc-"));
      // Two requirements; the model covers ONLY the first (focused, derived from index 1), leaving
      // the second deliberately uncovered.
      await runWithRequirements({
        evidenceDir,
        runId,
        requirements: [
          "REQ-COVERED-001: The system must require multi-factor verification before audit login access is granted.",
          "REQ-UNCOVERED-002: The system must present a confirmation screen before audit funds are transferred.",
        ],
        modelOutput: JSON.stringify({
          testCases: [testCase("Verify MFA gate before audit login", [1])],
        }),
      });
      manifest = defined(loadQualityIntelligenceRun(runId, { evidenceDir }), "manifest");
      const matrix = manifest.coverageMatrix ?? [];
      coveredAtomId = defined(
        matrix.find((r) => r.status === "covered"),
        "covered matrix row",
      ).atomId;
      uncoveredAtomId = defined(
        matrix.find((r) => r.status === "uncovered"),
        "uncovered matrix row",
      ).atomId;
      readDeps = buildDeps(evidenceDir, fakeChatPort(""));
    });

    afterAll(() => {
      rmSync(evidenceDir, { recursive: true, force: true });
    });

    it("SURFACE 1 — manifest: a high-severity gap names the uncovered requirement and the matrix has covered + uncovered (no weakly)", () => {
      const matrix = manifest.coverageMatrix ?? [];
      expect(matrix).toHaveLength(2);
      expect(matrix.some((r) => r.status === "weakly-covered")).toBe(false);
      const covered = defined(
        matrix.find((r) => r.atomId === coveredAtomId),
        "covered row",
      );
      const uncovered = defined(
        matrix.find((r) => r.atomId === uncoveredAtomId),
        "uncovered row",
      );
      expect(covered.requirementExcerptRedacted).toContain("REQ-COVERED-001");
      expect(uncovered.requirementExcerptRedacted).toContain("REQ-UNCOVERED-002");

      const gapFindings = manifest.findings.filter((f) => f.kind === "coverage-gap");
      const highGap = defined(
        gapFindings.find((f) => f.severity === "high"),
        "high-severity gap finding",
      );
      expect(highGap.summaryRedacted).toContain("REQ-UNCOVERED-002");
      expect(highGap.summaryRedacted).toMatch(UNCOVERED_TOKEN);
      // A covered atom produces no gap finding, so there is no low-severity (weakly) gap here.
      expect(gapFindings.some((f) => f.severity === "low")).toBe(false);
    });

    it("SURFACE 2 — run card: handleGetQiRun reports uncovered/covered and 50% (D1)", () => {
      const result = asResult(handleGetQiRun(runCtx(runId), readDeps));
      expect(result.status).toBe(200);
      const body = result.body as RunBody;
      expect(
        defined(
          body.coverageByAtom.find((r) => r.atomId === uncoveredAtomId),
          "card uncovered row",
        ).status,
      ).toBe("uncovered");
      expect(
        defined(
          body.coverageByAtom.find((r) => r.atomId === coveredAtomId),
          "card covered row",
        ).status,
      ).toBe("covered");
      // Exactly one of two atoms is covered -> 50%.
      expect(body.coveragePercentage).toBe(50);
    });

    it("SURFACE 3 — traceability CSV export shows the uncovered row (D3)", async () => {
      const result = await handleQiTraceabilityExport(traceCtx(runId, makeReq(null)), readDeps);
      expect(result.status).toBe(200);
      const body = result.body as ExportBody;
      expect(body.format).toBe("csv");
      const rows = csvRequirementRows(body.body);
      const uncoveredRow = defined(
        rows.find((row) => row.includes(uncoveredAtomId)),
        "CSV uncovered row",
      );
      expect(uncoveredRow).toMatch(UNCOVERED_TOKEN);
      expect(uncoveredRow).not.toMatch(COVERED_TOKEN);
      const coveredRow = defined(
        rows.find((row) => row.includes(coveredAtomId)),
        "CSV covered row",
      );
      expect(coveredRow).toMatch(COVERED_TOKEN);
    });

    it("SURFACE 4 — traceability Markdown export shows the uncovered row (D3, not covered by #741)", async () => {
      const result = await handleQiTraceabilityExport(
        traceCtx(runId, makeReq({ format: "markdown" })),
        readDeps,
      );
      expect(result.status).toBe(200);
      const body = result.body as ExportBody;
      expect(body.format).toBe("markdown");
      const mdRow = defined(
        body.body.split("\n").find((line) => line.includes(uncoveredAtomId)),
        "Markdown uncovered row",
      );
      expect(mdRow).toMatch(UNCOVERED_TOKEN);
      expect(mdRow).not.toMatch(COVERED_TOKEN);
    });
  });

  describe("a weakly-covered requirement", () => {
    const runId = "run-liveproof-weakly";
    let evidenceDir: string;
    let readDeps: UiHandlerDeps;
    let manifest: LoadedManifest;
    let weaklyAtomId: string;

    beforeAll(async () => {
      evidenceDir = mkdtempSync(join(tmpdir(), "keiko-734-liveproof-weak-"));
      // Four requirements covered ONLY by a single broad test case (derived from 4 atoms >
      // FOCUS_COVERED_MAX) are weakly-covered; the fifth is uncovered. No focused candidate -> 0%.
      await runWithRequirements({
        evidenceDir,
        runId,
        requirements: [
          "REQ-WEAK-001: The audit dashboard must list all pending approvals.",
          "REQ-WEAK-002: The audit dashboard must paginate approval history.",
          "REQ-WEAK-003: The audit dashboard must filter approvals by reviewer.",
          "REQ-WEAK-004: The audit dashboard must export approvals to CSV.",
          "REQ-UNCOVERED-005: The audit dashboard must lock after repeated failed reviewer logins.",
        ],
        modelOutput: JSON.stringify({
          testCases: [testCase("Broadly exercise the audit dashboard", [1, 2, 3, 4])],
        }),
      });
      manifest = defined(loadQualityIntelligenceRun(runId, { evidenceDir }), "manifest");
      const matrix = manifest.coverageMatrix ?? [];
      weaklyAtomId = defined(
        matrix.find(
          (r) =>
            r.status === "weakly-covered" &&
            (r.requirementExcerptRedacted ?? "").includes("REQ-WEAK-002"),
        ),
        "weakly-covered matrix row",
      ).atomId;
      readDeps = buildDeps(evidenceDir, fakeChatPort(""));
    });

    afterAll(() => {
      rmSync(evidenceDir, { recursive: true, force: true });
    });

    it("SURFACE 1 — manifest: 4 weakly + 1 uncovered, and a low-severity gap names the weakly requirement (D2)", () => {
      const matrix = manifest.coverageMatrix ?? [];
      expect(matrix).toHaveLength(5);
      expect(matrix.filter((r) => r.status === "weakly-covered")).toHaveLength(4);
      expect(matrix.filter((r) => r.status === "uncovered")).toHaveLength(1);
      expect(matrix.some((r) => r.status === "covered")).toBe(false);

      const gapFindings = manifest.findings.filter((f) => f.kind === "coverage-gap");
      const lowGap = defined(
        gapFindings.find((f) => f.severity === "low" && f.summaryRedacted.includes("REQ-WEAK-002")),
        "low-severity weakly gap finding",
      );
      // The finding summary phrases the status in prose ("is only weakly covered"); the enum form
      // "weakly-covered" is asserted on the status-column surfaces (run card + CSV) below.
      expect(lowGap.summaryRedacted).toContain("weakly covered");
      // The uncovered fifth requirement is still a high gap.
      expect(gapFindings.some((f) => f.severity === "high")).toBe(true);
    });

    it("SURFACE 2 — run card: the weakly atom is weakly-covered and does not count toward % (D1/D2)", () => {
      const result = asResult(handleGetQiRun(runCtx(runId), readDeps));
      expect(result.status).toBe(200);
      const body = result.body as RunBody;
      expect(
        defined(
          body.coverageByAtom.find((r) => r.atomId === weaklyAtomId),
          "card weakly row",
        ).status,
      ).toBe("weakly-covered");
      // Weakly-covered does not count toward the covered percentage.
      expect(body.coveragePercentage).toBe(0);
    });

    it("SURFACE 3 — traceability CSV export shows the weakly-covered row (D3)", async () => {
      const result = await handleQiTraceabilityExport(traceCtx(runId, makeReq(null)), readDeps);
      expect(result.status).toBe(200);
      const body = result.body as ExportBody;
      const rows = csvRequirementRows(body.body);
      const weaklyRow = defined(
        rows.find((row) => row.includes(weaklyAtomId)),
        "CSV weakly row",
      );
      expect(weaklyRow).toMatch(WEAKLY_TOKEN);
    });
  });
});
