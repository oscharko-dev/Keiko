import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";
import { API_ROUTES, isApiPath, matchRoute, STREAMING, type RouteContext } from "./routes.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";

const emptyCtx: RouteContext = {
  req: {} as RouteContext["req"],
  res: {} as RouteContext["res"],
  params: {},
  url: new URL("http://127.0.0.1/api/health"),
};

const stubDeps: UiHandlerDeps = {
  config: undefined,
  configPresent: false,
  evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
  env: {},
  redactor: buildRedactor({}),
  registry: createRunRegistry(),
  modelPortFactory: () => undefined,
  store: createInMemoryUiStore(),
};

describe("API route contract", () => {
  it("declares the additive route contract including the grounded workflow handoff route, local-knowledge capsule management, Quality Intelligence connector routes, the QI UI read routes, the QI run execution + review + export routes, the QI Conversation Center handoff route, the relationship engine routes (Epic #532), the memory maintenance route (#204), and the desktop chat SSE streaming route (#152)", () => {
    expect(API_ROUTES.length).toBeGreaterThanOrEqual(98);
    expect(
      API_ROUTES.find(
        (route) =>
          route.method === "POST" &&
          route.pattern === "/api/chats/messages/grounded/handoff",
      ),
    ).toBeDefined();
  });

  it("includes the Quality Intelligence UI read routes (#280)", () => {
    const list = API_ROUTES.find(
      (r) => r.method === "GET" && r.pattern === "/api/quality-intelligence/runs",
    );
    const detail = API_ROUTES.find(
      (r) => r.method === "GET" && r.pattern === "/api/quality-intelligence/runs/:id",
    );
    expect(list).toBeDefined();
    expect(detail).toBeDefined();
  });

  it("includes the Quality Intelligence run execution, review, and export routes (#273/#280/#282/#283)", () => {
    const patterns = [
      { method: "POST", pattern: "/api/quality-intelligence/runs" },
      { method: "POST", pattern: "/api/quality-intelligence/runs/:id/cancel" },
      { method: "POST", pattern: "/api/quality-intelligence/runs/:id/review" },
      { method: "POST", pattern: "/api/quality-intelligence/runs/:id/export" },
    ];
    for (const { method, pattern } of patterns) {
      expect(
        API_ROUTES.find((r) => r.method === method && r.pattern === pattern),
        `${method} ${pattern} must be registered`,
      ).toBeDefined();
    }
  });

  it("includes the Quality Intelligence Conversation Center handoff route (#281)", () => {
    const handoff = API_ROUTES.find(
      (r) => r.method === "POST" && r.pattern === "/api/quality-intelligence/handoff",
    );
    expect(handoff).toBeDefined();
  });

  it("includes the local-knowledge capsule detail routes", () => {
    const localKnowledgeRoutes = API_ROUTES.filter((r) =>
      r.pattern.startsWith("/api/local-knowledge"),
    );
    expect(localKnowledgeRoutes).toHaveLength(12);
    expect(
      localKnowledgeRoutes.find(
        (r) => r.method === "GET" && r.pattern === "/api/local-knowledge/capsules",
      ),
    ).toBeDefined();
    expect(
      localKnowledgeRoutes.find(
        (r) => r.method === "POST" && r.pattern === "/api/local-knowledge/capsules",
      ),
    ).toBeDefined();
    expect(
      localKnowledgeRoutes.find(
        (r) => r.method === "GET" && r.pattern === "/api/local-knowledge/capsule-sets",
      ),
    ).toBeDefined();
    expect(
      localKnowledgeRoutes.find(
        (r) => r.method === "POST" && r.pattern === "/api/local-knowledge/capsule-sets",
      ),
    ).toBeDefined();
    expect(
      localKnowledgeRoutes.find(
        (r) => r.method === "GET" && r.pattern === "/api/local-knowledge/capsules/:capsuleId",
      ),
    ).toBeDefined();
    expect(
      localKnowledgeRoutes.find(
        (r) => r.method === "PATCH" && r.pattern === "/api/local-knowledge/capsules/:capsuleId",
      ),
    ).toBeDefined();
    expect(
      localKnowledgeRoutes.find(
        (r) =>
          r.method === "POST" && r.pattern === "/api/local-knowledge/capsules/:capsuleId/index",
      ),
    ).toBeDefined();
    expect(
      localKnowledgeRoutes.find(
        (r) =>
          r.method === "DELETE" && r.pattern === "/api/local-knowledge/capsules/:capsuleId/index",
      ),
    ).toBeDefined();
    expect(
      localKnowledgeRoutes.find(
        (r) =>
          r.method === "DELETE" &&
          r.pattern === "/api/local-knowledge/capsules/:capsuleId/connection",
      ),
    ).toBeDefined();
    expect(
      localKnowledgeRoutes.find(
        (r) =>
          r.method === "POST" &&
          r.pattern === "/api/local-knowledge/capsules/:capsuleId/connection",
      ),
    ).toBeDefined();
    expect(
      localKnowledgeRoutes.find(
        (r) =>
          r.method === "POST" && r.pattern === "/api/local-knowledge/capsules/:capsuleId/reindex",
      ),
    ).toBeDefined();
    expect(
      localKnowledgeRoutes.find(
        (r) => r.method === "DELETE" && r.pattern === "/api/local-knowledge/capsules/:capsuleId",
      ),
    ).toBeDefined();
  });

  it("includes the 18 memory routes (12 from #211, 2 from #212, 3 consolidation-job routes from #208, 1 maintenance route from #204)", () => {
    const memoryRoutes = API_ROUTES.filter((r) => r.pattern.startsWith("/api/memory"));
    expect(memoryRoutes).toHaveLength(18);
    expect(
      API_ROUTES.find((r) => r.method === "POST" && r.pattern === "/api/memory/maintenance"),
    ).toBeDefined();
    expect(
      API_ROUTES.find((r) => r.method === "POST" && r.pattern === "/api/memory/context"),
    ).toBeDefined();
    expect(
      API_ROUTES.find(
        (r) => r.method === "POST" && r.pattern === "/api/memory/capture-from-conversation",
      ),
    ).toBeDefined();
    expect(
      API_ROUTES.find((r) => r.method === "POST" && r.pattern === "/api/memory/consolidation/jobs"),
    ).toBeDefined();
    expect(
      API_ROUTES.find(
        (r) => r.method === "GET" && r.pattern === "/api/memory/consolidation/jobs/:jobId",
      ),
    ).toBeDefined();
    expect(
      API_ROUTES.find(
        (r) => r.method === "POST" && r.pattern === "/api/memory/consolidation/jobs/:jobId/cancel",
      ),
    ).toBeDefined();
  });

  it("includes the first-run gateway setup route", () => {
    expect(
      API_ROUTES.find((r) => r.method === "POST" && r.pattern === "/api/gateway/setup"),
    ).toBeDefined();
  });

  it("includes the 8 browser-tool routes (#76)", () => {
    const browserRoutes = API_ROUTES.filter((r) => r.pattern.startsWith("/api/browser"));
    expect(browserRoutes).toHaveLength(8);
    expect(
      browserRoutes.find((r) => r.method === "GET" && r.pattern === "/api/browser/status"),
    ).toBeDefined();
    expect(
      browserRoutes.find(
        (r) => r.method === "GET" && r.pattern === "/api/browser/sessions/:sessionId/events",
      ),
    ).toBeDefined();
  });

  it("includes the files editor routes", () => {
    expect(
      API_ROUTES.find((r) => r.method === "GET" && r.pattern === "/api/files/content"),
    ).toBeDefined();
    expect(
      API_ROUTES.find((r) => r.method === "PATCH" && r.pattern === "/api/files/content"),
    ).toBeDefined();
  });

  it("includes the run-summary message routes (#66)", () => {
    const patchRoute = API_ROUTES.find(
      (r) => r.method === "PATCH" && r.pattern === "/api/chats/messages",
    );
    const pairRoute = API_ROUTES.find(
      (r) => r.method === "POST" && r.pattern === "/api/chats/messages/run-summary-pair",
    );
    expect(patchRoute).toBeDefined();
    expect(pairRoute).toBeDefined();
  });

  it("includes the composer chat-run route (#66)", () => {
    const route = API_ROUTES.find((r) => r.method === "POST" && r.pattern === "/api/chats/runs");
    expect(route).toBeDefined();
  });

  it("includes the desktop GPT chat routes", () => {
    expect(
      API_ROUTES.find((r) => r.method === "POST" && r.pattern === "/api/desktop/chats"),
    ).toBeDefined();
    expect(
      API_ROUTES.find((r) => r.method === "POST" && r.pattern === "/api/desktop/chat"),
    ).toBeDefined();
    // Issue #152 — additive SSE streaming surface alongside the buffered send route.
    expect(
      API_ROUTES.find((r) => r.method === "POST" && r.pattern === "/api/desktop/chat/stream"),
    ).toBeDefined();
  });

  it("includes the ADR-0018 terminal tool routes (no PTY surface)", () => {
    expect(
      API_ROUTES.find((r) => r.method === "GET" && r.pattern === "/api/terminal/policy"),
    ).toBeDefined();
    expect(
      API_ROUTES.find((r) => r.method === "GET" && r.pattern === "/api/terminal/directories"),
    ).toBeDefined();
    expect(
      API_ROUTES.find((r) => r.method === "POST" && r.pattern === "/api/terminal/executions"),
    ).toBeDefined();
    expect(
      API_ROUTES.find(
        (r) => r.method === "DELETE" && r.pattern === "/api/terminal/executions/:executionId",
      ),
    ).toBeDefined();
    expect(
      API_ROUTES.find((r) => r.method === "GET" && r.pattern === "/api/terminal/events"),
    ).toBeDefined();
    // PTY routes must be gone.
    expect(API_ROUTES.find((r) => r.pattern === "/api/terminal/shells")).toBeUndefined();
    expect(API_ROUTES.find((r) => r.pattern === "/api/terminal/sessions")).toBeUndefined();
  });

  it("includes the desktop files read-only routes", () => {
    expect(
      API_ROUTES.find((r) => r.method === "GET" && r.pattern === "/api/files/directories"),
    ).toBeDefined();
    expect(
      API_ROUTES.find((r) => r.method === "GET" && r.pattern === "/api/files/tree"),
    ).toBeDefined();
    expect(
      API_ROUTES.find((r) => r.method === "GET" && r.pattern === "/api/files/preview"),
    ).toBeDefined();
  });

  it("exposes every contract path exactly once per method", () => {
    const keys = API_ROUTES.map((r) => `${r.method} ${r.pattern}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("includes the workspace summary route", () => {
    expect(API_ROUTES.some((route) => route.pattern === "/api/workspace")).toBe(true);
  });
});

describe("matchRoute", () => {
  it("matches the health route", () => {
    const match = matchRoute("GET", "/api/health");
    expect(match).not.toBe("method-not-allowed");
    expect(match).toBeDefined();
  });

  it("captures a :runId param", () => {
    const match = matchRoute("GET", "/api/runs/run-123");
    expect(match).not.toBe("method-not-allowed");
    if (match !== undefined && match !== "method-not-allowed") {
      expect(match.params.runId).toBe("run-123");
    }
  });

  it("captures :runId for a nested events path", () => {
    const match = matchRoute("GET", "/api/runs/run-9/events");
    if (match !== undefined && match !== "method-not-allowed") {
      expect(match.params.runId).toBe("run-9");
    } else {
      expect.unreachable("events route should match");
    }
  });

  it("reports method-not-allowed for a known path with the wrong method", () => {
    expect(matchRoute("DELETE", "/api/health")).toBe("method-not-allowed");
  });

  it("treats DELETE /api/relationships/health as method-not-allowed instead of binding health to :id", () => {
    expect(matchRoute("DELETE", "/api/relationships/health")).toBe("method-not-allowed");
  });

  it("returns undefined for an unknown path", () => {
    expect(matchRoute("GET", "/api/nope")).toBeUndefined();
  });

  it("does not match an empty :runId segment", () => {
    expect(matchRoute("GET", "/api/runs/")).toBeUndefined();
  });
});

describe("health handler", () => {
  it("returns ok with the SDK version", async () => {
    const route = API_ROUTES.find((r) => r.pattern === "/api/health");
    expect(route).toBeDefined();
    const result = await route?.handler(emptyCtx, stubDeps);
    expect(result).toEqual({ status: 200, body: { status: "ok", version: SDK_VERSION } });
  });
});

describe("run routes are wired (Task B)", () => {
  it("returns 404 for an unknown run on the events route", async () => {
    const route = API_ROUTES.find((r) => r.pattern === "/api/runs/:runId/events");
    const ctxWithRun: RouteContext = { ...emptyCtx, params: { runId: "unknown-run" } };
    const result = await route?.handler(ctxWithRun, stubDeps);
    if (result === undefined || result === STREAMING) {
      throw new Error("expected a RouteResult");
    }
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});

describe("isApiPath", () => {
  it("recognizes /api/ paths", () => {
    expect(isApiPath("/api/health")).toBe(true);
    expect(isApiPath("/api")).toBe(true);
  });

  it("rejects non-api paths", () => {
    expect(isApiPath("/index.html")).toBe(false);
    expect(isApiPath("/apixyz")).toBe(false);
  });
});

// Drift guard: the BFF health route surfaces the canonical SDK package version, which must stay in
// sync with the root product's `package.json` "version" field. The CLI mirrors the same invariant
// in packages/keiko-cli/src/runner.test.ts.
describe("SDK package version", () => {
  it("matches the root package.json version", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const rootPackageJsonPath = join(here, "..", "..", "..", "package.json");
    const parsed: unknown = JSON.parse(readFileSync(rootPackageJsonPath, "utf8"));
    const version =
      typeof parsed === "object" && parsed !== null && "version" in parsed
        ? parsed.version
        : undefined;
    expect(typeof version).toBe("string");
    expect(SDK_VERSION).toBe(version);
  });
});
