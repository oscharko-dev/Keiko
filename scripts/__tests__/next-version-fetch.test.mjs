import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { URL } from "node:url";
import {
  createNextVersionFetch,
  NEXT_VERSION_METADATA_TIMEOUT_MS,
  NEXT_VERSION_METADATA_URL,
} from "../lib/next-version-fetch.mjs";

let deadline;
beforeEach(() => {
  deadline = new globalThis.AbortController();
  vi.spyOn(globalThis.AbortSignal, "timeout").mockReturnValue(deadline.signal);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Next development version metadata deadline", () => {
  it("lets the installed framework report unknown when its optional registry fetch stalls", async () => {
    const requireNext = createRequire(
      new URL("../../packages/keiko-ui/package.json", import.meta.url),
    );
    const { getVersionInfo } = requireNext("next/dist/server/dev/hot-reloader-shared-utils");
    const fetchImpl = vi.fn(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        }),
    );
    vi.stubGlobal("fetch", createNextVersionFetch(fetchImpl, vi.fn()));
    const pending = getVersionInfo();
    deadline.abort(new globalThis.DOMException("Fixture framework deadline", "TimeoutError"));
    expect(await pending).toEqual({
      installed: requireNext("next/package.json").version,
      staleness: "unknown",
    });
  });

  it.each([
    ["string", () => NEXT_VERSION_METADATA_URL],
    ["URL", () => new URL(NEXT_VERSION_METADATA_URL)],
    ["Request", () => new globalThis.Request(NEXT_VERSION_METADATA_URL)],
  ])("bounds a stalled %s request and preserves the timeout reason", async (_kind, input) => {
    const report = vi.fn();
    const fetchImpl = vi.fn(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        }),
    );
    const pending = createNextVersionFetch(fetchImpl, report)(input());
    const reason = new globalThis.DOMException("Fixture deadline", "TimeoutError");
    deadline.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(globalThis.AbortSignal.timeout).toHaveBeenCalledWith(NEXT_VERSION_METADATA_TIMEOUT_MS);
    expect(report).toHaveBeenCalledExactlyOnceWith();
  });

  it("returns successful metadata unchanged", async () => {
    const response = globalThis.Response.json({ latest: "16.3.8", canary: "16.3.8" });
    const report = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(response);
    expect(await createNextVersionFetch(fetchImpl, report)(NEXT_VERSION_METADATA_URL)).toBe(
      response,
    );
    expect(report).not.toHaveBeenCalled();
  });

  it("preserves caller cancellation and its reason", async () => {
    const caller = new globalThis.AbortController();
    const reason = new Error("Fixture caller cancellation");
    const report = vi.fn();
    const fetchImpl = vi.fn((_input, init) => {
      caller.abort(reason);
      return Promise.reject(init.signal.reason);
    });
    const pending = createNextVersionFetch(fetchImpl, report)(NEXT_VERSION_METADATA_URL, {
      signal: caller.signal,
    });
    await expect(pending).rejects.toBe(reason);
    expect(report).not.toHaveBeenCalled();
  });

  it("inherits a Request signal and honours an explicit null override", async () => {
    const reason = new Error("Fixture original request cancellation");
    const request = new globalThis.Request(NEXT_VERSION_METADATA_URL, {
      signal: globalThis.AbortSignal.abort(reason),
    });
    const fetchImpl = vi.fn().mockResolvedValue(globalThis.Response.json({}));
    const guarded = createNextVersionFetch(fetchImpl, vi.fn());
    await guarded(request);
    expect(fetchImpl.mock.calls[0][1].signal.reason).toBe(reason);
    await guarded(request, { signal: null });
    expect(fetchImpl.mock.calls[1][1].signal.aborted).toBe(false);
  });

  it("keeps the deadline on a real response whose JSON body never completes", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write("{");
    });
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new TypeError("Missing test port");
      const local = `http://127.0.0.1:${String(address.port)}/`;
      const report = vi.fn();
      const guarded = createNextVersionFetch(
        (_input, init) => globalThis.fetch(local, init),
        report,
      );
      const response = await guarded(NEXT_VERSION_METADATA_URL);
      const body = response.json();
      const reason = new globalThis.DOMException("Fixture body deadline", "TimeoutError");
      deadline.abort(reason);
      await expect(body).rejects.toBe(reason);
      expect(report).toHaveBeenCalledExactlyOnceWith();
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => {
        server.close(resolve);
      });
    }
  });

  it("does not report a later timeout after JSON was consumed successfully", async () => {
    const report = vi.fn();
    const response = globalThis.Response.json({ latest: "16.3.8" });
    const guarded = createNextVersionFetch(vi.fn().mockResolvedValue(response), report);
    expect(await (await guarded(NEXT_VERSION_METADATA_URL)).json()).toEqual({ latest: "16.3.8" });
    deadline.abort(new globalThis.DOMException("Fixture later deadline", "TimeoutError"));
    expect(report).not.toHaveBeenCalled();
  });

  it("propagates registry errors without inventing version metadata", async () => {
    const failure = new TypeError("Fixture network failure");
    const report = vi.fn();
    const guarded = createNextVersionFetch(vi.fn().mockRejectedValue(failure), report);
    await expect(guarded(NEXT_VERSION_METADATA_URL)).rejects.toBe(failure);
    expect(report).not.toHaveBeenCalled();
  });

  it("leaves Keiko release requests and their caller options untouched", async () => {
    const url = "https://api.github.com/repos/oscharko-dev/Keiko/releases/latest";
    const init = {
      signal: new globalThis.AbortController().signal,
      headers: { "X-Trace": "fixture" },
    };
    const response = globalThis.Response.json({ tag_name: "v1.2.6" });
    const fetchImpl = vi.fn().mockResolvedValue(response);
    expect(await createNextVersionFetch(fetchImpl, vi.fn())(url, init)).toBe(response);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(url, init);
    expect(fetchImpl.mock.calls[0][1]).toBe(init);
    expect(globalThis.AbortSignal.timeout).not.toHaveBeenCalled();
  });
});
