// The review instance's sidecar routes (ADR-0182 D1, Issue #4135, AC3): a request reaches the shared
// gateway and tool-facade handlers with the deps of the ONE review instance whose capability it
// carries, and with no runtime at all otherwise -- never with the Coding Workbench's runtime.

import { describe, expect, it, vi } from "vitest";

import { mockRequest, mockResponse } from "../../_support.js";
import type { CodingRuntimeToolFacadeBridge } from "../../coding-runtime/codingRuntimeControlPlane.js";
import type { UiHandlerDeps } from "../../deps.js";
import { API_ROUTES, matchRoute, type RouteContext } from "../../routes.js";
import type { ReviewRuntimeComposition } from "./composition.js";
import type { ReviewRuntimeService } from "./instance.js";
import { handleReviewSidecarToolFacade, reviewSidecarDeps } from "./routes.js";

function context(path: string, bearer?: string): RouteContext {
  return {
    correlationId: "review-sidecar-route-test",
    req: mockRequest({
      method: "POST",
      url: path,
      body: '{"action":"read"}',
      headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
    }),
    res: mockResponse().res,
    params: {},
    url: new URL(`http://127.0.0.1${path}`),
  };
}

const codingHandle = vi.fn(() => Promise.resolve({ status: 200, body: '{"status":"completed"}' }));
const codingBridge: CodingRuntimeToolFacadeBridge = {
  requestDeadlineMs: 30_000,
  handle: codingHandle,
};

function codingDeps(reviewRuntime?: ReviewRuntimeService): UiHandlerDeps {
  return {
    toolFacadeBridge: { resolve: () => codingBridge },
    runtimeCapabilityAuthenticator: { authenticate: () => ({ ok: true }) },
    codingRuntimeOrchestrator: { coding: true },
    ...(reviewRuntime === undefined ? {} : { reviewRuntime }),
  } as unknown as UiHandlerDeps;
}

function reviewInstance(bridge: CodingRuntimeToolFacadeBridge): {
  readonly runtime: ReviewRuntimeService;
  readonly composition: ReviewRuntimeComposition;
} {
  const composition = {
    sidecarDeps: (base: UiHandlerDeps): UiHandlerDeps => ({
      ...base,
      toolFacadeBridge: { resolve: () => bridge },
    }),
  } as unknown as ReviewRuntimeComposition;
  const runtime = {
    instanceForCapability: (capability: string) =>
      capability === "review-capability" ? composition : undefined,
  } as unknown as ReviewRuntimeService;
  return { runtime, composition };
}

describe("review sidecar routes", () => {
  it("are wired into the route table beside their coding twins", () => {
    for (const path of [
      "/api/review-sidecar/gateway/chat/completions",
      "/api/review-sidecar/tool",
    ]) {
      expect(matchRoute("POST", path)).not.toBeUndefined();
      expect(API_ROUTES.some((route) => route.method === "POST" && route.pattern === path)).toBe(
        true,
      );
    }
  });

  it("serves a review capability with its own instance's runtime", async () => {
    const reviewHandle = vi.fn(() =>
      Promise.resolve({ status: 200, body: '{"status":"completed"}' }),
    );
    const reviewBridge: CodingRuntimeToolFacadeBridge = {
      requestDeadlineMs: 30_000,
      handle: reviewHandle,
    };
    const { runtime } = reviewInstance(reviewBridge);

    await handleReviewSidecarToolFacade(
      context("/api/review-sidecar/tool", "review-capability"),
      codingDeps(runtime),
    );

    expect(reviewHandle).toHaveBeenCalledTimes(1);
    expect(codingHandle).not.toHaveBeenCalled();
  });

  it("strips every coding runtime capability from a request no review instance owns", async () => {
    const { runtime } = reviewInstance(codingBridge);
    for (const bearer of [undefined, "coding-capability"]) {
      const deps = reviewSidecarDeps(
        context("/api/review-sidecar/tool", bearer),
        codingDeps(runtime),
        "tool-facade",
      );
      expect(deps.toolFacadeBridge).toBeUndefined();
      expect(deps.runtimeCapabilityAuthenticator).toBeUndefined();
      expect(deps.codingRuntimeOrchestrator).toBeUndefined();
    }
    const result = await handleReviewSidecarToolFacade(
      context("/api/review-sidecar/tool", "coding-capability"),
      codingDeps(runtime),
    );
    expect(result).toMatchObject({ status: 503 });
    expect(codingHandle).not.toHaveBeenCalled();
  });

  it("refuses review sidecar calls when the server composed no review runtime", () => {
    const deps = reviewSidecarDeps(
      context("/api/review-sidecar/tool", "review-capability"),
      codingDeps(),
      "tool-facade",
    );
    expect(deps.toolFacadeBridge).toBeUndefined();
  });
});
