// Issue #212 — Conversation Center memory BFF tests.
//
// Exercises both new routes via direct handler invocation against an in-process vault.
//
//   - POST /api/memory/context  → handleMemoryRetrieveContext
//   - POST /api/memory/capture-from-conversation → handleMemoryCaptureFromConversation
//
// These tests intentionally do NOT spin up the HTTP server — the dispatch layer is shared
// with the Memory Center routes (#211) and is already covered by routes.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { Readable } from "node:stream";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type {
  MemoryEdge,
  MemoryId,
  MemoryRecord,
  MemoryUserId,
} from "@oscharko-dev/keiko-contracts";
import {
  handleMemoryRetrieveContext,
  handleMemoryCaptureFromConversation,
  vaultAsQueryPort,
} from "./memory-conv-handlers.js";
import { handleAcceptMemoryProposal } from "./memory-handlers.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import type { RouteContext, RouteResult } from "./routes.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeReq(payload: unknown): IncomingMessage {
  const json = JSON.stringify(payload);
  const stream = Readable.from([Buffer.from(json)]);
  // Cast through unknown so the test rig satisfies IncomingMessage's IO surface for the
  // body-reader's `data`/`end`/`error` event listeners.
  const req = stream as unknown as IncomingMessage;
  return req;
}

function makeCtx(payload: unknown): RouteContext {
  const socket = new Socket();
  return {
    req: makeReq(payload),
    res: { socket } as unknown as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/memory/context"),
  };
}

function makeDeps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: () => "",
      list: () => [],
      get: () => undefined,
      delete: () => undefined,
    },
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
  for (const v of activeVaults) {
    try {
      v.close();
    } catch {
      // Vault may already be closed by a test; ignore.
    }
  }
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeVault(): MemoryVaultStore {
  const dir = mkdtempSync(join(tmpdir(), "keiko-conv-mem-"));
  tmpDirs.push(dir);
  const vault = createMemoryVault({ memoryDir: dir, redactString: (s) => s });
  activeVaults.push(vault);
  return vault;
}

function registerChat(
  deps: UiHandlerDeps,
  label = "memory-conversation",
): { projectPath: string; chatId: string } {
  const projectPath = mkdtempSync(join(tmpdir(), `keiko-conv-chat-${label}-`));
  tmpDirs.push(projectPath);
  mkdirSync(projectPath, { recursive: true });
  deps.store.createProject(projectPath, label);
  const chat = deps.store.createChat(projectPath, `${label} chat`, "example-chat-model");
  return { projectPath, chatId: chat.id };
}

// Branded ids are nominally string + phantom symbol; the test rig is the boundary that
// mints them, so we use a single `as unknown as` cast at construction. The named identifiers
// document intent; eslint's no-unsafe-assignment is satisfied because the value is typed
// before assignment, not after.
// Branded ids: cast a freshly-built string via `unknown` so eslint's no-unsafe-assignment
// sees a typed expression on the RHS rather than a string flowing into a brand position.
function brandedMemoryId(value: string): MemoryId {
  const u: unknown = value;
  return u as MemoryId;
}
function brandedMemoryUserId(value: string): MemoryUserId {
  const u: unknown = value;
  return u as MemoryUserId;
}
function projectScope(projectPath: string): MemoryRecord["scope"] {
  return { kind: "project", projectId: projectPath } as unknown as MemoryRecord["scope"];
}
function brandedEdgeId(value: string): MemoryEdge["id"] {
  const u: unknown = value;
  return u as MemoryEdge["id"];
}

function insertAcceptedMemory(
  vault: MemoryVaultStore,
  options: {
    body?: string;
    userId?: string;
    scope?: MemoryRecord["scope"];
    validUntil?: number;
  } = {},
): MemoryRecord {
  const id: MemoryId = brandedMemoryId(`mem-${Math.random().toString(36).slice(2, 10)}`);
  const userId: MemoryUserId = brandedMemoryUserId(options.userId ?? "local-operator");
  const now = Date.now();
  const record: MemoryRecord = {
    id,
    schemaVersion: "1",
    scope: options.scope ?? { kind: "user", userId },
    type: "preference",
    body: options.body ?? "User prefers TypeScript strict mode in all packages.",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: now,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity:
      options.validUntil === undefined
        ? { validFrom: now }
        : { validFrom: now - 10_000, validUntil: options.validUntil },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: now,
    updatedAt: now,
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

function asJson(result: RouteResult): Record<string, unknown> {
  return result.body as Record<string, unknown>;
}

// ── /api/memory/context ───────────────────────────────────────────────────────

describe("handleMemoryRetrieveContext", () => {
  it("returns 503 when no vault is configured", async () => {
    const deps = makeDeps();
    const chat = registerChat(deps, "no-vault");
    const result = await handleMemoryRetrieveContext(
      makeCtx({ projectPath: chat.projectPath, chatId: chat.chatId }),
      deps,
    );
    expect(result.status).toBe(503);
  });

  it("returns 400 when projectPath or chatId is missing", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    registerChat(deps, "missing-fields");
    const missing = await handleMemoryRetrieveContext(makeCtx({}), deps);
    expect(missing.status).toBe(400);
    const missingChat = await handleMemoryRetrieveContext(
      makeCtx({ projectPath: "/tmp/project-only" }),
      deps,
    );
    expect(missingChat.status).toBe(400);
  });

  it("returns an empty contextBlock when the vault has no memories", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const chat = registerChat(deps, "empty");
    const result = await handleMemoryRetrieveContext(
      makeCtx({ projectPath: chat.projectPath, chatId: chat.chatId }),
      deps,
    );
    expect(result.status).toBe(200);
    const body = asJson(result);
    expect(body.contextBlock).toEqual({ text: "", memories: [] });
    expect(body.included).toEqual([]);
    expect(body.omitted).toEqual([]);
    const budget = body.budget as { tokens: number; used: number };
    expect(typeof budget.tokens).toBe("number");
    expect(budget.used).toBe(0);
  });

  it("returns included memories with inclusion reasons when vault has matching records", async () => {
    const vault = makeVault();
    insertAcceptedMemory(vault);
    const deps = makeDeps({ memoryVault: vault });
    const chat = registerChat(deps, "included");
    const result = await handleMemoryRetrieveContext(
      makeCtx({
        projectPath: chat.projectPath,
        chatId: chat.chatId,
        queryText: "TypeScript strict",
      }),
      deps,
    );
    expect(result.status).toBe(200);
    const body = asJson(result);
    const block = body.contextBlock as { text: string; memories: readonly unknown[] };
    expect(block.memories).toHaveLength(1);
    expect(block.text.length).toBeGreaterThan(0);
    expect(body.included).toHaveLength(1);
  });

  it("suppresses proposed memories from conversation retrieval until they are accepted", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const chat = registerChat(deps, "proposed-suppressed");
    const capture = await handleMemoryCaptureFromConversation(
      makeCtx({
        text: "remember that the formatter unique-token-xyz is biome",
        context: { projectPath: chat.projectPath, chatId: chat.chatId },
      }),
      deps,
    );
    const outcomes = asJson(capture).outcomes as readonly {
      proposal?: { proposalId: string };
    }[];
    const proposalId = outcomes[0]?.proposal?.proposalId;
    if (proposalId === undefined) {
      throw new Error("expected a proposed memory to be persisted");
    }

    const result = await handleMemoryRetrieveContext(
      makeCtx({
        projectPath: chat.projectPath,
        chatId: chat.chatId,
        queryText: "Which formatter should I use?",
      }),
      deps,
    );
    expect(result.status).toBe(200);
    const body = asJson(result);
    expect(body.included).toEqual([]);
    expect((body.contextBlock as { text: string }).text).toBe("");
    expect(body.omitted).toContainEqual({
      memoryId: proposalId,
      reason: "suppressed-by-status",
      suppressionDetail: "proposed",
    });
  });

  it("omits unrelated accepted memories below the relevance floor when a query is present", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const chat = registerChat(deps, "relevance-floor");
    const scope = projectScope(chat.projectPath);
    insertAcceptedMemory(vault, { body: "the formatter is biome", scope });
    const unrelated = insertAcceptedMemory(vault, {
      body: "deploys happen on Tuesdays",
      scope,
    });

    const result = await handleMemoryRetrieveContext(
      makeCtx({
        projectPath: chat.projectPath,
        chatId: chat.chatId,
        queryText: "Which formatter should I use?",
      }),
      deps,
    );
    expect(result.status).toBe(200);
    const body = asJson(result);
    const block = body.contextBlock as { text: string };
    expect(block.text).toContain("the formatter is biome");
    expect(block.text).not.toContain("deploys happen on Tuesdays");
    expect(body.omitted).toContainEqual({
      memoryId: unrelated.id,
      reason: "below-threshold",
    });
  });

  it("returns 400 when queryText or budgetTokens are invalid", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const chat = registerChat(deps, "invalid-params");
    const badQuery = await handleMemoryRetrieveContext(
      makeCtx({ projectPath: chat.projectPath, chatId: chat.chatId, queryText: 42 }),
      deps,
    );
    expect(badQuery.status).toBe(400);
    const badBudget = await handleMemoryRetrieveContext(
      makeCtx({ projectPath: chat.projectPath, chatId: chat.chatId, budgetTokens: -1 }),
      deps,
    );
    expect(badBudget.status).toBe(400);
  });

  it("excludes a forgotten (tombstoned) memory from included and contextBlock text", async () => {
    // AC7: memory-aware conversation must exclude deleted/out-of-scope memory.
    // This test pins the "deleted" (status=forgotten) path. The vault.updateMemory call
    // transitions accepted→forgotten, which is a valid status edge per the contract.
    // The retrieval layer receives the forgotten row (vaultAsQueryPort passes includeExpired
    // but the vault returns all statuses by default) and suppresses it with reason="forgotten".
    const vault = makeVault();
    const kept = insertAcceptedMemory(vault, { body: "Retained memory: prefer pnpm." });
    const forgotten = insertAcceptedMemory(vault, {
      body: "Forgotten memory: obsolete preference that must not appear.",
    });
    // Tombstone by transitioning to the absorbing "forgotten" status.
    vault.updateMemory(forgotten.id, { status: "forgotten" }, Date.now());

    const deps = makeDeps({ memoryVault: vault });
    const chat = registerChat(deps, "forgotten-excluded");
    const result = await handleMemoryRetrieveContext(
      makeCtx({ projectPath: chat.projectPath, chatId: chat.chatId }),
      deps,
    );
    expect(result.status).toBe(200);
    const body = asJson(result);

    // The forgotten memory's body must never appear in the prompt text.
    const block = body.contextBlock as { text: string; memories: readonly unknown[] };
    expect(block.text).not.toContain("obsolete preference");

    // The forgotten memory must not be in included.
    const included = body.included as readonly { memoryId: string }[];
    expect(included.every((m) => m.memoryId !== forgotten.id)).toBe(true);

    // The forgotten memory must appear in omitted with suppressionDetail=forgotten.
    const omitted = body.omitted as readonly {
      memoryId: string;
      reason: string;
      suppressionDetail?: string;
    }[];
    expect(omitted).toContainEqual({
      memoryId: forgotten.id,
      reason: "suppressed-by-status",
      suppressionDetail: "forgotten",
    });

    // Sanity: the kept memory is still available for inclusion (scope-matched user memories
    // are included; this guards against a false-pass where ALL memories are omitted).
    expect(kept.status).toBe("accepted");
  });

  it("surfaces expired memories as omitted with suppressionDetail=expired", async () => {
    const vault = makeVault();
    insertAcceptedMemory(vault, { body: "Fresh memory remains includable." });
    const expired = insertAcceptedMemory(vault, {
      body: "This memory is past its validity window.",
      validUntil: Date.now() - 1,
    });
    const deps = makeDeps({ memoryVault: vault });
    const chat = registerChat(deps, "expired");
    const result = await handleMemoryRetrieveContext(
      makeCtx({ projectPath: chat.projectPath, chatId: chat.chatId }),
      deps,
    );
    expect(result.status).toBe(200);
    const body = asJson(result);
    const omitted = body.omitted as readonly {
      memoryId: string;
      reason: string;
      suppressionDetail?: string;
    }[];
    expect(omitted).toContainEqual({
      memoryId: expired.id,
      reason: "suppressed-by-status",
      suppressionDetail: "expired",
    });
  });

  it("exposes vault edge lookups through the live query-port adapter", () => {
    const vault = makeVault();
    const source = insertAcceptedMemory(vault, { body: "Seed memory." });
    const target = insertAcceptedMemory(vault, { body: "Linked memory." });
    const edge = insertRelatedEdge(vault, source.id, target.id);

    const port = vaultAsQueryPort(vault);

    expect(port.listOutgoingEdges?.(source.id)).toEqual([edge]);
    expect(port.listIncomingEdges?.(target.id)).toEqual([edge]);
  });

  it("rejects oversize bodies with 413", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const chat = registerChat(deps, "oversize");
    const oversize = {
      projectPath: chat.projectPath,
      chatId: chat.chatId,
      queryText: "x".repeat(70_000),
    };
    const result = await handleMemoryRetrieveContext(makeCtx(oversize), deps);
    expect(result.status).toBe(413);
  });

  it("returns 404 when chatId does not belong to the supplied projectPath", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const chat = registerChat(deps, "chat-owner");
    const other = registerChat(deps, "other-project");
    const result = await handleMemoryRetrieveContext(
      makeCtx({ projectPath: other.projectPath, chatId: chat.chatId }),
      deps,
    );
    expect(result.status).toBe(404);
  });
});

// ── /api/memory/capture-from-conversation ─────────────────────────────────────

describe("handleMemoryCaptureFromConversation", () => {
  it("returns 503 when no vault is configured", async () => {
    const deps = makeDeps();
    const chat = registerChat(deps, "capture-no-vault");
    const result = await handleMemoryCaptureFromConversation(
      makeCtx({
        text: "remember that we deploy on Fridays",
        context: { projectPath: chat.projectPath, chatId: chat.chatId },
      }),
      deps,
    );
    expect(result.status).toBe(503);
  });

  it("returns 400 when text is missing or empty", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const chat = registerChat(deps, "capture-text");
    const missing = await handleMemoryCaptureFromConversation(
      makeCtx({ context: { projectPath: chat.projectPath, chatId: chat.chatId } }),
      deps,
    );
    expect(missing.status).toBe(400);
    const empty = await handleMemoryCaptureFromConversation(
      makeCtx({ text: "", context: { projectPath: chat.projectPath, chatId: chat.chatId } }),
      deps,
    );
    expect(empty.status).toBe(400);
  });

  it("returns 400 when context.projectPath or context.chatId is missing", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const result = await handleMemoryCaptureFromConversation(
      makeCtx({ text: "remember that we deploy on Fridays", context: {} }),
      deps,
    );
    expect(result.status).toBe(400);
  });

  it("returns an empty outcome list when no intent is detected", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const chat = registerChat(deps, "capture-empty");
    const result = await handleMemoryCaptureFromConversation(
      makeCtx({
        text: "what is the weather like?",
        context: { projectPath: chat.projectPath, chatId: chat.chatId },
      }),
      deps,
    );
    expect(result.status).toBe(200);
    const body = asJson(result);
    expect(Array.isArray(body.outcomes)).toBe(true);
    expect((body.outcomes as readonly unknown[]).length).toBe(0);
  });

  it("captures an explicit remember intent and returns a candidate outcome", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const chat = registerChat(deps, "capture-remember");
    const result = await handleMemoryCaptureFromConversation(
      makeCtx({
        text: "remember that we use pnpm not npm for installs",
        context: { projectPath: chat.projectPath, chatId: chat.chatId },
      }),
      deps,
    );
    expect(result.status).toBe(200);
    const body = asJson(result);
    const outcomes = body.outcomes as readonly {
      kind: string;
      proposal?: { proposalId: string; body: string };
    }[];
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]?.kind).toBe("candidate");
    expect(typeof outcomes[0]?.proposal?.proposalId).toBe("string");
    expect((outcomes[0]?.proposal?.body ?? "").length).toBeGreaterThan(0);
  });

  // eslint-disable-next-line complexity
  it("captures an ambient identity statement as a reviewable user-scoped candidate", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const chat = registerChat(deps, "capture-ambient-identity");
    const result = await handleMemoryCaptureFromConversation(
      makeCtx({
        text: "Hallo Keiko, ich bin Paul.",
        context: { projectPath: chat.projectPath, chatId: chat.chatId },
      }),
      deps,
    );
    expect(result.status).toBe(200);
    const outcomes = asJson(result).outcomes as readonly {
      kind: string;
      proposal?: { proposalId: string; body: string; scope?: { kind: string; userId?: string } };
    }[];
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.kind).toBe("candidate");
    expect(outcomes[0]?.proposal?.body).toBe("The user's name is Paul.");
    expect(outcomes[0]?.proposal?.scope).toEqual({ kind: "user", userId: "local-operator" });
    const proposalId = outcomes[0]?.proposal?.proposalId;
    expect(typeof proposalId).toBe("string");
    if (proposalId !== undefined) {
      const stored = vault.getMemory(proposalId as unknown as MemoryId);
      expect(stored?.status).toBe("proposed");
      expect(stored?.scope).toEqual({ kind: "user", userId: "local-operator" });
      expect(stored?.body).toBe("The user's name is Paul.");
    }
  });

  it("rejects provider base URLs at the capture boundary and persists nothing", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const chat = registerChat(deps, "capture-provider-url");
    const result = await handleMemoryCaptureFromConversation(
      makeCtx({
        text: "remember that our provider base URL is https://llm.internal.example.com/v1",
        context: { projectPath: chat.projectPath, chatId: chat.chatId },
      }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(asJson(result).outcomes).toEqual([
      { kind: "rejected", reason: "provider-base-url" },
    ]);
    expect(vault.listMemoriesByScope(projectScope(chat.projectPath), { includeExpired: true })).toEqual(
      [],
    );
  });

  it("rejects raw log excerpts at the capture boundary and persists nothing", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const chat = registerChat(deps, "capture-raw-log");
    const result = await handleMemoryCaptureFromConversation(
      makeCtx({
        text: "remember that this raw log matters: ERROR 2026-06-08T06:00:00Z worker failed at module X with stack trace line 1 at foo() line 2 at bar()",
        context: { projectPath: chat.projectPath, chatId: chat.chatId },
      }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(asJson(result).outcomes).toEqual([
      { kind: "rejected", reason: "raw-log-content" },
    ]);
    expect(vault.listMemoriesByScope(projectScope(chat.projectPath), { includeExpired: true })).toEqual(
      [],
    );
  });

  it("resolves an explicit forget intent against in-scope memories", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const chat = registerChat(deps, "capture-forget");
    const existing = insertAcceptedMemory(vault, {
      body: "I prefer dark mode in the editor.",
      scope: projectScope(chat.projectPath),
    });
    const result = await handleMemoryCaptureFromConversation(
      makeCtx({
        text: "forget about dark mode preference",
        context: { projectPath: chat.projectPath, chatId: chat.chatId },
      }),
      deps,
    );
    expect(result.status).toBe(200);
    const body = asJson(result);
    const outcomes = body.outcomes as readonly [
      { kind: string; operation?: { memoryId: string }; reason?: string },
    ];
    const first = outcomes[0];
    expect(first.kind).toBe("forget");
    expect(first.operation?.memoryId).toBe(existing.id);
  });

  it("resolves an explicit update intent against in-scope memories", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const chat = registerChat(deps, "capture-update");
    const existing = insertAcceptedMemory(vault, {
      body: "The test runner is jest.",
      scope: projectScope(chat.projectPath),
    });
    const result = await handleMemoryCaptureFromConversation(
      makeCtx({
        text: "update memory about test runner to be vitest",
        context: { projectPath: chat.projectPath, chatId: chat.chatId },
      }),
      deps,
    );
    expect(result.status).toBe(200);
    const body = asJson(result);
    const outcomes = body.outcomes as readonly [
      { kind: string; operation?: { memoryId: string; bodyPatch: string }; reason?: string },
    ];
    const first = outcomes[0];
    expect(first.kind).toBe("update");
    expect(first.operation?.memoryId).toBe(existing.id);
    expect(first.operation?.bodyPatch).toBe("vitest");
  });

  it("returns an ambiguous rejection when multiple memories match a forget target", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const chat = registerChat(deps, "capture-ambiguous");
    const scope = projectScope(chat.projectPath);
    insertAcceptedMemory(vault, { body: "I prefer dark mode in the editor.", scope });
    insertAcceptedMemory(vault, { body: "Dark mode is required in the terminal.", scope });
    const result = await handleMemoryCaptureFromConversation(
      makeCtx({
        text: "forget about dark mode",
        context: { projectPath: chat.projectPath, chatId: chat.chatId },
      }),
      deps,
    );
    expect(result.status).toBe(200);
    const body = asJson(result);
    const outcomes = body.outcomes as readonly [{ kind: string; reason?: string }];
    expect(outcomes[0]).toEqual({ kind: "rejected", reason: "ambiguous-forget" });
  });

  it("rejects oversize bodies with 413", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const chat = registerChat(deps, "capture-oversize");
    const oversize = {
      text: "x".repeat(70_000),
      context: { projectPath: chat.projectPath, chatId: chat.chatId },
    };
    const result = await handleMemoryCaptureFromConversation(makeCtx(oversize), deps);
    expect(result.status).toBe(413);
  });

  // Issue #642 — candidate outcomes must be persisted as `proposed` memory records so the
  // shared /api/memory/proposals/:id/accept route can transition them to accepted.
  describe("issue #642 — candidate persistence enables proposal accept", () => {
    function acceptCtx(id: string): RouteContext {
      const socket = new Socket();
      return {
        req: makeReq({}),
        res: { socket } as unknown as RouteContext["res"],
        params: { id },
        url: new URL(`http://127.0.0.1/api/memory/proposals/${id}/accept`),
      };
    }

    it("persists a candidate outcome as a `proposed` memory record under the returned id", async () => {
      const vault = makeVault();
      const deps = makeDeps({ memoryVault: vault });
      const chat = registerChat(deps, "capture-persist");
      const result = await handleMemoryCaptureFromConversation(
        makeCtx({
          text: "remember that release hardening uses vitest",
          context: { projectPath: chat.projectPath, chatId: chat.chatId },
        }),
        deps,
      );
      expect(result.status).toBe(200);
      const body = asJson(result);
      const outcomes = body.outcomes as readonly {
        kind: string;
        proposal?: { proposalId: string };
      }[];
      const proposalId = outcomes[0]?.proposal?.proposalId;
      expect(typeof proposalId).toBe("string");
      const stored = vault.getMemory(proposalId as unknown as MemoryId);
      expect(stored).not.toBeUndefined();
      expect(stored?.status).toBe("proposed");
    });

    it("allows the accept route to transition the captured proposal to accepted", async () => {
      const vault = makeVault();
      const deps = makeDeps({ memoryVault: vault });
      const chat = registerChat(deps, "capture-then-accept");
      const captureResult = await handleMemoryCaptureFromConversation(
        makeCtx({
          text: "remember that release hardening uses vitest",
          context: { projectPath: chat.projectPath, chatId: chat.chatId },
        }),
        deps,
      );
      const outcomes = asJson(captureResult).outcomes as readonly {
        proposal?: { proposalId: string };
      }[];
      const proposalId = outcomes[0]?.proposal?.proposalId;
      if (proposalId === undefined) {
        throw new Error("expected capture to emit a candidate proposalId");
      }
      const accepted = handleAcceptMemoryProposal(acceptCtx(proposalId), deps);
      expect(accepted.status).toBe(200);
      const reloaded = vault.getMemory(proposalId as unknown as MemoryId);
      expect(reloaded?.status).toBe("accepted");
    });

    it("does not insert records for non-candidate outcomes", async () => {
      const vault = makeVault();
      const deps = makeDeps({ memoryVault: vault });
      const chat = registerChat(deps, "capture-no-intent");
      const before = vault.listMemoriesByScope(
        { kind: "user", userId: "local" as unknown as MemoryUserId },
        { includeExpired: true },
      ).length;
      await handleMemoryCaptureFromConversation(
        makeCtx({
          text: "what is the weather like?",
          context: { projectPath: chat.projectPath, chatId: chat.chatId },
        }),
        deps,
      );
      const projectMemories = vault.listMemoriesByScope(projectScope(chat.projectPath), {
        includeExpired: true,
      });
      // No project-scoped memories should have been written for a chat with no detected intent.
      expect(projectMemories.length).toBe(0);
      // And nothing was added to the user scope either.
      const after = vault.listMemoriesByScope(
        { kind: "user", userId: "local" as unknown as MemoryUserId },
        { includeExpired: true },
      ).length;
      expect(after).toBe(before);
    });
  });
});
