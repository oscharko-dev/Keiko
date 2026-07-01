// Tests for the QI retention-enforcement bootstrap seam (Issue #1323 AC4).
//
// `enforceQiRetentionAtStartup` is the server-owned, best-effort wrapper around keiko-evidence's
// `enforceQualityIntelligenceRetentionPolicy`. It passes the server-owned companion suffixes + the
// figma snapshot side-file root, forwards every deletion receipt's audit event to an injectable
// sink exactly once, and NEVER throws into bootstrap (mirrors migrateLocalConfigCredentials).
//
// We also prove buildUiHandlerDeps runs it once at construction and forwards events to the injected
// sink. Deterministic: injected clock, no network, no keychain.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordQualityIntelligenceRun,
  type QualityIntelligenceEvidenceManifest,
  type QualityIntelligenceRunDeletedEvent,
} from "@oscharko-dev/keiko-evidence";
import {
  enforceQiRetentionAtStartup,
  qiRetentionDeletionAuditLedgerPath,
} from "../retentionEnforcement.js";
import { buildUiHandlerDeps } from "../../deps.js";
import { createInMemoryUiStore } from "../../store/index.js";

const AGE_EXPIRED_AT = "2026-01-01T00:00:00.000Z"; // older than qi:short-30d (30d)
const NOW_FAR_FUTURE = (): number => Date.parse("2026-06-01T00:00:00.000Z");

function recordInput(
  runId: string,
  completedAt: string,
): Parameters<typeof recordQualityIntelligenceRun>[0] {
  return {
    runId,
    planAt: completedAt,
    completedAt,
    status: "succeeded",
    policyProfileIds: ["qi:short-30d"],
    retentionPolicyId: "qi:short-30d",
    modelGatewayCallCount: 0,
    totals: { candidates: 0, findings: 0, exports: 0 },
    findings: [],
    exports: [],
    evidenceRefs: [],
    provenanceRefs: {
      envelopeIds: [],
      auditSummaryId:
        "qi-audit-1323" as QualityIntelligenceEvidenceManifest["provenanceRefs"]["auditSummaryId"],
    },
  };
}

let evidenceDir: string;

beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "keiko-qi-ret-srv-"));
});

afterEach(() => {
  rmSync(evidenceDir, { recursive: true, force: true });
});

const manifestPath = (runId: string): string => join(evidenceDir, "qi", `${runId}.qi.json`);

describe("enforceQiRetentionAtStartup", () => {
  it("purges age-expired runs and forwards one audit event per deletion to the sink", () => {
    recordQualityIntelligenceRun(recordInput("run-expired", AGE_EXPIRED_AT), { evidenceDir });
    const events: QualityIntelligenceRunDeletedEvent[] = [];

    enforceQiRetentionAtStartup({
      evidenceDir,
      now: NOW_FAR_FUTURE,
      auditSink: (event) => {
        events.push(event);
      },
    });

    expect(existsSync(manifestPath("run-expired"))).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("qi:run:deleted");
    expect(events[0]?.runId).toBe("run-expired");
    expect(events[0]?.status).toBe("deleted");
  });

  it("retains runs inside their retention window and forwards no events", () => {
    recordQualityIntelligenceRun(recordInput("run-fresh", "2026-05-31T00:00:00.000Z"), {
      evidenceDir,
    });
    const sink = vi.fn();

    enforceQiRetentionAtStartup({ evidenceDir, now: NOW_FAR_FUTURE, auditSink: sink });

    expect(existsSync(manifestPath("run-fresh"))).toBe(true);
    expect(sink).not.toHaveBeenCalled();
  });

  it("never throws when the evidence dir holds a corrupt manifest (best-effort bootstrap)", () => {
    mkdirSync(join(evidenceDir, "qi"), { recursive: true });
    writeFileSync(manifestPath("run-bad"), "{ not json ");
    const sink = vi.fn();

    expect(() => {
      enforceQiRetentionAtStartup({ evidenceDir, now: NOW_FAR_FUTURE, auditSink: sink });
    }).not.toThrow();
    // The corrupt file is never purged on a load fault, and no audit event is forged.
    expect(existsSync(manifestPath("run-bad"))).toBe(true);
    expect(sink).not.toHaveBeenCalled();
  });

  it("never throws when the evidence dir is unwritable/garbage (swallows boundary errors)", () => {
    // Point at a path whose parent is a file → any fs op throws; the wrapper must absorb it.
    const filePath = join(evidenceDir, "not-a-dir");
    writeFileSync(filePath, "x");
    expect(() => {
      enforceQiRetentionAtStartup({ evidenceDir: join(filePath, "nested"), now: NOW_FAR_FUTURE });
    }).not.toThrow();
  });

  it("defaults the audit sink to a durable JSONL deletion receipt ledger", () => {
    recordQualityIntelligenceRun(recordInput("run-nosink", AGE_EXPIRED_AT), { evidenceDir });
    expect(() => {
      enforceQiRetentionAtStartup({ evidenceDir, now: NOW_FAR_FUTURE });
    }).not.toThrow();
    expect(existsSync(manifestPath("run-nosink"))).toBe(false);
    const lines = readFileSync(qiRetentionDeletionAuditLedgerPath(evidenceDir), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      type: "qi:run:deleted",
      runId: "run-nosink",
      status: "deleted",
    });
  });
});

describe("buildUiHandlerDeps wires QI retention at bootstrap (Issue #1323 AC4)", () => {
  it("runs retention once at construction and forwards deletion events to the injected sink", () => {
    recordQualityIntelligenceRun(recordInput("run-boot-expired", AGE_EXPIRED_AT), { evidenceDir });
    const events: QualityIntelligenceRunDeletedEvent[] = [];
    const store = createInMemoryUiStore();

    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: {},
      store,
      qiRetentionNow: NOW_FAR_FUTURE,
      qiRetentionAuditSink: (event) => {
        events.push(event);
      },
    });

    expect(deps.evidenceDir).toBeDefined();
    expect(existsSync(manifestPath("run-boot-expired"))).toBe(false);
    expect(events.map((e) => e.runId)).toEqual(["run-boot-expired"]);
    expect(events[0]?.status).toBe("deleted");
  }, 15000);

  it("retains an in-window run at bootstrap and forwards no events", () => {
    recordQualityIntelligenceRun(recordInput("run-boot-fresh", "2026-05-31T00:00:00.000Z"), {
      evidenceDir,
    });
    const sink = vi.fn();
    const store = createInMemoryUiStore();

    buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: {},
      store,
      qiRetentionNow: NOW_FAR_FUTURE,
      qiRetentionAuditSink: sink,
    });

    expect(existsSync(manifestPath("run-boot-fresh"))).toBe(true);
    expect(sink).not.toHaveBeenCalled();
  }, 15000);
});
