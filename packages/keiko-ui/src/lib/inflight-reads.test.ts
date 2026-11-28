// Identical concurrent BFF GETs share one network read; nothing that is the caller's own is shared.
// Regression for the lab request storm: one page load sent six identical `GET /api/git/branches`
// and four identical `GET /api/editor/settings` within a few milliseconds.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGitBranches } from "./api";
import { bffFetchJson } from "./http";
import { INFLIGHT_READ_MAX_MS, coalescedFetch, endInflightReads } from "./inflight-reads";

interface Deferred {
  readonly respond: (body: unknown) => void;
  readonly promise: Promise<Response>;
}

function deferredResponse(): Deferred {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return {
    promise,
    respond: (body): void => {
      resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    },
  };
}

function mockFetchWith(...deferreds: readonly Deferred[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const deferred of deferreds) fetchMock.mockReturnValueOnce(deferred.promise);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  endInflightReads();
  vi.unstubAllGlobals();
});

describe("coalescedFetch", () => {
  it("serves concurrent identical reads from one request, each with its own body", async () => {
    const first = deferredResponse();
    const fetchMock = mockFetchWith(first);
    const reads = [1, 2, 3].map(() =>
      bffFetchJson<{ readonly ok: boolean }>("/api/editor/settings", undefined, {
        shareInflight: true,
      }).then((value) => value.ok),
    );
    first.respond({ ok: true });
    expect(await Promise.all(reads)).toEqual([true, true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares the read of the fetchJson transport too", async () => {
    const first = deferredResponse();
    const fetchMock = mockFetchWith(first);
    const reads = [1, 2, 3, 4, 5, 6].map(() => fetchGitBranches("/repo"));
    first.respond({ branches: [] });
    await Promise.all(reads);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never shares a read whose caller did not opt in, so a deliberate refresh reads now", async () => {
    const a = deferredResponse();
    const b = deferredResponse();
    const fetchMock = mockFetchWith(a, b);
    const reads = [bffFetchJson("/api/task-workspaces"), bffFetchJson("/api/task-workspaces")];
    a.respond({});
    b.respond({});
    await Promise.all(reads);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends a new request once the read has settled", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    const fetchMock = mockFetchWith(first, second);
    const initial = bffFetchJson("/api/config", undefined, { shareInflight: true });
    first.respond({});
    await initial;
    const later = bffFetchJson("/api/config", undefined, { shareInflight: true });
    second.respond({});
    await later;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not share reads of different routes or query strings", async () => {
    const a = deferredResponse();
    const b = deferredResponse();
    const fetchMock = mockFetchWith(a, b);
    const reads = [
      bffFetchJson("/api/git/branches?root=%2Fa", undefined, { shareInflight: true }),
      bffFetchJson("/api/git/branches?root=%2Fb", undefined, { shareInflight: true }),
    ];
    a.respond({});
    b.respond({});
    await Promise.all(reads);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never shares a read whose caller names its correlation id or owns the abort signal", async () => {
    const a = deferredResponse();
    const b = deferredResponse();
    const c = deferredResponse();
    const fetchMock = mockFetchWith(a, b, c);
    const reads = [
      bffFetchJson("/api/models", undefined, {
        shareInflight: true,
        correlationId: "ui_named-0001",
      }),
      bffFetchJson("/api/models", undefined, {
        shareInflight: true,
        correlationId: "ui_named-0002",
      }),
      bffFetchJson(
        "/api/models",
        { signal: new AbortController().signal },
        { shareInflight: true },
      ),
    ];
    a.respond({});
    b.respond({});
    c.respond({});
    await Promise.all(reads);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not let a read issued after a write join a read that predates it", async () => {
    const stale = deferredResponse();
    const write = deferredResponse();
    const fresh = deferredResponse();
    const fetchMock = mockFetchWith(stale, write, fresh);
    const before = bffFetchJson("/api/editor/settings", undefined, { shareInflight: true });
    const mutation = bffFetchJson("/api/editor/settings", {
      method: "PUT",
      body: "{}",
      headers: { "X-Keiko-CSRF": "1" },
    });
    write.respond({});
    await mutation;
    const after = bffFetchJson("/api/editor/settings", undefined, { shareInflight: true });
    stale.respond({ value: "old" });
    fresh.respond({ value: "new" });
    expect(await before).toEqual({ value: "old" });
    expect(await after).toEqual({ value: "new" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("propagates a failed read to every joiner", async () => {
    const failing = vi.fn().mockRejectedValue(new TypeError("network down"));
    vi.stubGlobal("fetch", failing);
    const reads = [coalescedFetch("/api/x", undefined, { joinable: true })];
    reads.push(coalescedFetch("/api/x", undefined, { joinable: true }));
    const settled = await Promise.allSettled(reads);
    expect(settled.map((entry) => entry.status)).toEqual(["rejected", "rejected"]);
    expect(failing).toHaveBeenCalledTimes(1);
  });
});

// U-45: a shared read that never settles must not keep its entry for good; every later identical read
// used to join it and no request ever reached the network again.
describe("coalescedFetch bounded lifetime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a new request once a hung shared read has outlived its bound", async () => {
    vi.useFakeTimers();
    const hung = deferredResponse();
    const fresh = deferredResponse();
    const fetchMock = mockFetchWith(hung, fresh);
    const options = { joinable: true };
    void coalescedFetch("/api/x", { cache: "no-store" }, options);
    const joiner = coalescedFetch("/api/x", { cache: "no-store" }, options);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(INFLIGHT_READ_MAX_MS);
    // The joiner is not left waiting for the hung read: it reads for itself.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fresh.respond({ ok: true });
    await expect((await joiner).json()).resolves.toEqual({ ok: true });
    // And the hung entry is gone: a read now sends its own request.
    mockFetchWith(deferredResponse());
    void coalescedFetch("/api/x", { cache: "no-store" }, options);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("starts one replacement read for every joiner of a hung read, not one each", async () => {
    vi.useFakeTimers();
    const hung = deferredResponse();
    const replacement = deferredResponse();
    const fetchMock = mockFetchWith(hung, replacement);
    const options = { joinable: true };
    void coalescedFetch("/api/x", { cache: "no-store" }, options);
    const joiners = [1, 2, 3].map(() => coalescedFetch("/api/x", { cache: "no-store" }, options));
    await vi.advanceTimersByTimeAsync(INFLIGHT_READ_MAX_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    replacement.respond({ ok: true });
    for (const joiner of joiners) {
      await expect((await joiner).json()).resolves.toEqual({ ok: true });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not clone a response that settles after its joiners moved on", async () => {
    vi.useFakeTimers();
    const hung = deferredResponse();
    mockFetchWith(hung, deferredResponse());
    const options = { joinable: true };
    const first = coalescedFetch("/api/x", { cache: "no-store" }, options);
    void coalescedFetch("/api/x", { cache: "no-store" }, options);
    await vi.advanceTimersByTimeAsync(INFLIGHT_READ_MAX_MS);
    const cloneSpy = vi.spyOn(Response.prototype, "clone");
    hung.respond({ late: true });
    await first;
    await vi.advanceTimersByTimeAsync(0);
    // Only the first caller's own copy is made; the expired joiner makes none.
    expect(cloneSpy).toHaveBeenCalledTimes(1);
    cloneSpy.mockRestore();
  });

  it("settles a joiner waiting on a hung read once the join windows end", async () => {
    vi.useFakeTimers();
    const hung = deferredResponse();
    const replacement = deferredResponse();
    const fetchMock = mockFetchWith(hung, replacement);
    const options = { joinable: true };
    void coalescedFetch("/api/x", { cache: "no-store" }, options);
    const joiners = [1, 2].map(() => coalescedFetch("/api/x", { cache: "no-store" }, options));
    endInflightReads();
    await vi.advanceTimersByTimeAsync(0);
    // One replacement read between the joiners, and no timer is left to wait for.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    replacement.respond({ ok: true });
    for (const joiner of joiners) {
      await expect((await joiner).json()).resolves.toEqual({ ok: true });
    }
    endInflightReads();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no lifetime timer running once the join windows end", () => {
    vi.useFakeTimers();
    mockFetchWith(deferredResponse());
    void coalescedFetch("/api/x", { cache: "no-store" }, { joinable: true });
    expect(vi.getTimerCount()).toBe(1);
    endInflightReads();
    expect(vi.getTimerCount()).toBe(0);
  });
});
