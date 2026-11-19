import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
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
import { GovernanceError } from "@oscharko-dev/keiko-memory-governance";
import {
  MEMORY_STATUSES,
  MEMORY_STATUS_TRANSITIONS,
  PROFILE_EXCLUDED_MEMORY_TAG,
  STANDING_FACT_RETENTION_POLICY_KEY,
} from "@oscharko-dev/keiko-contracts/runtime/memory";
import type {
  MemoryAuditEvent,
  MemoryConversationId,
  MemoryEdgeId,
  MemoryId,
  MemoryRecord,
  MemoryReviewerId,
  MemoryScope,
  MemoryUserId,
  MemoryWorkspaceId,
} from "@oscharko-dev/keiko-contracts";
import type { ProjectId } from "@oscharko-dev/keiko-contracts/memory";
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
  forgetStatementNotLearned,
  handleGetCorrectionPredecessors,
  handleGetMemory,
  handleListMemories,
  handleListMemoryTombstones,
  handleMemoryReviewQueue,
  handlePinMemory,
  handleRejectMemoryProposal,
  handleResolveMemoryConflict,
  handleUnpinMemory,
  forgetMemoryFromStatement,
} from "./memory-handlers.js";
import { standingProfileForUser } from "./memory-profile.js";
import { handleMemoryCaptureFromConversation } from "./memory-conv-handlers.js";
import { refreshMemoryEmbeddingAfterBodyEdit } from "./memory-embedding.js";
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
    correlationId: undefined,
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

function makeVaultDirectory(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-memory-handlers-"));
  tmpDirs.push(dir);
  return dir;
}

function makeVault(dir = makeVaultDirectory()): MemoryVaultStore {
  const vault = createMemoryVault({ memoryDir: dir, redactString: (s) => s });
  activeVaults.push(vault);
  return vault;
}

function makeReviewVaults(): readonly [MemoryVaultStore, MemoryVaultStore] {
  const options = {
    memoryDir: makeVaultDirectory(),
    vaultKey: Buffer.alloc(32, 67),
    redactString: (value: string): string => value,
  };
  const reader = createMemoryVault(options);
  const writer = createMemoryVault(options);
  activeVaults.push(reader, writer);
  return [reader, writer];
}

function interleaveAfterScopeRead<T>(read: () => T, write: () => void): T {
  const prepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")
    ?.value as DatabaseSync["prepare"];
  let restoreRead = (): void => undefined;
  let interleaved = false;
  const scopePrepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ): ReturnType<typeof prepare> {
    const statement = prepare.call(this, sql);
    if (sql.includes("SELECT DISTINCT scope_kind, scope_coordinate")) {
      const all = statement.all.bind(statement);
      const scopeRead = vi.spyOn(statement, "all").mockImplementationOnce((...params) => {
        const rows = all(...params);
        interleaved = true;
        write();
        return rows;
      });
      restoreRead = (): void => {
        scopeRead.mockRestore();
      };
    }
    return statement;
  });
  try {
    const result = read();
    expect(interleaved).toBe(true);
    return result;
  } finally {
    restoreRead();
    scopePrepare.mockRestore();
  }
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

// The person's own corrections, through the production correction and acceptance routes: three
// values of one fact, the first two superseded.
async function correctAndAccept(
  vault: MemoryVaultStore,
  id: string,
  body: string,
): Promise<MemoryId> {
  const proposal = await handleCorrectMemory(
    makeCtx(`/api/memory/${id}/correct`, { body }, { id }),
    makeDeps({ memoryVault: vault }),
  );
  const correction = asJson(proposal).correction as MemoryRecord;
  const accepted = await handleAcceptMemoryProposal(
    makeCtx(`/api/memory/proposals/${String(correction.id)}/accept`, {}, { id: correction.id }),
    makeDeps({ memoryVault: vault }),
  );
  expect(accepted.status).toBe(200);
  return correction.id;
}

async function threeValues(vault: MemoryVaultStore): Promise<{
  readonly first: MemoryId;
  readonly second: MemoryId;
  readonly third: MemoryId;
}> {
  vault.insertMemory(makeMemory("lineage-1", "Ich wohne in Köln"));
  const second = await correctAndAccept(vault, "lineage-1", "Ich wohne in Düsseldorf");
  const third = await correctAndAccept(vault, String(second), "Ich wohne in Bonn");
  return { first: memoryId("lineage-1"), second, third };
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

  it("reads only the requested sensitivity before matching a list search", () => {
    const vault = makeVault();
    const base = makeMemory("listed-public", "shared search term");
    vault.insertMemory(base);
    vault.insertMemory({
      ...base,
      id: memoryId("outside-sensitivity"),
      provenance: { ...base.provenance, sensitivity: "confidential" },
    });
    const reads = vi.spyOn(vault, "listMemoriesAcrossScopes");
    const result = handleListMemories(
      makeCtx("/api/memory?sensitivity=public&q=shared", {}),
      makeDeps({ memoryVault: vault }),
    );
    expect(result.status).toBe(200);
    expect(asJson(result).total).toBe(1);
    expect(reads.mock.results[0]?.value).toEqual([base]);
  });

  it("records only selection counts for an operator's list and review queue reads", () => {
    const vault = makeVault();
    vault.insertMemory(
      makeMemory("selection-fixture", "selection-fixture-body", { status: "proposed" }),
    );
    const deps = makeDeps({ memoryVault: vault });
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    try {
      expect(
        handleListMemories(makeCtx("/api/memory?q=missing-fixture-query", {}), deps).status,
      ).toBe(200);
      expect(handleMemoryReviewQueue(makeCtx("/api/memory/review-queue", {}), deps).status).toBe(
        200,
      );
    } finally {
      resetServerLogger();
    }
    const lines = sink.events
      .filter((event) => event.op === "memory.vault.records.selected")
      .map(formatActivityLogProofLine);
    const observations = lines.map((line) =>
      expectActivityLogProof("memory.vault.records.selected.line", line),
    );
    expect(observations).toMatchObject([
      { selection: "list", decodedCount: 1, selectedCount: 0 },
      { selection: "review-queue", decodedCount: 1, selectedCount: 1 },
    ]);
    expect(lines.join(" ")).not.toContain("fixture");
  });

  it("decrypts each reviewable memory once across every current status", () => {
    const vault = makeVault();
    for (const status of MEMORY_STATUSES) {
      for (const state of ["current", "stale"]) {
        const id = `${status}-${state}`;
        vault.insertMemory(
          makeMemory(id, id, {
            status,
            createdAt: 1,
            updatedAt: 1,
            ...(state === "stale" ? { staleReason: "superseded-source" } : {}),
          }),
        );
      }
    }
    const reads = vi.spyOn(vault, "listMemoryReviewQueue");
    const result = handleMemoryReviewQueue(
      makeCtx("/api/memory/review-queue", {}),
      makeDeps({ memoryVault: vault }),
    );
    expect(result.status).toBe(200);
    const queued = (asJson(result).memories as readonly MemoryRecord[]).map((memory) => memory.id);
    expect(queued).toEqual([
      "accepted-stale",
      "conflicted-current",
      "conflicted-stale",
      "expired-current",
      "expired-stale",
      "proposed-current",
      "proposed-stale",
      // "superseded-stale" is kept history, no review item (#4223, audit A5).
    ]);
    const decoded = reads.mock.results.flatMap((call) =>
      (call.value as readonly MemoryRecord[]).map((memory) => memory.id),
    );
    expect(decoded.sort((left, right) => left.localeCompare(right))).toEqual(queued);
  });

  it.each([
    ["proposed", "accepted"],
    ["accepted", "conflicted"],
  ] as const)(
    "reads one queue snapshot when another connection changes %s to %s",
    (before, after) => {
      const dir = makeVaultDirectory();
      const reader = makeVault(dir);
      const writer = makeVault(dir);
      const record = makeMemory("moving-review-record", "Synthetic review record", {
        status: before,
        staleReason: "changed-source",
      });
      reader.insertMemory(record);
      const read = reader.listMemoryReviewQueue;
      const selections = vi
        .spyOn(reader, "listMemoryReviewQueue")
        .mockImplementationOnce((...args) => {
          const rows = read(...args);
          writer.updateMemory(record.id, { status: after }, record.updatedAt + 1);
          return rows;
        });
      const statuses = (): readonly string[] => {
        const response = handleMemoryReviewQueue(
          makeCtx("/api/memory/review-queue", {}),
          makeDeps({ memoryVault: reader }),
        );
        expect(response.status).toBe(200);
        return (asJson(response).memories as readonly MemoryRecord[]).map(
          (memory) => memory.status,
        );
      };
      expect(statuses()).toEqual([before]);
      expect(selections).toHaveBeenCalledTimes(1);
      expect(statuses()).toEqual([after]);
    },
  );

  it.each([
    { kind: "global" },
    { kind: "user", userId: "shared-coordinate" },
    { kind: "project", projectId: "shared-coordinate" },
    { kind: "workspace", workspaceId: "shared-coordinate" },
    { kind: "workflow", workflowDefinitionId: "shared-coordinate" },
  ] as readonly MemoryScope[])(
    "keeps a queue snapshot when a new %j scope is inserted",
    (scope) => {
      const [reader, writer] = makeReviewVaults();
      const previous = makeMemory("existing-scope-record", "Synthetic existing preference", {
        scope: { kind: "project", projectId: "existing-project" as ProjectId },
        status: "accepted",
        createdAt: 20,
        updatedAt: 20,
      });
      const stable = makeMemory("stable-user-review", "Synthetic personal preference", {
        scope: { kind: "user", userId: userId("stable-user") },
        status: "proposed",
        createdAt: 30,
        updatedAt: 30,
      });
      reader.insertMemory(previous);
      reader.insertMemory(stable);
      const deps = makeDeps({ memoryVault: reader });
      const read = (): RouteResult =>
        handleMemoryReviewQueue(makeCtx("/api/memory/review-queue", {}), deps);
      const result = interleaveAfterScopeRead(read, () => {
        writer.insertMemory(
          makeMemory("new-scope-record", "Synthetic new preference", {
            scope,
            status: "proposed",
            createdAt: 10,
            updatedAt: 10,
          }),
        );
        writer.updateMemory(previous.id, { status: "conflicted" }, 21);
      });
      expect(result.status).toBe(200);
      expect((asJson(result).memories as readonly MemoryRecord[]).map(({ id }) => id)).toEqual([
        stable.id,
      ]);
      expect((asJson(read()).memories as readonly MemoryRecord[]).map(({ id }) => id)).toEqual([
        stable.id,
        previous.id,
        "new-scope-record",
      ]);
    },
  );

  it("reads a consistent empty queue while the first scope is concurrently inserted", () => {
    const [reader, writer] = makeReviewVaults();
    const deps = makeDeps({ memoryVault: reader });
    const read = (): RouteResult =>
      handleMemoryReviewQueue(makeCtx("/api/memory/review-queue", {}), deps);
    const result = interleaveAfterScopeRead(read, () => {
      writer.insertMemory(
        makeMemory("first-review-record", "Synthetic preference", { status: "proposed" }),
      );
    });
    expect(result.status).toBe(200);
    expect(asJson(result).total).toBe(0);
    expect(asJson(read()).total).toBe(1);
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

  it("takes an unpinned fact out of the standing profile until it is pinned again (#4228)", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const person = userId("local-operator");
    vault.insertMemory(
      makeMemory("memory-profile-pin", "Bevorzugt Tabellen.", {
        scope: { kind: "user", userId: person },
        pinned: true,
        tags: ["format"],
      }),
    );
    const id = memoryId("memory-profile-pin");
    const inProfile = (): boolean =>
      standingProfileForUser(vault, person, Date.now()).entries.some((entry) => entry.id === id);
    const route = (action: string): RouteContext =>
      makeCtx(`/api/memory/${id}/${action}`, {}, { id });
    expect(inProfile()).toBe(true);

    expect(handleUnpinMemory(route("unpin"), deps).status).toBe(200);
    expect(inProfile()).toBe(false);
    // The person edits their own tags; the removal from the profile survives the edit.
    const edited = await handleEditMemory(
      makeCtx(`/api/memory/${id}`, { tags: ["format", PROFILE_EXCLUDED_MEMORY_TAG] }, { id }),
      deps,
    );
    expect(edited.status).toBe(200);
    expect(vault.getMemory(id)?.tags).toEqual(["format", PROFILE_EXCLUDED_MEMORY_TAG]);
    expect(inProfile()).toBe(false);

    expect(handlePinMemory(route("pin"), deps).status).toBe(200);
    expect(vault.getMemory(id)?.tags).toEqual(["format"]);
    expect(inProfile()).toBe(true);
    // A person cannot set Keiko's own tag through an edit.
    await handleEditMemory(
      makeCtx(`/api/memory/${id}`, { tags: [PROFILE_EXCLUDED_MEMORY_TAG] }, { id }),
      deps,
    );
    expect(vault.getMemory(id)?.tags).toEqual([]);
    expect(inProfile()).toBe(true);
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

  it("makes a learned memory the person's own statement once they rewrite it", async () => {
    const vault = makeVault();
    const learned = makeMemory("memory-edit-learned", "Ich nutze PostgreSQL 14", {
      provenance: {
        sourceKind: "explicit-user-instruction",
        capturedAt: Date.now(),
        confidence: 0.85,
        sensitivity: "public",
        evidenceSpan: "Ich nutze PostgreSQL 14",
        sourceMessageIds: ["message-1"],
      },
    });
    vault.insertMemory(learned);
    vault.insertMemory(
      makeMemory("memory-edit-tagged", "Ich nutze Vim", { provenance: learned.provenance }),
    );

    const edited = await handleEditMemory(
      makeCtx(
        "/api/memory/memory-edit-learned",
        { body: "Ich nutze PostgreSQL 16" },
        { id: "memory-edit-learned" },
      ),
      makeDeps({ memoryVault: vault }),
    );
    const tagged = await handleEditMemory(
      makeCtx("/api/memory/memory-edit-tagged", { tags: ["db"] }, { id: "memory-edit-tagged" }),
      makeDeps({ memoryVault: vault }),
    );

    expect(edited.status).toBe(200);
    const provenance = vault.getMemory(memoryId("memory-edit-learned"))?.provenance;
    expect(provenance?.evidenceSpan).toBeUndefined();
    expect(provenance?.sourceMessageIds).toEqual(["message-1"]);
    expect(tagged.status).toBe(200);
    expect(vault.getMemory(memoryId("memory-edit-tagged"))?.provenance.evidenceSpan).toBe(
      "Ich nutze PostgreSQL 14",
    );
  });

  it.each([
    [{ body: "Updated synthetic preference" }, "confidential", false],
    [{ tags: ["updated"] }, "confidential", true],
    [{ body: "Updated synthetic preference", sensitivity: "public" }, "public", false],
    [{ sensitivity: "restricted" }, "restricted", true],
  ] as const)(
    "preserves concurrent edit metadata for %j",
    async (input, sensitivity, evidenceSpanPresent) => {
      const dir = makeVaultDirectory();
      const reader = makeVault(dir);
      const writer = makeVault(dir);
      const learned = makeMemory("concurrent-edit", "Original synthetic preference");
      reader.insertMemory({
        ...learned,
        provenance: { ...learned.provenance, evidenceSpan: learned.body },
      });
      const originalRead = reader.getMemory;
      vi.spyOn(reader, "getMemory").mockImplementationOnce((id) => {
        const snapshot = originalRead(id);
        writer.updateMemory(
          learned.id,
          {
            status: "conflicted",
            provenance: {
              ...learned.provenance,
              sensitivity: "confidential",
              confidence: 0.75,
              sourceMessageIds: ["concurrent-source"],
              evidenceSpan: learned.body,
            },
          },
          learned.updatedAt + 1,
        );
        return snapshot;
      });
      const deps = makeDeps({ memoryVault: reader });
      const ctx = makeCtx("/api/memory/concurrent-edit", input, { id: learned.id });
      const result = await handleEditMemory(ctx, deps);
      expect(result.status).toBe(200);
      const reread = handleGetMemory(makeCtx(ctx.url.pathname, {}, ctx.params), deps);
      expect(reread.status).toBe(200);
      for (const response of [result, reread]) {
        expect(asJson(response).memory).toMatchObject({
          id: learned.id,
          body: "body" in input ? input.body : learned.body,
          status: "conflicted",
          provenance: { sensitivity, confidence: 0.75, sourceMessageIds: ["concurrent-source"] },
        });
      }
      const stored = writer.getMemory(learned.id);
      expect(stored?.provenance.evidenceSpan !== undefined).toBe(evidenceSpanPresent);
      expect(stored?.tags).toEqual("tags" in input ? input.tags : []);
    },
  );

  it("preserves a concurrent profile exclusion while editing tags", async () => {
    const dir = makeVaultDirectory();
    const reader = makeVault(dir);
    const writer = makeVault(dir);
    const record = makeMemory("concurrent-profile-tag", "Synthetic preference");
    reader.insertMemory(record);
    const originalRead = reader.getMemory;
    vi.spyOn(reader, "getMemory").mockImplementationOnce((id) => {
      const snapshot = originalRead(id);
      writer.updateMemory(record.id, { tags: [PROFILE_EXCLUDED_MEMORY_TAG] }, record.updatedAt + 1);
      return snapshot;
    });
    const result = await handleEditMemory(
      makeCtx("/api/memory/concurrent-profile-tag", { tags: ["updated"] }, { id: record.id }),
      makeDeps({ memoryVault: reader }),
    );
    expect(result.status).toBe(200);
    expect(writer.getMemory(record.id)?.tags).toEqual(["updated", PROFILE_EXCLUDED_MEMORY_TAG]);
  });

  it.each([0, 1])("records one body-free edit settlement after %i conflicts", async (conflicts) => {
    const dir = makeVaultDirectory();
    const reader = makeVault(dir);
    const writer = makeVault(dir);
    const record = makeMemory("logged-edit", "Original synthetic preference");
    reader.insertMemory(record);
    const conditionalUpdate = reader.updateMemories;
    let interleaved = 0;
    vi.spyOn(reader, "updateMemories").mockImplementation((updates) => {
      if (interleaved < conflicts) {
        writer.updateMemory(record.id, { status: "conflicted" }, Date.now());
        interleaved += 1;
      }
      return conditionalUpdate(updates);
    });
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    try {
      const result = await handleEditMemory(
        makeCtx(
          "/api/memory/logged-edit",
          { body: "Updated synthetic preference" },
          { id: record.id },
        ),
        makeDeps({ memoryVault: reader }),
      );
      expect(result.status).toBe(200);
    } finally {
      resetServerLogger();
    }
    const settlements = sink.events.filter((event) => event.op === "memory.edit.settled");
    expect(settlements).toHaveLength(1);
    const [settled] = settlements;
    if (settled === undefined) throw new TypeError("Missing edit settlement");
    const line = formatActivityLogProofLine(settled);
    expectActivityLogProof("memory.edit.settled.line", line);
    expect(line).not.toContain(record.body);
    expect(line).not.toContain(record.id);
    expect(settled.extra).toMatchObject({ outcome: "updated", attemptCount: conflicts + 1 });
  });

  it("refuses a stale editor revision and accepts the current revision", async () => {
    const vault = makeVault();
    const initial = makeMemory("review-edit", "Initial body");
    vault.insertMemory(initial);
    const other = vault.updateMemory(
      initial.id,
      { body: "Edit from another window" },
      initial.updatedAt,
    );
    const deps = makeDeps({ memoryVault: vault });
    const edit = (expectedUpdatedAt: unknown): ReturnType<typeof handleEditMemory> =>
      handleEditMemory(
        makeCtx(
          "/api/memory/review-edit",
          { body: "My draft", expectedUpdatedAt },
          { id: initial.id },
        ),
        deps,
      );
    expect((await edit(initial.updatedAt)).status).toBe(409);
    expect(vault.getMemory(initial.id)?.body).toBe(other.body);
    expect((await edit("unversioned")).status).toBe(400);
    expect((await edit(other.updatedAt)).status).toBe(200);
    expect(vault.getMemory(initial.id)?.body).toBe("My draft");
  });

  it.each([{ value: [17] }, { value: ["valid", 17] }, { value: "wrong" }, { value: null }])(
    "rejects malformed tag replacements without a revision or content change",
    async ({ value: tags }) => {
      const vault = makeVault();
      const original = { ...makeMemory("invalid-edit-tags", "Existing body"), tags: ["kept"] };
      vault.insertMemory(original);
      const deps = makeDeps({ memoryVault: vault });
      const edit = (replacement: unknown): ReturnType<typeof handleEditMemory> =>
        handleEditMemory(
          makeCtx("/api/memory/invalid-edit-tags", { tags: replacement }, { id: original.id }),
          deps,
        );
      expect((await edit(tags)).status).toBe(400);
      expect(vault.getMemory(original.id)).toEqual(original);
      expect((await edit([])).status).toBe(200);
      expect(vault.getMemory(original.id)?.tags).toEqual([]);
    },
  );

  it("returns a bounded edit conflict without embedding or overwriting a competing update", async () => {
    const dir = makeVaultDirectory();
    const reader = makeVault(dir);
    const writer = makeVault(dir);
    const record = makeMemory("repeated-edit-conflict", "Original synthetic preference");
    reader.insertMemory(record);
    const conditionalUpdate = reader.updateMemories;
    const attempts = vi.spyOn(reader, "updateMemories").mockImplementation((updates) => {
      writer.updateMemory(record.id, { tags: ["concurrent-update"] }, Date.now());
      return conditionalUpdate(updates);
    });
    const embeddingRequest = vi.fn();
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    let result: RouteResult;
    try {
      result = await handleEditMemory(
        makeCtx(
          "/api/memory/repeated-edit-conflict",
          { body: "Updated synthetic preference" },
          {
            id: record.id,
          },
        ),
        makeDeps({
          memoryVault: reader,
          config: embeddingConfig(),
          localKnowledgeEmbeddingRequest: embeddingRequest,
        }),
      );
    } finally {
      resetServerLogger();
    }
    expect(result.status).toBe(409);
    expect(asJson(result).error).toMatchObject({ code: "MEMORY_ERROR" });
    expect(attempts).toHaveBeenCalledTimes(3);
    expect(embeddingRequest).not.toHaveBeenCalled();
    expect(writer.getMemory(record.id)).toMatchObject({
      body: record.body,
      status: record.status,
      tags: ["concurrent-update"],
    });
    const settlements = sink.events.filter((event) => event.op === "memory.edit.settled");
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.extra).toMatchObject({
      outcome: "conflict",
      attemptCount: 3,
    });
  });

  it.each(["before-read", "before-write"] as const)(
    "settles an edit exactly once when concurrently deleted %s",
    async (timing) => {
      const dir = makeVaultDirectory();
      const reader = makeVault(dir);
      const writer = makeVault(dir);
      const record = makeMemory("deleted-during-edit", "Synthetic preference");
      reader.insertMemory(record);
      const originalRead = reader.getMemory;
      vi.spyOn(reader, "getMemory").mockImplementationOnce((id) => {
        const snapshot = timing === "before-read" ? undefined : originalRead(id);
        writer.deleteMemory(record.id, {
          tombstone: true,
          forgetterSurface: "memoria",
          nowMs: record.updatedAt + 1,
        });
        return timing === "before-read" ? originalRead(id) : snapshot;
      });
      const deps = makeDeps({ memoryVault: reader });
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "info" }));
      let result: RouteResult;
      try {
        result = await handleEditMemory(
          makeCtx("/api/memory/deleted-during-edit", { tags: ["updated"] }, { id: record.id }),
          deps,
        );
      } finally {
        resetServerLogger();
      }
      expect(result.status).toBe(404);
      expect(asJson(result).error).toMatchObject({
        code: timing === "before-read" ? "NOT_FOUND" : "MEMORY_ERROR",
      });
      const reread = handleGetMemory(
        makeCtx("/api/memory/deleted-during-edit", {}, { id: record.id }),
        deps,
      );
      expect(reread.status).toBe(404);
      expect(writer.getMemory(record.id)).toBeUndefined();
      const settlements = sink.events.filter((event) => event.op === "memory.edit.settled");
      expect(settlements).toHaveLength(1);
      expect(settlements[0]?.extra).toMatchObject({ outcome: "not-found", attemptCount: 1 });
    },
  );

  it.each(["unchanged", "unrelated", "metadata"] as const)(
    "stores the edited version's vector with an %s competing record",
    async (change) => {
      const [reader, writer] = makeReviewVaults();
      const record = reader.insertMemory(makeMemory("embedding-current", "Initial preference"));
      const unrelated = reader.insertMemory(makeMemory("embedding-unrelated", "Other preference"));
      const body = "Current synthetic preference";
      let finish: (result: OpenAIEmbeddingOutcome) => void = () => {
        throw new TypeError("Embedding request not started");
      };
      let reportStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        reportStarted = resolve;
      });
      const deferred = new Promise<OpenAIEmbeddingOutcome>((resolve) => {
        finish = resolve;
      });
      const request = vi.fn(() => {
        reportStarted();
        return deferred;
      });
      const deps = makeDeps({
        memoryVault: reader,
        config: embeddingConfig(),
        configPresent: true,
        localKnowledgeEmbeddingRequest: request,
      });
      const edit = handleEditMemory(
        makeCtx(`/api/memory/${record.id}`, { body }, { id: record.id }),
        deps,
      );
      await started;
      if (change === "unrelated") {
        writer.updateMemory(unrelated.id, { tags: ["updated"] }, unrelated.updatedAt);
      } else if (change === "metadata") {
        writer.updateMemory(record.id, { tags: ["updated"] }, record.updatedAt);
      }
      finish({ ok: true, value: { modelId: EMBEDDING_MODEL, vector: vectorForText(body) } });
      expect((await edit).status).toBe(200);
      expect(writer.getMemory(record.id)?.body).toBe(body);
      expect(writer.getMemory(record.id)?.tags).toEqual(change === "metadata" ? ["updated"] : []);
      expect(Array.from(writer.getEmbedding(record.id)?.vector ?? [])).toEqual(
        Array.from(vectorForText(body)),
      );
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["success", "transport", "rejected-vector"] as const)(
    "keeps the newer edit's vector after an older refresh finishes with %s",
    async (outcome) => {
      const [reader, writer] = makeReviewVaults();
      const record = reader.insertMemory(makeMemory("embedding-edit-race", "Initial preference"));
      const olderBody = "Earlier synthetic preference";
      const newerBody = "Latest synthetic preference";
      let finishOlder: (result: OpenAIEmbeddingOutcome) => void = () => {
        throw new TypeError("Older embedding request not started");
      };
      let reportStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        reportStarted = resolve;
      });
      const delayed = new Promise<OpenAIEmbeddingOutcome>((resolve) => {
        finishOlder = resolve;
      });
      const embeddingRequest = vi.fn(
        (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> => {
          if (request.input === olderBody) {
            reportStarted();
            return delayed;
          }
          return Promise.resolve({
            ok: true,
            value: { modelId: request.modelId, vector: vectorForText(request.input) },
          });
        },
      );
      const deps = makeDeps({
        memoryVault: reader,
        config: embeddingConfig(),
        configPresent: true,
        localKnowledgeEmbeddingRequest: embeddingRequest,
      });
      const edit = (body: string): ReturnType<typeof handleEditMemory> =>
        handleEditMemory(makeCtx(`/api/memory/${record.id}`, { body }, { id: record.id }), deps);
      const older = edit(olderBody);
      await started;
      expect((await edit(newerBody)).status).toBe(200);
      const current = writer.getMemory(record.id);
      const currentVector = writer.getEmbedding(record.id);
      expect(current?.body).toBe(newerBody);
      expect(Array.from(currentVector?.vector ?? [])).toEqual(Array.from(vectorForText(newerBody)));
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "info" }));
      try {
        finishOlder(
          outcome === "transport"
            ? { ok: false, kind: "transport" }
            : {
                ok: true,
                value: {
                  modelId: EMBEDDING_MODEL,
                  vector:
                    outcome === "rejected-vector" ? new Float32Array() : vectorForText(olderBody),
                },
              },
        );
        expect((await older).status).toBe(200);
      } finally {
        resetServerLogger();
      }
      expect(writer.getMemory(record.id)).toEqual(current);
      expect(writer.getEmbedding(record.id)).toEqual(currentVector);
      const skipped = sink.events.filter(
        (event) => event.op === "memory.embedding.refresh.skipped",
      );
      expect(skipped).toHaveLength(1);
      expect(sink.events.some((event) => event.op === "memory.embedding.invalidated")).toBe(false);
      expect(sink.events.some((event) => event.op === "memory.embedding.store-rejected")).toBe(
        false,
      );
      const line = formatActivityLogProofLine(skipped[0] ?? {});
      expectActivityLogProof("memory.embedding.refresh.skipped.line", line);
      expect(line).not.toContain(olderBody);
      expect(line).not.toContain(newerBody);
      expect(line).not.toContain(record.id);
      expect(embeddingRequest).toHaveBeenCalledTimes(2);
      const reread = handleGetMemory(
        makeCtx(`/api/memory/${record.id}`, {}, { id: record.id }),
        deps,
      );
      expect(asJson(reread).memory).toMatchObject({
        body: newerBody,
        updatedAt: current?.updatedAt,
      });
    },
  );

  it.each(["body-changed", "deleted"] as const)(
    "skips provider work when a refresh already has a %s body binding",
    async (change) => {
      const [reader, writer] = makeReviewVaults();
      const record = reader.insertMemory(makeMemory("refresh-already-stale", "Old synthetic body"));
      if (change === "body-changed") {
        writer.updateMemory(record.id, { body: "Current synthetic body" }, record.updatedAt);
        writer.upsertEmbedding(record.id, {
          provider: "synthetic-provider",
          modelId: EMBEDDING_MODEL,
          metric: "cosine",
          vector: vectorForText("Current synthetic body"),
        });
      } else {
        writer.deleteMemory(record.id, {
          tombstone: true,
          forgetterSurface: "memory-center",
          nowMs: record.updatedAt,
        });
      }
      const current = writer.getEmbedding(record.id);
      const request = vi.fn();
      await refreshMemoryEmbeddingAfterBodyEdit(
        makeDeps({
          config: embeddingConfig(),
          configPresent: true,
          localKnowledgeEmbeddingRequest: request,
        }),
        reader,
        record.id,
        record.body,
      );
      expect(request).not.toHaveBeenCalled();
      expect(writer.getEmbedding(record.id)).toEqual(current);
    },
  );

  it.each([false, true])(
    "binds a delayed capture vector after a manual edit %s",
    async (edited) => {
      const [reader, writer] = makeReviewVaults();
      let finish: (result: OpenAIEmbeddingOutcome) => void = () => {
        throw new TypeError("Capture embedding not started");
      };
      let reportStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        reportStarted = resolve;
      });
      const deferred = new Promise<OpenAIEmbeddingOutcome>((resolve) => {
        finish = resolve;
      });
      let requestCount = 0;
      const request = vi.fn((input: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> => {
        requestCount += 1;
        if (requestCount === 1) {
          reportStarted();
          return deferred;
        }
        return Promise.resolve({
          ok: true,
          value: { modelId: input.modelId, vector: vectorForText(input.input) },
        });
      });
      const deps = makeDeps({
        memoryVault: reader,
        config: embeddingConfig(),
        configPresent: true,
        localKnowledgeEmbeddingRequest: request,
      });
      const projectPath = makeVaultDirectory();
      deps.store.createProject(projectPath, "synthetic-capture");
      const chat = deps.store.createChat(projectPath, "synthetic-capture", "synthetic-model");
      const capture = handleMemoryCaptureFromConversation(
        makeCtx("/api/memory/capture-from-conversation", {
          text: "remember that we use pnpm not npm for installs",
          context: { projectPath, chatId: chat.id },
        }),
        deps,
      );
      await started;
      const captured = writer.listMemoriesAcrossScopes(writer.listMemoryScopes())[0];
      if (captured === undefined) throw new TypeError("Missing captured synthetic memory");
      const expectedBody = edited ? "Latest synthetic capture preference" : captured.body;
      if (edited) {
        const result = await handleEditMemory(
          makeCtx(`/api/memory/${captured.id}`, { body: expectedBody }, { id: captured.id }),
          deps,
        );
        expect(result.status).toBe(200);
      }
      finish({
        ok: true,
        value: { modelId: EMBEDDING_MODEL, vector: vectorForText(captured.body) },
      });
      expect((await capture).status).toBe(200);
      expect(writer.getMemory(captured.id)?.body).toBe(expectedBody);
      expect(Array.from(writer.getEmbedding(captured.id)?.vector ?? [])).toEqual(
        Array.from(vectorForText(expectedBody)),
      );
      expect(request).toHaveBeenCalledTimes(edited ? 2 : 1);
    },
  );

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

  it("creates a correction proposal with a provenance-preserving predecessor binding", async () => {
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
    expect(edges[0]?.kind).toBe("corrects");
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
    expect(asJson(acceptResult).supersededMemoryIds).toEqual([memoryId("memory-correct-accept")]);
    const superseded = vault.getMemory(memoryId("memory-correct-accept"));
    expect(superseded?.status).toBe("superseded");
    // Bi-temporal-lite (#204, C1): the superseded fact's belief window is CLOSED at acceptance, so
    // "what did we believe as of T" is answerable and it drops out of default retrieval.
    expect(superseded?.validity.validUntil).toBeGreaterThan(superseded?.validity.validFrom ?? 0);
    expect(vault.getMemory(correction.id)?.status).toBe("accepted");
    expect(
      vault
        .listOutgoingEdges(memoryId("memory-correct-accept"))
        .some((edge) => edge.kind === "supersedes" && edge.toMemoryId === correction.id),
    ).toBe(true);
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

  it("lets an accepted correction take the corrected fact's place in the profile (#4228)", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const person = { kind: "user", userId: userId("local-operator") } as const;
    vault.insertMemory(
      makeMemory("memory-profile-pinned", "Arbeitet vormittags.", {
        scope: person,
        type: "episodic",
        pinned: true,
      }),
    );
    vault.insertMemory(
      makeMemory("memory-profile-removed", "Bevorzugt Tabellen.", {
        scope: person,
        tags: [PROFILE_EXCLUDED_MEMORY_TAG],
      }),
    );
    const correctAndAccept = async (id: string, body: string): Promise<MemoryRecord> => {
      const proposed = await handleCorrectMemory(
        makeCtx(`/api/memory/${id}/correct`, { body }, { id }),
        deps,
      );
      const correction = asJson(proposed).correction as MemoryRecord;
      const accepted = await handleAcceptMemoryProposal(
        makeCtx(`/api/memory/proposals/${String(correction.id)}/accept`, {}, { id: correction.id }),
        deps,
      );
      expect(accepted.status).toBe(200);
      const stored = vault.getMemory(correction.id);
      if (stored === undefined) throw new Error("correction missing");
      return stored;
    };
    const inProfile = (id: MemoryId): boolean =>
      standingProfileForUser(vault, person.userId, Date.now()).entries.some(
        (entry) => entry.id === id,
      );

    const afternoon = await correctAndAccept("memory-profile-pinned", "Arbeitet nachmittags.");
    expect(afternoon.retentionHint?.policyKey).toBe(STANDING_FACT_RETENTION_POLICY_KEY);
    expect(inProfile(afternoon.id)).toBe(true);
    const lists = await correctAndAccept("memory-profile-removed", "Bevorzugt Listen.");
    expect(lists.tags).toContain(PROFILE_EXCLUDED_MEMORY_TAG);
    expect(inProfile(lists.id)).toBe(false);
  });

  it("returns the bound predecessor to the authorized review surface", () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("memory-correction-candidate", "Prefer yarn."));
    const correction = vault.insertMemory(
      makeMemory("memory-correction-proposal", "Prefer npm ci.", {
        type: "correction",
        status: "proposed",
      }),
    );
    vault.insertEdge({
      id: "memory-correction-binding" as MemoryEdgeId,
      schemaVersion: "1",
      fromMemoryId: memoryId("memory-correction-candidate"),
      toMemoryId: correction.id,
      kind: "corrects",
      createdAt: correction.createdAt,
    });

    const result = handleGetCorrectionPredecessors(
      makeCtx(
        `/api/memory/proposals/${correction.id}/correction-predecessors`,
        {},
        {
          id: correction.id,
        },
      ),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(200);
    expect(asJson(result)).toMatchObject({
      candidates: [{ id: "memory-correction-candidate", body: "Prefer yarn." }],
    });
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

    expect(acceptResult.status).toBe(409);
    expect(vault.getMemory(correction.id)?.status).toBe("proposed");
    expect(vault.getMemory(memoryId("memory-correct-archived"))?.status).toBe("archived");
  });

  it("fails closed when a bound predecessor has already been superseded", async () => {
    const vault = makeVault();
    vault.insertMemory(
      makeMemory("memory-correct-superseded", "Prefer yarn.", { status: "superseded" }),
    );
    const correction = vault.insertMemory(
      makeMemory("memory-correct-superseded-proposal", "Prefer npm ci.", {
        type: "correction",
        status: "proposed",
      }),
    );
    vault.insertEdge({
      id: "memory-correct-superseded-binding" as MemoryEdgeId,
      schemaVersion: "1",
      fromMemoryId: memoryId("memory-correct-superseded"),
      toMemoryId: correction.id,
      kind: "corrects",
      createdAt: correction.createdAt,
    });

    const result = await handleAcceptMemoryProposal(
      makeCtx(`/api/memory/proposals/${correction.id}/accept`, {}, { id: correction.id }),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(409);
    expect((asJson(result).error as { code: string }).code).toBe(
      "CORRECTION_PREDECESSOR_ALREADY_SUPERSEDED",
    );
    expect(vault.getMemory(correction.id)?.status).toBe("proposed");
  });

  it("fails closed when the caller loses authorization for a bound predecessor", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("memory-correct-forbidden", "Prefer yarn."));
    const proposalResult = await handleCorrectMemory(
      makeCtx(
        "/api/memory/memory-correct-forbidden/correct",
        { body: "Prefer npm ci." },
        { id: "memory-correct-forbidden" },
      ),
      makeDeps({ memoryVault: vault }),
    );
    const correction = asJson(proposalResult).correction as MemoryRecord;

    const result = await handleAcceptMemoryProposal(
      makeCtx(`/api/memory/proposals/${correction.id}/accept`, {}, { id: correction.id }),
      makeDeps({
        memoryVault: vault,
        memoryAuthorization: {
          reviewerId: reviewerId("scope-limited-reviewer"),
          authorizedScopes: () => [{ kind: "workspace", workspaceId: workspaceId("allowed") }],
        },
      }),
    );

    expect(result.status).toBe(403);
    expect((asJson(result).error as { code: string }).code).toBe("MEMORY_SCOPE_FORBIDDEN");
    expect(vault.getMemory(correction.id)?.status).toBe("proposed");
  });

  it("fails closed when acceptance loses its predecessor version race", async () => {
    const vault = makeVault();
    const original = vault.insertMemory(makeMemory("memory-correct-race", "Prefer yarn."));
    const proposalResult = await handleCorrectMemory(
      makeCtx(
        "/api/memory/memory-correct-race/correct",
        { body: "Prefer npm ci." },
        { id: "memory-correct-race" },
      ),
      makeDeps({ memoryVault: vault }),
    );
    const correction = asJson(proposalResult).correction as MemoryRecord;
    const applyGraphMutation = vault.applyGraphMutation.bind(vault);
    vi.spyOn(vault, "applyGraphMutation").mockImplementationOnce((mutation) => {
      vault.updateMemory(original.id, { status: "archived" }, original.updatedAt + 1);
      return applyGraphMutation(mutation);
    });

    const result = await handleAcceptMemoryProposal(
      makeCtx(`/api/memory/proposals/${correction.id}/accept`, {}, { id: correction.id }),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(409);
    expect((asJson(result).error as { code: string }).code).toBe("CORRECTION_PREDECESSOR_STALE");
    expect(vault.getMemory(correction.id)?.status).toBe("proposed");
    expect(vault.listOutgoingEdges(original.id).some((edge) => edge.kind === "supersedes")).toBe(
      false,
    );
  });

  it("attributes a proposal version race to the proposal rather than its predecessor", async () => {
    const vault = makeVault();
    const original = vault.insertMemory(makeMemory("memory-correct-proposal-race", "Prefer yarn."));
    const proposalResult = await handleCorrectMemory(
      makeCtx(
        "/api/memory/memory-correct-proposal-race/correct",
        { body: "Prefer npm ci." },
        { id: "memory-correct-proposal-race" },
      ),
      makeDeps({ memoryVault: vault }),
    );
    const correction = asJson(proposalResult).correction as MemoryRecord;
    const applyGraphMutation = vault.applyGraphMutation.bind(vault);
    vi.spyOn(vault, "applyGraphMutation").mockImplementationOnce((mutation) => {
      vault.updateMemory(correction.id, { status: "archived" }, correction.updatedAt + 1);
      return applyGraphMutation(mutation);
    });

    const result = await handleAcceptMemoryProposal(
      makeCtx(`/api/memory/proposals/${correction.id}/accept`, {}, { id: correction.id }),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(409);
    expect((asJson(result).error as { code: string }).code).toBe("PROPOSAL_STALE");
    expect(vault.getMemory(original.id)?.status).toBe("accepted");
    expect(vault.listOutgoingEdges(original.id).some((edge) => edge.kind === "supersedes")).toBe(
      false,
    );
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

  // #4223: history is deletable by the person, and that deletion refuses a later relearning.
  it("lets the person forget a superseded record, and the forget refuses its body", async () => {
    const vault = makeVault();
    const now = Date.now();
    vault.insertMemory(
      makeMemory("memory-history-1", "Ich bevorzuge Tabs über Spaces", {
        status: "superseded",
        validity: { validFrom: now - 1_000, validUntil: now - 1 },
      }),
    );

    const result = await handleForgetMemory(
      makeCtx(
        "/api/memory/memory-history-1/forget",
        { acknowledged: true, reason: "user-request" },
        { id: "memory-history-1" },
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
    expect(vault.getMemory(memoryId("memory-history-1"))).toBeUndefined();
    const [tombstone] = vault.listTombstonesByScope({ kind: "global" });
    expect(tombstone?.originalStatus).toBe("superseded");
    expect(tombstone?.forgetterSurface).not.toBe("memory-maintenance");
    expect(
      vault.hasForgetTombstoneForBody({ kind: "global" }, "Ich bevorzuge Tabs über Spaces"),
    ).toBe(true);
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

  describe("Memory window forget leaves its own Activity Log line (#4206 AC 5)", () => {
    async function forgetWithLog(
      id: string,
      deps: UiHandlerDeps,
      handler: typeof handleForgetMemory = handleForgetMemory,
    ): Promise<{ result: RouteResult; events: BufferedServerLogSink["events"] }> {
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "info" }));
      try {
        const ctx = makeCtx(`/api/memory/${id}/forget`, { acknowledged: true }, { id });
        const result = await handler({ ...ctx, correlationId: "corr-forget-1" }, deps);
        return { result, events: forgetEvents(sink.events) };
      } finally {
        resetServerLogger();
      }
    }
    function forgetEvents(events: BufferedServerLogSink["events"]): typeof events {
      return events.filter((event) => event.op === "memory.explicit.forget");
    }
    const WINDOW_BY_ID = { surface: "memory-center", selectorKind: "by-id" } as const;
    const NOTHING = { tombstoneWritten: false, forgottenCount: 0, tombstoneCount: 0 } as const;
    // One line with exactly the expected fields, its correlation id and its registered shape,
    // through the real formatter. Returns the persisted line for content checks.
    function expectForgetLine(
      events: BufferedServerLogSink["events"],
      expected: Record<string, unknown>,
      correlationId = "corr-forget-1",
    ): string {
      expect(events).toHaveLength(1);
      const [event] = events;
      if (event === undefined) throw new TypeError("missing forget line");
      expect(event.extra).toEqual({ completeness: "complete", loss: "none", ...expected });
      expect(event.correlationId).toBe(correlationId);
      const line = formatActivityLogProofLine(event);
      expect(expectActivityLogProof("memory.explicit.forget.line", line)).toMatchObject({
        ...expected,
        correlationId,
      });
      return line;
    }

    it("records forgotten, surface, scope kind and tombstone without an id or body", async () => {
      const vault = makeVault();
      vault.insertMemory(makeMemory("window-forget-1", "WINDOW-FORGET-BODY"));
      const { result, events } = await forgetWithLog(
        "window-forget-1",
        makeDeps({ memoryVault: vault }),
      );
      expect(result.status).toBe(200);
      const line = expectForgetLine(events, {
        outcome: "forgotten",
        ...WINDOW_BY_ID,
        scopeKind: "global",
        tombstoneWritten: true,
        forgottenCount: 1,
        tombstoneCount: 1,
      });
      expect(line).not.toContain("window-forget-1");
      expect(line).not.toContain("WINDOW-FORGET-BODY");
    });

    it("records the DELETE alias the same way", async () => {
      const vault = makeVault();
      vault.insertMemory(makeMemory("window-delete-1", "body"));
      const { events } = await forgetWithLog(
        "window-delete-1",
        makeDeps({ memoryVault: vault }),
        handleDeleteMemory,
      );
      expectForgetLine(events, {
        outcome: "forgotten",
        ...WINDOW_BY_ID,
        scopeKind: "global",
        tombstoneWritten: true,
        forgottenCount: 1,
        tombstoneCount: 1,
      });
    });

    it("records not-found for an unknown memory without a tombstone", async () => {
      const { result, events } = await forgetWithLog(
        "window-missing",
        makeDeps({ memoryVault: makeVault() }),
      );
      expect(result.status).toBe(404);
      expectForgetLine(events, { outcome: "not-found", ...WINDOW_BY_ID, ...NOTHING });
    });

    it("records refused for a memory outside the caller's authorized scopes", async () => {
      const vault = makeVault();
      vault.insertMemory(
        makeMemory("window-refused", "body", {
          scope: { kind: "workspace", workspaceId: workspaceId("ws-restricted") },
        }),
      );
      const { result, events } = await forgetWithLog(
        "window-refused",
        makeDeps({
          memoryVault: vault,
          memoryAuthorization: {
            reviewerId: reviewerId("operator-a"),
            authorizedScopes: () => [{ kind: "global" }],
          },
        }),
      );
      expect(result.status).toBe(403);
      expectForgetLine(events, {
        outcome: "refused",
        ...WINDOW_BY_ID,
        scopeKind: "workspace",
        ...NOTHING,
      });
    });

    // Every request that ends before the selection still leaves one body-free line under the
    // request's correlation id, with no tombstone.
    async function expectEarlyExitLine(
      ctx: RouteContext,
      deps: UiHandlerDeps,
      handler: typeof handleForgetMemory,
      expected: { readonly status: number; readonly outcome: "failed" | "refused" },
    ): Promise<void> {
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "info" }));
      let result: RouteResult;
      try {
        result = await handler({ ...ctx, correlationId: "corr-early-exit" }, deps);
      } finally {
        resetServerLogger();
      }
      expect(result.status).toBe(expected.status);
      expectForgetLine(
        forgetEvents(sink.events),
        { outcome: expected.outcome, surface: "memory-center", tombstoneWritten: false },
        "corr-early-exit",
      );
    }

    it.each([
      ["handleForgetMemory", handleForgetMemory],
      ["handleDeleteMemory", handleDeleteMemory],
    ])("records failed when the vault is unavailable (%s)", async (_name, handler) => {
      await expectEarlyExitLine(
        makeCtx("/api/memory/x/forget", { acknowledged: true }, { id: "x" }),
        makeDeps({ memoryVault: undefined }),
        handler,
        { status: 503, outcome: "failed" },
      );
    });

    it.each([
      ["handleForgetMemory", handleForgetMemory],
      ["handleDeleteMemory", handleDeleteMemory],
    ])("records refused for a missing id (%s)", async (_name, handler) => {
      await expectEarlyExitLine(
        makeCtx("/api/memory/forget", { acknowledged: true }),
        makeDeps({ memoryVault: makeVault() }),
        handler,
        { status: 400, outcome: "refused" },
      );
    });

    it.each([
      ["handleForgetMemory", handleForgetMemory],
      ["handleDeleteMemory", handleDeleteMemory],
    ])("records refused for a rejected body (%s)", async (_name, handler) => {
      await expectEarlyExitLine(
        makeCtx("/api/memory/x/forget", ["not", "an", "object"], { id: "x" }),
        makeDeps({ memoryVault: makeVault() }),
        handler,
        { status: 400, outcome: "refused" },
      );
    });

    it.each([
      ["handleForgetMemory", handleForgetMemory],
      ["handleDeleteMemory", handleDeleteMemory],
    ])("records refused for a missing acknowledgement (%s)", async (_name, handler) => {
      const vault = makeVault();
      vault.insertMemory(makeMemory("window-no-ack", "must remain"));
      await expectEarlyExitLine(
        makeCtx("/api/memory/window-no-ack/forget", {}, { id: "window-no-ack" }),
        makeDeps({ memoryVault: vault }),
        handler,
        { status: 400, outcome: "refused" },
      );
      expect(vault.getMemory(memoryId("window-no-ack"))).toBeDefined();
    });

    it("records the early exits of the bulk route", async () => {
      const ack = { acknowledged: true };
      const bulk = async (
        payload: unknown,
        deps: UiHandlerDeps,
        expected: { readonly status: number; readonly outcome: "failed" | "refused" },
      ): Promise<void> =>
        expectEarlyExitLine(
          makeCtx("/api/memory/forget", payload),
          deps,
          handleForgetMemories,
          expected,
        );
      const deps = makeDeps({ memoryVault: makeVault() });
      await bulk(ack, makeDeps({ memoryVault: undefined }), { status: 503, outcome: "failed" });
      await bulk(["x"], deps, { status: 400, outcome: "refused" });
      await bulk({}, deps, { status: 400, outcome: "refused" });
      await bulk({ ...ack, selector: { kind: "unknown" } }, deps, {
        status: 400,
        outcome: "refused",
      });
      await bulk({ ...ack, selector: { kind: "by-id", memoryId: "" } }, deps, {
        status: 400,
        outcome: "refused",
      });
    });

    it("records refused when a bulk selector matches only pinned records (409)", async () => {
      const vault = makeVault();
      vault.insertMemory(
        makeMemory("window-pinned-only", "pinned preference", { type: "preference", pinned: true }),
      );
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "info" }));
      let result: RouteResult;
      try {
        result = await handleForgetMemories(
          {
            ...makeCtx("/api/memory/forget", {
              acknowledged: true,
              selector: { kind: "by-type", scope: { kind: "global" }, type: "preference" },
            }),
            correlationId: "corr-forget-1",
          },
          makeDeps({ memoryVault: vault }),
        );
      } finally {
        resetServerLogger();
      }
      expect(result.status).toBe(409);
      expect(vault.getMemory(memoryId("window-pinned-only"))).toBeDefined();
      expect(vault.listTombstonesByScope({ kind: "global" })).toEqual([]);
      expectForgetLine(forgetEvents(sink.events), {
        outcome: "refused",
        surface: "memory-center",
        selectorKind: "by-type",
        scopeKind: "global",
        ...NOTHING,
      });
    });

    it("forgets a pinned record through a by-id selector on the bulk route", async () => {
      const vault = makeVault();
      vault.insertMemory(makeMemory("window-bulk-pinned", "pinned and unwanted", { pinned: true }));
      const result = await handleForgetMemories(
        makeCtx("/api/memory/forget", {
          acknowledged: true,
          selector: { kind: "by-id", memoryId: "window-bulk-pinned" },
        }),
        makeDeps({ memoryVault: vault }),
      );
      expect(result.status).toBe(200);
      expect(vault.getMemory(memoryId("window-bulk-pinned"))).toBeUndefined();
      expect(vault.listTombstonesByScope({ kind: "global" }).map((t) => t.memoryId)).toEqual([
        memoryId("window-bulk-pinned"),
      ]);
    });

    it("records failed when getMemory throws inside the guarded block", async () => {
      const vault = makeVault();
      vi.spyOn(vault, "getMemory").mockImplementation(() => {
        throw new MemoryStorageError("internal", "vault unreadable");
      });
      const { result, events } = await forgetWithLog(
        "window-getmemory-throws",
        makeDeps({ memoryVault: vault }),
      );
      expect(result.status).toBe(500);
      expectForgetLine(events, { outcome: "failed", ...WINDOW_BY_ID, ...NOTHING });
    });

    it("records failed when the vault throws and when the audit preflight refuses", async () => {
      const vault = makeVault();
      vault.insertMemory(makeMemory("window-throws", "body"));
      vi.spyOn(vault, "deleteMemories").mockImplementation(() => {
        throw new MemoryStorageError("internal", "disk full");
      });
      const thrown = await forgetWithLog("window-throws", makeDeps({ memoryVault: vault }));
      expectForgetLine(thrown.events, { outcome: "failed", ...WINDOW_BY_ID, ...NOTHING });

      const audit = await forgetWithLog(
        "window-audit",
        makeDeps({
          memoryVault: makeVault(),
          evidenceStore: {
            put: () => {
              throw new Error("audit store unavailable");
            },
            list: () => [],
            get: () => undefined,
            delete: () => undefined,
          },
        }),
      );
      expect(audit.result.status).toBe(500);
      expectForgetLine(audit.events, {
        outcome: "failed",
        surface: "memory-center",
        tombstoneWritten: false,
      });
    });

    async function bulkWithLog(
      payload: unknown,
      deps: UiHandlerDeps,
    ): Promise<{ result: RouteResult; events: BufferedServerLogSink["events"] }> {
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "info" }));
      try {
        const ctx = { ...makeCtx("/api/memory/forget", payload), correlationId: "corr-forget-1" };
        const result = await handleForgetMemories(ctx, deps);
        return { result, events: forgetEvents(sink.events) };
      } finally {
        resetServerLogger();
      }
    }

    it("tells a sweep from one entry: the selector kind and the number forgotten", async () => {
      const vault = makeVault();
      for (let index = 0; index < 5; index += 1) {
        vault.insertMemory(makeMemory(`sweep-${String(index)}`, `body ${String(index)}`));
      }
      const { result, events } = await bulkWithLog(
        { acknowledged: true, selector: { kind: "by-scope", scope: { kind: "global" } } },
        makeDeps({ memoryVault: vault }),
      );
      expect(result.status).toBe(200);
      expectForgetLine(events, {
        outcome: "forgotten",
        surface: "memory-center",
        selectorKind: "by-scope",
        scopeKind: "global",
        tombstoneWritten: true,
        forgottenCount: 5,
        tombstoneCount: 5,
      });
    });

    it("does not follow an edge into another scope and counts it", async () => {
      const vault = makeVault();
      const { first, second, third } = await threeValues(vault);
      const foreign = makeMemory("lineage-foreign", "Ich wohne in Ulm", {
        scope: { kind: "workspace", workspaceId: workspaceId("ws-other") },
        status: "superseded",
      });
      vault.insertMemory(foreign);
      vault.insertEdge({
        id: "lineage-cross" as MemoryEdgeId,
        schemaVersion: "1",
        fromMemoryId: foreign.id,
        toMemoryId: third,
        kind: "supersedes",
        createdAt: Date.now(),
      });

      const { result, events } = await forgetWithLog(
        String(third),
        makeDeps({ memoryVault: vault }),
      );

      expect(result.status).toBe(200);
      for (const id of [first, second, third]) expect(vault.getMemory(id)).toBeUndefined();
      expect(vault.getMemory(foreign.id)).toBeDefined();
      expectForgetLine(events, {
        outcome: "forgotten",
        ...WINDOW_BY_ID,
        scopeKind: "global",
        tombstoneWritten: true,
        forgottenCount: 3,
        tombstoneCount: 3,
        lineageSkippedCount: 1,
      });
    });

    it("counts a fact and the earlier values it replaced in one line", async () => {
      const vault = makeVault();
      const { third } = await threeValues(vault);
      const { result, events } = await forgetWithLog(
        String(third),
        makeDeps({ memoryVault: vault }),
      );
      expect(result.status).toBe(200);
      expectForgetLine(events, {
        outcome: "forgotten",
        ...WINDOW_BY_ID,
        scopeKind: "global",
        tombstoneWritten: true,
        forgottenCount: 3,
        tombstoneCount: 3,
      });
    });

    it("records refused for a sweep of a scope the caller may not use (403)", async () => {
      const { result, events } = await bulkWithLog(
        {
          acknowledged: true,
          selector: {
            kind: "by-scope",
            scope: { kind: "workspace", workspaceId: workspaceId("ws-restricted") },
          },
        },
        makeDeps({
          memoryVault: makeVault(),
          memoryAuthorization: {
            reviewerId: reviewerId("operator-a"),
            authorizedScopes: () => [{ kind: "global" }],
          },
        }),
      );
      expect(result.status).toBe(403);
      expectForgetLine(events, {
        outcome: "refused",
        surface: "memory-center",
        selectorKind: "by-scope",
        scopeKind: "workspace",
        ...NOTHING,
      });
    });

    // A governance refusal is answered with 400 and a storage not-found with 404: neither is a fault.
    it("records refused for a sweep over an archived memory (400), and forgets nothing", async () => {
      const vault = makeVault();
      vault.insertMemory(makeMemory("sweep-archived", "archived body", { status: "archived" }));
      vault.insertMemory(makeMemory("sweep-live", "live body"));
      const { result, events } = await bulkWithLog(
        { acknowledged: true, selector: { kind: "by-scope", scope: { kind: "global" } } },
        makeDeps({ memoryVault: vault }),
      );
      expect(result.status).toBe(400);
      expect(vault.getMemory(memoryId("sweep-archived"))).toBeDefined();
      expect(vault.getMemory(memoryId("sweep-live"))).toBeDefined();
      expectForgetLine(events, {
        outcome: "refused",
        surface: "memory-center",
        selectorKind: "by-scope",
        scopeKind: "global",
        ...NOTHING,
      });
    });

    it("records refused when the governance layer throws while deleting (400)", async () => {
      const vault = makeVault();
      vault.insertMemory(makeMemory("window-governance", "body"));
      vi.spyOn(vault, "deleteMemories").mockImplementation(() => {
        throw new GovernanceError("illegal-status-transition", "not forgettable");
      });
      const { result, events } = await forgetWithLog(
        "window-governance",
        makeDeps({ memoryVault: vault }),
      );
      expect(result.status).toBe(400);
      expectForgetLine(events, { outcome: "refused", ...WINDOW_BY_ID, ...NOTHING });
    });

    it("records not-found when the memory vanished before it was deleted (404)", async () => {
      const vault = makeVault();
      vault.insertMemory(makeMemory("window-vanished", "body"));
      vi.spyOn(vault, "deleteMemories").mockImplementation(() => {
        throw new MemoryStorageError("not-found", "gone");
      });
      const { result, events } = await forgetWithLog(
        "window-vanished",
        makeDeps({ memoryVault: vault }),
      );
      expect(result.status).toBe(404);
      expectForgetLine(events, { outcome: "not-found", ...WINDOW_BY_ID, ...NOTHING });
    });

    // The person picked exactly this entry, so the pick is the acknowledgement an archived entry needs.
    it("forgets an archived entry the person picked", async () => {
      const vault = makeVault();
      vault.insertMemory(makeMemory("window-archived", "archived body", { status: "archived" }));
      const { result, events } = await forgetWithLog(
        "window-archived",
        makeDeps({ memoryVault: vault }),
      );
      expect(result.status).toBe(200);
      expect(vault.getMemory(memoryId("window-archived"))).toBeUndefined();
      expect(vault.listTombstonesByScope({ kind: "global" })[0]?.originalStatus).toBe("archived");
      expectForgetLine(events, {
        outcome: "forgotten",
        ...WINDOW_BY_ID,
        scopeKind: "global",
        tombstoneWritten: true,
        forgottenCount: 1,
        tombstoneCount: 1,
      });
    });
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

  // Pinning protects a fact from a sweep, not from the person who names it: seeing, correcting and
  // deleting one entry must always work (#4214).
  it.each([
    ["the forget route", handleForgetMemory],
    ["the delete route", handleDeleteMemory],
  ])("forgets a pinned memory the person names through %s", async (_route, handler) => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("pinned-named", "pinned and unwanted", { pinned: true }));

    const result = await handler(
      makeCtx("/api/memory/pinned-named/forget", { acknowledged: true }, { id: "pinned-named" }),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(200);
    expect(vault.getMemory(memoryId("pinned-named"))).toBeUndefined();
    expect(vault.listTombstonesByScope({ kind: "global" }).map((t) => t.memoryId)).toEqual([
      memoryId("pinned-named"),
    ]);
  });

  // The Chat gets its id from a word match or from what "das" refers to, not from a row the person
  // picked, so the pin keeps protecting there (ADR-0146 D4b, #4223).
  it("keeps a pinned memory a Chat statement resolved to, and forgets it once the person picks it", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("pinned-chat", "pinned and unwanted", { pinned: true }));
    const deps = makeDeps({ memoryVault: vault });

    expect(forgetMemoryFromStatement(deps, vault, memoryId("pinned-chat"), "corr-chat")).toBe(
      "refused",
    );
    expect(vault.getMemory(memoryId("pinned-chat"))).toBeDefined();
    expect(vault.listTombstonesByScope({ kind: "global" })).toEqual([]);

    const picked = await handleForgetMemory(
      makeCtx("/api/memory/pinned-chat/forget", { acknowledged: true }, { id: "pinned-chat" }),
      deps,
    );
    expect(picked.status).toBe(200);
    expect(vault.getMemory(memoryId("pinned-chat"))).toBeUndefined();
  });

  it("forgets an unpinned memory a Chat statement resolved to", () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("unpinned-chat", "unwanted"));
    const deps = makeDeps({ memoryVault: vault });
    expect(forgetMemoryFromStatement(deps, vault, memoryId("unpinned-chat"), "corr-chat")).toBe(
      "forgotten",
    );
    expect(vault.getMemory(memoryId("unpinned-chat"))).toBeUndefined();
  });

  it("sweeps a scope over pinned and unpinned memories and keeps the pinned ones", async () => {
    const vault = makeVault();
    vault.insertMemory(makeMemory("sweep-pinned", "keep me", { pinned: true }));
    vault.insertMemory(makeMemory("sweep-loose-1", "drop me"));
    vault.insertMemory(makeMemory("sweep-loose-2", "drop me too"));

    const result = await handleForgetMemories(
      makeCtx("/api/memory/forget", {
        acknowledged: true,
        selector: { kind: "by-scope", scope: { kind: "global" } },
      }),
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(200);
    expect(asJson(result).count).toBe(2);
    expect(vault.getMemory(memoryId("sweep-pinned"))).toBeDefined();
    expect(vault.getMemory(memoryId("sweep-loose-1"))).toBeUndefined();
    expect(vault.getMemory(memoryId("sweep-loose-2"))).toBeUndefined();
  });

  // #4223: a fact and the earlier values it replaced are one fact. The person's own corrections go
  // through the production correction and acceptance routes.
  describe("forgetting a corrected fact from the Memory window", () => {
    async function forgetById(vault: MemoryVaultStore, id: string): Promise<RouteResult> {
      return handleForgetMemory(
        makeCtx(`/api/memory/${id}/forget`, { acknowledged: true }, { id }),
        makeDeps({ memoryVault: vault }),
      );
    }

    it("forgets every earlier value with the current entry, each with its own tombstone", async () => {
      const vault = makeVault();
      const { first, second, third } = await threeValues(vault);
      vault.insertMemory(makeMemory("lineage-other", "Ich nutze Vim"));

      const result = await forgetById(vault, String(third));

      expect(result.status).toBe(200);
      expect(asJson(result).count).toBe(3);
      expect(new Set(asJson(result).memoryIds as readonly MemoryId[])).toEqual(
        new Set([first, second, third]),
      );
      for (const id of [first, second, third]) expect(vault.getMemory(id)).toBeUndefined();
      expect(vault.getMemory(memoryId("lineage-other"))).toBeDefined();
      const tombstones = vault.listTombstonesByScope({ kind: "global" });
      expect(tombstones.map((tombstone) => tombstone.forgetterSurface)).toEqual([
        "memory-center",
        "memory-center",
        "memory-center",
      ]);
      for (const body of ["Ich wohne in Köln", "Ich wohne in Düsseldorf", "Ich wohne in Bonn"]) {
        expect(vault.hasForgetTombstoneForBody({ kind: "global" }, body)).toBe(true);
      }
    });

    it("forgets only the picked history row and keeps the chain whole", async () => {
      const vault = makeVault();
      const { first, second, third } = await threeValues(vault);

      const result = await forgetById(vault, String(second));

      expect(result.status).toBe(200);
      expect(asJson(result).count).toBe(1);
      expect(vault.getMemory(second)).toBeUndefined();
      expect(vault.getMemory(first)?.status).toBe("superseded");
      expect(vault.getMemory(third)?.status).toBe("accepted");
      // The earlier value is still linked to the live one, so forgetting the fact later reaches it.
      expect(
        vault
          .listOutgoingEdges(first)
          .some((edge) => edge.kind === "supersedes" && edge.toMemoryId === third),
      ).toBe(true);

      const later = await forgetById(vault, String(third));
      expect(later.status).toBe(200);
      expect(vault.getMemory(first)).toBeUndefined();
    });

    it("ends on a cycle of supersession edges", async () => {
      const vault = makeVault();
      const { first, third } = await threeValues(vault);
      vault.insertEdge({
        id: "lineage-cycle" as MemoryEdgeId,
        schemaVersion: "1",
        fromMemoryId: third,
        toMemoryId: first,
        kind: "supersedes",
        createdAt: Date.now(),
      });

      const result = await forgetById(vault, String(third));

      expect(result.status).toBe(200);
      expect(asJson(result).count).toBe(3);
    });

    async function archive(vault: MemoryVaultStore, id: MemoryId): Promise<void> {
      const result = await handleArchiveMemory(
        makeCtx(
          `/api/memory/${String(id)}/archive`,
          { reason: "user-request" },
          { id: String(id) },
        ),
        makeDeps({ memoryVault: vault }),
      );
      expect(result.status).toBe(200);
    }

    // Archive is a legal transition from superseded: an archived history row is still a value of the
    // fact, so forgetting the fact reaches it, and the rows before it.
    it.each(["the middle", "the oldest", "every earlier"] as const)(
      "forgets archived history too (%s value archived)",
      async (which) => {
        const vault = makeVault();
        const { first, second, third } = await threeValues(vault);
        if (which !== "the oldest") await archive(vault, second);
        if (which !== "the middle") await archive(vault, first);

        const result = await forgetById(vault, String(third));

        expect(result.status).toBe(200);
        expect(asJson(result).count).toBe(3);
        for (const id of [first, second, third]) expect(vault.getMemory(id)).toBeUndefined();
        expect(vault.listTombstonesByScope({ kind: "global" })).toHaveLength(3);
        for (const body of ["Ich wohne in Köln", "Ich wohne in Düsseldorf", "Ich wohne in Bonn"]) {
          expect(vault.hasForgetTombstoneForBody({ kind: "global" }, body)).toBe(true);
        }
      },
    );

    it("forgets an expired and a rejected earlier value as well", async () => {
      const vault = makeVault();
      const { first, second, third } = await threeValues(vault);
      vault.updateMemory(first, { status: "archived" }, Date.now());
      vault.updateMemory(first, { status: "expired" }, Date.now());
      vault.updateMemory(second, { status: "rejected" }, Date.now());
      const result = await forgetById(vault, String(third));
      expect(result.status).toBe(200);
      expect(asJson(result).count).toBe(3);
    });

    // An edge to a rejected record makes nothing a history row: the newest value is still the
    // fact, and its earlier values go with it.
    it("forgets the earlier values although the newest value has an edge to a rejected record", async () => {
      const vault = makeVault();
      const { first, second, third } = await threeValues(vault);
      vault.insertMemory(
        makeMemory("lineage-rejected", "Ich wohne in Trier", { status: "rejected" }),
      );
      vault.insertEdge({
        id: "lineage-to-rejected" as MemoryEdgeId,
        schemaVersion: "1",
        fromMemoryId: third,
        toMemoryId: memoryId("lineage-rejected"),
        kind: "supersedes",
        createdAt: Date.now(),
      });

      const result = await forgetById(vault, String(third));

      expect(result.status).toBe(200);
      expect(asJson(result).count).toBe(3);
      for (const id of [first, second, third]) expect(vault.getMemory(id)).toBeUndefined();
      expect(vault.getMemory(memoryId("lineage-rejected"))).toBeDefined();
    });

    // An archived or expired successor can return to accepted, so it keeps its predecessor a history row.
    it.each(["archived", "expired"] as const)(
      "keeps a record with a %s successor a history row",
      async (status) => {
        const vault = makeVault();
        vault.insertMemory(makeMemory("hist-old", "Ich wohne in Köln", { status: "superseded" }));
        vault.insertMemory(makeMemory("hist-new", "Ich wohne in Bonn", { status }));
        vault.insertEdge({
          id: "hist-edge" as MemoryEdgeId,
          schemaVersion: "1",
          fromMemoryId: memoryId("hist-old"),
          toMemoryId: memoryId("hist-new"),
          kind: "supersedes",
          createdAt: Date.now(),
        });
        const result = await forgetById(vault, "hist-old");
        expect(result.status).toBe(200);
        expect(asJson(result).count).toBe(1);
        expect(vault.getMemory(memoryId("hist-new"))).toBeDefined();
      },
    );

    // A conflict loser stays `conflicted` with an edge to the winner (and may be rehabilitated).
    it("forgets a conflict loser with the winner, and a rehabilitated loser alone", async () => {
      const vault = makeVault();
      vault.insertMemory(makeMemory("cf-winner", "formatter is biome"));
      vault.insertMemory(makeMemory("cf-loser", "formatter is prettier"));
      const resolved = await handleResolveMemoryConflict(
        makeCtx("/api/memory/conflicts/resolve", {
          winner: "cf-winner",
          losers: ["cf-loser"],
          reason: "conflict-resolved",
        }),
        makeDeps({ memoryVault: vault }),
      );
      expect(resolved.status).toBe(200);
      vault.updateMemory(memoryId("cf-loser"), { status: "accepted" }, Date.now());

      const alone = await forgetById(vault, "cf-loser");
      expect(asJson(alone).count).toBe(1);
      expect(vault.getMemory(memoryId("cf-winner"))).toBeDefined();

      const other = makeVault();
      other.insertMemory(makeMemory("cf2-winner", "formatter is biome"));
      other.insertMemory(makeMemory("cf2-loser", "formatter is prettier"));
      await handleResolveMemoryConflict(
        makeCtx("/api/memory/conflicts/resolve", {
          winner: "cf2-winner",
          losers: ["cf2-loser"],
          reason: "conflict-resolved",
        }),
        makeDeps({ memoryVault: other }),
      );
      const together = await forgetById(other, "cf2-winner");
      expect(asJson(together).count).toBe(2);
      expect(other.getMemory(memoryId("cf2-loser"))).toBeUndefined();
    });

    // The walk does not pass through another scope: the earlier same-scope value behind a foreign
    // record is not reached, and lineageSkippedCount is the signal (ADR-0146).
    it("does not reach a same-scope value behind a foreign-scope middle record", async () => {
      const vault = makeVault();
      vault.insertMemory(makeMemory("fm-a", "Ich wohne in Köln", { status: "superseded" }));
      vault.insertMemory(
        makeMemory("fm-f", "Ich wohne in Ulm", {
          status: "superseded",
          scope: { kind: "workspace", workspaceId: workspaceId("ws-other") },
        }),
      );
      vault.insertMemory(makeMemory("fm-c", "Ich wohne in Bonn"));
      for (const [id, from, to] of [
        ["fm-e1", "fm-a", "fm-f"],
        ["fm-e2", "fm-f", "fm-c"],
      ] as const) {
        vault.insertEdge({
          id: id as MemoryEdgeId,
          schemaVersion: "1",
          fromMemoryId: memoryId(from),
          toMemoryId: memoryId(to),
          kind: "supersedes",
          createdAt: Date.now(),
        });
      }

      const result = await forgetById(vault, "fm-c");

      expect(result.status).toBe(200);
      expect(asJson(result).count).toBe(1);
      expect(vault.getMemory(memoryId("fm-a"))).toBeDefined();
      expect(vault.getMemory(memoryId("fm-f"))).toBeDefined();
    });

    it("picking an archived history row forgets only that row", async () => {
      const vault = makeVault();
      const { first, second, third } = await threeValues(vault);
      await archive(vault, second);
      const result = await forgetById(vault, String(second));
      expect(result.status).toBe(200);
      expect(asJson(result).count).toBe(1);
      expect(vault.getMemory(first)).toBeDefined();
      expect(vault.getMemory(third)?.status).toBe("accepted");
    });

    it("refuses and deletes nothing when the history is too long to forget whole", async () => {
      const vault = makeVault();
      const total = 260;
      for (let index = 0; index < total; index += 1) {
        const last = index === total - 1;
        vault.insertMemory(
          makeMemory(`long-${String(index)}`, `Value ${String(index)}`, {
            status: last ? "accepted" : "superseded",
          }),
        );
        if (index > 0) {
          vault.insertEdge({
            id: `long-edge-${String(index)}` as MemoryEdgeId,
            schemaVersion: "1",
            fromMemoryId: memoryId(`long-${String(index - 1)}`),
            toMemoryId: memoryId(`long-${String(index)}`),
            kind: "supersedes",
            createdAt: Date.now(),
          });
        }
      }

      const result = await forgetById(vault, `long-${String(total - 1)}`);

      expect(result.status).toBe(409);
      expect(vault.getMemory(memoryId(`long-${String(total - 1)}`))).toBeDefined();
      expect(vault.listTombstonesByScope({ kind: "global" })).toEqual([]);
    });

    it("keeps a pinned live entry and its history when a Chat statement named it", async () => {
      const vault = makeVault();
      const { first, third } = await threeValues(vault);
      vault.updateMemory(third, { pinned: true }, Date.now());

      const deps = makeDeps({ memoryVault: vault });
      expect(forgetMemoryFromStatement(deps, vault, third, "corr-lineage")).toBe("refused");

      expect(vault.getMemory(third)).toBeDefined();
      expect(vault.getMemory(first)).toBeDefined();
      expect(vault.listTombstonesByScope({ kind: "global" })).toEqual([]);
    });
  });

  describe("a Chat forget leaves its own Activity Log line (#4223)", () => {
    const CHAT_BY_ID = { surface: "chat", selectorKind: "by-id" } as const;
    const NOTHING = { tombstoneWritten: false, forgottenCount: 0, tombstoneCount: 0 } as const;

    async function withLog<T>(
      run: () => Promise<T> | T,
    ): Promise<{ value: T; events: BufferedServerLogSink["events"] }> {
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "info" }));
      try {
        const value = await run();
        return {
          value,
          events: sink.events.filter((event) => event.op === "memory.explicit.forget"),
        };
      } finally {
        resetServerLogger();
      }
    }

    function expectChatLine(
      events: BufferedServerLogSink["events"],
      expected: Record<string, unknown>,
    ): void {
      expect(events).toHaveLength(1);
      const [event] = events;
      if (event === undefined) throw new TypeError("missing forget line");
      expect(event.extra).toEqual({ completeness: "complete", loss: "none", ...expected });
      expect(event.correlationId).toBe("corr-chat");
      expect(
        expectActivityLogProof("memory.explicit.forget.line", formatActivityLogProofLine(event)),
      ).toMatchObject({ ...expected, correlationId: "corr-chat" });
    }

    it("records one forgotten entry with its scope kind and tombstone", async () => {
      const vault = makeVault();
      vault.insertMemory(makeMemory("chat-forget-1", "body"));
      const { value, events } = await withLog(() =>
        forgetMemoryFromStatement(
          makeDeps({ memoryVault: vault }),
          vault,
          memoryId("chat-forget-1"),
          "corr-chat",
        ),
      );
      expect(value).toBe("forgotten");
      expectChatLine(events, {
        outcome: "forgotten",
        ...CHAT_BY_ID,
        scopeKind: "global",
        tombstoneWritten: true,
        forgottenCount: 1,
        tombstoneCount: 1,
      });
    });

    it("counts a fact and the earlier values it replaced", async () => {
      const vault = makeVault();
      const { third } = await threeValues(vault);
      const { value, events } = await withLog(() =>
        forgetMemoryFromStatement(makeDeps({ memoryVault: vault }), vault, third, "corr-chat"),
      );
      expect(value).toBe("forgotten");
      expectChatLine(events, {
        outcome: "forgotten",
        ...CHAT_BY_ID,
        scopeKind: "global",
        tombstoneWritten: true,
        forgottenCount: 3,
        tombstoneCount: 3,
      });
    });

    it("records refused for a pinned entry and for an unknown one (not-found)", async () => {
      const vault = makeVault();
      vault.insertMemory(makeMemory("chat-pinned", "body", { pinned: true }));
      const deps = makeDeps({ memoryVault: vault });
      const pinned = await withLog(() =>
        forgetMemoryFromStatement(deps, vault, memoryId("chat-pinned"), "corr-chat"),
      );
      expect(pinned.value).toBe("refused");
      expectChatLine(pinned.events, {
        outcome: "refused",
        ...CHAT_BY_ID,
        scopeKind: "global",
        ...NOTHING,
      });
      const unknown = await withLog(() =>
        forgetMemoryFromStatement(deps, vault, memoryId("chat-unknown"), "corr-chat"),
      );
      expect(unknown.value).toBe("refused");
      expectChatLine(unknown.events, { outcome: "not-found", ...CHAT_BY_ID, ...NOTHING });
    });

    // The person's own words name the entry, so a Chat forget acts on an archived memory too
    // (ADR-0146 D4b); a governance refusal thrown by the vault is a plain "not applied", not a fault.
    it("forgets an archived entry a Chat statement named", async () => {
      const vault = makeVault();
      vault.insertMemory(makeMemory("chat-archived", "body", { status: "archived" }));
      const { value, events } = await withLog(() =>
        forgetMemoryFromStatement(
          makeDeps({ memoryVault: vault }),
          vault,
          memoryId("chat-archived"),
          "corr-chat",
        ),
      );
      expect(value).toBe("forgotten");
      expect(vault.getMemory(memoryId("chat-archived"))).toBeUndefined();
      expect(vault.listTombstonesByScope({ kind: "global" })[0]?.originalStatus).toBe("archived");
      expectChatLine(events, {
        outcome: "forgotten",
        ...CHAT_BY_ID,
        scopeKind: "global",
        tombstoneWritten: true,
        forgottenCount: 1,
        tombstoneCount: 1,
      });
    });

    it("records refused, not failed, when the vault refuses a Chat forget on governance grounds", async () => {
      const vault = makeVault();
      vault.insertMemory(makeMemory("chat-governed", "body"));
      vi.spyOn(vault, "deleteMemories").mockImplementation(() => {
        throw new GovernanceError("illegal-status-transition", "not forgettable");
      });
      const { value, events } = await withLog(() =>
        forgetMemoryFromStatement(
          makeDeps({ memoryVault: vault }),
          vault,
          memoryId("chat-governed"),
          "corr-chat",
        ),
      );
      expect(value).toBe("refused");
      expectChatLine(events, { outcome: "refused", ...CHAT_BY_ID, ...NOTHING });
    });

    it("records failed for a storage fault and for an unwritable audit store", async () => {
      const vault = makeVault();
      vault.insertMemory(makeMemory("chat-fault", "body"));
      vi.spyOn(vault, "deleteMemories").mockImplementation(() => {
        throw new MemoryStorageError("internal", "disk full");
      });
      const thrown = await withLog(() =>
        forgetMemoryFromStatement(
          makeDeps({ memoryVault: vault }),
          vault,
          memoryId("chat-fault"),
          "corr-chat",
        ),
      );
      expect(thrown.value).toBe("failed");
      expectChatLine(thrown.events, { outcome: "failed", ...CHAT_BY_ID, ...NOTHING });

      const audit = await withLog(() =>
        forgetMemoryFromStatement(
          makeDeps({
            memoryVault: vault,
            evidenceStore: {
              put: () => {
                throw new Error("audit store unavailable");
              },
              list: () => [],
              get: () => undefined,
              delete: () => undefined,
            },
          }),
          vault,
          memoryId("chat-fault"),
          "corr-chat",
        ),
      );
      expect(audit.value).toBe("failed");
      expectChatLine(audit.events, { outcome: "failed", ...CHAT_BY_ID, ...NOTHING });
    });

    describe("a statement nothing was stored from", () => {
      const STATEMENT = { surface: "chat", selectorKind: "statement" } as const;
      const scopes: readonly MemoryScope[] = [
        { kind: "user", userId: userId("u-1") },
        { kind: "workspace", workspaceId: workspaceId("ws-1") },
        { kind: "project", projectId: "p-1" as ProjectId },
      ];

      it("records one tombstone per scope and no forgotten memory", async () => {
        const vault = makeVault();
        const { value, events } = await withLog(() =>
          forgetStatementNotLearned(
            makeDeps({ memoryVault: vault }),
            vault,
            "Ich wohne in Köln",
            scopes,
            "corr-chat",
          ),
        );
        expect(value).toBe("forgotten");
        expectChatLine(events, {
          outcome: "forgotten",
          ...STATEMENT,
          tombstoneWritten: true,
          forgottenCount: 0,
          tombstoneCount: 3,
        });
      });

      it("names the scope kind when there is only one", async () => {
        const vault = makeVault();
        const { events } = await withLog(() =>
          forgetStatementNotLearned(
            makeDeps({ memoryVault: vault }),
            vault,
            "Ich wohne in Köln",
            [{ kind: "global" }],
            "corr-chat",
          ),
        );
        expectChatLine(events, {
          outcome: "forgotten",
          ...STATEMENT,
          scopeKind: "global",
          tombstoneWritten: true,
          forgottenCount: 0,
          tombstoneCount: 1,
        });
      });

      it("records refused when no scope is allowed, and failed when the vault cannot write", async () => {
        const vault = makeVault();
        const refused = await withLog(() =>
          forgetStatementNotLearned(
            makeDeps({
              memoryVault: vault,
              memoryAuthorization: {
                reviewerId: reviewerId("operator-a"),
                authorizedScopes: () => [],
              },
            }),
            vault,
            "Ich wohne in Köln",
            scopes,
            "corr-chat",
          ),
        );
        expect(refused.value).toBe("refused");
        expectChatLine(refused.events, { outcome: "refused", ...STATEMENT, ...NOTHING });

        vi.spyOn(vault, "recordForgottenStatements").mockImplementation(() => {
          throw new MemoryStorageError("internal", "disk full");
        });
        const failed = await withLog(() =>
          forgetStatementNotLearned(
            makeDeps({ memoryVault: vault }),
            vault,
            "Ich wohne in Köln",
            scopes,
            "corr-chat",
          ),
        );
        expect(failed.value).toBe("failed");
        expectChatLine(failed.events, { outcome: "failed", ...STATEMENT, ...NOTHING });
      });
    });
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

  it.each(["", "?q=Synthetic"])("reports a list failure %s", (query) => {
    const vault = makeVault();
    const { records, diagnostics } = recordingSink();
    const broken: MemoryVaultStore = {
      ...vault,
      listMemoryCenterPage: () => {
        throw new MemoryStorageError("internal", "simulated list failure");
      },
      listMemoryScopes: () => {
        throw new MemoryStorageError("internal", "simulated list failure");
      },
    };
    const result = handleListMemories(
      withCorrelation(makeCtx(`/api/memory${query}`, {}), "corr-list-1"),
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
      listMemoryReviewQueue: () => {
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
      updateMemories: () => {
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
      applyGraphMutation: () => {
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

// Request JSON is data even when it resembles an HTTP response.
describe("memory request response-shape isolation", () => {
  it.each([200, 400, 413, 99999])(
    "validates caller status %i instead of echoing it",
    async (status) => {
      const body = { error: { code: "CALLER_CONTROLLED" } };
      const deps = makeDeps({ memoryVault: makeVault() });
      const result = await handleEditMemory(
        makeCtx("/api/memory/test", { status, body }, { id: "test" }),
        deps,
      );
      expect(result).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
      expect(result.body).not.toEqual(body);
    },
  );
});
