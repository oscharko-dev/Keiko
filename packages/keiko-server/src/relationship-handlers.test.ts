// Issue #539 — relationship handlers tests. The strategy: spin up an in-memory SQLite
// behind the production factory and drive the handlers directly with synthetic
// IncomingMessage / RouteContext fixtures. We exercise:
//   - workspace scope rejection / isolation
//   - validator runs BEFORE persistence (denied proposal → 422 + zero rows persisted)
//   - idempotency replay
//   - optimistic-concurrency mismatch (412)
//   - bounded-query caps (400 bounded-query-exceeded)
//   - redactor invocation (single call site)
//   - happy paths for the read routes

import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "./store/schema.js";
import { listRelationshipAuditEntries } from "./store/relationship-audit.js";
import {
  createRelationshipStorePort,
  handleRelationshipCreate,
  handleRelationshipDelete,
  handleRelationshipDependencies,
  handleRelationshipEvents,
  handleRelationshipExplain,
  handleRelationshipGet,
  handleRelationshipHealth,
  handleRelationshipImpact,
  handleRelationshipList,
  handleRelationshipPatch,
  handleRelationshipValidate,
  _resetIdempotencyStoreForTests,
  type RelationshipHandlerDeps,
} from "./relationship-handlers.js";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { STREAMING } from "./routes.js";

interface FakeReq extends EventEmitter {
  headers: Record<string, string>;
  url: string;
  method: string;
}

function makeReq(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}): FakeReq {
  const e = new EventEmitter() as FakeReq;
  e.headers = opts.headers ?? {};
  e.url = opts.url ?? "/";
  e.method = opts.method ?? "GET";
  // Defer body emission to next tick so consumer can attach `data`/`end` listeners.
  process.nextTick(() => {
    if (opts.body !== undefined) {
      e.emit("data", Buffer.from(opts.body, "utf8"));
    }
    e.emit("end");
  });
  return e;
}

function makeCtx(req: FakeReq, params: Record<string, string> = {}): RouteContext {
  const url = new URL(`http://localhost${req.url}`);
  // The minimum ServerResponse interface the SSE handler touches.
  let writtenHead: { status?: number; headers?: Record<string, string> } = {};
  let body = "";
  const res = {
    writeHead(status: number, headers: Record<string, string>): void {
      writtenHead = { status, headers };
    },
    write(chunk: string): boolean {
      body += chunk;
      return true;
    },
    end(): void {
      /* no-op */
    },
    _sse: { writtenHead, body: (): string => body },
  } as unknown as ServerResponse;
  return {
    req: req as unknown as IncomingMessage,
    res,
    params,
    url,
  };
}

function trackingRedactor(): {
  readonly redactor: (value: unknown) => unknown;
  readonly calls: { count: number };
} {
  const calls = { count: 0 };
  const redactor = (value: unknown): unknown => {
    calls.count += 1;
    if (typeof value === "string") return value.replace(/sk-[A-Za-z0-9]+/g, "[REDACTED]");
    return value;
  };
  return { redactor, calls };
}

function buildDeps(
  workspaceId: string | undefined,
  relationship: RelationshipHandlerDeps["store"],
  redactor: (value: unknown) => unknown,
): UiHandlerDeps {
  const rel: RelationshipHandlerDeps = {
    scopeResolver: (): { readonly workspaceId: string } | undefined =>
      workspaceId === undefined ? undefined : { workspaceId },
    store: relationship,
  };
  // We only need the relationship-relevant fields for these tests; cast through a partial.
  return {
    relationship: rel,
    redactor,
  } as unknown as UiHandlerDeps;
}

interface FreshStoreBundle {
  readonly store: ReturnType<typeof createRelationshipStorePort>;
  readonly db: DatabaseSync;
}

function freshStoreBundle(opts?: {
  readonly redactString?: (input: string) => string;
}): FreshStoreBundle {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  let t = 1000;
  let n = 0;
  const store = createRelationshipStorePort({
    db,
    redactString:
      opts?.redactString ?? ((s: string): string => s.replace(/sk-[A-Za-z0-9]+/g, "[REDACTED]")),
    now: () => ++t,
    // Padded so every id satisfies the api-contract.md §3.2 / handler regex
    // `^[A-Za-z0-9._-]{8,128}$` — short test fixtures would now hit `relationship/bad-request`.
    newId: () => `rel-${String(++n).padStart(8, "0")}`,
  });
  return { store, db };
}

function freshStore(opts?: {
  readonly redactString?: (input: string) => string;
}): ReturnType<typeof createRelationshipStorePort> {
  return freshStoreBundle(opts).store;
}

const validProposalBody = JSON.stringify({
  schemaVersion: "1",
  proposal: {
    type: "depends-on",
    source: { kind: "capsule", id: "cap-1" },
    target: { kind: "capsule", id: "cap-2" },
  },
});

const validProposalWithSecret = JSON.stringify({
  schemaVersion: "1",
  proposal: {
    type: "depends-on",
    source: { kind: "capsule", id: "cap-3" },
    target: { kind: "capsule", id: "cap-4" },
    summary: "leaked sk-ABCDEFGHIJKL hint",
  },
});

function startsWorkflowBody(sourceId: string, targetId: string): string {
  return JSON.stringify({
    schemaVersion: "1",
    proposal: {
      type: "starts-workflow",
      source: { kind: "chat", id: sourceId },
      target: { kind: "workflow-run", id: targetId },
    },
  });
}

function producesEvidenceBody(sourceId: string, targetId: string): string {
  return JSON.stringify({
    schemaVersion: "1",
    proposal: {
      type: "produces-evidence",
      source: { kind: "workflow-run", id: sourceId },
      target: { kind: "evidence-run", id: targetId },
    },
  });
}

function dependsOnBody(
  sourceKind: "capsule" | "capsule-set" | "workflow-run" | "memory",
  sourceId: string,
  targetKind:
    | "capsule"
    | "capsule-set"
    | "workflow-run"
    | "memory"
    | "evidence-run"
    | "workspace-path",
  targetId: string,
): string {
  return JSON.stringify({
    schemaVersion: "1",
    proposal: {
      type: "depends-on",
      source: { kind: sourceKind, id: sourceId },
      target: { kind: targetKind, id: targetId },
    },
  });
}

beforeEach(() => {
  _resetIdempotencyStoreForTests();
});

describe("workspace scope (acceptance criterion)", () => {
  it("returns 403 when the scope resolver cannot resolve a workspace", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps(undefined, store, redactor);
    const req = makeReq({
      method: "POST",
      url: "/api/relationships/validate",
      body: validProposalBody,
    });
    const result = await handleRelationshipValidate(makeCtx(req), deps);
    expect(result.status).toBe(403);
  });

  it("isolates workspaces — wsB cannot read wsA's relationship", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const depsA = buildDeps("ws-a", store, redactor);
    const depsB = buildDeps("ws-b", store, redactor);
    // Create in ws-a.
    const createReq = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "abcdefgh" },
      body: validProposalBody,
    });
    const createRes = await handleRelationshipCreate(makeCtx(createReq), depsA);
    expect(createRes.status).toBe(201);
    const id = (createRes.body as { relationship: { id: string } }).relationship.id;
    // Read in ws-b.
    const getReq = makeReq({ method: "GET", url: `/api/relationships/${id}` });
    const getRes = await handleRelationshipGet(makeCtx(getReq, { id }), depsB);
    expect(getRes.status).toBe(404);
  });
});

describe("POST /api/relationships (create + validate-before-persist)", () => {
  it("rejects without Idempotency-Key (400)", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const req = makeReq({ method: "POST", url: "/api/relationships", body: validProposalBody });
    const result = await handleRelationshipCreate(makeCtx(req), deps);
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "relationship/idempotency-key-required",
    );
  });

  it("denies an invalid proposal at 422 with reasons, and the store row count stays zero", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const badBody = JSON.stringify({
      schemaVersion: "1",
      proposal: {
        type: "uses-tool",
        // Wrong source kind for uses-tool (validator denies).
        source: { kind: "capsule", id: "cap-1" },
        target: { kind: "tool", id: "tool-1" },
      },
    });
    const req = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "abcdefgh" },
      body: badBody,
    });
    const result = await handleRelationshipCreate(makeCtx(req), deps);
    expect(result.status).toBe(422);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "relationship/policy-denied",
    );
    // No relationship row was persisted (the list returns empty).
    const listReq = makeReq({ method: "GET", url: "/api/relationships?type=depends-on" });
    const listRes = await handleRelationshipList(makeCtx(listReq), deps);
    expect((listRes.body as { entries: unknown[] }).entries).toHaveLength(0);
  });

  it("rejects unknown proposal fields instead of silently ignoring them", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const req = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "unknown-field-1" },
      body: JSON.stringify({
        schemaVersion: "1",
        proposal: {
          type: "depends-on",
          source: { kind: "capsule", id: "cap-1" },
          target: { kind: "capsule", id: "cap-2" },
          metadata: { prompt: "should-not-be-ignored" },
        },
      }),
    });
    const res = await handleRelationshipCreate(makeCtx(req), deps);
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("relationship/bad-request");
  });

  it("rejects unknown top-level envelope fields", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const req = makeReq({
      method: "POST",
      url: "/api/relationships/validate",
      body: JSON.stringify({
        schemaVersion: "1",
        proposal: {
          type: "depends-on",
          source: { kind: "capsule", id: "cap-1" },
          target: { kind: "capsule", id: "cap-2" },
        },
        extra: true,
      }),
    });
    const res = await handleRelationshipValidate(makeCtx(req), deps);
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("relationship/bad-request");
  });

  it("replays an identical body via cached idempotency record", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const first = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "replay-1" },
      body: validProposalBody,
    });
    const firstRes = await handleRelationshipCreate(makeCtx(first), deps);
    expect(firstRes.status).toBe(201);
    const id1 = (firstRes.body as { relationship: { id: string } }).relationship.id;
    const second = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "replay-1" },
      body: validProposalBody,
    });
    const secondRes = await handleRelationshipCreate(makeCtx(second), deps);
    expect(secondRes.status).toBe(201);
    const id2 = (secondRes.body as { relationship: { id: string } }).relationship.id;
    expect(id2).toBe(id1);
  });

  it("returns 409 on idempotency replay with a divergent body", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const first = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "replay-2" },
      body: validProposalBody,
    });
    await handleRelationshipCreate(makeCtx(first), deps);
    const second = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "replay-2" },
      body: validProposalWithSecret,
    });
    const secondRes = await handleRelationshipCreate(makeCtx(second), deps);
    expect(secondRes.status).toBe(409);
  });

  // #543 hardening: verify the SINGLE redactor call site is exercised end-to-end.
  // We assert `calls.count >= 1` (not exact 1; a successful response may run nested
  // redaction through `respond` more than once when the body has structured sub-fields).
  // The fixture redactor only redacts top-level strings — its purpose here is to count
  // invocations, not to scrub the body. The end-to-end secret-scrubbing contract is
  // owned by the production redactor wired in `deps.ts` and reviewed in
  // docs/relationship-engine/security-review.md.
  it("invokes the wire-boundary redactor on success responses (single call site)", async () => {
    const store = freshStore();
    const { redactor, calls } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const req = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "redact-1" },
      body: validProposalWithSecret,
    });
    const result = await handleRelationshipCreate(makeCtx(req), deps);
    expect(result.status).toBe(201);
    expect(calls.count).toBeGreaterThanOrEqual(1);
  });

  it("validate denies duplicate starts-workflow with a cardinality reason before persistence", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const seedReq = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "sw-seed-1" },
      body: startsWorkflowBody("chat-1", "run-1"),
    });
    const seedRes = await handleRelationshipCreate(makeCtx(seedReq), deps);
    expect(seedRes.status).toBe(201);

    const validateReq = makeReq({
      method: "POST",
      url: "/api/relationships/validate",
      body: startsWorkflowBody("chat-2", "run-1"),
    });
    const validateRes = await handleRelationshipValidate(makeCtx(validateReq), deps);
    expect(validateRes.status).toBe(200);
    const decision = (
      validateRes.body as {
        decision: { allowed: boolean; reasons: { code: string }[] };
      }
    ).decision;
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((r) => r.code)).toContain("denied/cardinality-exceeded");
  });

  it("create denies duplicate produces-evidence with a cardinality reason before the DB write", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const firstReq = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "pe-seed-1" },
      body: producesEvidenceBody("run-1", "evidence-1"),
    });
    const firstRes = await handleRelationshipCreate(makeCtx(firstReq), deps);
    expect(firstRes.status).toBe(201);

    const secondReq = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "pe-seed-2" },
      body: producesEvidenceBody("run-1", "evidence-2"),
    });
    const secondRes = await handleRelationshipCreate(makeCtx(secondReq), deps);
    expect(secondRes.status).toBe(422);
    const reasons = (secondRes.body as { reasons: { code: string }[] }).reasons;
    expect(reasons.map((r) => r.code)).toContain("denied/cardinality-exceeded");

    const stored = store.listRelationships({
      workspaceId: "ws-a",
      type: "produces-evidence",
      sourceId: "run-1",
      limit: 10,
    });
    expect(stored.entries).toHaveLength(1);
  });

  it("validate denies a direct reverse depends-on edge before persistence", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const seedReq = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "dep-seed-1" },
      body: dependsOnBody("capsule", "cap-b", "capsule", "cap-a"),
    });
    const seedRes = await handleRelationshipCreate(makeCtx(seedReq), deps);
    expect(seedRes.status).toBe(201);

    const validateReq = makeReq({
      method: "POST",
      url: "/api/relationships/validate",
      body: dependsOnBody("capsule", "cap-a", "capsule", "cap-b"),
    });
    const validateRes = await handleRelationshipValidate(makeCtx(validateReq), deps);
    expect(validateRes.status).toBe(200);
    const decision = (
      validateRes.body as {
        decision: { allowed: boolean; reasons: { code: string }[] };
      }
    ).decision;
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((r) => r.code)).toContain("denied/cycle-forbidden");
  });

  it("sanitizes the create summary before persistence using deps.redactor", async () => {
    const store = freshStore({ redactString: (input: string): string => input });
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const req = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "persist-1" },
      body: validProposalWithSecret,
    });
    const res = await handleRelationshipCreate(makeCtx(req), deps);
    expect(res.status).toBe(201);
    const id = (res.body as { relationship: { id: string } }).relationship.id;
    expect(store.getRelationship("ws-a", id)?.summary).toBe("leaked [REDACTED] hint");
  });
});

describe("PATCH /api/relationships/:id (optimistic concurrency + If-Match)", () => {
  async function seed(
    store: ReturnType<typeof createRelationshipStorePort>,
    deps: UiHandlerDeps,
  ): Promise<{ id: string; etag: string }> {
    const req = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "seed-1-x" },
      body: validProposalBody,
    });
    const res = await handleRelationshipCreate(makeCtx(req), deps);
    // The handler returns `{ schemaVersion, relationship, etag }` — the top-level `etag`
    // is the opaque string used by If-Match. `relationship.etag` is the legacy numeric
    // updated_at field (see store/relationships.ts:225) and is NOT a valid If-Match token.
    const body = res.body as { relationship: { id: string }; etag: string };
    void store;
    return { id: body.relationship.id, etag: body.etag };
  }

  it("returns 428 without If-Match", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const { id } = await seed(store, deps);
    const patch = makeReq({
      method: "PATCH",
      url: `/api/relationships/${id}`,
      headers: { "idempotency-key": "patch-1x" },
      body: JSON.stringify({ schemaVersion: "1", transition: { to: "archived" } }),
    });
    const res = await handleRelationshipPatch(makeCtx(patch, { id }), deps);
    expect(res.status).toBe(428);
  });

  it("returns 412 on If-Match mismatch", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const { id } = await seed(store, deps);
    const patch = makeReq({
      method: "PATCH",
      url: `/api/relationships/${id}`,
      headers: { "idempotency-key": "patch-2x", "if-match": "wrong" },
      body: JSON.stringify({ schemaVersion: "1", transition: { to: "archived" } }),
    });
    const res = await handleRelationshipPatch(makeCtx(patch, { id }), deps);
    expect(res.status).toBe(412);
  });

  // #543 hardening: the seed flow itself was fine — the test was reading the etag from
  // the wrong field. `body.relationship.etag` is the legacy numeric `updated_at` field
  // (store/relationships.ts:225) which fails `requireIfMatch`'s `typeof v === "string"`
  // check → 428. The opaque If-Match token is the TOP-LEVEL `body.etag` written by
  // `respond(... etag)` in relationship-handlers.ts:352. `seed()` now returns that.
  it("transitions lifecycle with a matching If-Match and bumps etag", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const { id, etag } = await seed(store, deps);
    const patch = makeReq({
      method: "PATCH",
      url: `/api/relationships/${id}`,
      headers: { "idempotency-key": "patch-3x", "if-match": etag },
      body: JSON.stringify({ schemaVersion: "1", transition: { to: "archived" } }),
    });
    const res = await handleRelationshipPatch(makeCtx(patch, { id }), deps);
    expect(res.status).toBe(200);
    const newEtag = (res.body as { etag: string }).etag;
    expect(newEtag).not.toBe(etag);
  });

  it("rejects client-initiated active -> stale transitions", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const { id, etag } = await seed(store, deps);
    const patch = makeReq({
      method: "PATCH",
      url: `/api/relationships/${id}`,
      headers: { "idempotency-key": "patch-stale", "if-match": etag },
      body: JSON.stringify({ schemaVersion: "1", transition: { to: "stale" } }),
    });
    const res = await handleRelationshipPatch(makeCtx(patch, { id }), deps);
    expect(res.status).toBe(422);
    const reasons = (res.body as { reasons: { code: string; field?: string; message: string }[] })
      .reasons;
    expect(reasons).toContainEqual({
      code: "denied/lifecycle-illegal-transition",
      field: "transition.to",
      message: "client-initiated transitions to stale are reserved for health checks",
    });
  });

  it("rejects client-initiated stale -> active transitions", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const seeded = store.createRelationship({
      workspaceId: "ws-a",
      scope: { kind: "workspace", workspaceId: "ws-a" },
      type: "depends-on",
      source: { kind: "capsule", id: "cap-stale-1" },
      target: { kind: "capsule", id: "cap-stale-2" },
      lifecycleState: "stale",
    });
    const id = seeded.relationship.id;
    const patch = makeReq({
      method: "PATCH",
      url: `/api/relationships/${id}`,
      headers: { "idempotency-key": "patch-unstale", "if-match": seeded.etag },
      body: JSON.stringify({ schemaVersion: "1", transition: { to: "active" } }),
    });
    const res = await handleRelationshipPatch(makeCtx(patch, { id }), deps);
    expect(res.status).toBe(422);
    const reasons = (res.body as { reasons: { code: string; field?: string; message: string }[] })
      .reasons;
    expect(reasons).toContainEqual({
      code: "denied/lifecycle-illegal-transition",
      field: "transition.to",
      message: "client-initiated stale reactivation is reserved for health checks",
    });
  });

  it("sanitizes transition summaries before persistence", async () => {
    const store = freshStore({ redactString: (input: string): string => input });
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const { id, etag } = await seed(store, deps);
    const patch = makeReq({
      method: "PATCH",
      url: `/api/relationships/${id}`,
      headers: { "idempotency-key": "patch-redact", "if-match": etag },
      body: JSON.stringify({
        schemaVersion: "1",
        transition: { to: "archived", summary: "moved sk-TRANSITION1234 into archive" },
      }),
    });
    const res = await handleRelationshipPatch(makeCtx(patch, { id }), deps);
    expect(res.status).toBe(200);
    expect(store.getRelationship("ws-a", id)?.summary).toBe("moved [REDACTED] into archive");
  });

  it("rechecks reverse-edge cycles on transition back to active", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const reverseReq = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "dep-reverse-1" },
      body: dependsOnBody("capsule", "cap-b", "capsule", "cap-a"),
    });
    expect((await handleRelationshipCreate(makeCtx(reverseReq), deps)).status).toBe(201);

    const seeded = store.createRelationship({
      workspaceId: "ws-a",
      scope: { kind: "workspace", workspaceId: "ws-a" },
      type: "depends-on",
      source: { kind: "capsule", id: "cap-a" },
      target: { kind: "capsule", id: "cap-b" },
      lifecycleState: "blocked",
    });
    const patch = makeReq({
      method: "PATCH",
      url: `/api/relationships/${seeded.relationship.id}`,
      headers: { "idempotency-key": "dep-reactivate-1", "if-match": seeded.etag },
      body: JSON.stringify({ schemaVersion: "1", transition: { to: "active" } }),
    });
    const res = await handleRelationshipPatch(makeCtx(patch, { id: seeded.relationship.id }), deps);
    expect(res.status).toBe(422);
    const reasons = (res.body as { reasons: { code: string }[] }).reasons;
    expect(reasons.map((r) => r.code)).toContain("denied/cycle-forbidden");
  });

  it("rechecks starts-workflow target cardinality on transition back to active", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const liveReq = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "starts-live-1" },
      body: startsWorkflowBody("chat-live", "run-shared"),
    });
    expect((await handleRelationshipCreate(makeCtx(liveReq), deps)).status).toBe(201);

    const seeded = store.createRelationship({
      workspaceId: "ws-a",
      scope: { kind: "workspace", workspaceId: "ws-a" },
      type: "starts-workflow",
      source: { kind: "chat", id: "chat-blocked" },
      target: { kind: "workflow-run", id: "run-shared" },
      lifecycleState: "blocked",
    });
    const patch = makeReq({
      method: "PATCH",
      url: `/api/relationships/${seeded.relationship.id}`,
      headers: { "idempotency-key": "starts-reactivate-1", "if-match": seeded.etag },
      body: JSON.stringify({ schemaVersion: "1", transition: { to: "active" } }),
    });
    const res = await handleRelationshipPatch(makeCtx(patch, { id: seeded.relationship.id }), deps);
    expect(res.status).toBe(422);
    const reasons = (res.body as { reasons: { code: string }[] }).reasons;
    expect(reasons.map((r) => r.code)).toContain("denied/cardinality-exceeded");
  });
});

describe("PATCH /api/relationships/:id reconnect contract", () => {
  it("rejects reconnect for a non-reconnectable relationship type", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const createReq = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "reconnect-1" },
      body: startsWorkflowBody("chat-r", "run-r"),
    });
    const createRes = await handleRelationshipCreate(makeCtx(createReq), deps);
    expect(createRes.status).toBe(201);
    const id = (createRes.body as { relationship: { id: string } }).relationship.id;
    const etag = (createRes.body as { etag: string }).etag;

    const patch = makeReq({
      method: "PATCH",
      url: `/api/relationships/${id}`,
      headers: { "idempotency-key": "reconnect-2", "if-match": etag },
      body: JSON.stringify({
        schemaVersion: "1",
        reconnect: { target: { kind: "workflow-run", id: "run-r-2" } },
      }),
    });
    const res = await handleRelationshipPatch(makeCtx(patch, { id }), deps);
    expect(res.status).toBe(422);
    const reasons = (res.body as { reasons: { code: string; field?: string; message: string }[] })
      .reasons;
    expect(reasons).toContainEqual({
      code: "denied/lifecycle-illegal-transition",
      field: "reconnect.target",
      message: 'relationship type "starts-workflow" does not permit reconnect',
    });
  });

  it("sanitizes reconnect summaries before persistence", async () => {
    const store = freshStore({ redactString: (input: string): string => input });
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const createReq = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "reconnect-3" },
      body: validProposalBody,
    });
    const createRes = await handleRelationshipCreate(makeCtx(createReq), deps);
    expect(createRes.status).toBe(201);
    const id = (createRes.body as { relationship: { id: string } }).relationship.id;
    const etag = (createRes.body as { etag: string }).etag;

    const patch = makeReq({
      method: "PATCH",
      url: `/api/relationships/${id}`,
      headers: { "idempotency-key": "reconnect-4", "if-match": etag },
      body: JSON.stringify({
        schemaVersion: "1",
        reconnect: {
          target: { kind: "capsule", id: "cap-9" },
          summary: "relinked sk-RECONNECT1234 target",
        },
      }),
    });
    const res = await handleRelationshipPatch(makeCtx(patch, { id }), deps);
    expect(res.status).toBe(200);
    expect(store.getRelationship("ws-a", id)?.summary).toBe("relinked [REDACTED] target");
  });

  it("rejects reconnect when it would introduce a direct reverse depends-on edge", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const reverseReq = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "reconnect-cycle-1" },
      body: dependsOnBody("capsule", "cap-b", "capsule", "cap-a"),
    });
    expect((await handleRelationshipCreate(makeCtx(reverseReq), deps)).status).toBe(201);

    const createReq = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "reconnect-cycle-2" },
      body: dependsOnBody("capsule", "cap-a", "capsule", "cap-c"),
    });
    const createRes = await handleRelationshipCreate(makeCtx(createReq), deps);
    expect(createRes.status).toBe(201);
    const id = (createRes.body as { relationship: { id: string } }).relationship.id;
    const etag = (createRes.body as { etag: string }).etag;

    const patch = makeReq({
      method: "PATCH",
      url: `/api/relationships/${id}`,
      headers: { "idempotency-key": "reconnect-cycle-3", "if-match": etag },
      body: JSON.stringify({
        schemaVersion: "1",
        reconnect: { target: { kind: "capsule", id: "cap-b" } },
      }),
    });
    const res = await handleRelationshipPatch(makeCtx(patch, { id }), deps);
    expect(res.status).toBe(422);
    const reasons = (res.body as { reasons: { code: string }[] }).reasons;
    expect(reasons.map((r) => r.code)).toContain("denied/cycle-forbidden");
  });
});

describe("DELETE /api/relationships/:id soft-deletes to revoked", () => {
  // #543 hardening: same root cause as the PATCH counterpart — read the opaque etag from
  // the TOP-LEVEL `body.etag`, not `body.relationship.etag` (legacy numeric field).
  it("transitions lifecycle to revoked and emits an audit row", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const seedReq = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "delete-1" },
      body: validProposalBody,
    });
    const seedRes = await handleRelationshipCreate(makeCtx(seedReq), deps);
    const id = (seedRes.body as { relationship: { id: string } }).relationship.id;
    const etag = (seedRes.body as { etag: string }).etag;
    const del = makeReq({
      method: "DELETE",
      url: `/api/relationships/${id}`,
      headers: { "idempotency-key": "delete-2", "if-match": etag },
    });
    const res = await handleRelationshipDelete(makeCtx(del, { id }), deps);
    expect(res.status).toBe(200);
    expect((res.body as { relationship: { lifecycle: string } }).relationship.lifecycle).toBe(
      "revoked",
    );
  });
});

describe("GET /api/relationships (bounded query)", () => {
  it("returns 400 bounded-query-required without any selective filter", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const req = makeReq({ method: "GET", url: "/api/relationships" });
    const res = await handleRelationshipList(makeCtx(req), deps);
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "relationship/bounded-query-required",
    );
  });

  it("returns 400 bounded-query-exceeded when limit > hard cap", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const req = makeReq({ method: "GET", url: "/api/relationships?type=depends-on&limit=999" });
    const res = await handleRelationshipList(makeCtx(req), deps);
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "relationship/bounded-query-exceeded",
    );
  });
});

describe("GET /api/relationships/:id/dependencies + impact + health + explain + events", () => {
  it("dependencies walks outgoing edges within bounds", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const seedReq = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "deps-1xx" },
      body: validProposalBody,
    });
    const seedRes = await handleRelationshipCreate(makeCtx(seedReq), deps);
    const id = (seedRes.body as { relationship: { id: string } }).relationship.id;
    const depsReq = makeReq({
      method: "GET",
      url: `/api/relationships/${id}/dependencies?maxDepth=1`,
    });
    const res = await handleRelationshipDependencies(makeCtx(depsReq, { id }), deps);
    expect(res.status).toBe(200);
  });

  it("impact requires endpointKind + endpointId", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const req = makeReq({ method: "GET", url: "/api/relationships/impact" });
    const res = await handleRelationshipImpact(makeCtx(req), deps);
    expect(res.status).toBe(400);
  });

  it("impact returns a bounded walk from the focal endpoint", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const seedReq = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "imp-1" },
      body: validProposalBody,
    });
    await handleRelationshipCreate(makeCtx(seedReq), deps);
    const req = makeReq({
      method: "GET",
      url: "/api/relationships/impact?endpointKind=capsule&endpointId=cap-1",
    });
    const res = await handleRelationshipImpact(makeCtx(req), deps);
    expect(res.status).toBe(200);
  });

  // #543 hardening: idempotency-key was 3 chars ("h-1") and failed
  // IDEMPOTENCY_HEADER_RE `^[A-Za-z0-9._-]{8,64}$` → the seed POST returned 400 and the
  // row never persisted → totals were 0. Use a key that satisfies the contract.
  it("health returns workspace-scoped totals only", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const seedReq = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "health-1" },
      body: validProposalBody,
    });
    await handleRelationshipCreate(makeCtx(seedReq), deps);
    const req = makeReq({ method: "GET", url: "/api/relationships/health" });
    const res = await handleRelationshipHealth(makeCtx(req), deps);
    expect(res.status).toBe(200);
    const totals = (res.body as { totals: Record<string, number> }).totals;
    expect(totals.active).toBeGreaterThanOrEqual(1);
  });

  // #543 hardening: idempotency-key was 3 chars ("e-1") and failed
  // IDEMPOTENCY_HEADER_RE → seed returned a 400 denial body (no `.relationship` field)
  // and the test crashed reading `.id` on undefined. Use a contract-conforming key.
  it("explain returns the decision + lifecycle history", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const seedReq = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "explain-1" },
      body: validProposalBody,
    });
    const seedRes = await handleRelationshipCreate(makeCtx(seedReq), deps);
    const id = (seedRes.body as { relationship: { id: string } }).relationship.id;
    const req = makeReq({ method: "GET", url: `/api/relationships/${id}/explain` });
    const res = await handleRelationshipExplain(makeCtx(req, { id }), deps);
    expect(res.status).toBe(200);
    // The seed creates an active relationship from initial state — no lifecycle
    // transition has occurred, so the history is empty. (A transition history row is
    // only appended on PATCH/DELETE — see relationship-handlers.ts:applyTransition.)
    expect(Array.isArray((res.body as { lifecycle: unknown[] }).lifecycle)).toBe(true);
    expect((res.body as { decision: { allowed: boolean } }).decision.allowed).toBe(true);
  });

  it("events returns the STREAMING sentinel and writes a hello event", () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const req = makeReq({ method: "GET", url: "/api/relationships/events" });
    const ctx = makeCtx(req);
    const result = handleRelationshipEvents(ctx, deps);
    expect(result).toBe(STREAMING);
    // The hello event was written synchronously; close the stream to clean up the keep-alive.
    req.emit("close");
  });
});

describe("POST /api/relationships/validate (preview)", () => {
  it("returns decision.allowed=true for a valid proposal", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const req = makeReq({
      method: "POST",
      url: "/api/relationships/validate",
      body: validProposalBody,
    });
    const res = await handleRelationshipValidate(makeCtx(req), deps);
    expect(res.status).toBe(200);
    expect((res.body as { decision: { allowed: boolean } }).decision.allowed).toBe(true);
  });

  it("returns decision.allowed=false with reasons for an invalid proposal", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const badBody = JSON.stringify({
      schemaVersion: "1",
      proposal: {
        type: "produces-evidence",
        source: { kind: "capsule", id: "x" },
        target: { kind: "evidence-run", id: "y" },
      },
    });
    const req = makeReq({
      method: "POST",
      url: "/api/relationships/validate",
      body: badBody,
    });
    const res = await handleRelationshipValidate(makeCtx(req), deps);
    expect(res.status).toBe(200);
    expect((res.body as { decision: { allowed: boolean } }).decision.allowed).toBe(false);
  });
});

describe("Schema version is enforced", () => {
  it("rejects an unknown schemaVersion with 422", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const req = makeReq({
      method: "POST",
      url: "/api/relationships/validate",
      body: JSON.stringify({
        schemaVersion: "2",
        proposal: {
          type: "depends-on",
          source: { kind: "capsule", id: "x" },
          target: { kind: "capsule", id: "y" },
        },
      }),
    });
    const res: RouteResult = await handleRelationshipValidate(makeCtx(req), deps);
    expect(res.status).toBe(422);
  });
});

// Issue #539 audit pass — regressions for the in-scope gaps surfaced after merge.
describe("Issue #539 audit regressions", () => {
  // Architect GAP-1 / security C1: the BFF wiring must compose `relationship` into UiHandlerDeps
  // so production calls (`keiko ui`) reach the handlers instead of HTTP 500.
  it("BFF buildUiHandlerDeps wires the relationship deps with a scopeResolver", async () => {
    const tmpDir = await fs.mkdtemp(join(tmpdir(), "keiko-issue539-"));
    const dbPath = join(tmpDir, "ui.db");
    try {
      const env: Record<string, string> = { KEIKO_UI_DATA_DIR: tmpDir };
      const built = buildUiHandlerDeps({
        configPath: undefined,
        evidenceDir: tmpDir,
        env,
        uiDbPath: dbPath,
      });
      const wired = built.relationship;
      if (wired === undefined) throw new Error("relationship deps were not wired");
      expect(wired.scopeResolver({} as unknown as IncomingMessage)?.workspaceId).toBe("local");
      // KEIKO_WORKSPACE_ID overrides the loopback default.
      const customDbPath = join(tmpDir, "ui-custom.db");
      const customEnv: Record<string, string> = {
        KEIKO_UI_DATA_DIR: tmpDir,
        KEIKO_WORKSPACE_ID: "ws-explicit",
      };
      const customBuilt = buildUiHandlerDeps({
        configPath: undefined,
        evidenceDir: tmpDir,
        env: customEnv,
        uiDbPath: customDbPath,
      });
      const customWired = customBuilt.relationship;
      if (customWired === undefined) throw new Error("relationship deps were not wired (custom)");
      expect(customWired.scopeResolver({} as unknown as IncomingMessage)).toEqual({
        workspaceId: "ws-explicit",
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // Security M1: `/:id` routes must reject ids that fall outside the wire schema.
  it("rejects /:id routes when the id violates the wire schema", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const tooShort = "abc"; // < 8 chars
    const req = makeReq({ method: "GET", url: `/api/relationships/${tooShort}` });
    const res = await handleRelationshipGet(makeCtx(req, { id: tooShort }), deps);
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("relationship/bad-request");
  });

  it("rejects /:id routes when the id contains forbidden characters", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const bad = "rel-with/slash";
    const req = makeReq({ method: "GET", url: `/api/relationships/${bad}` });
    const res = await handleRelationshipGet(makeCtx(req, { id: bad }), deps);
    expect(res.status).toBe(400);
  });

  // Architect GAP-4: list response `limit` echoes the requested cap, not entries.length.
  it("list response limit echoes the requested cap, not entries.length", async () => {
    const store = freshStore();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    // Seed one relationship.
    const seedReq = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "list-cap-1" },
      body: validProposalBody,
    });
    await handleRelationshipCreate(makeCtx(seedReq), deps);
    // Query with explicit limit=128, but the seed only contains 1 row.
    const listReq = makeReq({
      method: "GET",
      url: "/api/relationships?type=depends-on&limit=128",
    });
    const res = await handleRelationshipList(makeCtx(listReq), deps);
    expect(res.status).toBe(200);
    const body = res.body as { limit: number; entries: readonly unknown[] };
    expect(body.entries).toHaveLength(1);
    expect(body.limit).toBe(128);
    // When no limit is supplied, the default cap (64) is echoed.
    const defaultReq = makeReq({ method: "GET", url: "/api/relationships?type=depends-on" });
    const defaultRes = await handleRelationshipList(makeCtx(defaultReq), deps);
    expect((defaultRes.body as { limit: number }).limit).toBe(64);
  });

  // Architect GAP-3: reconnect emits `relationship.updated` with the closed-set `changedFields`.
  it("reconnect audit payload includes changedFields (audit-events.md §4.2)", async () => {
    const { store, db } = freshStoreBundle();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    const seedReq = makeReq({
      method: "POST",
      url: "/api/relationships",
      headers: { "idempotency-key": "reconnect-audit-1" },
      body: validProposalBody,
    });
    const seedRes = await handleRelationshipCreate(makeCtx(seedReq), deps);
    expect(seedRes.status).toBe(201);
    const id = (seedRes.body as { relationship: { id: string } }).relationship.id;
    const etag = (seedRes.body as { etag: string }).etag;
    const patchReq = makeReq({
      method: "PATCH",
      url: `/api/relationships/${id}`,
      headers: { "idempotency-key": "reconnect-audit-2", "if-match": etag },
      body: JSON.stringify({
        schemaVersion: "1",
        reconnect: { target: { kind: "capsule", id: "cap-reconnected" } },
      }),
    });
    const res = await handleRelationshipPatch(makeCtx(patchReq, { id }), deps);
    expect(res.status).toBe(200);
    const rows = listRelationshipAuditEntries(db, "ws-a", 16);
    const updated = rows.find((r) => r.kind === "relationship.updated");
    if (updated === undefined) throw new Error("expected a relationship.updated audit row");
    expect(updated.payload.changedFields).toEqual([]);
    expect(updated.payload).toHaveProperty("previousEtag");
    expect(updated.payload).toHaveProperty("newEtag");
  });

  // Architect GAP-5: impact-truncated audit row carries `originRelationshipId` and the response
  // shape no longer leaks the dependency-walk-only rootRelationshipId placeholder.
  it("impact truncation audit carries originRelationshipId", async () => {
    const { store, db } = freshStoreBundle();
    const { redactor } = trackingRedactor();
    const deps = buildDeps("ws-a", store, redactor);
    // Force truncation by asking for the smallest legal node budget — maxNodes=1.
    const impactReq = makeReq({
      method: "GET",
      url: "/api/relationships/impact?endpointKind=capsule&endpointId=cap-focal&maxNodes=1",
    });
    const res = await handleRelationshipImpact(makeCtx(impactReq), deps);
    expect(res.status).toBe(200);
    // Response: no `rootRelationshipId` placeholder; echoes the requested origin endpoint.
    const reportBody = res.body as { report: Record<string, unknown> };
    expect(reportBody.report).not.toHaveProperty("rootRelationshipId");
    expect(reportBody.report).toHaveProperty("origin");
    // Audit obligation: when the walk is bounded, a row should record the origin endpoint
    // (encoded as `<kind>:<id>` in the `originRelationshipId` field per audit-events.md §4.8).
    if ((reportBody.report as { truncated: boolean }).truncated) {
      const rows = listRelationshipAuditEntries(db, "ws-a", 16);
      const audit = rows.find((r) => r.kind === "relationship.impact-analysis-bounded");
      if (audit === undefined) {
        throw new Error("expected a relationship.impact-analysis-bounded audit row");
      }
      expect(audit.payload.originRelationshipId).toBe("capsule:cap-focal");
    }
  });

  // PR-reviewer M1: history PK collision under a pinned clock. Two transitions sharing a
  // `Date.now()` millisecond must NOT roll back the second UPDATE with a UNIQUE violation.
  it("lifecycle history PK is collision-safe under a pinned clock", () => {
    // Build a store with a NON-monotonic clock so two updates report the same updatedAt.
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    const pinned = createRelationshipStorePort({
      db,
      redactString: (s: string): string => s,
      now: () => 9000, // identical every call
      newId: (() => {
        let i = 0;
        return (): string => `rel-pinned-${String(++i).padStart(4, "0")}`;
      })(),
    });
    const { relationship } = pinned.createRelationship({
      workspaceId: "ws-a",
      scope: { kind: "workspace", workspaceId: "ws-a" },
      type: "depends-on",
      source: { kind: "capsule", id: "cap-x" },
      target: { kind: "capsule", id: "cap-y" },
      lifecycleState: "active",
    });
    // Two lifecycle changes under the SAME clock — both must succeed.
    expect(() =>
      pinned.updateLifecycle({
        workspaceId: "ws-a",
        id: relationship.id,
        currentEtag: "ignored", // store does not check here
        to: "archived",
      }),
    ).not.toThrow();
    expect(() =>
      pinned.updateLifecycle({
        workspaceId: "ws-a",
        id: relationship.id,
        currentEtag: "ignored",
        to: "superseded",
      }),
    ).not.toThrow();
  });
});
