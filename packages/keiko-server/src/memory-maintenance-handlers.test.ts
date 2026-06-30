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
    type: "preference",
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
    // Regression guard for the promote-before-consolidate ordering. Consolidation only inspects
    // `accepted` records, so freshly-captured `proposed` conflicts must be promoted FIRST within the
    // same pass — otherwise a single "Run maintenance" promotes but detects nothing until a
    // second run.
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
      listMemories: () => {
        throw new Error("disk gone");
      },
    };
    const result = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: faulty }));
    expect(result.status).toBe(500);
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
      listMemories: () => {
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
