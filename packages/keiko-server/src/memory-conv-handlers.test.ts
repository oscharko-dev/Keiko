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
import { mkdtempSync, rmSync } from "node:fs";
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
function brandedEdgeId(value: string): MemoryEdge["id"] {
  const u: unknown = value;
  return u as MemoryEdge["id"];
}

function insertAcceptedMemory(
  vault: MemoryVaultStore,
  options: { body?: string; userId?: string; validUntil?: number } = {},
): MemoryRecord {
  const id: MemoryId = brandedMemoryId(`mem-${Math.random().toString(36).slice(2, 10)}`);
  const userId: MemoryUserId = brandedMemoryUserId(options.userId ?? "u-1");
  const now = Date.now();
  const record: MemoryRecord = {
    id,
    schemaVersion: "1",
    scope: { kind: "user", userId },
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
    const result = await handleMemoryRetrieveContext(
      makeCtx({ scopes: [{ kind: "user", userId: "u-1" }] }),
      makeDeps(),
    );
    expect(result.status).toBe(503);
  });

  it("returns 400 when scopes is missing or empty", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const missing = await handleMemoryRetrieveContext(makeCtx({}), deps);
    expect(missing.status).toBe(400);
    const empty = await handleMemoryRetrieveContext(makeCtx({ scopes: [] }), deps);
    expect(empty.status).toBe(400);
  });

  it("returns 400 when a scope has an invalid kind", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const result = await handleMemoryRetrieveContext(
      makeCtx({ scopes: [{ kind: "not-a-real-kind", userId: "u-1" }] }),
      deps,
    );
    expect(result.status).toBe(400);
  });

  it("returns an empty contextBlock when the vault has no memories", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const result = await handleMemoryRetrieveContext(
      makeCtx({ scopes: [{ kind: "user", userId: "u-1" }] }),
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
    const result = await handleMemoryRetrieveContext(
      makeCtx({
        scopes: [{ kind: "user", userId: "u-1" }],
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

  it("returns 400 when queryText or budgetTokens are invalid", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const badQuery = await handleMemoryRetrieveContext(
      makeCtx({ scopes: [{ kind: "user", userId: "u-1" }], queryText: 42 }),
      deps,
    );
    expect(badQuery.status).toBe(400);
    const badBudget = await handleMemoryRetrieveContext(
      makeCtx({ scopes: [{ kind: "user", userId: "u-1" }], budgetTokens: -1 }),
      deps,
    );
    expect(badBudget.status).toBe(400);
  });

  it("surfaces expired memories as omitted with suppressionDetail=expired", async () => {
    const vault = makeVault();
    insertAcceptedMemory(vault, { body: "Fresh memory remains includable." });
    const expired = insertAcceptedMemory(vault, {
      body: "This memory is past its validity window.",
      validUntil: Date.now() - 1,
    });
    const deps = makeDeps({ memoryVault: vault });
    const result = await handleMemoryRetrieveContext(
      makeCtx({ scopes: [{ kind: "user", userId: "u-1" }] }),
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
    const oversize = { scopes: [{ kind: "user", userId: "u-1" }], queryText: "x".repeat(70_000) };
    const result = await handleMemoryRetrieveContext(makeCtx(oversize), deps);
    expect(result.status).toBe(413);
  });
});

// ── /api/memory/capture-from-conversation ─────────────────────────────────────

describe("handleMemoryCaptureFromConversation", () => {
  it("returns 503 when no vault is configured", async () => {
    const result = await handleMemoryCaptureFromConversation(
      makeCtx({
        text: "remember that we deploy on Fridays",
        context: { userId: "u-1" },
      }),
      makeDeps(),
    );
    expect(result.status).toBe(503);
  });

  it("returns 400 when text is missing or empty", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const missing = await handleMemoryCaptureFromConversation(
      makeCtx({ context: { userId: "u-1" } }),
      deps,
    );
    expect(missing.status).toBe(400);
    const empty = await handleMemoryCaptureFromConversation(
      makeCtx({ text: "", context: { userId: "u-1" } }),
      deps,
    );
    expect(empty.status).toBe(400);
  });

  it("returns 400 when context.userId is missing", async () => {
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
    const result = await handleMemoryCaptureFromConversation(
      makeCtx({ text: "what is the weather like?", context: { userId: "u-1" } }),
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
    const result = await handleMemoryCaptureFromConversation(
      makeCtx({
        text: "remember that we use pnpm not npm for installs",
        context: { userId: "u-1" },
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

  it("resolves an explicit forget intent against in-scope memories", async () => {
    const vault = makeVault();
    const existing = insertAcceptedMemory(vault, { body: "I prefer dark mode in the editor." });
    const deps = makeDeps({ memoryVault: vault });
    const result = await handleMemoryCaptureFromConversation(
      makeCtx({ text: "forget about dark mode preference", context: { userId: "u-1" } }),
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
    const existing = insertAcceptedMemory(vault, { body: "The test runner is jest." });
    const deps = makeDeps({ memoryVault: vault });
    const result = await handleMemoryCaptureFromConversation(
      makeCtx({
        text: "update memory about test runner to be vitest",
        context: { userId: "u-1" },
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
    insertAcceptedMemory(vault, { body: "I prefer dark mode in the editor." });
    insertAcceptedMemory(vault, { body: "Dark mode is required in the terminal." });
    const deps = makeDeps({ memoryVault: vault });
    const result = await handleMemoryCaptureFromConversation(
      makeCtx({ text: "forget about dark mode", context: { userId: "u-1" } }),
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
    const oversize = { text: "x".repeat(70_000), context: { userId: "u-1" } };
    const result = await handleMemoryCaptureFromConversation(makeCtx(oversize), deps);
    expect(result.status).toBe(413);
  });
});
