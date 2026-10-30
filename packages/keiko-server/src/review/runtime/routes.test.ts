// The review instance's sidecar routes (ADR-0182 D1, Issue #4135, AC3): a request reaches the shared
// gateway and tool-facade handlers with the deps of the ONE review instance whose capability it
// carries, and with no runtime at all otherwise -- never with the Coding Workbench's runtime.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBufferedServerLogSink } from "../../../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../../../tests/support/activity-log-test-support.js";
import { mockRequest, mockResponse } from "../../_support.js";
import { handleCodingSidecarGatewayChatCompletions } from "../../coding-sidecar-gateway.js";
import { handleCodingSidecarToolFacade } from "../../coding-sidecar-tool-facade.js";
import { createServerLogger, setServerLogger } from "../../observability/index.js";
import type { CodingRuntimeToolFacadeBridge } from "../../coding-runtime/codingRuntimeControlPlane.js";
import type { UiHandlerDeps } from "../../deps.js";
import { API_ROUTES, matchRoute, type RouteContext } from "../../routes.js";
import type { ReviewRuntimeComposition } from "./composition.js";
import type { ReviewRuntimeService } from "./instance.js";
import {
  handleReviewSidecarGatewayChatCompletions,
  handleReviewSidecarToolFacade,
  reviewSidecarDeps,
} from "./routes.js";
import { sidecarGatewayRouteTemplate } from "./sidecarSurface.js";

const processLog = createBufferedServerLogSink();
beforeEach(() => {
  processLog.events.splice(0);
  setServerLogger(createServerLogger({ sink: processLog, level: "debug" }));
});
afterEach(() => {
  resetServerLogger();
});

function context(
  path: string,
  bearer?: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): RouteContext {
  return {
    correlationId: "review-sidecar-route-test",
    req: mockRequest({
      method: "POST",
      url: path,
      body: '{"action":"read"}',
      headers: {
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
        ...extraHeaders,
      },
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

  // Security review of #4135, finding 6: a rejection on the review twin was indistinguishable from
  // one on the Coding Workbench's own route.
  it("tags the shared handlers' rejection lines with the review purpose on the review routes", async () => {
    const origin = { origin: "https://example.invalid" };
    await handleReviewSidecarToolFacade(
      context("/api/review-sidecar/tool", "review-capability", origin),
      codingDeps(),
    );
    await handleCodingSidecarToolFacade(
      context("/api/coding-sidecar/tool", "coding-capability", origin),
      codingDeps(),
    );
    await handleReviewSidecarGatewayChatCompletions(
      context("/api/review-sidecar/gateway/chat/completions", undefined, origin),
      codingDeps(),
    );
    await handleCodingSidecarGatewayChatCompletions(
      context("/api/coding-sidecar/gateway/chat/completions", undefined, origin),
      codingDeps(),
    );

    const lines = (op: string): readonly (Readonly<Record<string, unknown>> | undefined)[] =>
      processLog.events.filter((event) => event.op === op).map((event) => event.extra);
    const facade = lines("coding-sidecar.tool-facade.rejected");
    expect(facade).toHaveLength(2);
    expect(facade[0]).toMatchObject({ reason: "origin-not-allowed", runtimePurpose: "review" });
    expect(facade[1]).not.toHaveProperty("runtimePurpose");
    const gateway = lines("coding-sidecar.gateway.rejected");
    expect(gateway).toHaveLength(2);
    expect(gateway[0]).toMatchObject({ runtimePurpose: "review" });
    expect(gateway[1]).not.toHaveProperty("runtimePurpose");
  });

  it("names the review route in the gateway's diagnostics on the review route", () => {
    expect(
      sidecarGatewayRouteTemplate(context("/api/review-sidecar/gateway/chat/completions")),
    ).toBe("POST /api/review-sidecar/gateway/chat/completions");
    expect(
      sidecarGatewayRouteTemplate(context("/api/coding-sidecar/gateway/chat/completions")),
    ).toBe("POST /api/coding-sidecar/gateway/chat/completions");
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
