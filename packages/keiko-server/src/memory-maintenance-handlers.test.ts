import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type {
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
  type AutoMaintenanceState,
} from "./memory-maintenance-handlers.js";
import { createInMemoryUiStore } from "./store/index.js";
import type { RouteContext, RouteResult } from "./routes.js";

const DAY = 864e5;

function makeCtx(): RouteContext {
  const socket = new Socket();
  return {
    req: {} as RouteContext["req"],
    res: { socket } as unknown as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/memory/maintenance"),
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
  const dir = mkdtempSync(join(tmpdir(), "keiko-maintenance-mem-"));
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

  it("promotes a strong public proposed memory to accepted", () => {
    const vault = makeVault();
    insert(vault, { id: "m", status: "proposed", sensitivity: "public", confidence: 0.6 });
    const result = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: vault }));
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
    const result = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: vault }));
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
    const faulty = {
      ...makeVault(),
      listMemoriesAcrossScopes: () => {
        throw new Error("disk gone");
      },
    } as MemoryVaultStore;
    const state: AutoMaintenanceState = {};
    expect(
      maybeRunAutoMaintenance(faulty, undefined, state, { nowMs: NOW, enabled: true }),
    ).toBeNull();
    // Cursor advanced BEFORE running so a persistently-failing pass cannot hot-loop.
    expect(state.lastRunAtMs).toBe(NOW);
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
