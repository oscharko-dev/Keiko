import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryVault,
  MemoryStorageError,
  type MemoryVaultStore,
} from "@oscharko-dev/keiko-memory-vault";
import type {
  MemoryEdge,
  MemoryId,
  MemoryRecord,
  MemoryStatus,
  MemoryUserId,
} from "@oscharko-dev/keiko-contracts";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import {
  HEALTH_SCAN_MIN_INTERVAL_MS,
  handleGetMemoryHealthScan,
  healthScanRateLimitState,
} from "./memory-health-scan-handlers.js";
import { createInMemoryUiStore } from "./store/index.js";
import type { RouteContext, RouteResult } from "./routes.js";

function makeCtx(): RouteContext {
  const socket = new Socket();
  return {
    req: {} as RouteContext["req"],
    res: { socket } as unknown as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/memory/health-scan"),
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
  // Each test gets a fresh cooldown so the rate limiter (AC7) never leaks state across unrelated
  // test cases; only the dedicated "rate limiting" describe block below exercises it deliberately.
  // `delete` (not `= undefined`) — exactOptionalPropertyTypes rejects assigning undefined to an
  // optional field.
  delete healthScanRateLimitState.lastRunAtMs;
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
  const dir = mkdtempSync(join(tmpdir(), "keiko-health-scan-"));
  tmpDirs.push(dir);
  const vault = createMemoryVault({ memoryDir: dir, redactString: (s) => s });
  activeVaults.push(vault);
  return vault;
}

function mid(value: string): MemoryId {
  return value as unknown as MemoryId;
}

function brandedEdgeId(value: string): MemoryEdge["id"] {
  const u: unknown = value;
  return u as MemoryEdge["id"];
}

interface RecordOptions {
  readonly id: string;
  readonly body?: string;
  readonly type?: MemoryRecord["type"];
  readonly status?: MemoryStatus;
  readonly confidence?: number;
  readonly createdAt?: number;
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
      sensitivity: "confidential",
    },
    validity: { validFrom: createdAt },
    status: options.status ?? "accepted",
    pinned: false,
    tags: [],
    createdAt,
    updatedAt: createdAt,
  };
  return vault.insertMemory(record);
}

function insertRelatedEdge(
  vault: MemoryVaultStore,
  fromMemoryId: MemoryId,
  toMemoryId: MemoryId,
): MemoryEdge {
  return vault.insertEdge({
    id: brandedEdgeId(`edge-${Math.random().toString(36).slice(2, 10)}`),
    schemaVersion: "1",
    fromMemoryId,
    toMemoryId,
    kind: "related",
    createdAt: Date.now(),
  });
}

interface HealthScanBody {
  readonly findings: readonly {
    readonly id: string;
    readonly kind: string;
    readonly memories: readonly { readonly memoryId: string }[];
    readonly reason: string;
    readonly detectedAt: number;
  }[];
  readonly recordsInspected: number;
  readonly truncated: boolean;
}

function body(result: RouteResult): HealthScanBody {
  return result.body as HealthScanBody;
}

describe("handleGetMemoryHealthScan", () => {
  it("returns 503 when no vault is configured", () => {
    const result = handleGetMemoryHealthScan(makeCtx(), makeDeps({ memoryVault: undefined }));
    expect(result.status).toBe(503);
  });

  it("returns an empty scan for an empty vault", () => {
    const vault = makeVault();
    const result = handleGetMemoryHealthScan(makeCtx(), makeDeps({ memoryVault: vault }));
    expect(result.status).toBe(200);
    const b = body(result);
    expect(b.findings).toEqual([]);
    expect(b.recordsInspected).toBe(0);
    expect(b.truncated).toBe(false);
  });

  it("reports an accepted memory with zero edges as an orphan-memory finding", () => {
    const vault = makeVault();
    insert(vault, { id: "m", status: "accepted" });
    const result = handleGetMemoryHealthScan(makeCtx(), makeDeps({ memoryVault: vault }));
    expect(result.status).toBe(200);
    const b = body(result);
    expect(b.findings).toHaveLength(1);
    expect(b.findings[0]?.kind).toBe("orphan-memory");
    expect(b.findings[0]?.memories).toHaveLength(1);
    expect(b.findings[0]?.memories[0]?.memoryId).toBe("m");
  });

  it("wires real vault edges: a genuine edge between two records suppresses the orphan finding", () => {
    const vault = makeVault();
    const a = insert(vault, { id: "a", status: "accepted", body: "uses vim for editing" });
    const b2 = insert(vault, { id: "b", status: "accepted", body: "uses emacs for editing" });
    insertRelatedEdge(vault, a.id, b2.id);
    const result = handleGetMemoryHealthScan(makeCtx(), makeDeps({ memoryVault: vault }));
    expect(result.status).toBe(200);
    const b = body(result);
    expect(b.recordsInspected).toBe(2);
    expect(b.findings.filter((f) => f.kind === "orphan-memory")).toHaveLength(0);
  });

  it("never leaks the raw memory body text into the response (no-raw-content, AC6)", () => {
    const vault = makeVault();
    const secretBody = "the launch codes are 9f3c7a-do-not-share";
    insert(vault, { id: "m", status: "accepted", body: secretBody });
    const result = handleGetMemoryHealthScan(makeCtx(), makeDeps({ memoryVault: vault }));
    expect(result.status).toBe(200);
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain(secretBody);
    expect(serialized).not.toContain("9f3c7a-do-not-share");
  });

  it("returns 500 wrapping a vault storage fault", () => {
    const vault = makeVault();
    const faulty: MemoryVaultStore = {
      ...vault,
      listMemoriesAcrossScopes: () => {
        throw new MemoryStorageError("internal", "disk gone");
      },
    };
    const result = handleGetMemoryHealthScan(makeCtx(), makeDeps({ memoryVault: faulty }));
    expect(result.status).toBe(500);
  });
});

describe("handleGetMemoryHealthScan — rate limiting (AC7, security-triage follow-up)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 429 when called again within the cooldown window", () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const first = handleGetMemoryHealthScan(makeCtx(), deps);
    expect(first.status).toBe(200);

    const second = handleGetMemoryHealthScan(makeCtx(), deps);
    expect(second.status).toBe(429);
    expect((second.body as { error?: { code?: string } }).error?.code).toBe(
      "HEALTH_SCAN_RATE_LIMITED",
    );
  });

  it("does not consume the vault or increment recordsInspected on a rate-limited call", () => {
    const vault = makeVault();
    insert(vault, { id: "m", status: "accepted" });
    const deps = makeDeps({ memoryVault: vault });
    handleGetMemoryHealthScan(makeCtx(), deps);

    const blocked = handleGetMemoryHealthScan(makeCtx(), deps);
    expect(blocked.status).toBe(429);
    expect(blocked.body).not.toHaveProperty("recordsInspected");
  });

  it("allows a new scan once the cooldown has elapsed", () => {
    vi.useFakeTimers();
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const first = handleGetMemoryHealthScan(makeCtx(), deps);
    expect(first.status).toBe(200);

    vi.advanceTimersByTime(HEALTH_SCAN_MIN_INTERVAL_MS);

    const second = handleGetMemoryHealthScan(makeCtx(), deps);
    expect(second.status).toBe(200);
  });

  it("rate-limits ahead of vault resolution, so a missing vault still returns 429 once warmed up", () => {
    const vault = makeVault();
    handleGetMemoryHealthScan(makeCtx(), makeDeps({ memoryVault: vault }));

    const blocked = handleGetMemoryHealthScan(makeCtx(), makeDeps({ memoryVault: undefined }));
    expect(blocked.status).toBe(429);
  });
});
