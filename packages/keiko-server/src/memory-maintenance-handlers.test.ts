import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type {
  CodingWorkbenchMode,
  MemoryId,
  MemoryRecord,
  MemoryStatus,
  MemoryUserId,
} from "@oscharko-dev/keiko-contracts";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import {
  handleRunMaintenance,
  isMaintenanceDue,
  maybeRunAutoMaintenance,
  runMemoryMaintenance,
  MEMORY_AUTO_MAINTENANCE_MIN_INTERVAL_MS,
  memoryRetentionPolicy,
  resolveMemoryRetentionPolicy,
  type AutoMaintenanceState,
} from "./memory-maintenance-handlers.js";
import { maybeRunChatAutoMaintenance } from "./chat-handlers.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import type { RouteContext, RouteResult } from "./routes.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
} from "./observability/index.js";

const DAY = 864e5;
const RETENTION_NOW = Date.parse("2026-08-02T08:00:00.000Z");

function makeCtx(correlationId?: string): RouteContext {
  const socket = new Socket();
  return {
    req: {} as RouteContext["req"],
    res: { socket } as unknown as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/memory/maintenance"),
    correlationId,
  };
}

function makeDeps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    ...overrides,
  };
}

// Deps whose EFFECTIVE memory autonomy posture permits unattended acceptance: the operator's
// persisted requested mode is written through the same store the /api/memory/autonomy-policy route
// uses, and the server-owned deployment ceiling is raised to admit it (ADR-0146 D1).
function makeUnattendedDeps(
  vault: MemoryVaultStore,
  mode: CodingWorkbenchMode = "autonomous-delivery",
): UiHandlerDeps {
  const store: UiStore = createInMemoryUiStore();
  store.updateMemoryAutonomyPolicy(mode, 0);
  return makeDeps({ memoryVault: vault, store, codingRuntimeDeploymentCeiling: mode });
}

let activeVaults: MemoryVaultStore[] = [];
let tmpDirs: string[] = [];

beforeEach(() => {
  activeVaults = [];
  tmpDirs = [];
});

afterEach(() => {
  for (const vault of activeVaults) {
    try {
      vault.close();
    } catch {
      // ignore
    }
  }
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeVault(): MemoryVaultStore {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-maintenance-mem-"));
  tmpDirs.push(dir);
  const vault = createMemoryVault({ memoryDir: dir, redactString: (s) => s });
  activeVaults.push(vault);
  return vault;
}

function mid(value: string): MemoryId {
  return value as unknown as MemoryId;
}

interface RecordOptions {
  readonly id: string;
  readonly body?: string;
  readonly type?: MemoryRecord["type"];
  readonly status?: MemoryStatus;
  readonly confidence?: number;
  readonly sensitivity?: MemoryRecord["provenance"]["sensitivity"];
  readonly pinned?: boolean;
  readonly createdAt?: number;
  readonly validUntil?: number;
}

function insert(vault: MemoryVaultStore, options: RecordOptions): MemoryRecord {
  const createdAt = options.createdAt ?? Date.now();
  const record: MemoryRecord = {
    id: mid(options.id),
    schemaVersion: "1",
    scope: { kind: "user", userId: "u-1" as unknown as MemoryUserId },
    type: options.type ?? "preference",
    body: options.body ?? "prefers dark mode",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: createdAt,
      confidence: options.confidence ?? 0.9,
      sensitivity: options.sensitivity ?? "confidential",
    },
    validity:
      options.validUntil === undefined
        ? { validFrom: createdAt }
        : { validFrom: createdAt, validUntil: options.validUntil },
    status: options.status ?? "accepted",
    pinned: options.pinned ?? false,
    tags: [],
    createdAt,
    updatedAt: createdAt,
  };
  return vault.insertMemory(record);
}

function counts(result: RouteResult): Record<string, number> {
  return result.body as Record<string, number>;
}

function uniqueEdgeCount(vault: MemoryVaultStore, ids: readonly MemoryId[]): number {
  const edges = vault.listEdgesForMemories(ids);
  const edgeIds = new Set<string>();
  for (const group of edges.values()) {
    for (const edge of group) {
      edgeIds.add(edge.id);
    }
  }
  return edgeIds.size;
}

describe("handleRunMaintenance", () => {
  it("returns 503 when no vault is configured", () => {
    const result = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: undefined }));
    expect(result.status).toBe(503);
  });

  it("promotes a strong public proposed memory to accepted when the mode permits it", () => {
    const vault = makeVault();
    insert(vault, { id: "m", status: "proposed", sensitivity: "public", confidence: 0.6 });
    const result = handleRunMaintenance(makeCtx(), makeUnattendedDeps(vault));
    expect(result.status).toBe(200);
    expect(counts(result).promoted).toBe(1);
    expect(vault.getMemory(mid("m"))?.status).toBe("accepted");
  });

  it("does NOT mutate confidence when a memory is frequently recalled (O-V2 immutability)", () => {
    const vault = makeVault();
    insert(vault, { id: "m", status: "accepted", confidence: 0.7 });
    vault.recordAccess([mid("m")], Date.now());
    vault.recordAccess([mid("m")], Date.now());
    handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: vault }));
    // Reuse strengthens ranking live, NOT provenance — confidence stays exactly as captured.
    expect(vault.getMemory(mid("m"))?.provenance.confidence).toBe(0.7);
  });

  it("does NOT mutate confidence of an aged, unaccessed memory (O-V2 immutability)", () => {
    const vault = makeVault();
    insert(vault, {
      id: "m",
      status: "conflicted",
      confidence: 0.7,
      createdAt: Date.now() - 60 * DAY,
    });
    handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: vault }));
    // Disuse is reflected by the live strength curve, never by a rewritten (0.6^n) confidence.
    expect(vault.getMemory(mid("m"))?.provenance.confidence).toBe(0.7);
  });

  it("archives a faded accepted memory", () => {
    const vault = makeVault();
    insert(vault, {
      id: "m",
      status: "accepted",
      confidence: 0.25,
      createdAt: Date.now() - 60 * DAY,
    });
    const result = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: vault }));
    expect(counts(result).archived).toBe(1);
    expect(vault.getMemory(mid("m"))?.status).toBe("archived");
  });

  it("does not duplicate auto-applied consolidation edges on repeated maintenance passes", () => {
    const vault = makeVault();
    const now = Date.now();
    insert(vault, { id: "old", body: "use tabs", createdAt: now - DAY });
    insert(vault, { id: "new", body: "use tabs", createdAt: now });

    const first = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: vault }));
    expect(counts(first).edgesCreated).toBe(3);
    expect(uniqueEdgeCount(vault, [mid("old"), mid("new")])).toBe(3);

    const second = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: vault }));
    expect(counts(second).edgesCreated).toBe(0);
    expect(uniqueEdgeCount(vault, [mid("old"), mid("new")])).toBe(3);
  });

  it("forgets an expired non-accepted, non-archived memory and writes a tombstone", () => {
    const vault = makeVault();
    insert(vault, {
      id: "m",
      status: "proposed",
      confidence: 0.9,
      createdAt: Date.now() - DAY,
      validUntil: Date.now() - 1,
    });
    const result = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: vault }));
    expect(counts(result).forgotten).toBe(1);
    expect(vault.getMemory(mid("m"))).toBeUndefined();
    expect(
      vault.listTombstonesByScope({ kind: "user", userId: "u-1" as unknown as MemoryUserId }),
    ).toHaveLength(1);
  });

  it("does not hard-delete expired archived memories during retention", () => {
    const vault = makeVault();
    insert(vault, {
      id: "m",
      status: "archived",
      confidence: 0.1,
      createdAt: Date.now() - 60 * DAY,
      validUntil: Date.now() - 1,
    });
    const result = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: vault }));
    expect(counts(result).forgotten).toBe(0);
    expect(vault.getMemory(mid("m"))?.status).toBe("archived");
    expect(
      vault.listTombstonesByScope({ kind: "user", userId: "u-1" as unknown as MemoryUserId }),
    ).toHaveLength(0);
  });

  it("runs configured age retention and tombstoning inside the bounded maintenance pass", () => {
    const vault = makeVault();
    const now = RETENTION_NOW;
    insert(vault, { id: "old-accepted", status: "accepted", createdAt: now - 40 * DAY });

    const result = runMemoryMaintenance(vault, undefined, {
      nowMs: now,
      retentionPolicy: { maxAgeMs: 30 * DAY },
    });

    expect(result.retentionForgotten).toBe(1);
    expect(result.forgotten).toBe(1);
    expect(vault.getMemory(mid("old-accepted"))).toBeUndefined();
    expect(
      vault.listTombstonesByScope({ kind: "user", userId: "u-1" as unknown as MemoryUserId }),
    ).toHaveLength(1);
  });

  it("builds retention only from explicit operator configuration", () => {
    expect(memoryRetentionPolicy({})).toBeUndefined();
    expect(
      memoryRetentionPolicy({
        KEIKO_MEMORY_RETENTION_MAX_AGE_DAYS: "30",
        KEIKO_MEMORY_RETENTION_MAX_RECORDS_PER_SCOPE: "5000",
        KEIKO_MEMORY_RETENTION_EXPIRE_PROPOSALS_AFTER_DAYS: "14",
        KEIKO_MEMORY_RETENTION_PURGE_FORGOTTEN_AFTER_DAYS: "365",
      }),
    ).toEqual({
      maxAgeMs: 30 * DAY,
      maxRecordsPerScope: 5000,
      expireProposalsAfterMs: 14 * DAY,
      purgeForgottenAfterMs: 365 * DAY,
    });
  });

  it.each(["0", "-1", "1.5", "not-a-number", "9007199254740992"])(
    "rejects invalid retention configuration value %s",
    (raw) => {
      expect(() => memoryRetentionPolicy({ KEIKO_MEMORY_RETENTION_MAX_AGE_DAYS: raw })).toThrow(
        TypeError,
      );
    },
  );

  it("reports invalid retention configuration without exposing its raw value", () => {
    const diagnostics: ServerDiagnosticRecord[] = [];
    const raw = "customer-secret-invalid-value";
    const policy = resolveMemoryRetentionPolicy(
      makeDeps({
        env: { KEIKO_MEMORY_RETENTION_MAX_AGE_DAYS: raw },
        diagnostics: { record: (record) => diagnostics.push(record) },
      }),
    );

    expect(policy).toEqual({ ok: false });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        operation: "memory.maintenance.retention-policy",
        source: "memory-maintenance-handlers.resolveMemoryRetentionPolicy",
      }),
    );
    expect(JSON.stringify(diagnostics)).not.toContain(raw);
  });

  it("fails an explicit maintenance request when retention configuration is invalid", () => {
    const vault = makeVault();
    const diagnostics: ServerDiagnosticRecord[] = [];
    const raw = "customer-secret-invalid-retention";
    const result = handleRunMaintenance(
      makeCtx(),
      makeDeps({
        memoryVault: vault,
        env: { KEIKO_MEMORY_RETENTION_MAX_AGE_DAYS: raw },
        diagnostics: { record: (record) => diagnostics.push(record) },
      }),
    );

    expect(result).toMatchObject({
      status: 500,
      body: {
        error: {
          code: "MEMORY_RETENTION_CONFIG_INVALID",
        },
      },
    });
    expect(result).toHaveProperty("body.error.correlationId", expect.any(String));
    expect(diagnostics).toHaveLength(1);
    expect(JSON.stringify({ result, diagnostics })).not.toContain(raw);
  });

  it("threads the request's own correlation id into the retention-config-invalid response instead of minting one", () => {
    // ADR-0173 D5 / g12: ctx.correlationId is minted at request entry (server.ts) and is already
    // in scope in handleRunMaintenance — the failure diagnostic and error body must reuse it, not
    // a disconnected randomUUID(). Before the fix handleRunMaintenance discarded ctx entirely
    // (bound as `_ctx`), so the response correlationId never matched ctx.correlationId.
    const vault = makeVault();
    const diagnostics: ServerDiagnosticRecord[] = [];
    const result = handleRunMaintenance(
      makeCtx("req-maintenance-thread-01"),
      makeDeps({
        memoryVault: vault,
        env: { KEIKO_MEMORY_RETENTION_MAX_AGE_DAYS: "not-a-number" },
        diagnostics: { record: (record) => diagnostics.push(record) },
      }),
    );

    expect(result).toMatchObject({
      status: 500,
      body: { error: { correlationId: "req-maintenance-thread-01" } },
    });
    expect(diagnostics[0]?.correlationId).toBe("req-maintenance-thread-01");
  });

  it("threads the request's own correlation id into an autonomy-mode-read failure too, sharing it with the retention read", () => {
    // ADR-0173 D5 / g12: resolveMaintenanceAutonomyMode's own default mint only fires when NO id
    // is threaded in; the route always threads its one correlationId (from ctx or minted once) so
    // an autonomy-mode failure never gets its own disconnected id relative to the SAME call's
    // other diagnostics.
    const diagnostics: ServerDiagnosticRecord[] = [];
    const vault = makeVault();
    const store = createInMemoryUiStore();
    const faultyStore: UiStore = {
      ...store,
      readMemoryAutonomyPolicy: (): never => {
        throw new Error("preference store unavailable");
      },
    };
    handleRunMaintenance(
      makeCtx("req-maintenance-autonomy-thread-01"),
      makeDeps({
        memoryVault: vault,
        store: faultyStore,
        diagnostics: { record: (record) => diagnostics.push(record) },
      }),
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.source).toBe(
      "memory-maintenance-handlers.resolveMaintenanceAutonomyMode",
    );
    expect(diagnostics[0]?.correlationId).toBe("req-maintenance-autonomy-thread-01");
  });

  it("returns a review item instead of auto-superseding a pairwise correction conflict", () => {
    const vault = makeVault();
    const now = Date.now();
    insert(vault, {
      id: "old",
      status: "accepted",
      body: "our primary production database is postgresql for all storage",
      createdAt: now - 2 * DAY,
    });
    insert(vault, {
      id: "new",
      status: "accepted",
      body: "our primary production database is not postgresql for all storage",
      createdAt: now - DAY,
    });
    const result = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: vault }));
    const body = result.body as {
      reviewItems: readonly { reason: string }[];
      superseded: number;
      reviewItemsCreated: number;
    };
    expect(body.superseded).toBe(0);
    expect(body.reviewItemsCreated).toBe(1);
    expect(body.reviewItems[0]?.reason).toBe("potential-conflict");
    expect(vault.getMemory(mid("old"))?.status).toBe("accepted");
    expect(vault.getMemory(mid("new"))?.status).toBe("accepted");
  });

  it("promotes proposed conflicts and surfaces review evidence in a single pass", () => {
    // Regression guard for the promote-before-consolidate ordering: strong public proposals become
    // accepted and are reviewed for conflicts in the same maintenance pass.
    const vault = makeVault();
    const now = Date.now();
    insert(vault, {
      id: "old",
      status: "proposed",
      sensitivity: "public",
      confidence: 0.6,
      body: "our primary production database is postgresql for all storage",
      createdAt: now - 2 * DAY,
    });
    insert(vault, {
      id: "new",
      status: "proposed",
      sensitivity: "public",
      confidence: 0.6,
      body: "our primary production database is not postgresql for all storage",
      createdAt: now - DAY,
    });
    const result = handleRunMaintenance(makeCtx(), makeUnattendedDeps(vault));
    expect(counts(result).promoted).toBe(2);
    const body = result.body as {
      reviewItems: readonly { reason: string }[];
      superseded: number;
      reviewItemsCreated: number;
    };
    expect(body.superseded).toBe(0);
    expect(body.reviewItemsCreated).toBe(1);
    expect(body.reviewItems[0]?.reason).toBe("potential-conflict");
    expect(vault.getMemory(mid("old"))?.status).toBe("accepted");
    expect(vault.getMemory(mid("new"))?.status).toBe("accepted");
  });

  it("surfaces review for non-promoted proposed and conflicted records", () => {
    const vault = makeVault();
    const now = Date.now();
    insert(vault, {
      id: "conflicted",
      status: "conflicted",
      body: "deployment window is friday morning",
      createdAt: now - DAY,
    });
    insert(vault, {
      id: "proposed",
      status: "proposed",
      sensitivity: "confidential",
      body: "deployment window is friday morning",
      createdAt: now,
    });
    const result = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: vault }));
    const body = result.body as {
      reviewItems: readonly { reason: string }[];
      reviewItemsCreated: number;
      promoted: number;
    };
    expect(body.promoted).toBe(0);
    expect(body.reviewItemsCreated).toBe(1);
    expect(body.reviewItems[0]?.reason).toBe("duplicate-review");
  });

  it("never touches a pinned memory", () => {
    const vault = makeVault();
    insert(vault, {
      id: "m",
      status: "accepted",
      pinned: true,
      confidence: 0.01,
      createdAt: Date.now() - 400 * DAY,
    });
    const result = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: vault }));
    const c = counts(result);
    expect(c.archived).toBe(0);
    expect(c.forgotten).toBe(0);
    expect(vault.getMemory(mid("m"))?.status).toBe("accepted");
    // A pinned record's confidence is also never rewritten.
    expect(vault.getMemory(mid("m"))?.provenance.confidence).toBe(0.01);
  });

  it("returns 500 wrapping a vault fault", () => {
    const vault = makeVault();
    const faulty: MemoryVaultStore = {
      ...vault,
      listMemoriesAcrossScopes: () => {
        throw new Error("disk gone");
      },
    };
    const result = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: faulty }));
    expect(result.status).toBe(500);
  });

  it("does NOT forward a secret-bearing vault fault message into the 500 envelope (COUPLING-004)", () => {
    // A vault fault can carry a filesystem path or, worse, a credential. The 500 response must be a
    // fixed code-keyed string — never the raw error.message.
    const secret = "sk-" + "test0ABC123DEF456GHI789";
    const rawMessage = `open /srv/vault/u-1.db failed: token ${secret} at /etc/keiko/secret.key`;
    const vault = makeVault();
    const faulty: MemoryVaultStore = {
      ...vault,
      listMemoryScopes: () => {
        throw new Error(rawMessage);
      },
    };
    const result = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: faulty }));
    expect(result.status).toBe(500);
    const body = result.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("MEMORY_MAINTENANCE_FAILED");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("/srv/vault");
    expect(serialized).not.toContain("/etc/keiko");
    expect(body.error.message).toBe("Memory maintenance failed.");
  });
});

describe("handleRunMaintenance — consolidation.summary.fallback activity-log wiring (#2902 w6)", () => {
  afterEach(() => {
    resetServerLogger();
  });

  // FAILS BEFORE: runConsolidationPass never set `logSink` on the options handed to
  // `runConsolidation`, so `emitConsolidationLogEvent` no-op'd on every fallback and
  // `consolidation.summary.fallback` never reached `server.log` for a maintenance sweep, unlike
  // the scheduled consolidation-job path. PASSES AFTER: the route's own request correlationId is
  // threaded through as the sink's correlationId, so this sweep's fallback line joins the same
  // request an operator is already looking at.
  it("emits a durable, request-correlated line when the summary generator is absent", () => {
    const vault = makeVault();
    insert(vault, { id: "m-a", body: "x" });
    insert(vault, { id: "m-b", body: "x" });
    insert(vault, { id: "m-c", body: "x" });
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));

    const result = handleRunMaintenance(
      makeCtx("req-consolidation-fallback-1"),
      makeDeps({ memoryVault: vault }),
    );
    expect(result.status).toBe(200);

    expect(sink.events).toContainEqual(
      expect.objectContaining({
        category: "consolidation",
        op: "consolidation.summary.fallback",
        correlationId: "req-consolidation-fallback-1",
        extra: { reason: "absent" },
      }),
    );
  });
});

// ADR-0146 D2: in `governed-assist` ("Ask for approval") a routine, public candidate is held as
// `proposed` for human review. The standing maintenance sweep shares the promotion lever with
// at-capture promotion, so it must consult the SAME autonomy posture — otherwise the sweep silently
// accepts exactly the set the capture gate refused, and the human-control invariant is defeated.
describe("handleRunMaintenance — autonomy-mode gate on promotion (ADR-0146 D2)", () => {
  function seedStrongPublicProposal(vault: MemoryVaultStore): void {
    insert(vault, { id: "m", status: "proposed", sensitivity: "public", confidence: 0.6 });
  }

  it("does NOT promote a strong public proposal in the default governed-assist posture", () => {
    const vault = makeVault();
    seedStrongPublicProposal(vault);
    const result = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: vault }));
    expect(result.status).toBe(200);
    expect(counts(result).promoted).toBe(0);
    expect(vault.getMemory(mid("m"))?.status).toBe("proposed");
  });

  it("does NOT promote when the ceiling is wide but the operator's persisted posture is governed-assist", () => {
    const vault = makeVault();
    seedStrongPublicProposal(vault);
    const store: UiStore = createInMemoryUiStore();
    store.updateMemoryAutonomyPolicy("governed-assist", 0);
    const result = handleRunMaintenance(
      makeCtx(),
      makeDeps({
        memoryVault: vault,
        store,
        codingRuntimeDeploymentCeiling: "autonomous-delivery",
      }),
    );
    expect(counts(result).promoted).toBe(0);
    expect(vault.getMemory(mid("m"))?.status).toBe("proposed");
  });

  it("does NOT promote when the operator requested a wide posture the deployment ceiling denies", () => {
    const vault = makeVault();
    seedStrongPublicProposal(vault);
    const store: UiStore = createInMemoryUiStore();
    store.updateMemoryAutonomyPolicy("autonomous-delivery", 0);
    const result = handleRunMaintenance(
      makeCtx(),
      makeDeps({ memoryVault: vault, store, codingRuntimeDeploymentCeiling: "governed-assist" }),
    );
    expect(counts(result).promoted).toBe(0);
    expect(vault.getMemory(mid("m"))?.status).toBe("proposed");
  });

  it("fails closed to no promotion when the deployment ceiling is malformed", () => {
    const vault = makeVault();
    seedStrongPublicProposal(vault);
    const store: UiStore = createInMemoryUiStore();
    store.updateMemoryAutonomyPolicy("autonomous-delivery", 0);
    const result = handleRunMaintenance(
      makeCtx(),
      makeDeps({
        memoryVault: vault,
        store,
        codingRuntimeDeploymentCeiling: "not-a-mode" as unknown as CodingWorkbenchMode,
      }),
    );
    expect(counts(result).promoted).toBe(0);
    expect(vault.getMemory(mid("m"))?.status).toBe("proposed");
  });

  it("fails closed to no promotion when the persisted posture cannot be read", () => {
    const vault = makeVault();
    seedStrongPublicProposal(vault);
    const store = createInMemoryUiStore();
    const faultyStore: UiStore = {
      ...store,
      readMemoryAutonomyPolicy: () => {
        throw new Error("ui store unavailable");
      },
    };
    const result = handleRunMaintenance(
      makeCtx(),
      makeDeps({
        memoryVault: vault,
        store: faultyStore,
        codingRuntimeDeploymentCeiling: "autonomous-delivery",
      }),
    );
    expect(result.status).toBe(200);
    expect(counts(result).promoted).toBe(0);
    expect(vault.getMemory(mid("m"))?.status).toBe("proposed");
  });

  it("promotes under supervised-coding, so raising the posture never tightens the outcome", () => {
    const vault = makeVault();
    seedStrongPublicProposal(vault);
    const result = handleRunMaintenance(makeCtx(), makeUnattendedDeps(vault, "supervised-coding"));
    expect(counts(result).promoted).toBe(1);
    expect(vault.getMemory(mid("m"))?.status).toBe("accepted");
  });

  it("attributes an unattended promotion to retention, never to the operator's Memory Center", () => {
    // The audit envelope is the only record of WHO accepted a memory. Claiming `memory-center` for
    // an autonomous sweep would attribute an unattended acceptance to a human surface.
    const vault = makeVault();
    seedStrongPublicProposal(vault);
    const ledger = new Map<string, string>();
    const evidenceStore: UiHandlerDeps["evidenceStore"] = {
      put: (runId: string, json: string): string => {
        ledger.set(runId, json);
        return runId;
      },
      get: (runId: string): string | undefined => ledger.get(runId),
      list: (): readonly string[] => [...ledger.keys()],
      delete: (runId: string): void => {
        ledger.delete(runId);
      },
    };
    const base = makeUnattendedDeps(vault);
    const result = handleRunMaintenance(makeCtx(), { ...base, evidenceStore });
    expect(counts(result).promoted).toBe(1);
    const serialized = [...ledger.values()].join("\n");
    expect(serialized).toContain('"initiatorSurface":"retention"');
    expect(serialized).not.toContain("memory-center");
    // Still body-free.
    expect(serialized).not.toContain("prefers dark mode");
  });
});

// A `proposed` record exists solely to be decided by a human. An unattended pass may fade it out of
// retrieval, but it may NOT destroy it: `proposed -> expired` is the contract's documented terminus
// for "capture window elapsed before review" (MEMORY_STATUS_TRANSITIONS), and it keeps the record
// visible in the review queue and recoverable (expired -> accepted / archived / forgotten).
describe("handleRunMaintenance — un-reviewed proposals are expired, never hard-deleted", () => {
  const SCOPE = { kind: "user", userId: "u-1" as unknown as MemoryUserId } as const;

  it("expires a faint aged-out proposal instead of deleting it", () => {
    const vault = makeVault();
    insert(vault, {
      id: "m",
      status: "proposed",
      sensitivity: "public",
      confidence: 0.2,
      createdAt: Date.now() - 400 * DAY,
    });
    const result = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: vault }));
    expect(counts(result).forgotten).toBe(0);
    expect(counts(result).expired).toBe(1);
    expect(vault.getMemory(mid("m"))?.status).toBe("expired");
    expect(vault.getMemory(mid("m"))?.staleReason).toBe("proposed-faint-aged-out");
    expect(vault.listTombstonesByScope(SCOPE)).toHaveLength(0);
  });

  it("is idempotent: a second pass neither re-expires nor deletes the record", () => {
    const vault = makeVault();
    insert(vault, {
      id: "m",
      status: "proposed",
      sensitivity: "public",
      confidence: 0.2,
      createdAt: Date.now() - 400 * DAY,
    });
    handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: vault }));
    const second = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: vault }));
    expect(counts(second).expired).toBe(0);
    expect(counts(second).forgotten).toBe(0);
    expect(vault.getMemory(mid("m"))?.status).toBe("expired");
    expect(vault.listTombstonesByScope(SCOPE)).toHaveLength(0);
  });

  it("still hard-deletes a record whose explicit validity window elapsed", () => {
    // The validity-expired branch is an author-declared end date, not an un-answered review item.
    const vault = makeVault();
    insert(vault, {
      id: "m",
      status: "proposed",
      confidence: 0.9,
      createdAt: Date.now() - DAY,
      validUntil: Date.now() - 1,
    });
    const result = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: vault }));
    expect(counts(result).forgotten).toBe(1);
    expect(vault.getMemory(mid("m"))).toBeUndefined();
  });
});

const HOUR = 3_600_000;
const NOW = 1_600_000_000_000;

describe("isMaintenanceDue (O-V4)", () => {
  it("is due when maintenance has never run", () => {
    expect(isMaintenanceDue(undefined, NOW)).toBe(true);
  });

  it("is NOT due before the interval elapses", () => {
    expect(isMaintenanceDue(NOW - 5 * HOUR, NOW)).toBe(false);
  });

  it("is due once the interval has elapsed", () => {
    expect(isMaintenanceDue(NOW - 7 * HOUR, NOW)).toBe(true);
    expect(isMaintenanceDue(NOW - MEMORY_AUTO_MAINTENANCE_MIN_INTERVAL_MS, NOW)).toBe(true);
  });

  it("is disabled (never due) for a non-positive or non-finite interval", () => {
    expect(isMaintenanceDue(undefined, NOW, 0)).toBe(false);
    expect(isMaintenanceDue(undefined, NOW, -1)).toBe(false);
    expect(isMaintenanceDue(undefined, NOW, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("maybeRunAutoMaintenance (O-V4)", () => {
  it("does nothing and leaves the cursor untouched when disabled", () => {
    const vault = makeVault();
    const state: AutoMaintenanceState = {};
    expect(
      maybeRunAutoMaintenance(vault, undefined, state, { nowMs: NOW, enabled: false }),
    ).toBeNull();
    expect(state.lastRunAtMs).toBeUndefined();
  });

  it("runs once when due, advances the cursor, then rate-limits until the interval elapses", () => {
    const vault = makeVault();
    // Accepted memories are never hard-deleted by autonomous maintenance.
    insert(vault, { id: "m", status: "accepted", validUntil: NOW - 1, createdAt: NOW - DAY });
    const state: AutoMaintenanceState = {};

    const first = maybeRunAutoMaintenance(vault, undefined, state, { nowMs: NOW, enabled: true });
    expect(first?.forgotten).toBe(0);
    expect(state.lastRunAtMs).toBe(NOW);
    expect(vault.getMemory(mid("m"))).toBeDefined();

    // Second call within the interval is a no-op.
    expect(
      maybeRunAutoMaintenance(vault, undefined, state, { nowMs: NOW + 1000, enabled: true }),
    ).toBeNull();

    // After the interval, it runs again.
    expect(
      maybeRunAutoMaintenance(vault, undefined, state, {
        nowMs: NOW + MEMORY_AUTO_MAINTENANCE_MIN_INTERVAL_MS,
        enabled: true,
      }),
    ).not.toBeNull();
  });

  it("never throws and still advances the cursor when the pass faults", () => {
    const onFailure = vi.fn(() => {
      throw new Error("diagnostic sink unavailable");
    });
    const faulty = {
      ...makeVault(),
      listMemoriesAcrossScopes: () => {
        throw new Error("disk gone");
      },
    } as MemoryVaultStore;
    const state: AutoMaintenanceState = {};
    expect(
      maybeRunAutoMaintenance(faulty, undefined, state, {
        nowMs: NOW,
        enabled: true,
        onFailure,
      }),
    ).toBeNull();
    // Cursor advanced BEFORE running so a persistently-failing pass cannot hot-loop.
    expect(state.lastRunAtMs).toBe(NOW);
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("emits a content-free server diagnostic for a failed chat-triggered pass", () => {
    const diagnostics: ServerDiagnosticRecord[] = [];
    const faulty = {
      ...makeVault(),
      listMemoriesAcrossScopes: () => {
        throw new Error("disk path and customer content must stay private");
      },
    } as MemoryVaultStore;

    maybeRunChatAutoMaintenance(
      makeDeps({ diagnostics: { record: (record) => diagnostics.push(record) } }),
      faulty,
      {},
      NOW,
    );

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        operation: "chat.memory.auto-maintenance",
        source: "chat.memory.maintenance",
        message: "chat-memory-auto-maintenance-failed",
      }),
    );
    expect(JSON.stringify(diagnostics)).not.toContain("customer content");
  });

  it("mints ONE correlation id shared by every diagnostic of a single auto-maintenance pass, not one per failure point", () => {
    // ADR-0173 D5 / g12: before the fix, resolveMemoryRetentionPolicy's own catch and this
    // function's onFailure catch each minted a disconnected randomUUID() — an operator could not
    // tell two diagnostics from the SAME opportunistic pass apart from two diagnostics from two
    // different passes. A malformed retention env (read at pass start) AND a vault fault (surfaced
    // through onFailure) now both report under the SAME id.
    const diagnostics: ServerDiagnosticRecord[] = [];
    const faulty = {
      ...makeVault(),
      listMemoriesAcrossScopes: () => {
        throw new Error("disk gone");
      },
    } as MemoryVaultStore;

    maybeRunChatAutoMaintenance(
      makeDeps({
        env: { KEIKO_MEMORY_RETENTION_MAX_AGE_DAYS: "not-a-number" },
        diagnostics: { record: (record) => diagnostics.push(record) },
      }),
      faulty,
      {},
      NOW,
    );

    const sources = diagnostics.map((record) => record.source);
    expect(sources).toContain("memory-maintenance-handlers.resolveMemoryRetentionPolicy");
    expect(sources).toContain("chat.memory.maintenance");
    const ids = new Set(diagnostics.map((record) => record.correlationId));
    expect(ids.size).toBe(1);
  });

  it("promotes nothing when no autonomy mode is supplied (fail closed to governed-assist)", () => {
    const vault = makeVault();
    insert(vault, {
      id: "m",
      status: "proposed",
      sensitivity: "public",
      confidence: 0.6,
      createdAt: NOW,
    });
    const result = maybeRunAutoMaintenance(vault, undefined, {}, { nowMs: NOW, enabled: true });
    expect(result?.promoted).toBe(0);
    expect(vault.getMemory(mid("m"))?.status).toBe("proposed");
  });

  it("promotes only when the caller hands it a posture that permits unattended acceptance", () => {
    const vault = makeVault();
    insert(vault, {
      id: "m",
      status: "proposed",
      sensitivity: "public",
      confidence: 0.6,
      createdAt: NOW,
    });
    const result = maybeRunAutoMaintenance(
      vault,
      undefined,
      {},
      {
        nowMs: NOW,
        enabled: true,
        autonomyMode: "autonomous-delivery",
      },
    );
    expect(result?.promoted).toBe(1);
    expect(vault.getMemory(mid("m"))?.status).toBe("accepted");
  });
});

describe("runMemoryMaintenance — injected clock (O-V4 determinism)", () => {
  it("uses the injected nowMs (not the wall clock) for expiry decisions", () => {
    const vault = makeVault();
    // 'future' expires AFTER the injected now but BEFORE the real 2026 wall clock — so a real
    // Date.now() would forget it, while the injected clock must keep it.
    insert(vault, {
      id: "future",
      status: "conflicted",
      validUntil: 1_700_000_000_000,
      createdAt: 1_500_000_000_000,
    });
    insert(vault, {
      id: "expired",
      status: "conflicted",
      validUntil: 1_500_000_000_001,
      createdAt: 1_500_000_000_000,
    });
    const result = runMemoryMaintenance(vault, undefined, { nowMs: NOW });
    expect(result.forgotten).toBe(1);
    expect(vault.getMemory(mid("expired"))).toBeUndefined();
    // Survives because validUntil (1.7e12) is still in the future relative to the injected now.
    expect(vault.getMemory(mid("future"))).toBeDefined();
  });
});

describe("handleRunMaintenance — type-aware decay (semanticization, env-gated)", () => {
  const DECAY_DAYS = 45;

  function seedTwoAgedTypes(vault: MemoryVaultStore): void {
    const createdAt = Date.now() - DECAY_DAYS * DAY;
    // Same confidence, same age, same (no) access — only the memory TYPE differs.
    insert(vault, { id: "ep", type: "episodic", confidence: 0.5, createdAt });
    insert(vault, { id: "se", type: "semantic-fact", confidence: 0.5, createdAt });
  }

  it("keeps both aged types when semanticization is off (default, byte-identical)", () => {
    const vault = makeVault();
    seedTwoAgedTypes(vault);
    const result = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: vault }));
    expect(result.status).toBe(200);
    expect(counts(result).archived).toBe(0);
    expect(vault.getMemory(mid("ep"))?.status).toBe("accepted");
    expect(vault.getMemory(mid("se"))?.status).toBe("accepted");
  });

  it("archives the aged episodic detail but keeps the semantic fact when enabled", () => {
    const vault = makeVault();
    seedTwoAgedTypes(vault);
    const result = handleRunMaintenance(
      makeCtx(),
      makeDeps({ memoryVault: vault, env: { KEIKO_MEMORY_SEMANTICIZATION: "1" } }),
    );
    expect(result.status).toBe(200);
    expect(counts(result).archived).toBe(1);
    expect(vault.getMemory(mid("ep"))?.status).toBe("archived");
    expect(vault.getMemory(mid("se"))?.status).toBe("accepted");
  });
});
