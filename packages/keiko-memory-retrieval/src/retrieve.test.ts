import { describe, expect, it } from "vitest";

import { retrieveMemoryContext } from "./retrieve.js";
import { RetrievalError } from "./errors.js";
import type { MemoryQueryPort, MemoryRetrievalRequest } from "./types.js";
import { buildRecord, memoryId, projectScope, userScope } from "./_support.js";
import type { MemoryRecord, MemoryScope } from "@oscharko-dev/keiko-contracts/memory";

const now = 7 * 86_400_000;

function portReturning(byScopeKey: Record<string, readonly MemoryRecord[]>): {
  readonly port: MemoryQueryPort;
  readonly calledScopes: readonly MemoryScope[];
} {
  const calls: MemoryScope[] = [];
  const port: MemoryQueryPort = {
    listByScope: (scope) => {
      calls.push(scope);
      const key = scopeKey(scope);
      return byScopeKey[key] ?? [];
    },
  };
  return { port, calledScopes: calls };
}

function scopeKey(scope: MemoryScope): string {
  switch (scope.kind) {
    case "user":
      return `user:${scope.userId}`;
    case "workspace":
      return `workspace:${scope.workspaceId}`;
    case "project":
      return `project:${scope.projectId}`;
    case "workflow":
      return `workflow:${scope.workflowDefinitionId}`;
    case "global":
      return "global";
  }
}

function baseRequest(overrides: Partial<MemoryRetrievalRequest> = {}): MemoryRetrievalRequest {
  return { scopes: [userScope()], nowMs: now, ...overrides };
}

describe("retrieveMemoryContext — input validation", () => {
  it("throws RetrievalError('empty-scopes') when scopes is empty", () => {
    const { port } = portReturning({});
    expect(() => retrieveMemoryContext({ scopes: [], nowMs: now }, port)).toThrow(RetrievalError);
  });

  it("throws RetrievalError('invalid-budget') when budgetTokens is negative", () => {
    const { port } = portReturning({});
    try {
      retrieveMemoryContext(baseRequest({ budgetTokens: -1 }), port);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RetrievalError);
      expect((e as RetrievalError).code).toBe("invalid-budget");
    }
  });

  it("throws RetrievalError('invalid-weight') when a weight is negative", () => {
    const { port } = portReturning({});
    try {
      retrieveMemoryContext(baseRequest({ recencyWeight: -0.1 }), port);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RetrievalError);
      expect((e as RetrievalError).code).toBe("invalid-weight");
    }
  });

  it("throws RetrievalError('invalid-weight') when a weight is not finite", () => {
    const { port } = portReturning({});
    try {
      retrieveMemoryContext(baseRequest({ recencyWeight: Number.POSITIVE_INFINITY }), port);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RetrievalError);
      expect((e as RetrievalError).code).toBe("invalid-weight");
    }
  });

  it("throws RetrievalError('invalid-budget') when budgetTokens is not an integer", () => {
    const { port } = portReturning({});
    try {
      retrieveMemoryContext(baseRequest({ budgetTokens: 1.5 }), port);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RetrievalError);
      expect((e as RetrievalError).code).toBe("invalid-budget");
    }
  });

  it("throws RetrievalError('invalid-budget') when maxIncluded is not finite", () => {
    const { port } = portReturning({});
    try {
      retrieveMemoryContext(baseRequest({ maxIncluded: Number.NaN }), port);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RetrievalError);
      expect((e as RetrievalError).code).toBe("invalid-budget");
    }
  });

  it("throws RetrievalError('invalid-threshold') when staleConfidenceThreshold is NaN", () => {
    const { port } = portReturning({});
    try {
      retrieveMemoryContext(baseRequest({ staleConfidenceThreshold: Number.NaN }), port);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RetrievalError);
      expect((e as RetrievalError).code).toBe("invalid-threshold");
    }
  });

  it("throws RetrievalError('invalid-threshold') when staleConfidenceThreshold is out of range", () => {
    const { port } = portReturning({});
    try {
      retrieveMemoryContext(baseRequest({ staleConfidenceThreshold: 1.1 }), port);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RetrievalError);
      expect((e as RetrievalError).code).toBe("invalid-threshold");
    }
  });

  it("wraps port failures as RetrievalError('port-failure') with cause preserved", () => {
    const root = new Error("port boom");
    const port: MemoryQueryPort = {
      listByScope: () => {
        throw root;
      },
    };
    try {
      retrieveMemoryContext(baseRequest(), port);
      throw new Error("expected throw");
    } catch (e) {
      const err = e as RetrievalError;
      expect(err.code).toBe("port-failure");
      expect(err.cause).toBe(root);
    }
  });
});

describe("retrieveMemoryContext — AC1 exact preference retrieval", () => {
  it("returns a user-scope preference matched by query text at rank 1", () => {
    const pref = buildRecord({
      id: "pref",
      type: "preference",
      body: "always use vitest for new tests",
      updatedAt: now,
    });
    const { port } = portReturning({ "user:u1": [pref] });
    const result = retrieveMemoryContext(
      baseRequest({ queryText: "vitest tests", budgetTokens: 200 }),
      port,
    );
    expect(result.included[0]?.memoryId).toBe(memoryId("pref"));
    expect(result.contextBlock.text).toMatch(/vitest/);
  });
});

describe("retrieveMemoryContext — AC2 project-scoped decisions", () => {
  it("returns only project-scoped records when scope is project", () => {
    const decision = buildRecord({
      id: "d1",
      scope: projectScope(),
      type: "decision",
      body: "chose pnpm over npm",
      updatedAt: now,
    });
    const { port } = portReturning({ "project:p1": [decision] });
    const result = retrieveMemoryContext(
      { scopes: [projectScope()], nowMs: now, queryText: "pnpm" },
      port,
    );
    expect(result.included.length).toBe(1);
    expect(result.included[0]?.memoryId).toBe(memoryId("d1"));
  });
});

describe("retrieveMemoryContext — AC3 correction outranks older fact", () => {
  it("places a newer correction above an older semantic-fact on the same topic", () => {
    const oldFact = buildRecord({
      id: "fact",
      type: "semantic-fact",
      body: "user prefers dark mode",
      updatedAt: now - 30 * 86_400_000,
      capturedAt: now - 30 * 86_400_000,
      createdAt: now - 30 * 86_400_000,
    });
    const correction = buildRecord({
      id: "correction",
      type: "correction",
      body: "user prefers dark mode",
      updatedAt: now,
      capturedAt: now,
      createdAt: now,
    });
    const { port } = portReturning({ "user:u1": [oldFact, correction] });
    const result = retrieveMemoryContext(
      baseRequest({ queryText: "dark mode", budgetTokens: 200 }),
      port,
    );
    expect(result.included[0]?.memoryId).toBe(memoryId("correction"));
    expect(result.included[1]?.memoryId).toBe(memoryId("fact"));
  });
});

describe("retrieveMemoryContext — AC4 stale suppression", () => {
  it("omits archived/forgotten/expired/low-confidence with reason suppressed-by-status", () => {
    const fresh = buildRecord({ id: "ok", updatedAt: now });
    const archived = buildRecord({ id: "arch", status: "archived" });
    const forgotten = buildRecord({ id: "forg", status: "forgotten" });
    const expired = buildRecord({ id: "exp", validFrom: 0, validUntil: now - 1 });
    const lowConf = buildRecord({ id: "low", confidence: 0.2 });
    const { port } = portReturning({
      "user:u1": [fresh, archived, forgotten, expired, lowConf],
    });
    const result = retrieveMemoryContext(baseRequest({ budgetTokens: 500 }), port);
    expect(result.included.map((i) => i.memoryId)).toEqual([memoryId("ok")]);
    const omittedIds = result.omitted.map((o) => o.memoryId);
    expect(omittedIds).toContain(memoryId("arch"));
    expect(omittedIds).toContain(memoryId("forg"));
    expect(omittedIds).toContain(memoryId("exp"));
    expect(omittedIds).toContain(memoryId("low"));
    for (const o of result.omitted) {
      expect(o.reason).toBe("suppressed-by-status");
      expect(o.suppressionDetail).toBeDefined();
    }
  });

  it("requests archived, forgotten, and expired rows from the port for explainable omissions", () => {
    const optionsSeen: unknown[] = [];
    const expired = buildRecord({ id: "exp", validFrom: 0, validUntil: now - 1 });
    const port: MemoryQueryPort = {
      listByScope: (_scope, options) => {
        optionsSeen.push(options);
        return [expired];
      },
    };
    const result = retrieveMemoryContext(baseRequest({ budgetTokens: 500 }), port);
    expect(optionsSeen).toEqual([
      {
        includeForgotten: true,
        includeArchived: true,
        includeExpired: true,
        maxResults: 500,
      },
    ]);
    expect(result.included).toEqual([]);
    expect(result.omitted).toContainEqual({
      memoryId: memoryId("exp"),
      reason: "suppressed-by-status",
      suppressionDetail: "expired",
    });
  });
});

describe("retrieveMemoryContext — AC5 budget pressure", () => {
  it("under low budget, surfaces budget-exceeded omissions", () => {
    const records = Array.from({ length: 30 }, (_, i) =>
      buildRecord({
        id: `m${String(i)}`,
        body: "alpha beta gamma delta epsilon zeta eta theta iota kappa",
        updatedAt: now - i,
      }),
    );
    const { port } = portReturning({ "user:u1": records });
    const result = retrieveMemoryContext(baseRequest({ budgetTokens: 20, maxIncluded: 12 }), port);
    expect(result.budget.used).toBeLessThanOrEqual(20);
    const overflowOmissions = result.omitted.filter((o) => o.reason === "budget-exceeded");
    expect(overflowOmissions.length).toBeGreaterThan(0);
  });
});

describe("retrieveMemoryContext — AC6 cross-scope isolation", () => {
  it("never queries a scope not present in request.scopes", () => {
    const userRecord = buildRecord({ id: "u", scope: userScope() });
    const projectRecord = buildRecord({ id: "p", scope: projectScope() });
    const { port, calledScopes } = portReturning({
      "user:u1": [userRecord],
      "project:p1": [projectRecord],
    });
    const result = retrieveMemoryContext({ scopes: [userScope()], nowMs: now }, port);
    expect(calledScopes.length).toBe(1);
    expect(calledScopes[0]?.kind).toBe("user");
    expect(result.included.map((i) => i.memoryId)).toEqual([memoryId("u")]);
    expect(result.included.map((i) => i.memoryId)).not.toContain(memoryId("p"));
  });
});

describe("retrieveMemoryContext — AC7 no-memory result", () => {
  it("returns a clean empty result when the port has nothing", () => {
    const { port } = portReturning({});
    const result = retrieveMemoryContext(baseRequest(), port);
    expect(result.included).toEqual([]);
    expect(result.omitted).toEqual([]);
    expect(result.contextBlock.text).toBe("");
    expect(result.contextBlock.memories).toEqual([]);
    expect(result.budget.used).toBe(0);
    expect(result.request.scopes.length).toBe(1);
  });
});

describe("retrieveMemoryContext — type filter + explainability + determinism", () => {
  it("omits records whose type is not in request.types with reason type-filtered", () => {
    const fact = buildRecord({ id: "f", type: "semantic-fact" });
    const decision = buildRecord({ id: "d", type: "decision" });
    const { port } = portReturning({ "user:u1": [fact, decision] });
    const result = retrieveMemoryContext(baseRequest({ types: ["decision"] }), port);
    expect(result.included.map((i) => i.memoryId)).toEqual([memoryId("d")]);
    expect(result.omitted.map((o) => o.memoryId)).toEqual([memoryId("f")]);
    expect(result.omitted[0]?.reason).toBe("type-filtered");
  });

  it("every included carries inclusionReason and every omitted carries a reason", () => {
    const ok = buildRecord({ id: "ok", updatedAt: now });
    const bad = buildRecord({ id: "bad", status: "archived" });
    const { port } = portReturning({ "user:u1": [ok, bad] });
    const result = retrieveMemoryContext(baseRequest(), port);
    for (const i of result.included) expect(i.inclusionReason.length).toBeGreaterThan(0);
    for (const o of result.omitted) expect(o.reason.length).toBeGreaterThan(0);
  });

  it("is deterministic: same request + port responses -> byte-equal output", () => {
    const a = buildRecord({ id: "a", body: "alpha", updatedAt: now });
    const b = buildRecord({ id: "b", body: "beta", updatedAt: now });
    const { port: p1 } = portReturning({ "user:u1": [a, b] });
    const { port: p2 } = portReturning({ "user:u1": [a, b] });
    const r1 = retrieveMemoryContext(baseRequest({ queryText: "alpha" }), p1);
    const r2 = retrieveMemoryContext(baseRequest({ queryText: "alpha" }), p2);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it("dedupes by memoryId across multiple scopes that return the same record", () => {
    const m = buildRecord({ id: "shared", scope: userScope() });
    const { port } = portReturning({
      "user:u1": [m],
      "project:p1": [m],
    });
    const result = retrieveMemoryContext(
      { scopes: [userScope(), projectScope()], nowMs: now },
      port,
    );
    expect(result.included.filter((i) => i.memoryId === memoryId("shared")).length).toBe(1);
  });
});
