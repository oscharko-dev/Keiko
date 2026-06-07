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
import { handleRunMaintenance } from "./memory-maintenance-handlers.js";
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

  it("reinforces a frequently-recalled accepted memory", () => {
    const vault = makeVault();
    insert(vault, { id: "m", status: "accepted", confidence: 0.7 });
    vault.recordAccess([mid("m")], Date.now());
    vault.recordAccess([mid("m")], Date.now());
    const result = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: vault }));
    expect(counts(result).reinforced).toBe(1);
    const confidence = vault.getMemory(mid("m"))?.provenance.confidence ?? 0;
    expect(confidence).toBeGreaterThan(0.7);
  });

  it("decays an unaccessed, aged, mid-strength memory", () => {
    const vault = makeVault();
    insert(vault, {
      id: "m",
      status: "conflicted",
      confidence: 0.7,
      createdAt: Date.now() - 60 * DAY,
    });
    const result = handleRunMaintenance(makeCtx(), makeDeps({ memoryVault: vault }));
    expect(counts(result).decayed).toBe(1);
    const confidence = vault.getMemory(mid("m"))?.provenance.confidence ?? 1;
    expect(confidence).toBeLessThan(0.7);
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

  it("forgets an expired memory and writes a tombstone", () => {
    const vault = makeVault();
    insert(vault, {
      id: "m",
      status: "accepted",
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

  it("auto-supersedes the older memory of a pairwise correction conflict", () => {
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
    expect(counts(result).superseded).toBe(1);
    expect(vault.getMemory(mid("old"))?.status).toBe("superseded");
    expect(vault.getMemory(mid("new"))?.status).toBe("accepted");
  });

  it("promotes proposed conflicts AND supersedes the older one in a single pass", () => {
    // Regression guard for the promote-before-consolidate ordering. Consolidation only inspects
    // `accepted` records, so freshly-captured `proposed` conflicts must be promoted FIRST within the
    // same pass — otherwise a single "Run maintenance" promotes but supersedes nothing until a
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
    expect(counts(result).superseded).toBe(1);
    expect(vault.getMemory(mid("old"))?.status).toBe("superseded");
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
    expect(c.decayed).toBe(0);
    expect(vault.getMemory(mid("m"))?.status).toBe("accepted");
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
