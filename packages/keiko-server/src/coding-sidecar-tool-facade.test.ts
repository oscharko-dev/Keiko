// #3390 (ADR-0043 D11-D14): the coding-sidecar tool facade rides the SAME attested loopback BFF
// port as `/api/coding-sidecar/gateway/*` instead of a second ephemeral listener the Seatbelt
// `keiko-gateway` egress profile denies (packages/keiko-sandbox/src/backends.ts
// buildGatewaySeatbeltCommand). This route builds no second authenticator: it forwards the
// request to the active run's tool bridge (`OpenCodeRuntimeComposition.toolBridge.handle`, exposed
// here as `deps.toolFacadeBridge`), which already authenticates the bearer capability
// (`preflightToolRequest` in opencodeRuntimeComposition.ts) and enforces its own admission gate.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UiHandlerDeps } from "./deps.js";
import type { CodingRuntimeToolFacadeBridge } from "./coding-runtime/codingRuntimeControlPlane.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
} from "./observability/index.js";
import { API_ROUTES, matchRoute, type RouteContext } from "./routes.js";
import { mockRequest, mockResponse } from "./_support.js";
import { handleCodingSidecarToolFacade } from "./coding-sidecar-tool-facade.js";

function captureServerLog(): BufferedServerLogSink {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "warn" }));
  return sink;
}

afterEach(() => {
  resetServerLogger();
});

function toolFacadeContext(
  options: {
    readonly body?: string | Buffer;
    readonly origin?: string;
    readonly bearer?: string;
  } = {},
): RouteContext {
  const headers: Record<string, string> = {};
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.bearer !== undefined) headers.authorization = `Bearer ${options.bearer}`;
  return {
    correlationId: "run-tool-facade-test",
    req: mockRequest({
      method: "POST",
      url: "/api/coding-sidecar/tool",
      body: options.body ?? '{"action":"read"}',
      headers,
    }),
    res: mockResponse().res,
    params: {},
    url: new URL("http://127.0.0.1/api/coding-sidecar/tool"),
  };
}

function bridge(handle: CodingRuntimeToolFacadeBridge["handle"]): {
  readonly resolve: () => CodingRuntimeToolFacadeBridge | undefined;
} {
  return { resolve: (): CodingRuntimeToolFacadeBridge => ({ handle }) };
}

function depsWith(toolFacadeBridge: UiHandlerDeps["toolFacadeBridge"] | undefined): UiHandlerDeps {
  return { toolFacadeBridge } as unknown as UiHandlerDeps;
}

describe("coding-sidecar tool facade route", () => {
  it("is wired into the real route table at POST /api/coding-sidecar/tool", () => {
    const match = matchRoute("POST", "/api/coding-sidecar/tool");
    expect(match).not.toBe("method-not-allowed");
    expect(match).not.toBeUndefined();
    expect(
      API_ROUTES.find((r) => r.method === "POST" && r.pattern === "/api/coding-sidecar/tool"),
    ).toBeDefined();
    // ADR-0043 D11-D14: routing (not this bridge) now owns "wrong method" -- the shared
    // `matchRoute` engine reports method-not-allowed for any other verb on this exact pattern,
    // the same generic mechanism every other route in routes.test.ts is pinned against.
    expect(matchRoute("GET", "/api/coding-sidecar/tool")).toBe("method-not-allowed");
  });

  it("dispatches an authorized JSON body through the real route dispatcher to the run's bridge and returns its 200", async () => {
    const handle = vi.fn(
      (
        _request: Parameters<CodingRuntimeToolFacadeBridge["handle"]>[0],
      ): ReturnType<CodingRuntimeToolFacadeBridge["handle"]> =>
        Promise.resolve({ status: 200, body: JSON.stringify({ status: "completed" }) }),
    );
    const deps = depsWith(bridge(handle));
    const ctx = toolFacadeContext({ bearer: "tool-capability-material" });
    const match = matchRoute("POST", "/api/coding-sidecar/tool");
    if (match === undefined || match === "method-not-allowed") {
      throw new Error("tool-facade-route-not-registered");
    }
    const result = await match.definition.handler(ctx, deps);
    expect(result).toEqual({ status: 200, body: { status: "completed" } });
    expect(handle).toHaveBeenCalledOnce();
    const call = handle.mock.calls[0]?.[0];
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("authorization")).toBe("Bearer tool-capability-material");
    expect(call?.body).toBe('{"action":"read"}');
  });

  it("rejects a browser-origin request with 403 before reaching the bridge, and logs one body-free rejected line", async () => {
    const log = captureServerLog();
    const handle = vi.fn(() => Promise.resolve({ status: 200, body: "{}" }));
    const deps = depsWith(bridge(handle));
    const ctx = toolFacadeContext({ origin: "http://evil.test", bearer: "tool-capability" });
    const result = await handleCodingSidecarToolFacade(ctx, deps);
    expect(result).toMatchObject({
      status: 403,
      body: { error: { code: "FORBIDDEN" } },
    });
    expect(handle).not.toHaveBeenCalled();
    expect(log.events).toEqual([
      expect.objectContaining({
        category: "gateway",
        op: "coding-sidecar.tool-facade.rejected",
        correlationId: "run-tool-facade-test",
        status: 403,
        extra: { reason: "origin-not-allowed" },
      }),
    ]);
    // Body-free: the log line never carries the browser origin value itself.
    expect(log.lines().join("\n")).not.toContain("evil.test");
  });

  it("returns 503 CODING_TOOL_FACADE_UNAVAILABLE, without logging a rejection, when no run is active", async () => {
    const log = captureServerLog();
    const noRunDeps = depsWith({ resolve: (): undefined => undefined });
    const ctx = toolFacadeContext({ bearer: "tool-capability" });
    const result = await handleCodingSidecarToolFacade(ctx, noRunDeps);
    expect(result).toMatchObject({
      status: 503,
      body: { error: { code: "CODING_TOOL_FACADE_UNAVAILABLE" } },
    });
    expect(log.events).toEqual([]);

    // Deps carrying no `toolFacadeBridge` at all fails closed the same way.
    const missingDeps = depsWith(undefined);
    const missingResult = await handleCodingSidecarToolFacade(ctx, missingDeps);
    expect(missingResult).toMatchObject({ status: 503 });
  });

  it("maps the bridge's 401 to UNAUTHORIZED and logs capability-invalid (missing/invalid bearer)", async () => {
    const log = captureServerLog();
    const handle = vi.fn(() => Promise.resolve({ status: 401, body: "" }));
    const deps = depsWith(bridge(handle));
    const ctx = toolFacadeContext({});
    const result = await handleCodingSidecarToolFacade(ctx, deps);
    expect(result).toMatchObject({ status: 401, body: { error: { code: "UNAUTHORIZED" } } });
    expect(log.events).toEqual([
      expect.objectContaining({
        op: "coding-sidecar.tool-facade.rejected",
        status: 401,
        extra: { reason: "capability-invalid" },
      }),
    ]);
  });

  it("rejects an oversized body with 413 before ever calling the bridge, and logs body-too-large", async () => {
    const log = captureServerLog();
    const handle = vi.fn(() => Promise.resolve({ status: 200, body: "{}" }));
    const deps = depsWith(bridge(handle));
    const oversized = `{"padding":"${"x".repeat(2_000_000)}"}`;
    const ctx = toolFacadeContext({ bearer: "tool-capability", body: oversized });
    const result = await handleCodingSidecarToolFacade(ctx, deps);
    expect(result).toMatchObject({
      status: 413,
      body: { error: { code: "PAYLOAD_TOO_LARGE" } },
    });
    expect(handle).not.toHaveBeenCalled();
    expect(log.events).toEqual([
      expect.objectContaining({
        op: "coding-sidecar.tool-facade.rejected",
        status: 413,
        extra: { reason: "body-too-large" },
      }),
    ]);
  });

  // #3390: relocated from opencodeRuntimeComposition.test.ts's retired raw-listener fatal-UTF-8
  // pin -- the BFF's own body reader (`readJsonObject`, over the real `IncomingMessage`) is now
  // the layer that decodes ingress bytes, so a byte sequence that cannot round-trip as valid JSON
  // is rejected HERE, before the bridge is ever reached.
  it("rejects a body with an invalid byte sequence as 400 body-invalid, before calling the bridge", async () => {
    const log = captureServerLog();
    const handle = vi.fn(() => Promise.resolve({ status: 200, body: "{}" }));
    const deps = depsWith(bridge(handle));
    // `{`, an invalid UTF-8 continuation byte, `}` -- decodes (lossily) to something that is not
    // valid JSON, so `readJsonObject`'s `JSON.parse` rejects it the same way a fatal decoder would.
    const ctx = toolFacadeContext({
      bearer: "tool-capability",
      body: Buffer.from([0x7b, 0xc3, 0x28, 0x7d]),
    });
    const result = await handleCodingSidecarToolFacade(ctx, deps);
    expect(result).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
    expect(handle).not.toHaveBeenCalled();
    expect(log.events).toEqual([
      expect.objectContaining({
        op: "coding-sidecar.tool-facade.rejected",
        status: 400,
        extra: { reason: "body-invalid" },
      }),
    ]);
  });

  it("passes a genuine facade-execution failure (502) through verbatim without logging a rejection", async () => {
    const log = captureServerLog();
    const handle = vi.fn(() => Promise.resolve({ status: 502, body: "" }));
    const deps = depsWith(bridge(handle));
    const ctx = toolFacadeContext({ bearer: "tool-capability" });
    const result = await handleCodingSidecarToolFacade(ctx, deps);
    expect(result).toMatchObject({
      status: 502,
      body: { error: { code: "CODING_TOOL_FACADE_UNAVAILABLE" } },
    });
    // 502 is a genuine, already-diagnosed facade failure (its own source already logged it) --
    // this route intentionally emits no SECOND, redundant "rejected" line for it.
    expect(log.events).toEqual([]);
  });

  it("bounds the disconnect signal to the request/response lifecycle (bindRouteDisconnect)", async () => {
    let observedSignal: AbortSignal | undefined;
    let releaseHandle: (() => void) | undefined;
    const invoked = new Promise<void>((resolve) => {
      releaseHandle = resolve;
    });
    const handle = vi.fn(
      (input: {
        readonly signal?: AbortSignal;
      }): Promise<{ readonly status: number; readonly body: string }> => {
        observedSignal = input.signal;
        releaseHandle?.();
        return new Promise((resolve) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              resolve({ status: 502, body: "" });
            },
            { once: true },
          );
        });
      },
    );
    const deps = depsWith(bridge(handle));
    const ctx = toolFacadeContext({ bearer: "tool-capability" });
    const handled = (async (): Promise<unknown> => {
      return handleCodingSidecarToolFacade(ctx, deps);
    })();
    await invoked;
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(false);
    // Simulates the client disconnecting mid-request: a real `res.close` without `writableFinished`
    // being true, exactly what `bindRouteDisconnect` listens for.
    ctx.res.emit("close");
    await vi.waitFor(() => {
      expect(observedSignal?.aborted).toBe(true);
    });
    await expect(handled).resolves.toMatchObject({ status: 502 });
  });
});
