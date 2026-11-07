// Identical concurrent BFF GETs share one network read; nothing that is the caller's own is shared.
// Regression for the lab request storm: one page load sent six identical `GET /api/git/branches`
// and four identical `GET /api/editor/settings` within a few milliseconds.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGitBranches } from "./api";
import { bffFetchJson } from "./http";
import { coalescedFetch, endInflightReads } from "./inflight-reads";

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
