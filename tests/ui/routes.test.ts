import { describe, expect, it } from "vitest";
import { API_ROUTES, isApiPath, matchRoute, type RouteContext } from "../../src/ui/routes.js";
import { SDK_VERSION } from "../../src/sdk/index.js";

const emptyCtx: RouteContext = {
  req: {} as RouteContext["req"],
  params: {},
};

describe("API route contract", () => {
  it("declares the eleven D5 routes", () => {
    expect(API_ROUTES).toHaveLength(11);
  });

  it("exposes every contract path exactly once per method", () => {
    const keys = API_ROUTES.map((r) => `${r.method} ${r.pattern}`);
    expect(new Set(keys).size).toBe(keys.length);
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
    const result = await route?.handler(emptyCtx);
    expect(result).toEqual({ status: 200, body: { status: "ok", version: SDK_VERSION } });
  });
});

describe("not-implemented placeholders", () => {
  it("returns a 501 NOT_IMPLEMENTED envelope for a deferred route", async () => {
    const route = API_ROUTES.find((r) => r.pattern === "/api/config");
    const result = await route?.handler(emptyCtx);
    expect(result?.status).toBe(501);
    expect(result?.body).toMatchObject({ error: { code: "NOT_IMPLEMENTED" } });
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
