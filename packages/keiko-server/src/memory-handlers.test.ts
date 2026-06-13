import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createInMemoryEvidenceStore, type EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type {
  MemoryAuditEvent,
  MemoryConversationId,
  MemoryId,
  MemoryRecord,
  MemoryUserId,
  MemoryWorkspaceId,
} from "@oscharko-dev/keiko-contracts";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import {
  handleListMemories,
  handleMemoryReviewQueue,
  handleAcceptMemoryProposal,
  handleCorrectMemory,
  handleDeleteMemory,
  handleForgetMemories,
  handleForgetMemory,
  handlePinMemory,
  handleResolveMemoryConflict,
  handleRejectMemoryProposal,
} from "./memory-handlers.js";
import { createInMemoryUiStore } from "./store/index.js";
import type { RouteContext, RouteResult } from "./routes.js";

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
  const dir = mkdtempSync(join(tmpdir(), "keiko-memory-handlers-"));
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

function asJson(result: RouteResult): Record<string, unknown> {
  return result.body as Record<string, unknown>;
}

function readAllAuditEvents(store: EvidenceStore): readonly MemoryAuditEvent[] {
  return store
    .list()
    .flatMap((runId) => JSON.parse(store.get(runId) ?? "[]") as readonly MemoryAuditEvent[]);
}

describe("memory handlers", () => {
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

  it("allows conflicted memories to be dismissed through the reject route", async () => {
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

    expect(result.status).toBe(200);
    const body = asJson(result);
    const memory = body.memory as MemoryRecord;
    expect(memory.status).toBe("rejected");
    expect(memory.staleReason).toBe("dismissed from queue");
  });

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

    expect(readAllAuditEvents(evidenceStore)).toEqual([]);
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
    const acceptResult = handleAcceptMemoryProposal(
      makeCtx(`/api/memory/proposals/${String(correction.id)}/accept`, {}, { id: correction.id }),
      makeDeps({ memoryVault: vault, evidenceStore }),
    );

    expect(acceptResult.status).toBe(200);
    expect(vault.getMemory(memoryId("memory-correct-accept"))?.status).toBe("superseded");
    expect(vault.getMemory(correction.id)?.status).toBe("accepted");
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

    const acceptResult = handleAcceptMemoryProposal(
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
      makeDeps({ memoryVault: vault }),
    );

    expect(result.status).toBe(200);
    expect(vault.getMemory(memoryId("memory-forget-1"))).toBeUndefined();
    const tombstones = vault.listTombstonesByScope({ kind: "global" });
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.memoryId).toBe(memoryId("memory-forget-1"));
    expect(tombstones[0]?.reason).toBe("user removed stale package-manager preference");
    expect(tombstones[0]?.reviewerId).toBe("memoriaviva-ui");
    expect(tombstones[0]?.originalStatus).toBe("accepted");
    expect(JSON.stringify(tombstones)).not.toContain("PRIVATE-BODY-FORGET-FINGERPRINT");
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
        reason: "operator requested delete",
        reviewerId: "memoriaviva-ui",
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
    expect(vault.getMemory(memoryId("conflict-loser"))?.staleReason).toBe(
      "reviewed and winner selected",
    );
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
});
