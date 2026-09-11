import { describe, expect, it, vi, type MockInstance } from "vitest";
import {
  fetchGitHubReleaseAsset,
  fetchWithPortableRetry,
  firstClassArchiveSetComplete,
  PortableAssetRedirectError,
  type GitHubAsset,
} from "./update-preflight-portable-shared.js";

const INITIAL =
  "https://github.com/oscharko-dev/Keiko/releases/download/v1.2.3/keiko-windows-x64.zip";

function asset(name: string, id: number): GitHubAsset {
  return {
    id,
    name,
    size: 1,
    downloadUrl: `https://github.com/oscharko-dev/Keiko/releases/download/v0.3.17/${name}`,
  };
}

const LEGACY_ARCHIVES = [
  "keiko-windows-x64.zip",
  "keiko-macos-arm64.zip",
  "keiko-macos-x64.zip",
] as const;

function spyOnBodyCancellation(response: Response): MockInstance {
  const body = response.body;
  if (body === null) throw new Error("response fixture body is missing");
  return vi.spyOn(body, "cancel");
}

describe("portable GitHub release asset redirect policy", () => {
  it("walks a real GitHub asset redirect family through the governed fetch on every hop", async () => {
    const urls: string[] = [];
    const redirected = new Response("discarded", {
      status: 302,
      headers: {
        location:
          "https://release-assets.githubusercontent.com/github-production-release-asset/1/archive.zip",
      },
    });
    const cancel = spyOnBodyCancellation(redirected);
    const fetchHop = vi.fn((url: string): Promise<Response> => {
      urls.push(url);
      if (urls.length === 1) return Promise.resolve(redirected);
      return Promise.resolve(new Response("verified bytes"));
    });

    await expect(fetchGitHubReleaseAsset(INITIAL, fetchHop)).resolves.toMatchObject({
      status: 200,
    });
    expect(urls).toEqual([
      INITIAL,
      "https://release-assets.githubusercontent.com/github-production-release-asset/1/archive.zip",
    ]);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    "http://release-assets.githubusercontent.com/archive.zip",
    "https://user:secret@release-assets.githubusercontent.com/archive.zip",
    "https://downloads.example.invalid/archive.zip",
  ])("rejects an unsafe redirect without fetching it: %s", async (location) => {
    const response = new Response("discarded", { status: 302, headers: { location } });
    const cancel = spyOnBodyCancellation(response);
    const fetchHop = vi.fn(() => Promise.resolve(response));

    await expect(fetchGitHubReleaseAsset(INITIAL, fetchHop)).rejects.toBeInstanceOf(
      PortableAssetRedirectError,
    );
    expect(fetchHop).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects non-canonical HTTPS ports before issuing a request", async () => {
    const fetchHop = vi.fn(() => Promise.resolve(new Response("unexpected")));

    await expect(
      fetchGitHubReleaseAsset(
        "https://github.com:444/oscharko-dev/keiko/releases/download/v1.2.3/archive.zip",
        fetchHop,
      ),
    ).rejects.toThrow("origin is unsafe");
    expect(fetchHop).not.toHaveBeenCalled();

    const redirected = new Response("discarded", {
      status: 302,
      headers: { location: "https://release-assets.githubusercontent.com:444/archive.zip" },
    });
    const redirectCancel = spyOnBodyCancellation(redirected);
    await expect(
      fetchGitHubReleaseAsset(INITIAL, () => Promise.resolve(redirected)),
    ).rejects.toThrow("target is unsafe");
    expect(redirectCancel).toHaveBeenCalledOnce();
  });

  it("cancels a discarded terminal error body", async () => {
    const response = new Response("discarded", { status: 404 });
    const cancel = spyOnBodyCancellation(response);

    await expect(fetchGitHubReleaseAsset(INITIAL, () => Promise.resolve(response))).resolves.toBe(
      response,
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects missing locations, redirect loops, and excessive redirect chains", async () => {
    await expect(
      fetchGitHubReleaseAsset(INITIAL, () => Promise.resolve(new Response(null, { status: 302 }))),
    ).rejects.toBeInstanceOf(PortableAssetRedirectError);

    await expect(
      fetchGitHubReleaseAsset(INITIAL, () =>
        Promise.resolve(new Response(null, { status: 302, headers: { location: INITIAL } })),
      ),
    ).rejects.toThrow("loop");

    let hop = 0;
    await expect(
      fetchGitHubReleaseAsset(INITIAL, () => {
        hop += 1;
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: {
              location: `https://release-assets.githubusercontent.com/release/${String(hop)}.zip`,
            },
          }),
        );
      }),
    ).rejects.toThrow("limit");
    expect(hop).toBe(4);
  });
});

describe("portable fetch retry policy", () => {
  it("refuses an attempt once the operation-wide deadline has elapsed", async () => {
    const attempt = vi.fn(() => Promise.resolve(new Response("late")));

    await expect(
      fetchWithPortableRetry(attempt, { deadlineAt: 2_000, now: () => 2_000 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(attempt).not.toHaveBeenCalled();
  });

  it("retries 429 and 5xx twice with capped Retry-After and fixed backoff", async () => {
    const responses = [
      new Response(null, { status: 429, headers: { "retry-after": "99" } }),
      new Response(null, { status: 503 }),
      new Response("ok"),
    ];
    const delays: number[] = [];
    let attempt = 0;

    await expect(
      fetchWithPortableRetry(
        () => Promise.resolve(responses[attempt++] ?? new Response(null, { status: 500 })),
        {
          now: () => 1_000,
          sleep: (ms) => {
            delays.push(ms);
            return Promise.resolve();
          },
        },
      ),
    ).resolves.toMatchObject({ status: 200 });
    expect(attempt).toBe(3);
    expect(delays).toEqual([30_000, 3_000]);
  });

  it("retries only DNS/timeouts and never retries closed 4xx responses", async () => {
    const dnsThenOk = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(Object.assign(new Error("dns"), { code: "EAI_AGAIN" }))
      .mockResolvedValueOnce(new Response("ok"));

    await expect(
      fetchWithPortableRetry(dnsThenOk, { sleep: () => Promise.resolve() }),
    ).resolves.toMatchObject({ status: 200 });
    expect(dnsThenOk).toHaveBeenCalledTimes(2);

    const forbidden = vi.fn(() => Promise.resolve(new Response(null, { status: 403 })));
    await expect(fetchWithPortableRetry(forbidden)).resolves.toMatchObject({ status: 403 });
    expect(forbidden).toHaveBeenCalledTimes(1);

    const protocolFailure = vi.fn(() => Promise.reject(new Error("malformed response")));
    await expect(fetchWithPortableRetry(protocolFailure)).rejects.toThrow("malformed response");
    expect(protocolFailure).toHaveBeenCalledTimes(1);
  });
});

describe("portable release archive-set compatibility", () => {
  it("accepts historic three-target releases and the current four-target release", () => {
    const legacy = LEGACY_ARCHIVES.map(asset);
    const current = [asset("keiko-linux-x64.zip", 4), ...legacy];

    expect(firstClassArchiveSetComplete(legacy)).toBe(true);
    expect(firstClassArchiveSetComplete(current)).toBe(true);
  });

  it("rejects partial, duplicated, and unknown portable archive sets", () => {
    const partial = LEGACY_ARCHIVES.slice(1).map(asset);
    const duplicated = [...LEGACY_ARCHIVES, LEGACY_ARCHIVES[0]].map(asset);
    const unknown = [...LEGACY_ARCHIVES, "keiko-freebsd-x64.zip"].map(asset);

    expect(firstClassArchiveSetComplete([])).toBe(false);
    expect(firstClassArchiveSetComplete(partial)).toBe(false);
    expect(firstClassArchiveSetComplete(duplicated)).toBe(false);
    expect(firstClassArchiveSetComplete(unknown)).toBe(false);
  });
});
