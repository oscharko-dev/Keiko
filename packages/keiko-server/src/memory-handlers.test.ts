import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  createAuditRedactor,
  createInMemoryEvidenceStore,
  type EvidenceStore,
} from "@oscharko-dev/keiko-evidence";
import {
  createMemoryVault,
  MemoryStorageError,
  type MemoryVaultStore,
} from "@oscharko-dev/keiko-memory-vault";
import { runConsolidation } from "@oscharko-dev/keiko-memory-consolidation";
import { MEMORY_STATUS_TRANSITIONS } from "@oscharko-dev/keiko-contracts/runtime/memory";
import type {
  MemoryAuditEvent,
  MemoryConversationId,
  MemoryEdgeId,
  MemoryId,
  MemoryRecord,
  MemoryReviewerId,
  MemoryUserId,
  MemoryWorkspaceId,
} from "@oscharko-dev/keiko-contracts";
import type {
  GatewayConfig,
  OpenAIEmbeddingOutcome,
  OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import {
  handleAcceptMemoryProposal,
  handleArchiveMemory,
  handleCorrectMemory,
  handleDeleteMemory,
  handleEditMemory,
  handleForgetMemories,
  handleForgetMemory,
  handleGetMemory,
  handleListMemories,
  handleListMemoryTombstones,
  handleMemoryReviewQueue,
  handlePinMemory,
  handleRejectMemoryProposal,
  handleResolveMemoryConflict,
  handleUnpinMemory,
} from "./memory-handlers.js";
import { createInMemoryUiStore } from "./store/index.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { recordMemoryAudit } from "./memory-audit-handler.js";
import { buildMemoryCaptureDecisionAuditEvent } from "./memory-capture-projection.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";

// Real security-layer redactor: `recordMemoryAudit` requires one by name, so a fixture must not
// reinstate the identity default that made the evidence-redaction boundary fail open.
const TEST_AUDIT_REDACT: (input: string) => string = createAuditRedactor({}, {});

function makeReq(payload: unknown): IncomingMessage {
  return Readable.from([Buffer.from(JSON.stringify(payload))]) as unknown as IncomingMessage;
}

function makeCtx(
  path: string,
  payload: unknown,
  params: Record<string, string> = {},
): RouteContext {
  const socket = new Socket();
  return {
    req: makeReq(payload),
    res: { socket } as unknown as RouteContext["res"],
    params,
    url: new URL(`http://127.0.0.1${path}`),
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

function tombstoneDeps(vault: MemoryVaultStore): UiHandlerDeps {
  return makeDeps({
    memoryVault: vault,
    memoryAuthorization: {
      reviewerId: reviewerId("tombstone-auditor"),
      authorizedScopes: () => vault.listMemoryScopes(),
    },
  });
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
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-memory-handlers-"));
  tmpDirs.push(dir);
  const vault = createMemoryVault({ memoryDir: dir, redactString: (s) => s });
  activeVaults.push(vault);
  return vault;
}

function memoryId(value: string): MemoryId {
  return value as MemoryId;
}

function userId(value: string): MemoryUserId {
  return value as MemoryUserId;
}

function workspaceId(value: string): MemoryWorkspaceId {
  return value as MemoryWorkspaceId;
}

function reviewerId(value: string): MemoryReviewerId {
  return value as MemoryReviewerId;
}

function makeMemory(id: string, body: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  return {
    id: memoryId(id),
    schemaVersion: "1",
    scope: { kind: "global" },
    type: "preference",
    body,
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: now,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: now },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const EMBEDDING_MODEL = "text-embedding-3-large";

function embeddingConfig(baseUrl = "https://gateway.example.test/v1"): GatewayConfig {
  return {
    providers: [
      {
        modelId: EMBEDDING_MODEL,
        baseUrl,
        apiKey: "test-key",
        timeoutMs: 30_000,
        maxRetries: 1,
        retryBaseDelayMs: 100,
      },
    ],
    circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000, halfOpenProbes: 1 },
  };
}

function vectorForText(text: string): Float32Array {
  const first = text.length === 0 ? 0 : text.charCodeAt(0);
  const last = text.length === 0 ? 0 : text.charCodeAt(text.length - 1);
  return Float32Array.from([text.length, first, last]);
}

function asJson(result: RouteResult): Record<string, unknown> {
  return result.body as Record<string, unknown>;
}

function readAllAuditEvents(store: EvidenceStore): readonly MemoryAuditEvent[] {
  return store
    .list()
    .flatMap((runId) => JSON.parse(store.get(runId) ?? "[]") as readonly MemoryAuditEvent[]);
}

describe("memory handlers", () => {
  it("lists the bounded, content-free tombstone audit ledger for authorized scopes", () => {
    const vault = makeVault();
    const scope = { kind: "user" as const, userId: userId("u-1") };
    vault.insertMemory(makeMemory("forgotten-1", "secret body", { scope }));
    vault.deleteMemory(memoryId("forgotten-1"), {
      tombstone: true,
      forgetterSurface: "memory-center",
      reason: "user-request",
      nowMs: 200,
    });

    const result = handleListMemoryTombstones(
      makeCtx("/api/memory/tombstones?limit=10", {}),
      tombstoneDeps(vault),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      total: 1,
      limit: 10,
      nextCursor: null,
      tombstones: [
        {
          memoryId: "forgotten-1",
          scopeKind: "user",
          scopeCoordinate: "u-1",
          forgetterSurface: "memory-center",
        },
      ],
    });
    expect(JSON.stringify(result.body)).not.toContain("secret body");
    expect(JSON.stringify(result.body)).not.toContain("bodyHash");
  });

  it("accepts the advertised maximum tombstone page size with its look-ahead row", () => {
    const result = handleListMemoryTombstones(
      makeCtx("/api/memory/tombstones?limit=200", {}),
      tombstoneDeps(makeVault()),
    );

    expect(result).toMatchObject({
      status: 200,
      body: { limit: 200, nextCursor: null, tombstones: [] },
    });
  });

  it("redacts tombstone scope and reviewer identifiers before the BFF response", () => {
    const vault = makeVault();
    const scope = {
      kind: "user" as const,
      userId: userId("customer-secret-scope"),
    };
    vault.insertMemory(makeMemory("redacted-tombstone", "private body", { scope }));
    vault.deleteMemory(memoryId("redacted-tombstone"), {
      tombstone: true,
      forgetterSurface: "memory-center",
      reviewerId: reviewerId("customer-secret-reviewer"),
      nowMs: 200,
    });
    const redactCustomerSecret = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value).replaceAll("customer-secret", "[REDACTED]")) as unknown;

    const result = handleListMemoryTombstones(
      makeCtx("/api/memory/tombstones?limit=10", {}),
      makeDeps({
        memoryVault: vault,
        redactor: redactCustomerSecret,
        memoryAuthorization: {
          reviewerId: reviewerId("customer-secret-auditor"),
          authorizedScopes: () => [scope],
        },
      }),
    );

    expect(JSON.stringify(result.body)).not.toContain("customer-secret");
    expect(result.body).toMatchObject({
      tombstones: [
        {
          scopeCoordinate: "[REDACTED]-scope",
          reviewerId: "[REDACTED]-reviewer",
        },
      ],
    });
  });

  it("paginates the complete tombstone ledger with an opaque continuation cursor", () => {
    const vault = makeVault();
    const scope = { kind: "user" as const, userId: userId("u-1") };
    for (const [id, nowMs] of [
      ["forgotten-newest", 300],
      ["forgotten-middle", 200],
      ["forgotten-oldest", 100],
    ] as const) {
      vault.insertMemory(makeMemory(id, `secret-${id}`, { scope }));
      vault.deleteMemory(memoryId(id), {
        tombstone: true,
        forgetterSurface: "memory-center",
        reason: "user-request",
        nowMs,
      });
    }

    const first = handleListMemoryTombstones(
      makeCtx("/api/memory/tombstones?limit=2", {}),
      tombstoneDeps(vault),
    );
    const firstBody = asJson(first);
    expect(firstBody).toMatchObject({ total: 3, limit: 2 });
    expect(firstBody.nextCursor).toEqual(expect.any(String));
    expect(firstBody.tombstones).toMatchObject([
      { memoryId: "forgotten-newest" },
      { memoryId: "forgotten-middle" },
    ]);

    const second = handleListMemoryTombstones(
      makeCtx(`/api/memory/tombstones?limit=2&cursor=${String(firstBody.nextCursor)}`, {}),
      tombstoneDeps(vault),
    );
    expect(second.body).toMatchObject({
      total: 3,
      limit: 2,
      nextCursor: null,
      tombstones: [{ memoryId: "forgotten-oldest" }],
    });
  });

  it("returns a bounded client error when retention removes a cursor row", () => {
    const vault = makeVault();
    const scope = { kind: "user" as const, userId: userId("u-1") };
    for (const [id, nowMs] of [
      ["cursor-row", 200],
      ["remaining-row", 100],
    ] as const) {
      vault.insertMemory(makeMemory(id, `secret-${id}`, { scope }));
      vault.deleteMemory(memoryId(id), {
        tombstone: true,
        forgetterSurface: "memory-center",
        reason: "user-request",
        nowMs,
      });
    }
    vault.insertMemory(makeMemory("live-scope-anchor", "live", { scope }));
    const first = handleListMemoryTombstones(
      makeCtx("/api/memory/tombstones?limit=1", {}),
      tombstoneDeps(vault),
    );
    const cursor = String(asJson(first).nextCursor);
    vault.purgeTombstonesByScopeBefore(scope, 201);

    const resumed = handleListMemoryTombstones(
      makeCtx(`/api/memory/tombstones?limit=1&cursor=${cursor}`, {}),
      tombstoneDeps(vault),
    );

    expect(resumed).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
  });

  it("round-trips a tombstone cursor for a valid long scope coordinate", () => {
    const vault = makeVault();
    const scope = { kind: "user" as const, userId: userId(`user-${"x".repeat(2_000)}`) };
    for (const [id, nowMs] of [
      ["long-scope-newest", 200],
      ["long-scope-oldest", 100],
    ] as const) {
      vault.insertMemory(makeMemory(id, `secret-${id}`, { scope }));
      vault.deleteMemory(memoryId(id), {
        tombstone: true,
        forgetterSurface: "memory-center",
        nowMs,
      });
    }

    const first = handleListMemoryTombstones(
      makeCtx("/api/memory/tombstones?limit=1", {}),
      tombstoneDeps(vault),
    );
    const cursor = String(asJson(first).nextCursor);
    expect(cursor.length).toBeLessThanOrEqual(1_024);

    const second = handleListMemoryTombstones(
      makeCtx(`/api/memory/tombstones?limit=1&cursor=${cursor}`, {}),
      tombstoneDeps(vault),
    );
    expect(second).toMatchObject({
      status: 200,
      body: { nextCursor: null, tombstones: [{ memoryId: "long-scope-oldest" }] },
    });
  });

  it("rejects a malformed tombstone continuation cursor", () => {
    const result = handleListMemoryTombstones(
      makeCtx("/api/memory/tombstones?cursor=not.valid", {}),
      tombstoneDeps(makeVault()),
    );

    expect(result).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
  });

  it("rejects a tombstone cursor after the authorized scope set changes", () => {
    const vault = makeVault();
    const firstScope = { kind: "user" as const, userId: userId("scope-a") };
    const secondScope = { kind: "user" as const, userId: userId("scope-b") };
    for (const [id, scope, nowMs] of [
      ["scope-a-new", firstScope, 300],
      ["scope-a-old", firstScope, 200],
      ["scope-b-new", secondScope, 400],
    ] as const) {
      vault.insertMemory(makeMemory(id, `secret-${id}`, { scope }));
      vault.deleteMemory(memoryId(id), {
        tombstone: true,
        forgetterSurface: "memory-center",
        nowMs,
      });
    }
    let authorized = [firstScope] as readonly (typeof firstScope | typeof secondScope)[];
    const deps = makeDeps({
      memoryVault: vault,
      memoryAuthorization: {
        reviewerId: reviewerId("tombstone-auditor"),
        authorizedScopes: () => authorized,
      },
    });
    const first = handleListMemoryTombstones(makeCtx("/api/memory/tombstones?limit=1", {}), deps);
    const cursor = String(asJson(first).nextCursor);
    authorized = [firstScope, secondScope];

    const resumed = handleListMemoryTombstones(
      makeCtx(`/api/memory/tombstones?limit=1&cursor=${cursor}`, {}),
      deps,
    );

    expect(resumed).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
  });

  it("fails closed when tombstone audit authorization is unavailable", () => {
    const result = handleListMemoryTombstones(
      makeCtx("/api/memory/tombstones", {}),
      makeDeps({ memoryVault: makeVault() }),
    );

    expect(result).toMatchObject({
      status: 403,
      body: { error: { code: "MEMORY_AUTHORIZATION_REQUIRED" } },
    });
  });

  it("lists tombstones only from the caller's authorized scopes", () => {
    const vault = makeVault();
    const allowedScope = { kind: "user" as const, userId: userId("allowed-user") };
    const deniedScope = { kind: "user" as const, userId: userId("denied-user") };
    for (const [id, scope] of [
      ["allowed-memory", allowedScope],
      ["denied-memory", deniedScope],
    ] as const) {
      vault.insertMemory(makeMemory(id, `private-${id}`, { scope }));
      vault.deleteMemory(memoryId(id), {
        tombstone: true,
        forgetterSurface: "memory-center",
        nowMs: 200,
      });
    }
    const result = handleListMemoryTombstones(
      makeCtx("/api/memory/tombstones", {}),
      makeDeps({
        memoryVault: vault,
        memoryAuthorization: {
          reviewerId: reviewerId("scope-auditor"),
          authorizedScopes: () => [allowedScope],
        },
      }),
    );

    expect(result).toMatchObject({
      status: 200,
      body: { total: 1, tombstones: [{ memoryId: "allowed-memory" }] },
    });
    expect(JSON.stringify(result.body)).not.toContain("denied-memory");
  });

  it("lists memories across scopes and paginates after filtering", () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("global-1", "global"));
    vault.insertMemory(
      makeMemory("user-1", "user one", {
        scope: { kind: "user", userId: userId("u-1") },
        provenance: {
          sourceKind: "explicit-user-instruction",
          capturedAt: 2,
          confidence: 0.9,
          sensitivity: "restricted",
        },
        createdAt: 2,
        updatedAt: 2,
      }),
    );
    vault.insertMemory(
      makeMemory("user-2", "user two", {
        scope: { kind: "user", userId: userId("u-2") },
        provenance: {
          sourceKind: "explicit-user-instruction",
          capturedAt: 3,
          confidence: 0.9,
          sensitivity: "restricted",
        },
        createdAt: 3,
        updatedAt: 3,
      }),
    );
    vault.insertMemory(
      makeMemory("workspace-1", "workspace", {
        scope: { kind: "workspace", workspaceId: workspaceId("ws-1") },
        createdAt: 4,
        updatedAt: 4,
      }),
    );

    const result = handleListMemories(
      makeCtx("/api/memory?scope=user&sensitivity=restricted&limit=1&offset=1", {}),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(200);
    const body = asJson(result);
    expect(body.total).toBe(2);
    const memories = body.memories as readonly MemoryRecord[];
    expect(memories).toHaveLength(1);
    expect(memories[0]?.id).toBe("user-1");
  });

  it("filters listed memories by free-text query across body and tags", () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("atlas-body", "Atlas runs on Rust", { tags: ["backend"] }));
    vault.insertMemory(makeMemory("tag-hit", "Deployment notes", { tags: ["atlas"] }));
    vault.insertMemory(makeMemory("miss", "Unrelated preference", { tags: ["frontend"] }));

    const result = handleListMemories(
      makeCtx("/api/memory?q=atlas", {}),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(200);
    const body = asJson(result);
    expect(body.total).toBe(2);
    expect((body.memories as readonly MemoryRecord[]).map((memory) => memory.id).sort()).toEqual([
      "atlas-body",
      "tag-hit",
    ]);
  });

  it("keeps the legacy list response byte-identical when no recent params are present", () => {
    const vault = makeVault();
    const legacy = makeMemory("legacy-pin", "legacy body", {
      provenance: {
        sourceKind: "explicit-user-instruction",
        capturedAt: 123,
        confidence: 0.9,
        sensitivity: "public",
      },
      validity: { validFrom: 123 },
      createdAt: 123,
      updatedAt: 123,
    });
    vault.insertMemory(legacy);

    const result = handleListMemories(
      makeCtx("/api/memory?scope=global&type=preference&status=accepted&limit=50", {}),
      makeDeps({ memoryVault: vault }),
    );

    expect(JSON.stringify(result.body)).toBe(
      '{"memories":[{"id":"legacy-pin","schemaVersion":"1","scope":{"kind":"global"},"type":"preference","body":"legacy body","provenance":{"sourceKind":"explicit-user-instruction","capturedAt":123,"confidence":0.9,"sensitivity":"public"},"validity":{"validFrom":123},"status":"accepted","pinned":false,"tags":[],"createdAt":123,"updatedAt":123}],"total":1,"limit":50,"offset":0}',
    );
  });

  it("lists recent captures only from server-authorized scope coordinates", () => {
    const vault = makeVault();
    const evidenceStore = createInMemoryEvidenceStore();
    const ownScope = { kind: "user" as const, userId: userId("operator-a") };
    const foreignScope = { kind: "user" as const, userId: userId("operator-b") };
    const own = makeMemory("own-capture", "owned governed excerpt", { scope: ownScope });
    const foreign = makeMemory("foreign-capture", "foreign body must stay hidden", {
      scope: foreignScope,
    });
    vault.insertMemory(own);
    vault.insertMemory(foreign);
    for (const [record, occurredAt] of [
      [own, 200],
      [foreign, 300],
    ] as const) {
      recordMemoryAudit(
        { evidenceStore, redactString: TEST_AUDIT_REDACT },
        buildMemoryCaptureDecisionAuditEvent({
          eventId: `capture-${String(record.id)}`,
          occurredAt,
          outcome: "auto-accepted",
          scope: record.scope,
          mode: "supervised-coding",
          initiatorSurface: "conversation-center",
          sourceKind: record.provenance.sourceKind,
          reason: "governance-auto-accepted",
          memoryId: record.id,
        }),
      );
    }

    const result = handleListMemories(
      makeCtx("/api/memory?since=0&order=desc", {}),
      makeDeps({
        memoryVault: vault,
        evidenceStore,
        memoryAuthorization: {
          reviewerId: reviewerId("operator-a"),
          authorizedScopes: () => [ownScope],
        },
      }),
    );

    expect(result.status).toBe(200);
    const serialized = JSON.stringify(result.body);
    expect(serialized).toContain("own-capture");
    expect(serialized).toContain("owned governed excerpt");
    expect(serialized).not.toContain("foreign-capture");
    expect(serialized).not.toContain("foreign body must stay hidden");
  });

  it("rejects malformed, duplicated, and oversized recent cursors", () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const paths = [
      "/api/memory?since=not-a-timestamp",
      "/api/memory?since=12345678901234",
      "/api/memory?since=1&since=2",
      "/api/memory?order=desc",
    ];

    for (const path of paths) {
      expect(handleListMemories(makeCtx(path, {}), deps).status).toBe(400);
    }
  });

  it("includes non-global conflicts in the review queue", () => {
    const vault = makeVault();
    vault.insertMemory(
      makeMemory("conflict-1", "conflict", {
        scope: { kind: "workspace", workspaceId: workspaceId("ws-9") },
        status: "conflicted",
      }),
    );

    const result = handleMemoryReviewQueue(
      makeCtx("/api/memory/review-queue", {}),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(200);
    const body = asJson(result);
    expect(body.total).toBe(1);
    const memories = body.memories as readonly MemoryRecord[];
    expect(memories[0]?.id).toBe("conflict-1");
  });

  it("includes expired and stale accepted memories in the review queue", () => {
    const vault = makeVault();
    vault.insertMemory(
      makeMemory("expired-1", "expired proposal", {
        status: "expired",
        createdAt: 30,
        updatedAt: 30,
      }),
    );
    vault.insertMemory(
      makeMemory("stale-accepted-1", "stale accepted preference", {
        status: "accepted",
        staleReason: "source workflow was revoked",
        createdAt: 20,
        updatedAt: 20,
      }),
    );
    vault.insertMemory(
      makeMemory("archived-stale-1", "resolved stale preference", {
        status: "archived",
        staleReason: "already handled",
        createdAt: 10,
        updatedAt: 10,
      }),
    );

    const result = handleMemoryReviewQueue(
      makeCtx("/api/memory/review-queue", {}),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(200);
    const body = asJson(result);
    expect(body.total).toBe(2);
    const memories = body.memories as readonly MemoryRecord[];
    expect(memories.map((memory) => memory.id)).toEqual(["expired-1", "stale-accepted-1"]);
  });

  // MEMORY_STATUS_TRANSITIONS forbids `conflicted -> rejected`; `rejected` is reachable only from
  // `proposed`. The reject route was the ONE governance mutation that wrote the status without
  // consulting checkStatusTransition, so it produced a record in a state the contract says cannot
  // exist. The legal way to retire a conflicted record is `archived` (see the next test).
  it("refuses the contract-forbidden conflicted -> rejected transition", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("conflict-2", "dismiss me", { status: "conflicted" }));

    const result = await handleRejectMemoryProposal(
      makeCtx(
        "/api/memory/proposals/conflict-2/reject",
        { reason: "dismissed from queue" },
        { id: "conflict-2" },
      ),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(409);
    expect(asJson(result).error).toMatchObject({ code: "CONFLICT" });
    expect(vault.getMemory("conflict-2" as MemoryId)?.status).toBe("conflicted");
  });

  it("archives a conflicted memory through the transition the contract does allow", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("conflict-3", "retire me", { status: "conflicted" }));

    const result = await handleArchiveMemory(
      makeCtx(
        "/api/memory/conflict-3/archive",
        { reason: "archived conflicting memory from review queue" },
        { id: "conflict-3" },
      ),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(200);
    const archived = asJson(result).memory as MemoryRecord;
    expect(archived.status).toBe("archived");
    // KEIKO-0348: the archive route now threads the (sanitised) reason through to
    // vault.updateMemory so it lands on the record. Before the fix, staleReason was
    // undefined here — the reason was validated and then discarded.
    expect(archived.staleReason).toBe("archived-by-user");
    // KEIKO-0216: a persisted archived record confirms the raw client string never
    // survives to disk verbatim; the closed-vocabulary sanitiser collapses out-of-enum
    // strings (which may contain PII/secrets from a coerced client) to a safe default.
    expect(archived.staleReason).not.toContain("archived conflicting memory");
  });

  it("persists a client-provided in-enum archive reason as-is (KEIKO-0348)", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("in-enum-1", "archive me", { status: "accepted" }));

    const result = await handleArchiveMemory(
      makeCtx("/api/memory/in-enum-1/archive", { reason: "user-request" }, { id: "in-enum-1" }),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(200);
    expect((asJson(result).memory as MemoryRecord).staleReason).toBe("user-request");
  });

  it("still rejects a proposed memory, the one legal source state", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("proposal-9", "reject me", { status: "proposed" }));

    const result = await handleRejectMemoryProposal(
      makeCtx(
        "/api/memory/proposals/proposal-9/reject",
        { reason: "rejected from review queue" },
        { id: "proposal-9" },
      ),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(200);
    const memory = asJson(result).memory as MemoryRecord;
    expect(memory.status).toBe("rejected");
    // KEIKO-0216: a free-form client-supplied reason is normalised to the closed enum;
    // "rejected from review queue" is not in the allowed vocabulary, so it collapses
    // to the safe "rejected-by-user" default instead of being persisted verbatim.
    expect(memory.staleReason).toBe("rejected-by-user");
  });

  it.each(["accepted", "archived", "superseded", "expired"] as const)(
    "refuses to reject a %s memory (no contract edge to rejected)",
    async (status) => {
      const vault = makeVault();
      vault.insertMemory(makeMemory(`from-${status}`, "not rejectable", { status }));

      const result = await handleRejectMemoryProposal(
        makeCtx(
          `/api/memory/proposals/from-${status}/reject`,
          { reason: "nope" },
          { id: `from-${status}` },
        ),
        makeDeps({ memoryVault: vault }),
      );

      expect(result.status).toBe(409);
      expect(vault.getMemory(`from-${status}` as MemoryId)?.status).toBe(status);
    },
  );

  it("sanitises GovernanceError responses so the memory id is not leaked", () => {
    const vault = makeVault();
    const idValue = "leak-probe-7f3a1c";
    // Pre-pinned record causes buildPinOperation to throw GovernanceError("idempotent-noop", ...)
    // whose composed message embeds the memory id; the handler must not forward that message.
    vault.insertMemory(makeMemory(idValue, "already pinned", { pinned: true }));

    const result = handlePinMemory(
      makeCtx(`/api/memory/${idValue}/pin`, {}, { id: idValue }),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(409);
    const body = asJson(result);
    const errorField = body.error as { code: string; message: string };
    expect(errorField.code).toBe("GOVERNANCE_ERROR");
    expect(errorField.message).toContain("idempotent-noop");
    expect(errorField.message).not.toContain("GovernanceError(");
    expect(errorField.message).not.toContain(idValue);
  });

  it("re-embeds a memory when editing its body", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("memory-edit-1", "Old body"));
    vault.upsertEmbedding(memoryId("memory-edit-1"), {
      provider: "old-provider",
      modelId: "old-model",
      metric: "cosine",
      vector: Float32Array.from([1, 1, 1]),
    });
    const embeddingRequest = vi.fn(
      (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
        Promise.resolve({
          ok: true,
          value: { modelId: request.modelId, vector: vectorForText(request.input) },
        }),
    );

    const result = await handleEditMemory(
      makeCtx(
        "/api/memory/memory-edit-1",
        { body: "New body for embedding" },
        { id: "memory-edit-1" },
      ),
      makeDeps({
        memoryVault: vault,
        config: embeddingConfig(),
        configPresent: true,
        localKnowledgeEmbeddingRequest: embeddingRequest,
      }),
    );

    expect(result.status).toBe(200);
    expect(vault.getMemory(memoryId("memory-edit-1"))?.body).toBe("New body for embedding");
    expect(embeddingRequest).toHaveBeenCalledWith(
      expect.objectContaining({ input: "New body for embedding", modelId: EMBEDDING_MODEL }),
    );
    expect(Array.from(vault.getEmbedding(memoryId("memory-edit-1"))?.vector ?? [])).toEqual(
      Array.from(vectorForText("New body for embedding")),
    );
  });

  it("invalidates a stale embedding when body edit re-embedding fails", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("memory-edit-2", "Old body"));
    vault.upsertEmbedding(memoryId("memory-edit-2"), {
      provider: "old-provider",
      modelId: "old-model",
      metric: "cosine",
      vector: Float32Array.from([1, 1, 1]),
    });
    const embeddingRequest = vi.fn((): Promise<OpenAIEmbeddingOutcome> =>
      Promise.resolve({ ok: false, kind: "transport" }),
    );

    const result = await handleEditMemory(
      makeCtx(
        "/api/memory/memory-edit-2",
        { body: "Body whose embed fails" },
        { id: "memory-edit-2" },
      ),
      makeDeps({
        memoryVault: vault,
        config: embeddingConfig(),
        configPresent: true,
        localKnowledgeEmbeddingRequest: embeddingRequest,
      }),
    );

    expect(result.status).toBe(200);
    expect(vault.getMemory(memoryId("memory-edit-2"))?.body).toBe("Body whose embed fails");
    expect(vault.getEmbedding(memoryId("memory-edit-2"))).toBeUndefined();
  });

  // #2902 w5-sse-counters: readJsonBody now consolidates onto the shared readBoundedRequestBody,
  // so an oversized body must still yield the shared reader's own 413 rejection shape.
  it("rejects an oversized body using the shared bounded-body reader", async () => {
    const vault = makeVault();

    const result = await handleCorrectMemory(
      makeCtx(
        "/api/memory/memory-oversize/correct",
        { body: "x".repeat(70_000) },
        { id: "memory-oversize" },
      ),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(413);
    expect(asJson(result)).toEqual({
      error: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large." },
    });
  });

  it("creates a correction proposal with a provenance-preserving supersession edge", async () => {
    const vault = makeVault();
    const evidenceStore = createInMemoryEvidenceStore();
    vault.insertMemory(makeMemory("memory-correct-1", "Prefer yarn for package installs."));

    const result = await handleCorrectMemory(
      makeCtx(
        "/api/memory/memory-correct-1/correct",
        { body: "Prefer npm ci for package installs." },
        { id: "memory-correct-1" },
      ),
      makeDeps({ memoryVault: vault, evidenceStore }),
    );

    expect(result.status).toBe(201);
    const body = asJson(result);
    const correction = body.correction as MemoryRecord;
    expect(correction.type).toBe("correction");
    expect(correction.status).toBe("proposed");
    expect(correction.provenance.sourceKind).toBe("accepted-correction");
    expect(correction.body).toBe("Prefer npm ci for package installs.");

    const edges = vault.listOutgoingEdges(memoryId("memory-correct-1"));
    expect(edges).toHaveLength(1);
    expect(edges[0]?.kind).toBe("supersedes");
    expect(edges[0]?.fromMemoryId).toBe(memoryId("memory-correct-1"));
    expect(edges[0]?.toMemoryId).toBe(correction.id);
    expect(edges[0]?.provenanceSummary).toBe("user-issued correction");

    expect(readAllAuditEvents(evidenceStore)).toEqual([
      expect.objectContaining({
        kind: "memory:proposed",
        memoryId: correction.id,
      }),
    ]);
  });

  it("accepts a correction by superseding the original and writing body-free audit evidence", async () => {
    const vault = makeVault();
    const evidenceStore = createInMemoryEvidenceStore();
    vault.insertMemory(makeMemory("memory-correct-accept", "Prefer yarn for package installs."));

    const proposalResult = await handleCorrectMemory(
      makeCtx(
        "/api/memory/memory-correct-accept/correct",
        { body: "Prefer npm ci for package installs." },
        { id: "memory-correct-accept" },
      ),
      makeDeps({ memoryVault: vault, evidenceStore }),
    );

    const correction = asJson(proposalResult).correction as MemoryRecord;
    const acceptResult = await handleAcceptMemoryProposal(
      makeCtx(`/api/memory/proposals/${String(correction.id)}/accept`, {}, { id: correction.id }),
      makeDeps({ memoryVault: vault, evidenceStore }),
    );

    expect(acceptResult.status).toBe(200);
    const superseded = vault.getMemory(memoryId("memory-correct-accept"));
    expect(superseded?.status).toBe("superseded");
    // Bi-temporal-lite (#204, C1): the superseded fact's belief window is CLOSED at acceptance, so
    // "what did we believe as of T" is answerable and it drops out of default retrieval.
    expect(superseded?.validity.validUntil).toBeGreaterThan(superseded?.validity.validFrom ?? 0);
    expect(vault.getMemory(correction.id)?.status).toBe("accepted");
    // The replacement's window stays OPEN (the current belief).
    expect(vault.getMemory(correction.id)?.validity.validUntil).toBeUndefined();
    expect(vault.getMemory(correction.id)?.type).toBe("preference");
    expect(vault.getMemory(correction.id)?.provenance.sourceKind).toBe("accepted-correction");

    const events = readAllAuditEvents(evidenceStore);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "memory:superseded",
          oldMemoryId: memoryId("memory-correct-accept"),
          newMemoryId: correction.id,
        }),
      ]),
    );
    const persistedAudit = JSON.stringify(events);
    expect(persistedAudit).not.toContain("Prefer yarn");
    expect(persistedAudit).not.toContain("Prefer npm ci");
  });

  it("does not accept a correction when the original can no longer be superseded", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("memory-correct-archived", "Prefer yarn."));

    const proposalResult = await handleCorrectMemory(
      makeCtx(
        "/api/memory/memory-correct-archived/correct",
        { body: "Prefer npm ci." },
        { id: "memory-correct-archived" },
      ),
      makeDeps({ memoryVault: vault }),
    );
    const correction = asJson(proposalResult).correction as MemoryRecord;
    vault.updateMemory(memoryId("memory-correct-archived"), { status: "archived" }, Date.now());

    const acceptResult = await handleAcceptMemoryProposal(
      makeCtx(`/api/memory/proposals/${String(correction.id)}/accept`, {}, { id: correction.id }),
      makeDeps({ memoryVault: vault }),
    );

    expect(acceptResult.status).toBe(400);
    expect(vault.getMemory(correction.id)?.status).toBe("proposed");
    expect(vault.getMemory(memoryId("memory-correct-archived"))?.status).toBe("archived");
  });

  it("forgets a memory only after acknowledgement and persists a body-free tombstone", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("memory-forget-1", "PRIVATE-BODY-FORGET-FINGERPRINT"));

    const result = await handleForgetMemory(
      makeCtx(
        "/api/memory/memory-forget-1/forget",
        { acknowledged: true, reason: "user removed stale package-manager preference" },
        { id: "memory-forget-1" },
      ),
      makeDeps({
        memoryVault: vault,
        memoryAuthorization: {
          reviewerId: reviewerId("operator-a"),
          authorizedScopes: () => [{ kind: "global" }],
        },
      }),
    );

    expect(result.status).toBe(200);
    expect(vault.getMemory(memoryId("memory-forget-1"))).toBeUndefined();
    const tombstones = vault.listTombstonesByScope({ kind: "global" });
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.memoryId).toBe(memoryId("memory-forget-1"));
    expect(tombstones[0]?.reason).toBe("user-request");
    expect(tombstones[0]?.reviewerId).toBe("operator-a");
    expect(tombstones[0]?.originalStatus).toBe("accepted");
    expect(JSON.stringify(tombstones)).not.toContain("PRIVATE-BODY-FORGET-FINGERPRINT");
    expect(JSON.stringify(tombstones)).not.toContain("package-manager preference");
  });

  it("does not persist browser-supplied forget reason text into tombstones", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("memory-forget-sensitive-reason", "body can be forgotten"));

    const result = await handleForgetMemory(
      makeCtx(
        "/api/memory/memory-forget-sensitive-reason/forget",
        {
          acknowledged: true,
          reason:
            "forget customer-id CUST-SECRET-123 and token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        { id: "memory-forget-sensitive-reason" },
      ),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(200);
    const serializedTombstones = JSON.stringify(vault.listTombstonesByScope({ kind: "global" }));
    expect(serializedTombstones).toContain("user-request");
    expect(serializedTombstones).not.toContain("CUST-SECRET-123");
    expect(serializedTombstones).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("rejects destructive forget requests that omit explicit acknowledgement", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("memory-forget-guard", "must remain"));

    const result = await handleForgetMemory(
      makeCtx(
        "/api/memory/memory-forget-guard/forget",
        { reason: "missing acknowledgement" },
        { id: "memory-forget-guard" },
      ),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(400);
    expect(vault.getMemory(memoryId("memory-forget-guard"))).toBeDefined();
    expect(vault.listTombstonesByScope({ kind: "global" })).toEqual([]);
  });

  it("refuses destructive forgets when audit evidence cannot be written", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("memory-forget-audit-down", "must remain until audited"));
    const failingEvidenceStore: EvidenceStore = {
      put: () => {
        throw new Error("audit store unavailable");
      },
      list: () => [],
      get: () => undefined,
      delete: () => undefined,
    };

    const result = await handleForgetMemory(
      makeCtx(
        "/api/memory/memory-forget-audit-down/forget",
        { acknowledged: true, reason: "user requested forget while audit down" },
        { id: "memory-forget-audit-down" },
      ),
      makeDeps({ memoryVault: vault, evidenceStore: failingEvidenceStore }),
    );

    expect(result.status).toBe(500);
    expect(asJson(result).error).toEqual(
      expect.objectContaining({
        code: "MEMORY_AUDIT_UNAVAILABLE",
      }),
    );
    expect(vault.getMemory(memoryId("memory-forget-audit-down"))).toBeDefined();
    expect(vault.listTombstonesByScope({ kind: "global" })).toEqual([]);
  });

  it("rejects by-id forgets when the caller is not authorized for the memory scope", async () => {
    const vault = makeVault();
    const restrictedScope = {
      kind: "workspace" as const,
      workspaceId: workspaceId("ws-restricted"),
    };
    vault.insertMemory(
      makeMemory("memory-forget-out-of-scope", "must remain in restricted scope", {
        scope: restrictedScope,
      }),
    );

    const result = await handleForgetMemory(
      makeCtx(
        "/api/memory/memory-forget-out-of-scope/forget",
        { acknowledged: true, reason: "caller attempts cross-scope forget" },
        { id: "memory-forget-out-of-scope" },
      ),
      makeDeps({
        memoryVault: vault,
        memoryAuthorization: {
          reviewerId: reviewerId("operator-a"),
          authorizedScopes: () => [
            { kind: "workspace", workspaceId: workspaceId("ws-authorized") },
          ],
        },
      }),
    );

    expect(result.status).toBe(403);
    expect(asJson(result).error).toEqual(
      expect.objectContaining({ code: "MEMORY_SCOPE_FORBIDDEN" }),
    );
    expect(vault.getMemory(memoryId("memory-forget-out-of-scope"))).toBeDefined();
    expect(vault.listTombstonesByScope(restrictedScope)).toEqual([]);
  });

  it("rejects scoped forget selectors outside the caller authorization", async () => {
    const vault = makeVault();
    const restrictedScope = {
      kind: "workspace" as const,
      workspaceId: workspaceId("ws-restricted"),
    };
    vault.insertMemory(
      makeMemory("memory-selector-out-of-scope", "must remain in restricted scope", {
        scope: restrictedScope,
      }),
    );

    const result = await handleForgetMemories(
      makeCtx("/api/memory/forget", {
        acknowledged: true,
        selector: { kind: "by-scope", scope: restrictedScope },
        reason: "caller attempts cross-scope selector forget",
      }),
      makeDeps({
        memoryVault: vault,
        memoryAuthorization: {
          reviewerId: reviewerId("operator-a"),
          authorizedScopes: () => [
            { kind: "workspace", workspaceId: workspaceId("ws-authorized") },
          ],
        },
      }),
    );

    expect(result.status).toBe(403);
    expect(asJson(result).error).toEqual(
      expect.objectContaining({ code: "MEMORY_SCOPE_FORBIDDEN" }),
    );
    expect(vault.getMemory(memoryId("memory-selector-out-of-scope"))).toBeDefined();
    expect(vault.listTombstonesByScope(restrictedScope)).toEqual([]);
  });

  it("deletes a memory through the governed tombstone path, not a hard-delete bypass", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("memory-delete-1", "DELETE-BODY-FINGERPRINT"));

    const result = await handleDeleteMemory(
      makeCtx(
        "/api/memory/memory-delete-1",
        { acknowledged: true, reason: "operator requested delete" },
        { id: "memory-delete-1" },
      ),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(200);
    expect(vault.getMemory(memoryId("memory-delete-1"))).toBeUndefined();
    const tombstones = vault.listTombstonesByScope({ kind: "global" });
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toEqual(
      expect.objectContaining({
        memoryId: memoryId("memory-delete-1"),
        reason: "user-request",
        reviewerId: "local-operator",
        originalStatus: "accepted",
      }),
    );
    expect(JSON.stringify(tombstones)).not.toContain("DELETE-BODY-FINGERPRINT");
  });

  it("selectively forgets memories by type while preserving pinned records", async () => {
    const vault = makeVault();
    vault.insertMemory(
      makeMemory("pref-1", "forget this preference", {
        type: "preference",
        createdAt: 10,
        updatedAt: 10,
      }),
    );
    vault.insertMemory(
      makeMemory("pref-pinned", "keep this preference", {
        type: "preference",
        pinned: true,
        createdAt: 20,
        updatedAt: 20,
      }),
    );
    vault.insertMemory(
      makeMemory("decision-1", "keep this decision", {
        type: "decision",
        createdAt: 30,
        updatedAt: 30,
      }),
    );

    const result = await handleForgetMemories(
      makeCtx("/api/memory/forget", {
        acknowledged: true,
        selector: { kind: "by-type", scope: { kind: "global" }, type: "preference" },
        reason: "remove stale preferences",
      }),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(200);
    expect(vault.getMemory(memoryId("pref-1"))).toBeUndefined();
    expect(vault.getMemory(memoryId("pref-pinned"))).toBeDefined();
    expect(vault.getMemory(memoryId("decision-1"))).toBeDefined();
    expect(vault.listTombstonesByScope({ kind: "global" }).map((t) => t.memoryId)).toEqual([
      memoryId("pref-1"),
    ]);
  });

  it("selectively forgets matching records through one batch delete", async () => {
    const vault = makeVault();
    vault.insertMemory(
      makeMemory("pref-1", "forget this preference", {
        type: "preference",
        createdAt: 10,
        updatedAt: 10,
      }),
    );
    vault.insertMemory(
      makeMemory("pref-2", "forget this other preference", {
        type: "preference",
        createdAt: 20,
        updatedAt: 20,
      }),
    );
    const deleteMemories = vi.fn(vault.deleteMemories);
    const guardedVault: MemoryVaultStore = {
      ...vault,
      deleteMemory: () => {
        throw new Error("selector forget must use batch delete");
      },
      deleteMemories,
    };

    const result = await handleForgetMemories(
      makeCtx("/api/memory/forget", {
        acknowledged: true,
        selector: { kind: "by-type", scope: { kind: "global" }, type: "preference" },
      }),
      makeDeps({ memoryVault: guardedVault }),
    );

    expect(result.status).toBe(200);
    expect(deleteMemories).toHaveBeenCalledTimes(1);
    expect(deleteMemories.mock.calls[0]?.[0].map((entry) => entry.id).sort()).toEqual([
      memoryId("pref-1"),
      memoryId("pref-2"),
    ]);
    expect(vault.getMemory(memoryId("pref-1"))).toBeUndefined();
    expect(vault.getMemory(memoryId("pref-2"))).toBeUndefined();
  });

  it("selectively forgets memories by source conversation", async () => {
    const vault = makeVault();
    vault.insertMemory(
      makeMemory("conv-1", "from selected conversation", {
        provenance: {
          sourceKind: "explicit-user-instruction",
          sourceConversationId: "conversation-a" as MemoryConversationId,
          capturedAt: 1,
          confidence: 0.9,
          sensitivity: "public",
        },
      }),
    );
    vault.insertMemory(
      makeMemory("conv-2", "from another conversation", {
        provenance: {
          sourceKind: "explicit-user-instruction",
          sourceConversationId: "conversation-b" as MemoryConversationId,
          capturedAt: 1,
          confidence: 0.9,
          sensitivity: "public",
        },
      }),
    );

    const result = await handleForgetMemories(
      makeCtx("/api/memory/forget", {
        acknowledged: true,
        selector: {
          kind: "by-source-conversation",
          scope: { kind: "global" },
          sourceConversationId: "conversation-a",
        },
      }),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(200);
    expect(vault.getMemory(memoryId("conv-1"))).toBeUndefined();
    expect(vault.getMemory(memoryId("conv-2"))).toBeDefined();
  });

  it("resolves conflicts by marking losers conflicted and linking them to the winner", async () => {
    const vault = makeVault();
    const evidenceStore = createInMemoryEvidenceStore();
    vault.insertMemory(makeMemory("conflict-winner", "formatter is biome"));
    vault.insertMemory(makeMemory("conflict-loser", "formatter is prettier"));

    const result = await handleResolveMemoryConflict(
      makeCtx("/api/memory/conflicts/resolve", {
        winner: "conflict-winner",
        losers: ["conflict-loser"],
        reason: "reviewed and winner selected",
      }),
      makeDeps({ memoryVault: vault, evidenceStore }),
    );

    expect(result.status).toBe(200);
    expect(vault.getMemory(memoryId("conflict-loser"))?.status).toBe("conflicted");
    // KEIKO-0216: the client-supplied free-form reason "reviewed and winner selected" is
    // outside the closed vocabulary; sanitisation collapses it to the "conflict-resolved"
    // default rather than persisting the raw string.
    expect(vault.getMemory(memoryId("conflict-loser"))?.staleReason).toBe("conflict-resolved");
    const edges = vault.listOutgoingEdges(memoryId("conflict-loser"));
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual(
      expect.objectContaining({
        kind: "supersedes",
        fromMemoryId: memoryId("conflict-loser"),
        toMemoryId: memoryId("conflict-winner"),
      }),
    );
    expect(readAllAuditEvents(evidenceStore)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "memory:superseded",
          oldMemoryId: memoryId("conflict-loser"),
          newMemoryId: memoryId("conflict-winner"),
        }),
      ]),
    );
  });

  // Pins what `persistConflictTransitions` documents: a conflict loser lands in `conflicted`, a
  // state MEMORY_STATUS_TRANSITIONS lets return to `accepted`, so its belief window must stay OPEN.
  // Only monotonic supersession (the correction-acceptance path) closes a window.
  it("leaves a conflict loser rehabilitable with its belief window open", async () => {
    const vault = makeVault();
    const evidenceStore = createInMemoryEvidenceStore();
    vault.insertMemory(makeMemory("validity-winner", "formatter is biome"));
    vault.insertMemory(makeMemory("validity-loser", "formatter is prettier"));
    const before = vault.getMemory(memoryId("validity-loser"))?.validity;

    const result = await handleResolveMemoryConflict(
      makeCtx("/api/memory/conflicts/resolve", {
        winner: "validity-winner",
        losers: ["validity-loser"],
        reason: "reviewed and winner selected",
      }),
      makeDeps({ memoryVault: vault, evidenceStore }),
    );

    expect(result.status).toBe(200);
    const loser = vault.getMemory(memoryId("validity-loser"));
    expect(loser?.status).toBe("conflicted");
    expect(loser?.validity).toEqual(before);
    expect(loser?.validity).not.toHaveProperty("validUntil");
    expect(MEMORY_STATUS_TRANSITIONS.conflicted).toContain("accepted");
  });

  it("rejects conflict resolution for duplicate ids before mutating state", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("conflict-dup-winner", "formatter is biome"));
    vault.insertMemory(makeMemory("conflict-dup-loser", "formatter is prettier"));

    const result = await handleResolveMemoryConflict(
      makeCtx("/api/memory/conflicts/resolve", {
        winner: "conflict-dup-winner",
        losers: ["conflict-dup-loser", "conflict-dup-loser"],
      }),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(400);
    expect(vault.getMemory(memoryId("conflict-dup-loser"))?.status).toBe("accepted");
    expect(vault.listOutgoingEdges(memoryId("conflict-dup-loser"))).toEqual([]);
  });

  it("rejects conflict resolution across scope boundaries", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("conflict-scope-winner", "formatter is biome"));
    vault.insertMemory(
      makeMemory("conflict-scope-loser", "formatter is prettier", {
        scope: { kind: "workspace", workspaceId: workspaceId("ws-conflict") },
      }),
    );

    const result = await handleResolveMemoryConflict(
      makeCtx("/api/memory/conflicts/resolve", {
        winner: "conflict-scope-winner",
        losers: ["conflict-scope-loser"],
      }),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(400);
    expect(vault.getMemory(memoryId("conflict-scope-loser"))?.status).toBe("accepted");
    expect(vault.listOutgoingEdges(memoryId("conflict-scope-loser"))).toEqual([]);
  });

  it("rejects conflict resolution across memory types", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("conflict-type-winner", "formatter is biome"));
    vault.insertMemory(
      makeMemory("conflict-type-loser", "formatter is prettier", { type: "decision" }),
    );

    const result = await handleResolveMemoryConflict(
      makeCtx("/api/memory/conflicts/resolve", {
        winner: "conflict-type-winner",
        losers: ["conflict-type-loser"],
      }),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(400);
    expect(vault.getMemory(memoryId("conflict-type-loser"))?.status).toBe("accepted");
    expect(vault.listOutgoingEdges(memoryId("conflict-type-loser"))).toEqual([]);
  });

  it("rejects conflict resolution when the records are not actually conflicting", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("conflict-real-winner", "formatter is biome"));
    vault.insertMemory(makeMemory("conflict-real-loser", "deploys happen on Tuesdays"));

    const result = await handleResolveMemoryConflict(
      makeCtx("/api/memory/conflicts/resolve", {
        winner: "conflict-real-winner",
        losers: ["conflict-real-loser"],
      }),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(400);
    expect(vault.getMemory(memoryId("conflict-real-loser"))?.status).toBe("accepted");
    expect(vault.listOutgoingEdges(memoryId("conflict-real-loser"))).toEqual([]);
  });

  // Structural pin for MemoryConsolidation.tsx's withheld merge control: the winner/losers are
  // taken VERBATIM from the consolidation engine's own review item (no hand-written pair), so this
  // stays true if the engine's clustering or winner selection moves. A duplicate cluster is by
  // construction above the dedup overlap threshold that disqualifies `value-mismatch`, so the
  // resolution route can never accept what a duplicate-derived merge item proposes.
  it("refuses the merge action the consolidation engine emits for a duplicate cluster", async () => {
    const vault = makeVault();
    const capturedAt = Date.now();
    const ids = ["dup-a", "dup-b", "dup-c"];
    ids.forEach((id, index) => {
      const at = capturedAt + index * 1_000;
      vault.insertMemory(
        makeMemory(id, "The user prefers tabs over spaces.", {
          createdAt: at,
          updatedAt: at,
          validity: { validFrom: at },
        }),
      );
    });
    const records = ids.flatMap((id) => {
      const record = vault.getMemory(memoryId(id));
      return record === undefined ? [] : [record];
    });

    let reviewSeq = 0;
    let edgeSeq = 0;
    const consolidated = runConsolidation(records, {
      nowMs: Date.now(),
      newEdgeId: () => `edge-${String((edgeSeq += 1))}` as MemoryEdgeId,
      newReviewItemId: () => `rv-${String((reviewSeq += 1))}`,
      includeStatuses: ["accepted", "proposed", "conflicted"],
    });
    const mergeAction = consolidated.reviewItems
      .map((item) => item.proposedAction)
      .find((action) => action?.kind === "merge");
    if (mergeAction === undefined) {
      throw new TypeError("consolidation no longer emits a merge action for a duplicate cluster");
    }

    const result = await handleResolveMemoryConflict(
      makeCtx("/api/memory/conflicts/resolve", {
        winner: mergeAction.winner,
        losers: mergeAction.losers,
        reason: "resolved from consolidation review item",
      }),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(400);
    // The refusal is the conflict precondition itself, not an incidental status-transition guard.
    expect(asJson(result)).toMatchObject({
      error: { message: "Governance constraint violated (invalid-resolution)." },
    });
    for (const loser of mergeAction.losers) {
      expect(vault.getMemory(loser)?.status).toBe("accepted");
      expect(vault.listOutgoingEdges(loser)).toEqual([]);
    }
  });
});

describe("memory handlers — outcome-driven forgetting (O-V1)", () => {
  it("records a positive outcome for a conflict winner and a negative for the loser", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("ov1-winner", "formatter is biome"));
    vault.insertMemory(makeMemory("ov1-loser", "formatter is prettier"));

    const result = await handleResolveMemoryConflict(
      makeCtx("/api/memory/conflicts/resolve", {
        winner: "ov1-winner",
        losers: ["ov1-loser"],
        reason: "reviewed and winner selected",
      }),
      makeDeps({ memoryVault: vault }),
    );
    expect(result.status).toBe(200);

    const winner = vault.getAccessStats([memoryId("ov1-winner")]).get(memoryId("ov1-winner"));
    expect(winner).toMatchObject({ outcomeCount: 1, utilitySum: 1 });
    const loser = vault.getAccessStats([memoryId("ov1-loser")]).get(memoryId("ov1-loser"));
    expect(loser).toMatchObject({ outcomeCount: 1, utilitySum: 0 });
  });

  it("records a positive outcome for an accepted correction and a negative for its origin", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("ov1-origin", "Prefer yarn for installs."));
    const proposalResult = await handleCorrectMemory(
      makeCtx(
        "/api/memory/ov1-origin/correct",
        { body: "Prefer npm ci for installs." },
        { id: "ov1-origin" },
      ),
      makeDeps({ memoryVault: vault }),
    );
    const correction = asJson(proposalResult).correction as MemoryRecord;

    const acceptResult = await handleAcceptMemoryProposal(
      makeCtx(`/api/memory/proposals/${String(correction.id)}/accept`, {}, { id: correction.id }),
      makeDeps({ memoryVault: vault }),
    );
    expect(acceptResult.status).toBe(200);

    expect(vault.getAccessStats([correction.id]).get(correction.id)).toMatchObject({
      outcomeCount: 1,
      utilitySum: 1,
    });
    expect(
      vault.getAccessStats([memoryId("ov1-origin")]).get(memoryId("ov1-origin")),
    ).toMatchObject({ outcomeCount: 1, utilitySum: 0 });
  });

  it("records a positive outcome for a plain accepted proposal and no negative", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("ov1-proposal", "Use tabs over spaces.", { status: "proposed" }));

    const result = await handleAcceptMemoryProposal(
      makeCtx("/api/memory/proposals/ov1-proposal/accept", {}, { id: "ov1-proposal" }),
      makeDeps({ memoryVault: vault }),
    );
    expect(result.status).toBe(200);
    expect(
      vault.getAccessStats([memoryId("ov1-proposal")]).get(memoryId("ov1-proposal")),
    ).toMatchObject({ outcomeCount: 1, utilitySum: 1 });
  });

  it("records a negative outcome when a proposal is rejected", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("ov1-reject", "speculative note", { status: "proposed" }));

    const result = await handleRejectMemoryProposal(
      makeCtx(
        "/api/memory/proposals/ov1-reject/reject",
        { reason: "not useful" },
        { id: "ov1-reject" },
      ),
      makeDeps({ memoryVault: vault }),
    );
    expect(result.status).toBe(200);
    expect(
      vault.getAccessStats([memoryId("ov1-reject")]).get(memoryId("ov1-reject")),
    ).toMatchObject({
      outcomeCount: 1,
      utilitySum: 0,
    });
  });
});

// ─── emitServerDiagnostic on storage failures (epic #3233, w4b) ───────────────
// Before this wave every one of these catch blocks converted a real `MemoryStorageError` (or, for
// the audit preflight, ANY thrown value) into an opaque response with the underlying cause
// discarded — zero `emitServerDiagnostic` calls existed anywhere in memory-handlers.ts, so an
// operator had no way to see WHY a memory route started failing. Each test below forces the vault
// (or, for the preflight check, the evidence store) to throw and asserts a correlation-keyed
// `ServerDiagnosticRecord` reaches the injected sink with the expected `operation` label.
describe("emitServerDiagnostic on memory-handler storage failures (w4b)", () => {
  function recordingSink(): {
    readonly records: ServerDiagnosticRecord[];
    readonly diagnostics: { record: (record: ServerDiagnosticRecord) => void };
  } {
    const records: ServerDiagnosticRecord[] = [];
    return { records, diagnostics: { record: (record) => records.push(record) } };
  }

  function withCorrelation(ctx: RouteContext, correlationId: string): RouteContext {
    return { ...ctx, correlationId };
  }

  function expectMemoryStorageDiagnostic(
    records: readonly ServerDiagnosticRecord[],
    correlationId: string,
    operation: string,
  ): void {
    expect(records).toContainEqual(
      expect.objectContaining({ correlationId, operation, errorClass: "MemoryStorageError" }),
    );
  }

  it("reports a list failure", () => {
    const vault = makeVault();
    const { records, diagnostics } = recordingSink();
    const broken: MemoryVaultStore = {
      ...vault,
      listMemoryScopes: () => {
        throw new MemoryStorageError("internal", "simulated list failure");
      },
    };
    const result = handleListMemories(
      withCorrelation(makeCtx("/api/memory", {}), "corr-list-1"),
      makeDeps({ memoryVault: broken, diagnostics }),
    );
    expect(result.status).toBe(500);
    expectMemoryStorageDiagnostic(records, "corr-list-1", "memory.list");
  });

  it("reports a review-queue failure", () => {
    const vault = makeVault();
    const { records, diagnostics } = recordingSink();
    const broken: MemoryVaultStore = {
      ...vault,
      listMemoryScopes: () => {
        throw new MemoryStorageError("internal", "simulated review-queue failure");
      },
    };
    const result = handleMemoryReviewQueue(
      withCorrelation(makeCtx("/api/memory/review-queue", {}), "corr-review-1"),
      makeDeps({ memoryVault: broken, diagnostics }),
    );
    expect(result.status).toBe(500);
    expectMemoryStorageDiagnostic(records, "corr-review-1", "memory.review-queue");
  });

  it("reports a get failure", () => {
    const vault = makeVault();
    const { records, diagnostics } = recordingSink();
    const broken: MemoryVaultStore = {
      ...vault,
      getMemory: () => {
        throw new MemoryStorageError("internal", "simulated get failure");
      },
    };
    const result = handleGetMemory(
      withCorrelation(makeCtx("/api/memory/get-1", {}, { id: "get-1" }), "corr-get-1"),
      makeDeps({ memoryVault: broken, diagnostics }),
    );
    expect(result.status).toBe(500);
    expectMemoryStorageDiagnostic(records, "corr-get-1", "memory.get");
  });

  it("reports an edit failure", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("edit-1", "editable body"));
    const { records, diagnostics } = recordingSink();
    const broken: MemoryVaultStore = {
      ...vault,
      updateMemory: () => {
        throw new MemoryStorageError("internal", "simulated edit failure");
      },
    };
    const result = await handleEditMemory(
      withCorrelation(
        makeCtx("/api/memory/edit-1", { body: "new body" }, { id: "edit-1" }),
        "corr-edit-1",
      ),
      makeDeps({ memoryVault: broken, diagnostics }),
    );
    expect(result.status).toBe(500);
    expectMemoryStorageDiagnostic(records, "corr-edit-1", "memory.edit");
  });

  it("reports a pin failure", () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("pin-1", "pinnable body"));
    const { records, diagnostics } = recordingSink();
    const broken: MemoryVaultStore = {
      ...vault,
      updateMemory: () => {
        throw new MemoryStorageError("internal", "simulated pin failure");
      },
    };
    const result = handlePinMemory(
      withCorrelation(makeCtx("/api/memory/pin-1/pin", {}, { id: "pin-1" }), "corr-pin-1"),
      makeDeps({ memoryVault: broken, diagnostics }),
    );
    expect(result.status).toBe(500);
    expectMemoryStorageDiagnostic(records, "corr-pin-1", "memory.pin");
  });

  it("reports an unpin failure", () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("unpin-1", "pinned body", { pinned: true }));
    const { records, diagnostics } = recordingSink();
    const broken: MemoryVaultStore = {
      ...vault,
      updateMemory: () => {
        throw new MemoryStorageError("internal", "simulated unpin failure");
      },
    };
    const result = handleUnpinMemory(
      withCorrelation(makeCtx("/api/memory/unpin-1/unpin", {}, { id: "unpin-1" }), "corr-unpin-1"),
      makeDeps({ memoryVault: broken, diagnostics }),
    );
    expect(result.status).toBe(500);
    expectMemoryStorageDiagnostic(records, "corr-unpin-1", "memory.unpin");
  });

  it("reports an archive failure", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("archive-1", "archivable body"));
    const { records, diagnostics } = recordingSink();
    const broken: MemoryVaultStore = {
      ...vault,
      updateMemory: () => {
        throw new MemoryStorageError("internal", "simulated archive failure");
      },
    };
    const result = await handleArchiveMemory(
      withCorrelation(
        makeCtx("/api/memory/archive-1/archive", {}, { id: "archive-1" }),
        "corr-archive-1",
      ),
      makeDeps({ memoryVault: broken, diagnostics }),
    );
    expect(result.status).toBe(500);
    expectMemoryStorageDiagnostic(records, "corr-archive-1", "memory.archive");
  });

  it("reports a forget failure", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("forget-1", "forgettable body"));
    const { records, diagnostics } = recordingSink();
    const broken: MemoryVaultStore = {
      ...vault,
      deleteMemories: () => {
        throw new MemoryStorageError("internal", "simulated forget failure");
      },
    };
    const result = await handleForgetMemory(
      withCorrelation(
        makeCtx("/api/memory/forget-1/forget", { acknowledged: true }, { id: "forget-1" }),
        "corr-forget-1",
      ),
      makeDeps({ memoryVault: broken, diagnostics }),
    );
    expect(result.status).toBe(500);
    expectMemoryStorageDiagnostic(records, "corr-forget-1", "memory.forget");
  });

  it("reports a batch-forget failure", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("forget-batch-1", "forgettable body"));
    const { records, diagnostics } = recordingSink();
    const broken: MemoryVaultStore = {
      ...vault,
      deleteMemories: () => {
        throw new MemoryStorageError("internal", "simulated batch-forget failure");
      },
    };
    const result = await handleForgetMemories(
      withCorrelation(
        makeCtx("/api/memory/forget", {
          acknowledged: true,
          selector: { kind: "by-scope", scope: { kind: "global" } },
        }),
        "corr-forget-batch-1",
      ),
      makeDeps({ memoryVault: broken, diagnostics }),
    );
    expect(result.status).toBe(500);
    expectMemoryStorageDiagnostic(records, "corr-forget-batch-1", "memory.forget.batch");
  });

  it("reports a delete failure", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("delete-1", "deletable body"));
    const { records, diagnostics } = recordingSink();
    const broken: MemoryVaultStore = {
      ...vault,
      deleteMemories: () => {
        throw new MemoryStorageError("internal", "simulated delete failure");
      },
    };
    const result = await handleDeleteMemory(
      withCorrelation(
        makeCtx("/api/memory/delete-1", { acknowledged: true }, { id: "delete-1" }),
        "corr-delete-1",
      ),
      makeDeps({ memoryVault: broken, diagnostics }),
    );
    expect(result.status).toBe(500);
    expectMemoryStorageDiagnostic(records, "corr-delete-1", "memory.delete");
  });

  it("reports a destructive-preflight audit failure", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("preflight-1", "preflight body"));
    const { records, diagnostics } = recordingSink();
    const result = await handleForgetMemory(
      withCorrelation(
        makeCtx("/api/memory/preflight-1/forget", { acknowledged: true }, { id: "preflight-1" }),
        "corr-preflight-1",
      ),
      makeDeps({
        memoryVault: vault,
        diagnostics,
        evidenceStore: {
          put: () => {
            throw new Error("simulated evidence store failure");
          },
          list: () => [],
          get: () => undefined,
          delete: () => undefined,
        },
      }),
    );
    expect(result.status).toBe(500);
    expect(records).toContainEqual(
      expect.objectContaining({
        correlationId: "corr-preflight-1",
        operation: "memory.audit.preflight",
      }),
    );
  });

  it("reports a conflict-resolution failure", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("resolve-winner", "formatter is biome"));
    vault.insertMemory(makeMemory("resolve-loser", "formatter is prettier"));
    const { records, diagnostics } = recordingSink();
    const broken: MemoryVaultStore = {
      ...vault,
      updateMemory: () => {
        throw new MemoryStorageError("internal", "simulated conflict-resolve failure");
      },
    };
    const result = await handleResolveMemoryConflict(
      withCorrelation(
        makeCtx("/api/memory/conflicts/resolve", {
          winner: "resolve-winner",
          losers: ["resolve-loser"],
        }),
        "corr-resolve-1",
      ),
      makeDeps({ memoryVault: broken, diagnostics }),
    );
    expect(result.status).toBe(500);
    expectMemoryStorageDiagnostic(records, "corr-resolve-1", "memory.conflicts.resolve");
  });

  it("reports a correction failure", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("correct-1", "original body"));
    const { records, diagnostics } = recordingSink();
    const broken: MemoryVaultStore = {
      ...vault,
      insertMemory: () => {
        throw new MemoryStorageError("internal", "simulated correction failure");
      },
    };
    const result = await handleCorrectMemory(
      withCorrelation(
        makeCtx("/api/memory/correct-1/correct", { body: "corrected body" }, { id: "correct-1" }),
        "corr-correct-1",
      ),
      makeDeps({ memoryVault: broken, diagnostics }),
    );
    expect(result.status).toBe(500);
    expectMemoryStorageDiagnostic(records, "corr-correct-1", "memory.correct");
  });

  it("reports an accept-proposal failure", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("accept-1", "proposed body", { status: "proposed" }));
    const { records, diagnostics } = recordingSink();
    const broken: MemoryVaultStore = {
      ...vault,
      updateMemories: () => {
        throw new MemoryStorageError("internal", "simulated accept failure");
      },
    };
    const result = await handleAcceptMemoryProposal(
      withCorrelation(
        makeCtx("/api/memory/proposals/accept-1/accept", {}, { id: "accept-1" }),
        "corr-accept-1",
      ),
      makeDeps({ memoryVault: broken, diagnostics }),
    );
    expect(result.status).toBe(500);
    expectMemoryStorageDiagnostic(records, "corr-accept-1", "memory.proposals.accept");
  });

  it("reports a reject-proposal failure", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("reject-1", "proposed body", { status: "proposed" }));
    const { records, diagnostics } = recordingSink();
    const broken: MemoryVaultStore = {
      ...vault,
      updateMemory: () => {
        throw new MemoryStorageError("internal", "simulated reject failure");
      },
    };
    const result = await handleRejectMemoryProposal(
      withCorrelation(
        makeCtx("/api/memory/proposals/reject-1/reject", {}, { id: "reject-1" }),
        "corr-reject-1",
      ),
      makeDeps({ memoryVault: broken, diagnostics }),
    );
    expect(result.status).toBe(500);
    expectMemoryStorageDiagnostic(records, "corr-reject-1", "memory.proposals.reject");
  });

  it("mints a fresh correlation id when the route context carries none", () => {
    const vault = makeVault();
    const { records, diagnostics } = recordingSink();
    const broken: MemoryVaultStore = {
      ...vault,
      getMemory: () => {
        throw new MemoryStorageError("internal", "simulated get failure");
      },
    };
    const result = handleGetMemory(
      makeCtx("/api/memory/no-corr-1", {}, { id: "no-corr-1" }),
      makeDeps({ memoryVault: broken, diagnostics }),
    );
    expect(result.status).toBe(500);
    expect(records).toHaveLength(1);
    expect(typeof records[0]?.correlationId).toBe("string");
    expect(records[0]?.correlationId.length).toBeGreaterThan(0);
  });
});
