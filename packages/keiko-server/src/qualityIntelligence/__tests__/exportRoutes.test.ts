// Integration tests for handleQiExport (Epic #270, Issue #283).
//
// Seeds a temp evidenceDir with a recorded run manifest + candidate artifact, then calls
// the handler directly. Verifies local adapters, unknown adapter, TMS dry-run/live,
// no-candidates, and formula-injection safety. Pure function + real fs.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  recordQualityIntelligenceRun,
  recordQualityIntelligenceCandidates,
  applyQualityIntelligenceCandidateEdit,
  loadQualityIntelligenceRun,
} from "@oscharko-dev/keiko-evidence";
import type {
  EvidenceStore,
  QualityIntelligenceEvidenceManifest,
} from "@oscharko-dev/keiko-evidence";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import type { QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import type { RouteContext, RouteResult } from "../../routes.js";
import { STREAMING } from "../../routes.js";
import type { UiHandlerDeps } from "../../deps.js";
import { buildRedactor, createRunRegistry } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import { handleQiExport } from "../exportRoutes.js";
import { applyReviewDecision } from "../reviewStore.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

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

function depsNoDir(): UiHandlerDeps {
  return { ...deps("/tmp/fake"), evidenceDir: undefined };
}

function makeReq(body: Record<string, unknown>): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  return req as unknown as IncomingMessage;
}

function makeRawReq(raw: string): IncomingMessage {
  const req = Readable.from([Buffer.from(raw, "utf8")]);
  return req as unknown as IncomingMessage;
}

function ctx(runId: string, req: IncomingMessage): RouteContext {
  return {
    req,
    res: {} as RouteContext["res"],
    params: { id: runId },
    url: new URL(`http://127.0.0.1/api/quality-intelligence/runs/${runId}/export`),
  };
}

function asResult(outcome: RouteResult | typeof STREAMING): RouteResult {
  if (outcome === STREAMING) throw new Error("expected RouteResult, got STREAMING");
  return outcome;
}

/** Minimal run record input with matched totals. */
function runRecordInput(runId: string): Parameters<typeof recordQualityIntelligenceRun>[0] {
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
      auditSummaryId:
        "qi-audit-test" as QualityIntelligenceEvidenceManifest["provenanceRefs"]["auditSummaryId"],
    },
  };
}

/** Build a minimal test-case candidate. */
function makeCandidate(title: string, id = "cand-001"): QI.QualityIntelligenceTestCaseCandidate {
  return {
    id: QualityIntelligence.asQualityIntelligenceTestCaseId(id),
    runId: QualityIntelligence.asQualityIntelligenceRunId("run-export-001"),
    derivedFromAtomIds: [QualityIntelligence.asQualityIntelligenceEvidenceAtomId("atom-1")],
    title,
    preconditions: ["User is on the login page"],
    steps: ["Enter email", "Enter password", "Click Submit"],
    expectedResults: ["User is redirected to dashboard"],
    priority: "P1",
    riskClass: "functional",
    tags: ["smoke"],
    status: "proposed",
  };
}

// ─── Test lifecycle ───────────────────────────────────────────────────────────

let evidenceDir: string;

const RUN_ID = "run-export-001";

beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "keiko-export-test-"));
  // Seed the manifest.
  recordQualityIntelligenceRun(runRecordInput(RUN_ID), { evidenceDir });
  // Seed the candidate artifact with one candidate.
  recordQualityIntelligenceCandidates({
    runId: RUN_ID,
    generatedAt: "2026-06-01T10:01:00.000Z",
    candidates: [makeCandidate("User can log in with valid credentials")],
    evidenceDir,
    redact: (v: unknown): unknown => v,
  });
});

afterEach(() => {
  rmSync(evidenceDir, { recursive: true, force: true });
});

// ─── Error: missing id param ──────────────────────────────────────────────────

describe("handleQiExport — missing id param", () => {
  it("returns 400 QI_BAD_REQUEST when id param is absent", async () => {
    const c: RouteContext = {
      req: makeReq({ adapter: "csv" }),
      res: {} as RouteContext["res"],
      params: {},
      url: new URL("http://127.0.0.1/api/quality-intelligence/runs//export"),
    };
    const result = asResult(await handleQiExport(c, deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });

  it("returns 400 QI_BAD_REQUEST when id param is an empty string", async () => {
    const c: RouteContext = {
      req: makeReq({ adapter: "csv" }),
      res: {} as RouteContext["res"],
      params: { id: "" },
      url: new URL("http://127.0.0.1/api/quality-intelligence/runs//export"),
    };
    const result = asResult(await handleQiExport(c, deps(evidenceDir)));
    expect(result.status).toBe(400);
  });
});

// ─── Error: no evidence dir ───────────────────────────────────────────────────

describe("handleQiExport — no evidence dir", () => {
  it("returns 500 QI_NO_EVIDENCE_DIR when evidenceDir is not configured", async () => {
    const result = asResult(
      await handleQiExport(ctx(RUN_ID, makeReq({ adapter: "csv" })), depsNoDir()),
    );
    expect(result.status).toBe(500);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_NO_EVIDENCE_DIR");
  });
});

// ─── Error: non-JSON body ────────────────────────────────────────────────────

describe("handleQiExport — non-JSON body", () => {
  it("returns 400 QI_BAD_REQUEST for a non-JSON body", async () => {
    const result = asResult(
      await handleQiExport(ctx(RUN_ID, makeRawReq("not json")), deps(evidenceDir)),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });

  it("returns 400 QI_BAD_REQUEST for a JSON array body", async () => {
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeRawReq(JSON.stringify([{ adapter: "csv" }]))),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(400);
  });
});

// ─── Error: unknown adapter ────────────────────────────────────────────────────

describe("handleQiExport — unknown adapter", () => {
  it("returns 400 QI_BAD_ADAPTER for an unrecognised adapter value", async () => {
    const result = asResult(
      await handleQiExport(ctx(RUN_ID, makeReq({ adapter: "not-an-adapter" })), deps(evidenceDir)),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_ADAPTER");
  });

  it("returns 400 QI_BAD_ADAPTER when adapter field is missing from body", async () => {
    const result = asResult(
      await handleQiExport(ctx(RUN_ID, makeReq({ dryRun: false })), deps(evidenceDir)),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_ADAPTER");
  });
});

// ─── Error: run not found ─────────────────────────────────────────────────────

describe("handleQiExport — run not found", () => {
  it("returns 404 QI_NOT_FOUND for an unknown run id", async () => {
    const result = asResult(
      await handleQiExport(
        ctx("run-does-not-exist", makeReq({ adapter: "csv" })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(404);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_NOT_FOUND");
  });
});

// ─── Error: no candidates artifact ───────────────────────────────────────────

describe("handleQiExport — no candidates", () => {
  it("returns 409 QI_NO_CANDIDATES for a run with no candidate artifact", async () => {
    // Record a run WITHOUT a candidate artifact.
    const emptyDir = mkdtempSync(join(tmpdir(), "keiko-export-no-cands-"));
    try {
      recordQualityIntelligenceRun(runRecordInput("run-no-cands"), { evidenceDir: emptyDir });
      // No recordQualityIntelligenceCandidates call — artifact is absent.
      const result = asResult(
        await handleQiExport(ctx("run-no-cands", makeReq({ adapter: "csv" })), deps(emptyDir)),
      );
      expect(result.status).toBe(409);
      expect((result.body as { error: { code: string } }).error.code).toBe("QI_NO_CANDIDATES");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("handleQiExport — malformed candidates companion", () => {
  it("returns 500 QI_EXPORT_FAILED when the candidates companion is corrupted", async () => {
    writeFileSync(
      join(evidenceDir, "qi", `${RUN_ID}.candidates.json`),
      JSON.stringify({
        qiCandidatesSchemaVersion: 1,
        runId: RUN_ID,
        generatedAt: "2026-06-01T10:01:00.000Z",
        candidates: [
          {
            id: "cand-001",
            title: "Corrupt me",
            preconditions: ["ready"],
            steps: "not-an-array",
            expectedResults: ["done"],
            priority: "P1",
            riskClass: "functional",
            tags: [],
            status: "proposed",
            derivedFromAtomIds: ["atom-1"],
          },
        ],
      }),
      "utf8",
    );

    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "csv", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(500);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_EXPORT_FAILED");
  });
});

// ─── Happy path: CSV adapter (local) ─────────────────────────────────────────

describe("handleQiExport — CSV adapter", () => {
  it("returns 200 with dryRun: false for adapter 'csv'", async () => {
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "csv", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const body = result.body as { dryRun: boolean };
    expect(body.dryRun).toBe(false);
  });

  it("CSV result body has a non-empty 'body' field", async () => {
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "csv", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    const body = result.body as { body: string };
    expect(typeof body.body).toBe("string");
    expect(body.body.length).toBeGreaterThan(0);
  });

  it("CSV result filename ends with .csv", async () => {
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "csv", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    const body = result.body as { filename: string };
    expect(body.filename).toMatch(/\.csv$/);
  });

  it("CSV adapter returns contentType text/csv", async () => {
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "csv", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    const body = result.body as { contentType: string };
    expect(body.contentType).toBe("text/csv");
  });
});

// ─── Happy path: JSON adapter (local) ────────────────────────────────────────

describe("handleQiExport — JSON adapter", () => {
  it("returns 200 with dryRun: false for adapter 'json'", async () => {
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "json", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    expect((result.body as { dryRun: boolean }).dryRun).toBe(false);
  });

  it("JSON result filename ends with .json", async () => {
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "json", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    const body = result.body as { filename: string };
    expect(body.filename).toMatch(/\.json$/);
  });
});

// ─── TMS adapter: jira-issues with dryRun: false → 403 ────────────────────────

describe("handleQiExport — TMS adapter live export disabled", () => {
  it("returns 403 QI_EXTERNAL_EXPORT_DISABLED for jira-issues with dryRun: false and approved candidates", async () => {
    // Approve the seeded candidate so it passes the approval filter.
    applyReviewDecision({
      runId: RUN_ID,
      evidenceDir,
      action: "approve",
      scope: "candidate",
      candidateId: "cand-001",
      reviewerLabel: "tester",
      now: new Date().toISOString(),
      redact: (v: unknown): unknown => v,
    });

    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "jira-issues", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(403);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "QI_EXTERNAL_EXPORT_DISABLED",
    );
  });
});

// ─── TMS adapter: jira-issues dryRun: true with no approved candidates → 409 ──

describe("handleQiExport — TMS dryRun with no approved candidates", () => {
  it("returns 409 QI_NOTHING_TO_EXPORT for jira-issues dryRun: true with zero approved candidates", async () => {
    // No review decision applied — all candidates remain in 'open' state.
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "jira-issues", dryRun: true })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_NOTHING_TO_EXPORT");
  });
});

// ─── TMS adapter: jira-issues dryRun: true with approved candidate → 200 ──────

describe("handleQiExport — TMS dryRun with approved candidate", () => {
  it("returns 200 dryRun: true with candidateCount >= 1 after approval", async () => {
    // Approve the seeded candidate.
    applyReviewDecision({
      runId: RUN_ID,
      evidenceDir,
      action: "approve",
      scope: "candidate",
      candidateId: "cand-001",
      reviewerLabel: "tester",
      now: new Date().toISOString(),
      redact: (v: unknown): unknown => v,
    });

    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "jira-issues", dryRun: true })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const body = result.body as { dryRun: boolean; candidateCount: number };
    expect(body.dryRun).toBe(true);
    expect(body.candidateCount).toBeGreaterThanOrEqual(1);
  });
});

// ─── FIX E (Issue #282) — export honors RUN-scope approval ───────────────────
//
// A reviewer can approve the whole RUN (runState = approved) instead of each candidate. The
// approvedOnly gate (incl. every TMS adapter, which forces approvedOnly) must treat a run-approved
// run's candidates as approved — not 409 QI_NOTHING_TO_EXPORT.

describe("handleQiExport — run-scope approval gates the approvedOnly filter", () => {
  const approveRun = (): void => {
    applyReviewDecision({
      runId: RUN_ID,
      evidenceDir,
      action: "approve",
      scope: "run",
      reviewerLabel: "tester",
      now: "2026-06-01T12:00:00.000Z",
      redact: (v: unknown): unknown => v,
    });
  };

  it("returns all candidates for an approvedOnly local export when the RUN is approved (no per-candidate approval)", async () => {
    approveRun();
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "json", dryRun: false, approvedOnly: true })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    // The single seeded candidate is present in the serialised body (its id round-trips).
    expect((result.body as { body: string }).body).toContain("cand-001");
  });

  it("still returns 409 for an approvedOnly export when the run is NOT approved and no candidate is approved", async () => {
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "json", dryRun: false, approvedOnly: true })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_NOTHING_TO_EXPORT");
  });

  it("permits a TMS dry-run (forces approvedOnly) once the RUN is approved", async () => {
    approveRun();
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "jira-issues", dryRun: true })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const body = result.body as { dryRun: boolean; candidateCount: number };
    expect(body.dryRun).toBe(true);
    expect(body.candidateCount).toBeGreaterThanOrEqual(1);
  });
});

// ─── Formula-injection safety ─────────────────────────────────────────────────

describe("handleQiExport — formula-injection safety in CSV", () => {
  // Seed a candidate whose title starts with a formula-triggering character.
  // The exported CSV must not contain a bare formula-injection prefix in the cell.
  it.each([
    ["=SUM(A1:B1)", "="],
    ["@echo attack", "@"],
    ["+CMD|calc", "+"],
    ["-1+1", "-"],
  ])("title starting with '%s' is safe in CSV output", async (title) => {
    const injDir = mkdtempSync(join(tmpdir(), "keiko-export-inject-"));
    const injRunId = "run-inject-test";
    try {
      recordQualityIntelligenceRun(
        { ...runRecordInput(injRunId), totals: { candidates: 1, findings: 0, exports: 0 } },
        { evidenceDir: injDir },
      );
      recordQualityIntelligenceCandidates({
        runId: injRunId,
        generatedAt: "2026-06-01T10:01:00.000Z",
        candidates: [makeCandidate(title, "cand-inject")],
        evidenceDir: injDir,
        redact: (v: unknown): unknown => v,
      });

      const result = asResult(
        await handleQiExport(
          ctx(injRunId, makeReq({ adapter: "spreadsheet-safe-csv", dryRun: false })),
          deps(injDir),
        ),
      );
      expect(result.status).toBe(200);
      const csvBody = (result.body as { body: string }).body;

      // The raw formula prefix must not appear unescaped at the start of a CSV cell.
      // A bare comma-then-formula-char would be the injection point.
      const triggerChars = ["=", "@", "+", "-"];
      for (const char of triggerChars) {
        if (title.startsWith(char)) {
          // The cell must NOT start directly with the formula char after a comma or at line start.
          // Acceptable: quoted cell "=SUM(...)", prefixed cell '=SUM(...), or any non-bare form.
          // We assert that the raw formula string does not appear unquoted after comma/newline.
          // Escape ALL regex metacharacters (incl. backslash) so the pattern is built safely.
          const escaped = char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const barePattern = new RegExp(`(?:,|\n|^)${escaped}`, "m");
          expect(barePattern.test(csvBody)).toBe(false);
          break;
        }
      }
    } finally {
      rmSync(injDir, { recursive: true, force: true });
    }
  });
});

// ─── All local adapters return 200 ────────────────────────────────────────────

describe("handleQiExport — local adapter coverage", () => {
  it.each(["csv", "json", "spreadsheet-safe-csv"])("adapter '%s' returns 200", async (adapter) => {
    const result = asResult(
      await handleQiExport(ctx(RUN_ID, makeReq({ adapter, dryRun: false })), deps(evidenceDir)),
    );
    expect(result.status).toBe(200);
  });
});

// ─── All TMS adapters with dryRun: false → 403 or 409 ────────────────────────

describe("handleQiExport — all TMS adapters reject live export", () => {
  it.each(["jira-issues", "qtest", "xray", "polarion", "alm", "quality-center"])(
    "TMS adapter '%s' with dryRun: false returns 403 (after approval) or 409 (no approval)",
    async (adapter) => {
      const result = asResult(
        await handleQiExport(ctx(RUN_ID, makeReq({ adapter, dryRun: false })), deps(evidenceDir)),
      );
      // Without approval → 409; the TMS live-export guard fires before the format check.
      // The test asserts the status is NOT 200, i.e. live TMS export is never allowed.
      expect(result.status).not.toBe(200);
    },
  );
});

// ─── Epic #711 — multi-format export (Markdown / plain-text / PDF / ZIP / Quality Center) ────────

describe("handleQiExport — Epic #711 multi-format export", () => {
  const exportWith = async (
    adapter: string,
    extra: Record<string, unknown> = {},
  ): Promise<RouteResult> =>
    asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter, dryRun: false, ...extra })),
        deps(evidenceDir),
      ),
    );

  const approveSeeded = (): void => {
    applyReviewDecision({
      runId: RUN_ID,
      evidenceDir,
      action: "approve",
      scope: "candidate",
      candidateId: "cand-001",
      reviewerLabel: "tester",
      now: "2026-06-01T12:00:00.000Z",
      redact: (v: unknown): unknown => v,
    });
  };

  it("exports Markdown with a candidate section", async () => {
    const result = await exportWith("markdown");
    expect(result.status).toBe(200);
    expect((result.body as { body: string }).body).toContain("## ");
  });

  it("exports plain text with non-empty body", async () => {
    const result = await exportWith("plain-text");
    expect(result.status).toBe(200);
    expect((result.body as { body: string }).body.length).toBeGreaterThan(0);
  });

  it("exports a deterministic PDF (base64, %PDF- header, byte-stable across runs)", async () => {
    const a = await exportWith("pdf");
    const b = await exportWith("pdf");
    expect(a.status).toBe(200);
    const ba = a.body as { encoding: string; body: string; contentType: string };
    expect(ba.encoding).toBe("base64");
    expect(ba.contentType).toBe("application/pdf");
    expect(Buffer.from(ba.body, "base64").subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect((b.body as { body: string }).body).toBe(ba.body);
  });

  it("exports a deterministic ZIP bundle (base64, PK header, byte-stable across runs)", async () => {
    const a = await exportWith("zip-bundle");
    const b = await exportWith("zip-bundle");
    expect(a.status).toBe(200);
    const ba = a.body as { encoding: string; body: string; contentType: string };
    expect(ba.encoding).toBe("base64");
    expect(ba.contentType).toBe("application/zip");
    const bytes = Buffer.from(ba.body, "base64");
    expect(bytes[0]).toBe(0x50); // 'P'
    expect(bytes[1]).toBe(0x4b); // 'K'
    expect((b.body as { body: string }).body).toBe(ba.body);
  });

  it("Quality Center dry-run returns a redaction-safe preview (after approval)", async () => {
    approveSeeded();
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "quality-center", dryRun: true })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const body = result.body as { dryRun: boolean; candidateCount: number; preview: string };
    expect(body.dryRun).toBe(true);
    expect(body.candidateCount).toBe(1);
    // The preview must carry the Quality Center serializer's own output, not an empty or
    // wrong-adapter body — pins the preview content so an empty/truncated preview regresses RED.
    expect(body.preview).toContain("Quality Center Export Preview");
    expect(body.preview).toContain("QC-0001");
  });

  it("Quality Center dry-run returns 409 QI_NOTHING_TO_EXPORT when no candidate is approved (TMS forces approvedOnly)", async () => {
    // No approveSeeded() — the seeded candidate stays unapproved. A TMS adapter forces approvedOnly,
    // so the dry-run must NOT preview unapproved content; it returns 409 instead of a 200 preview.
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "quality-center", dryRun: true })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_NOTHING_TO_EXPORT");
  });

  it("Quality Center live write is disabled: 403 QI_EXTERNAL_EXPORT_DISABLED (after approval)", async () => {
    approveSeeded();
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "quality-center", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(403);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "QI_EXTERNAL_EXPORT_DISABLED",
    );
  });

  it("ZIP bundle entries are named for the run with contained, traversal-free names", async () => {
    const result = await exportWith("zip-bundle");
    expect(result.status).toBe(200);
    const body = result.body as { encoding: string; body: string };
    const bytes = Buffer.from(body.body, "base64");
    // Parse central-directory file names from the STORE ZIP.
    const names: string[] = [];
    for (let i = 0; i + 4 <= bytes.length; i++) {
      if (bytes.readUInt32LE(i) !== 0x02014b50) continue;
      const nameLen = bytes.readUInt16LE(i + 28);
      const extraLen = bytes.readUInt16LE(i + 30);
      const commentLen = bytes.readUInt16LE(i + 32);
      names.push(bytes.toString("utf8", i + 46, i + 46 + nameLen));
      i += 46 + nameLen + extraLen + commentLen - 1;
    }
    expect(names).toEqual([`${RUN_ID}.csv`, `${RUN_ID}.md`, `${RUN_ID}.txt`]);
    for (const name of names) {
      expect(name).not.toContain("/");
      expect(name).not.toContain("\\");
      expect(name).not.toContain("..");
    }
  });
});

// ─── Request-body size cap (Issue #721 — size caps enforced) ─────────────────────

describe("handleQiExport — request body size cap", () => {
  it("returns 413 QI_BODY_TOO_LARGE for a body exceeding 16KB", async () => {
    const huge = JSON.stringify({ adapter: "csv", pad: "x".repeat(17 * 1024) });
    const result = asResult(await handleQiExport(ctx(RUN_ID, makeRawReq(huge)), deps(evidenceDir)));
    expect(result.status).toBe(413);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BODY_TOO_LARGE");
  });
});

// ─── Edit → export composition (Epic #712 AC3: export reflects the curated text) ─────────

describe("handleQiExport — reflects an inline candidate edit", () => {
  it("exports the human-edited title, not the originally-generated one (markdown)", async () => {
    const edit = applyQualityIntelligenceCandidateEdit({
      runId: RUN_ID,
      candidateId: "cand-001",
      editedFields: { title: "Curated login title", steps: ["Open app", "Authenticate"] },
      provenance: { editedAt: "2026-06-09T11:00:00.000Z", editedBy: "human", editorLabel: "Alice" },
      evidenceDir,
      redact: (v: unknown): unknown => v,
    });
    expect(edit.ok).toBe(true);
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "markdown", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const body = (result.body as { body: string }).body;
    expect(body).toContain("Curated login title");
    expect(body).toContain("Authenticate");
    expect(body).not.toContain("User can log in with valid credentials");
  });
});

// ─── Issue #283 AC4 — export evidence emission ───────────────────────────────────────

describe("handleQiExport — emits export evidence (Issue #283, AC4)", () => {
  const exportAdapter = async (
    adapter: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter, dryRun: false, ...extra })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
  };

  const exportsOf = (): QualityIntelligenceEvidenceManifest["exports"] => {
    const manifest = loadQualityIntelligenceRun(RUN_ID, { evidenceDir });
    if (manifest === undefined) throw new Error("run manifest missing");
    return manifest.exports;
  };

  const approveSeeded = (): void => {
    applyReviewDecision({
      runId: RUN_ID,
      evidenceDir,
      action: "approve",
      scope: "candidate",
      candidateId: "cand-001",
      reviewerLabel: "tester",
      now: "2026-06-01T12:00:00.000Z",
      redact: (v: unknown): unknown => v,
    });
  };

  it("records a row for a materialised local export (csv): target + attestation + dryRun=false", async () => {
    await exportAdapter("csv");
    const rows = exportsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetAdapter).toBe("csv");
    expect(rows[0]?.redactionAttested).toBe(true);
    expect(rows[0]?.dryRun ?? false).toBe(false);
    expect(rows[0]?.integrityHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps totals.exports in lockstep and the manifest re-loads (integrity holds)", async () => {
    await exportAdapter("csv");
    const manifest = loadQualityIntelligenceRun(RUN_ID, { evidenceDir });
    expect(manifest?.totals.exports).toBe(1);
    expect(manifest?.exports.length).toBe(1);
    // A second load must not throw — the recomputed exports hash + totals invariant survive a round-trip.
    expect(() => loadQualityIntelligenceRun(RUN_ID, { evidenceDir })).not.toThrow();
  });

  it("deduplicates a repeated identical export (csv twice → one row)", async () => {
    await exportAdapter("csv");
    await exportAdapter("csv");
    expect(exportsOf()).toHaveLength(1);
  });

  it("records distinct rows for distinct adapters (csv then json → two rows)", async () => {
    await exportAdapter("csv");
    await exportAdapter("json");
    expect(
      exportsOf()
        .map((r) => r.targetAdapter)
        .sort(),
    ).toEqual(["csv", "json"]);
  });

  it("records a binary export target faithfully (pdf)", async () => {
    await exportAdapter("pdf");
    const rows = exportsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetAdapter).toBe("pdf");
    expect(rows[0]?.dryRun ?? false).toBe(false);
  });

  it("records a TMS dry-run preview with dryRun=true (jira-issues, approved)", async () => {
    approveSeeded();
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "jira-issues", dryRun: true })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const rows = exportsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetAdapter).toBe("jira-issues");
    expect(rows[0]?.dryRun).toBe(true);
  });

  it("records a TMS dry-run preview with dryRun=true (quality-center, approved)", async () => {
    approveSeeded();
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "quality-center", dryRun: true })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const rows = exportsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetAdapter).toBe("quality-center");
    expect(rows[0]?.dryRun).toBe(true);
    expect(rows[0]?.redactionAttested).toBe(true);
  });

  it("records NO row for a disabled external TMS write (jira-issues live → 403)", async () => {
    approveSeeded();
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "jira-issues", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(403);
    expect(exportsOf()).toHaveLength(0);
  });

  it("records a dry-run AND a materialised row as distinct (csv dry-run then csv download)", async () => {
    asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "csv", dryRun: true })),
        deps(evidenceDir),
      ),
    );
    await exportAdapter("csv");
    const rows = exportsOf();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dryRun ?? false).sort()).toEqual([false, true]);
  });
});

// ─── Issue #283 AC4 — audit-evidence append is fail-open ──────────────────────────────
//
// A failed audit-evidence write must NOT turn a successful local export into a 500: the artifact has
// no external side effect and the run already exists on disk (recordExportEvidence, exportRoutes.ts
// :160-176). We provoke a write failure by making the qi/ directory read-only — the atomic manifest
// re-persist cannot create its temp file — and assert the export still returns 200 with its body
// intact. Without the fail-open swallow the append error would reach the handler's outer catch and
// yield 500 QI_EXPORT_FAILED (verifier Gap 1).

describe("handleQiExport — AC4 audit write is fail-open", () => {
  it("returns 200 with the export body when the audit-evidence append fails", async () => {
    if (platform() === "win32") return; // POSIX permission bits only
    const qiDir = join(evidenceDir, "qi");
    chmodSync(qiDir, 0o555); // read + traverse, but no new files → atomic manifest write fails
    try {
      const result = asResult(
        await handleQiExport(
          ctx(RUN_ID, makeReq({ adapter: "csv", dryRun: false })),
          deps(evidenceDir),
        ),
      );
      // Fail-open contract: the export succeeds despite the swallowed audit-write error.
      expect(result.status).toBe(200);
      expect((result.body as { body: string }).body.length).toBeGreaterThan(0);

      // When the chmod actually blocked the write (i.e. not running as root) no audit row was
      // recorded — the error was swallowed, not surfaced. Under root, chmod is a no-op and the row
      // is written; the 200 + body assertions above (the invariant under test) still hold.
      if (process.getuid?.() !== 0) {
        const manifest = loadQualityIntelligenceRun(RUN_ID, { evidenceDir });
        expect(manifest?.exports).toHaveLength(0);
      }
    } finally {
      chmodSync(qiDir, 0o755); // restore so afterEach cleanup can remove the dir
    }
  });
});

// ─── Issue #283 L1 + m3 — formula escape is explicit and whitespace-robust ────────────

describe("handleQiExport — spreadsheet formula escape is explicit and whitespace-robust", () => {
  const exportInjectedTitle = async (title: string): Promise<string> => {
    const injDir = mkdtempSync(join(tmpdir(), "keiko-export-inj2-"));
    try {
      recordQualityIntelligenceRun(runRecordInput("run-inj2"), { evidenceDir: injDir });
      recordQualityIntelligenceCandidates({
        runId: "run-inj2",
        generatedAt: "2026-06-01T10:01:00.000Z",
        candidates: [makeCandidate(title, "cand-inj2")],
        evidenceDir: injDir,
        redact: (v: unknown): unknown => v,
      });
      const result = asResult(
        await handleQiExport(
          ctx("run-inj2", makeReq({ adapter: "spreadsheet-safe-csv", dryRun: false })),
          deps(injDir),
        ),
      );
      expect(result.status).toBe(200);
      return (result.body as { body: string }).body;
    } finally {
      rmSync(injDir, { recursive: true, force: true });
    }
  };

  it("prefixes a leading formula char with an explicit apostrophe (not just removing the bare char)", async () => {
    const body = await exportInjectedTitle("=SUM(A1:B1)");
    expect(body).toContain("'=SUM(A1:B1)");
  });

  it("guards a formula hidden behind leading whitespace (' =1+1' bypass)", async () => {
    const body = await exportInjectedTitle(" =1+1");
    expect(body).toContain("' =1+1");
  });
});

// ─── Issue #724 GROUP A — AC sweep: all multi-format adapters return 200; QC live → 403 ────────
//
// Mirrors the Issue #724 AC verbatim: "export a real run as CSV / PDF / Markdown / Text / ZIP;
// attempt a Quality Center write → 403". A single it.each sweeps all five local/binary adapters.
// Kills: any format dropped from the route ADAPTERS allowlist or the serialise DISPATCH table.

describe("handleQiExport — Issue #724 AC sweep (multi-format + QC live gate)", () => {
  it.each(["csv", "markdown", "plain-text", "pdf", "zip-bundle"])(
    "adapter '%s' returns 200 through the route (AC sweep)",
    async (adapter) => {
      // Mutant killed: if any adapter is dropped from ADAPTERS or the serialise path, status !== 200.
      const result = asResult(
        await handleQiExport(ctx(RUN_ID, makeReq({ adapter, dryRun: false })), deps(evidenceDir)),
      );
      expect(result.status).toBe(200);
    },
  );

  it("Quality Center live write returns 403 QI_EXTERNAL_EXPORT_DISABLED (AC: QC arm)", async () => {
    // Approve the seeded candidate so the approvedOnly filter passes — the 403 is the TMS live gate,
    // not the empty-selection 409. This is the QC arm of the AC sweep, co-located so the Issue AC
    // reads as one block. Kills: removing the isTms && !dryRun guard from serialiseExport.
    applyReviewDecision({
      runId: RUN_ID,
      evidenceDir,
      action: "approve",
      scope: "candidate",
      candidateId: "cand-001",
      reviewerLabel: "tester",
      now: "2026-06-01T12:00:00.000Z",
      redact: (v: unknown): unknown => v,
    });
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "quality-center", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(403);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "QI_EXTERNAL_EXPORT_DISABLED",
    );
  });
});

// ─── Issue #724 GROUP B — ZIP entry CONTENT validation ───────────────────────────────────────
//
// The existing ZIP test (line 696) verifies entry NAMES only. These tests additionally verify
// that the RIGHT serializer body lands under the RIGHT entry name, by parsing the local-header
// structure and decoding the raw data bytes. A mutant that swaps serializer bodies under entry
// names is invisible to the names-only test; these assertions catch it (RED).
//
// ZIP STORE (no-compression) local-header layout (RFC 1950 / PKZIP spec):
//   offset +0:  4 bytes — local file header signature 0x04034b50
//   offset +26: 2 bytes — file name length
//   offset +28: 2 bytes — extra field length
//   offset +30+nameLen+extraLen: data (compressedSize bytes)
//
// Central-directory entries are scanned first to get per-entry (nameLen, compressedSize, localOffset).

describe("handleQiExport — Issue #724 GROUP B — ZIP entry CONTENT validation", () => {
  interface ZipEntry {
    name: string;
    size: number;
    localOffset: number;
  }

  /** Parse (name, compressedSize, localHeaderOffset) triples from a STORE ZIP's central directory. */
  function parseCentralDirectory(bytes: Buffer): ZipEntry[] {
    const entries: ZipEntry[] = [];
    for (let i = 0; i + 4 <= bytes.length; i++) {
      if (bytes.readUInt32LE(i) !== 0x02014b50) continue; // central-directory signature
      const compressedSize = bytes.readUInt32LE(i + 20);
      const nameLen = bytes.readUInt16LE(i + 28);
      const extraLen = bytes.readUInt16LE(i + 30);
      const commentLen = bytes.readUInt16LE(i + 32);
      const localOffset = bytes.readUInt32LE(i + 42);
      const name = bytes.toString("utf8", i + 46, i + 46 + nameLen);
      entries.push({ name, size: compressedSize, localOffset });
      i += 46 + nameLen + extraLen + commentLen - 1;
    }
    return entries;
  }

  /** Follow the local-header pointer and slice the raw (uncompressed STORE) data bytes. */
  function extractEntryData(bytes: Buffer, localOffset: number, size: number): Buffer {
    // local header: sig(4)+ver(2)+flags(2)+method(2)+time(2)+date(2)+crc(4)+compSize(4)+uncompSize(4)
    //               +nameLen(2)+extraLen(2) = 30 bytes fixed, then nameLen+extraLen bytes before data
    const localSig = bytes.readUInt32LE(localOffset);
    if (localSig !== 0x04034b50) throw new Error(`bad local header sig at ${String(localOffset)}`);
    const nameLen = bytes.readUInt16LE(localOffset + 26);
    const extraLen = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + nameLen + extraLen;
    return bytes.subarray(dataStart, dataStart + size);
  }

  /** Require an entry by name; throws (RED) if absent — replaces find + non-null-assertion. */
  function requireEntry(entries: ZipEntry[], entryName: string): ZipEntry {
    const found = entries.find((e) => e.name === entryName);
    if (found === undefined) throw new Error(`ZIP entry not found: ${entryName}`);
    return found;
  }

  it("ZIP entry run-export-001.csv contains the CSV header row 'CandidateId,'", async () => {
    // Mutant killed: a route mutant that puts wrong serializer bytes under .csv → header absent → RED.
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "zip-bundle", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const bytes = Buffer.from((result.body as { body: string }).body, "base64");
    const entries = parseCentralDirectory(bytes);
    const csvEntry = requireEntry(entries, `${RUN_ID}.csv`);
    const csvData = extractEntryData(bytes, csvEntry.localOffset, csvEntry.size);
    expect(csvData.toString("utf8")).toContain("CandidateId,");
  });

  it("ZIP entry run-export-001.md contains a markdown candidate section ('## ')", async () => {
    // Mutant killed: wrong serializer body under .md (e.g. plain-text bytes) has no '## ' → RED.
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "zip-bundle", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const bytes = Buffer.from((result.body as { body: string }).body, "base64");
    const entries = parseCentralDirectory(bytes);
    const mdEntry = requireEntry(entries, `${RUN_ID}.md`);
    const mdData = extractEntryData(bytes, mdEntry.localOffset, mdEntry.size);
    expect(mdData.toString("utf8")).toContain("## ");
  });

  it("ZIP entry run-export-001.txt contains a plain-text '===...' divider (60× '=')", async () => {
    // Mutant killed: wrong serializer body under .txt (e.g. csv bytes) has no '===' run → RED.
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "zip-bundle", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const bytes = Buffer.from((result.body as { body: string }).body, "base64");
    const entries = parseCentralDirectory(bytes);
    const txtEntry = requireEntry(entries, `${RUN_ID}.txt`);
    const txtData = extractEntryData(bytes, txtEntry.localOffset, txtEntry.size);
    // The plain-text adapter opens with RULE = "=".repeat(60) — a 60-char run of '='.
    expect(txtData.toString("utf8")).toContain("=".repeat(60));
  });
});

// ─── Issue #724 GROUP C — Route-level zip-slip negative (Security finding #2) ───────────────
//
// Drives traversal-shaped runIds through handleQiExport with zip-bundle and asserts the route
// returns NOT 200. The store calls assertValidRunId(runId) which rejects '/', '%', ' ', and
// leading '.'; the thrown InvalidRunIdError is caught by the outer try/catch → 500
// QI_EXPORT_FAILED. The key invariant: a traversal-shaped id NEVER yields a successful ZIP.
// Kills: weakening assertValidRunId to accept separator characters → route returns 200 with a
// ZIP that could contain a traversal entry name.

describe("handleQiExport — Issue #724 GROUP C — zip-slip traversal runId guard", () => {
  it.each([
    ["../../etc/passwd", "slash and dot-dot"],
    ["a%2e%2e", "percent-encoded dot-dot"],
    ["a b", "space (NUL-class disallowed char)"],
  ])(
    "runId '%s' (%s) is rejected — route returns non-200, no traversal ZIP produced",
    async (badId) => {
      // assertValidRunId rejects these in the store layer; the outer catch → 500 QI_EXPORT_FAILED.
      // The invariant under test: a traversal runId NEVER yields a 200 ZIP at the route boundary.
      const result = asResult(
        await handleQiExport(
          ctx(badId, makeReq({ adapter: "zip-bundle", dryRun: false })),
          deps(evidenceDir),
        ),
      );
      expect(result.status).not.toBe(200);
    },
  );
});

// ─── Issue #724 GROUP D — Evidence targetAdapter per remaining format ─────────────────────────
//
// After a successful export, asserts the recorded evidence row's targetAdapter equals the
// requested format for markdown, plain-text, and zip-bundle. The existing tests (lines 793-865)
// already pin csv, pdf, jira-issues, and quality-center. These fill the Explorer Gap #5.
// Kills: a mutant recording a hardcoded adapter label (e.g. always "csv") → RED for others.

describe("handleQiExport — Issue #724 GROUP D — evidence targetAdapter for remaining formats", () => {
  const exportAdapter = async (
    adapter: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter, dryRun: false, ...extra })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
  };

  const exportsOf = (): QualityIntelligenceEvidenceManifest["exports"] => {
    const manifest = loadQualityIntelligenceRun(RUN_ID, { evidenceDir });
    if (manifest === undefined) throw new Error("run manifest missing");
    return manifest.exports;
  };

  it("records targetAdapter='markdown' in the evidence row after a markdown export", async () => {
    await exportAdapter("markdown");
    const rows = exportsOf();
    expect(rows).toHaveLength(1);
    // Mutant killed: if buildExportEvidenceRow hardcodes adapter label → wrong value → RED.
    expect(rows[0]?.targetAdapter).toBe("markdown");
    expect(rows[0]?.dryRun ?? false).toBe(false);
  });

  it("records targetAdapter='plain-text' in the evidence row after a plain-text export", async () => {
    await exportAdapter("plain-text");
    const rows = exportsOf();
    expect(rows).toHaveLength(1);
    // Mutant killed: wrong adapter label in evidence row → assertion fails → RED.
    expect(rows[0]?.targetAdapter).toBe("plain-text");
    expect(rows[0]?.dryRun ?? false).toBe(false);
  });

  it("records targetAdapter='zip-bundle' in the evidence row after a zip-bundle export", async () => {
    await exportAdapter("zip-bundle");
    const rows = exportsOf();
    expect(rows).toHaveLength(1);
    // Mutant killed: if binaryResponse hardcodes mode label in buildExportEvidenceRow → RED.
    expect(rows[0]?.targetAdapter).toBe("zip-bundle");
    expect(rows[0]?.dryRun ?? false).toBe(false);
  });
});

// ─── Issue #724 GROUP E — Binary dryRun characterization (ADR-0023 design pin) ─────────────
//
// Pins CURRENT behavior: binary formats (pdf, zip-bundle) IGNORE the dryRun flag and always
// return the full binary artifact (dryRun: false in the response envelope, encoding: 'base64').
// This is intentional per ADR-0023 — binary has no meaningful "preview" mode; returning the full
// artifact is the only useful response.
//
// A future silent change (e.g. binary formats start honouring dryRun: true by returning a truncated
// base64 body or dryRun: true in the envelope) would turn these assertions RED, forcing a deliberate
// decision rather than an accidental behavior change.

describe("handleQiExport — Issue #724 GROUP E — binary dryRun characterization (ADR-0023 pin)", () => {
  it("pdf with dryRun:true still returns 200, encoding:'base64', and dryRun:false in envelope", async () => {
    // Design pin: binary formats ignore dryRun — no preview mode exists for binary per ADR-0023.
    // Changing binaryResponse to honour dryRun:true silently would turn this RED.
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "pdf", dryRun: true })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const body = result.body as { encoding: string; dryRun: boolean; body: string };
    expect(body.encoding).toBe("base64");
    // dryRun in the response envelope must be false: the full artifact was returned, not a preview.
    expect(body.dryRun).toBe(false);
    // Sanity: the artifact is a real PDF, not an empty/truncated body.
    expect(Buffer.from(body.body, "base64").subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("zip-bundle with dryRun:true still returns 200, encoding:'base64', and dryRun:false in envelope", async () => {
    // Design pin: binary formats ignore dryRun — no preview mode exists for binary per ADR-0023.
    // Changing binaryResponse to honour dryRun:true silently would turn this RED.
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "zip-bundle", dryRun: true })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const body = result.body as { encoding: string; dryRun: boolean; body: string };
    expect(body.encoding).toBe("base64");
    // dryRun in the response envelope must be false: the full artifact was returned, not a preview.
    expect(body.dryRun).toBe(false);
    // Sanity: the artifact starts with the PK ZIP magic bytes.
    const bytes = Buffer.from(body.body, "base64");
    expect(bytes[0]).toBe(0x50); // 'P'
    expect(bytes[1]).toBe(0x4b); // 'K'
  });
});

// ─── Issue #724 GROUP F — TMS gate ordering: unapproved TMS live export → 409 beats 403 ──────
//
// Without approveSeeded (candidate stays 'proposed'), a live TMS export must return 409
// QI_NOTHING_TO_EXPORT — not 403 QI_EXTERNAL_EXPORT_DISABLED. The ordering in serialiseExport is:
//   1. isTms → forces approvedOnly=true
//   2. selectRows → empty (no approved candidates)
//   3. rows.length === 0 → 409 (BEFORE the isTms && !dryRun → 403 check)
// This pins the 409-beats-403 ordering: if the guard order were swapped, an unapproved-but-live
// TMS request would return 403 instead, which is the wrong signal (implies a credentials problem
// rather than a missing approval). Kills: swapping the guard order in serialiseExport → RED.

describe("handleQiExport — Issue #724 GROUP F — TMS unapproved live export: 409 beats 403", () => {
  it("jira-issues with dryRun:false and no approved candidates returns 409 QI_NOTHING_TO_EXPORT (not 403)", async () => {
    // No approveSeeded() — seeded candidate stays 'proposed'. TMS forces approvedOnly → selectRows
    // returns [] → 409 fires at rows.length===0, BEFORE the isTms && !dryRun → 403 check.
    // If the guard order were swapped, this would return 403 instead → test goes RED.
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "jira-issues", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_NOTHING_TO_EXPORT");
  });

  it("quality-center with dryRun:false and no approved candidates also returns 409 (not 403)", async () => {
    // Same ordering invariant for quality-center, which is also a TMS adapter.
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "quality-center", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_NOTHING_TO_EXPORT");
  });
});
