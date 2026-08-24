// Confluence Cloud v2 sync adapter tests (Issue #2242, ADR-0128 D3/D5). Hermetic: the injected
// fixture transport mirrors createInMemoryManualFetcher — no network, no atlassian.net.

import { describe, expect, it } from "vitest";
import { AtlassianCredentialCustodyError } from "./atlassian-credential-custody.js";
import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "./atlassian-http-port.js";
import {
  ATLASSIAN_SYNC_ITEM_MAX_BYTES,
  type AtlassianSyncFetchContext,
  type AtlassianSyncItemFetchOutcome,
} from "./atlassian-sync-lane.js";
import { createConfluenceSyncSource, type ConfluencePageRef } from "./confluence-sync-adapter.js";
import {
  createInMemoryConfluenceFixture,
  type ConfluenceFixturePage,
  type ConfluenceFixtureSpace,
} from "./confluence-sync-fixtures.js";

const BASE_URL = "https://tenant.example";

function fixturePage(
  id: number,
  overrides: Partial<ConfluenceFixturePage> = {},
): ConfluenceFixturePage {
  return {
    pageId: String(id),
    title: `Page ${String(id)}`,
    storageBody: `<h1>Heading ${String(id)}</h1><p>Body of page ${String(id)}.</p>`,
    ...overrides,
  };
}

function space(
  key: string,
  id: string,
  pages: readonly ConfluenceFixturePage[],
): ConfluenceFixtureSpace {
  return { key, id, pages };
}

function contextFor(http: AtlassianHttpBodyPort, maxItems = 2_000): AtlassianSyncFetchContext {
  return { http, deadlineExceeded: () => false, maxItems };
}

function sourceFor(spaceKeys: readonly string[]): ReturnType<typeof createConfluenceSyncSource> {
  return createConfluenceSyncSource({ baseUrl: BASE_URL, connectorId: "cred-test", spaceKeys });
}

describe("createConfluenceSyncSource — construction guards", () => {
  it("refuses invalid connector ids, empty scopes, and invalid space keys", () => {
    expect(() =>
      createConfluenceSyncSource({ baseUrl: BASE_URL, connectorId: "a:b", spaceKeys: ["ENG"] }),
    ).toThrow(AtlassianCredentialCustodyError);
    expect(() =>
      createConfluenceSyncSource({ baseUrl: BASE_URL, connectorId: "cred-x", spaceKeys: [] }),
    ).toThrow(AtlassianCredentialCustodyError);
    expect(() =>
      createConfluenceSyncSource({
        baseUrl: BASE_URL,
        connectorId: "cred-x",
        spaceKeys: ["not a key!"],
      }),
    ).toThrow(AtlassianCredentialCustodyError);
    expect(() =>
      createConfluenceSyncSource({
        baseUrl: "http://tenant.example",
        connectorId: "cred-x",
        spaceKeys: ["ENG"],
      }),
    ).toThrow(AtlassianCredentialCustodyError);
  });
});

describe("enumerate — spaces and page listings", () => {
  it("resolves space keys and enumerates pages across pagination cursors", async () => {
    const pages = Array.from({ length: 25 }, (_, index) => fixturePage(index + 1));
    const requests: AtlassianHttpBodyRequest[] = [];
    const http = createInMemoryConfluenceFixture({
      baseUrl: BASE_URL,
      spaces: [space("ENG", "100", pages)],
      listPageSize: 10,
      onRequest: (request) => requests.push(request),
    });
    const outcome = await sourceFor(["ENG"]).enumerate(contextFor(http));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.complete).toBe(true);
    expect(outcome.refs).toHaveLength(25);
    expect(outcome.refs[0]).toEqual({ itemKey: "confluence:cred-test:1", pageId: "1" });
    // Exact endpoints: one spaces resolution + three cursor-paginated page listings.
    const paths = requests.map((request) => new URL(request.url).pathname);
    expect(paths[0]).toBe("/wiki/api/v2/spaces");
    expect(paths.filter((path) => path === "/wiki/api/v2/spaces/100/pages")).toHaveLength(3);
  });

  it("stops early with complete=false once refs cross the lane's item ceiling", async () => {
    const pages = Array.from({ length: 12 }, (_, index) => fixturePage(index + 1));
    const http = createInMemoryConfluenceFixture({
      baseUrl: BASE_URL,
      spaces: [space("ENG", "100", pages)],
      listPageSize: 10,
    });
    const outcome = await sourceFor(["ENG"]).enumerate(contextFor(http, 5));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.complete).toBe(false);
  });

  it("fails the run with permission-denied when a configured space key does not resolve", async () => {
    const http = createInMemoryConfluenceFixture({
      baseUrl: BASE_URL,
      spaces: [space("ENG", "100", [fixturePage(1)])],
    });
    const outcome = await sourceFor(["ENG", "HIDDEN"]).enumerate(contextFor(http));
    expect(outcome).toEqual({ ok: false, reason: "permission-denied" });
  });

  it("maps enumeration transport statuses onto closed run-fatal reasons (401/403/timeout)", async () => {
    const cases: readonly [AtlassianHttpBodyResult, string][] = [
      [
        { kind: "response", status: 401, bodyText: "", bodyBytes: 0, truncated: false },
        "auth-failed",
      ],
      [
        { kind: "response", status: 403, bodyText: "", bodyBytes: 0, truncated: false },
        "permission-denied",
      ],
      [{ kind: "timeout" }, "timeout"],
      [{ kind: "network-error" }, "unavailable"],
    ];
    for (const [result, reason] of cases) {
      const outcome = await sourceFor(["ENG"]).enumerate(contextFor(() => Promise.resolve(result)));
      expect(outcome).toEqual({ ok: false, reason });
    }
  });

  it("refuses a pagination cursor that leaves the approved host or API root — fail closed", async () => {
    const offHost = createInMemoryConfluenceFixture({
      baseUrl: BASE_URL,
      spaces: [space("ENG", "100", [fixturePage(1)])],
      override: (request) => {
        const url = new URL(request.url);
        if (
          url.pathname === "/wiki/api/v2/spaces/100/pages" &&
          url.searchParams.get("cursor") === null
        ) {
          return {
            kind: "response",
            status: 200,
            bodyText: JSON.stringify({
              results: [{ id: "1", title: "Page 1" }],
              _links: { next: "https://attacker.example/wiki/api/v2/spaces/100/pages?cursor=1" },
            }),
            bodyBytes: 200,
            truncated: false,
          };
        }
        return undefined;
      },
    });
    const outcome = await sourceFor(["ENG"]).enumerate(contextFor(offHost));
    expect(outcome).toEqual({ ok: false, reason: "scope-exceeded" });

    const offRoot = createInMemoryConfluenceFixture({
      baseUrl: BASE_URL,
      spaces: [space("ENG", "100", [fixturePage(1)])],
      override: (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/wiki/api/v2/spaces") {
          return {
            kind: "response",
            status: 200,
            bodyText: JSON.stringify({
              results: [{ id: "100", key: "ENG" }],
              _links: { next: "/logout?redirect=/wiki/api/v2/spaces" },
            }),
            bodyBytes: 200,
            truncated: false,
          };
        }
        return undefined;
      },
    });
    // The off-root cursor is only followed when more keys remain unresolved; a second wanted key
    // forces the walk to continue into the hostile cursor.
    const outcome2 = await createConfluenceSyncSource({
      baseUrl: BASE_URL,
      connectorId: "cred-test",
      spaceKeys: ["ENG", "OPS"],
    }).enumerate(contextFor(offRoot));
    expect(outcome2).toEqual({ ok: false, reason: "scope-exceeded" });
  });

  it("classifies unparseable list payloads as malformed-payload", async () => {
    const http: AtlassianHttpBodyPort = () =>
      Promise.resolve({
        kind: "response",
        status: 200,
        bodyText: "<html>not json</html>",
        bodyBytes: 21,
        truncated: false,
      });
    const outcome = await sourceFor(["ENG"]).enumerate(contextFor(http));
    expect(outcome).toEqual({ ok: false, reason: "malformed-payload" });
  });

  it("fails closed on a self-referential pagination cursor after two requests, not the 500-request ceiling", async () => {
    // Regression for the cursor-loop detection tightening (audit finding, Epic #2238):
    // a `_links.next` that points back to the current URL must terminate the walk immediately,
    // not spin against the fail-closed hard ceiling.
    const requests: AtlassianHttpBodyRequest[] = [];
    const spacesPath = "/wiki/api/v2/spaces";
    const http: AtlassianHttpBodyPort = (request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === spacesPath) {
        return Promise.resolve({
          kind: "response",
          status: 200,
          bodyText: JSON.stringify({
            results: [{ id: "100", key: "ENG" }],
            _links: { next: request.url },
          }),
          bodyBytes: 200,
          truncated: false,
        });
      }
      throw new Error(`unexpected request: ${request.url}`);
    };
    // Two configured keys keep the walk continuing after the first page (found.size < wanted.size),
    // forcing the walker to follow the self-referential `next` cursor.
    const outcome = await createConfluenceSyncSource({
      baseUrl: BASE_URL,
      connectorId: "cred-test",
      spaceKeys: ["ENG", "OPS"],
    }).enumerate(contextFor(http));
    expect(outcome).toEqual({ ok: false, reason: "malformed-payload" });
    // The seen-URL guard must fire on the second iteration; the walker must not touch the
    // 500-request ceiling. A generous cap (< 10) captures the regression without pinning the exact
    // request count to an internal implementation detail.
    expect(requests.length).toBeLessThan(10);
  });
});

describe("fetchItem — page bodies, comments, and the failure matrix", () => {
  async function fetchPage(
    http: AtlassianHttpBodyPort,
    pageId: string,
  ): Promise<AtlassianSyncItemFetchOutcome> {
    const ref: ConfluencePageRef = { itemKey: `confluence:cred-test:${pageId}`, pageId };
    return sourceFor(["ENG"]).fetchItem(ref, contextFor(http));
  }

  it("normalizes a page into one HTML document with escaped title, storage body, and comments", async () => {
    const http = createInMemoryConfluenceFixture({
      baseUrl: BASE_URL,
      spaces: [
        space("ENG", "100", [
          fixturePage(7, {
            title: 'Ops <Guide> & "Runbook"',
            comments: ["<p>First comment</p>", "<p>Second comment</p>"],
            webuiPath: "/wiki/spaces/ENG/pages/7/Ops-Guide",
          }),
        ]),
      ],
    });
    const outcome = await fetchPage(http, "7");
    expect(outcome.kind).toBe("item");
    if (outcome.kind !== "item") return;
    expect(outcome.item.itemKey).toBe("confluence:cred-test:7");
    expect(outcome.item.relativePath).toBe("pages/7.html");
    expect(outcome.item.title).toBe('Ops <Guide> & "Runbook"');
    expect(outcome.item.webuiPath).toBe("/wiki/spaces/ENG/pages/7/Ops-Guide");
    expect(outcome.item.contentHtml).toContain(
      "<title>Ops &lt;Guide&gt; &amp; &quot;Runbook&quot;</title>",
    );
    expect(outcome.item.contentHtml).toContain("<h1>Heading 7</h1>");
    expect(outcome.item.contentHtml).toContain("<h2>Comments</h2>");
    expect(outcome.item.contentHtml).toContain("<p>Second comment</p>");
    expect(outcome.item.byteLength).toBe(new TextEncoder().encode(outcome.item.contentHtml).length);
  });

  it("drops hostile webui links instead of carrying them into citation metadata", async () => {
    const http = createInMemoryConfluenceFixture({
      baseUrl: BASE_URL,
      spaces: [
        space("ENG", "100", [fixturePage(8, { webuiPath: "https://attacker.example/phish" })]),
      ],
    });
    const outcome = await fetchPage(http, "8");
    expect(outcome.kind).toBe("item");
    if (outcome.kind !== "item") return;
    expect(outcome.item.webuiPath).toBeUndefined();
  });

  it("classifies the per-page failure matrix: 401 fatal, 403 denied, 404 missing, 429 rate-limited, 5xx unavailable, timeout, malformed", async () => {
    const matrix: readonly [Partial<ConfluenceFixturePage>, AtlassianSyncItemFetchOutcome][] = [
      [{ bodyStatus: 401 }, { kind: "fatal", reason: "auth-failed" }],
      [{ bodyStatus: 403 }, { kind: "skipped", reason: "permission-denied" }],
      [{ bodyStatus: 404 }, { kind: "missing" }],
      [{ malformedBody: true }, { kind: "skipped", reason: "malformed-payload" }],
    ];
    for (const [overrides, expected] of matrix) {
      const http = createInMemoryConfluenceFixture({
        baseUrl: BASE_URL,
        spaces: [space("ENG", "100", [fixturePage(9, overrides)])],
      });
      expect(await fetchPage(http, "9")).toEqual(expected);
    }
    expect(await fetchPage(() => Promise.resolve({ kind: "timeout" }), "9")).toEqual({
      kind: "skipped",
      reason: "timeout",
    });
    expect(await fetchPage(() => Promise.resolve({ kind: "network-error" }), "9")).toEqual({
      kind: "skipped",
      reason: "unavailable",
    });
    // Non-retryable rate-limit / server errors surface as closed reasons (the lane's budgeted
    // port owns the retry ladder; by the time the adapter sees the status it is final).
    const rateLimited: AtlassianHttpBodyPort = () =>
      Promise.resolve({
        kind: "response",
        status: 429,
        bodyText: "",
        bodyBytes: 0,
        truncated: false,
      });
    expect(await fetchPage(rateLimited, "9")).toEqual({ kind: "skipped", reason: "rate-limited" });
    const upstream: AtlassianHttpBodyPort = () =>
      Promise.resolve({
        kind: "response",
        status: 503,
        bodyText: "",
        bodyBytes: 0,
        truncated: false,
      });
    expect(await fetchPage(upstream, "9")).toEqual({ kind: "skipped", reason: "unavailable" });
  });

  it("skips an oversized page body with bounds-exceeded (truncated bytes are never indexed)", async () => {
    const oversized = "<p>" + "x".repeat(ATLASSIAN_SYNC_ITEM_MAX_BYTES) + "</p>";
    const http = createInMemoryConfluenceFixture({
      baseUrl: BASE_URL,
      spaces: [space("ENG", "100", [fixturePage(10, { storageBody: oversized })])],
    });
    const outcome = await fetchPage(http, "10");
    expect(outcome).toEqual({ kind: "skipped", reason: "bounds-exceeded" });
  });

  it("degrades comment failures to a page without comments (the body remains citable)", async () => {
    const http = createInMemoryConfluenceFixture({
      baseUrl: BASE_URL,
      spaces: [space("ENG", "100", [fixturePage(11, { comments: ["<p>never served</p>"] })])],
      override: (request) => {
        if (new URL(request.url).pathname.endsWith("/footer-comments")) {
          return { kind: "network-error" };
        }
        return undefined;
      },
    });
    const outcome = await fetchPage(http, "11");
    expect(outcome.kind).toBe("item");
    if (outcome.kind !== "item") return;
    expect(outcome.item.contentHtml).not.toContain("never served");
    expect(outcome.item.contentHtml).toContain("<h1>Heading 11</h1>");
  });

  it("stops harvesting comments at the per-item byte allowance instead of overflowing", async () => {
    const bigBody = "<p>" + "b".repeat(ATLASSIAN_SYNC_ITEM_MAX_BYTES - 2_000) + "</p>";
    const http = createInMemoryConfluenceFixture({
      baseUrl: BASE_URL,
      spaces: [
        space("ENG", "100", [
          fixturePage(12, {
            storageBody: bigBody,
            comments: ["<p>small</p>", "<p>" + "c".repeat(5_000) + "</p>"],
          }),
        ]),
      ],
    });
    const outcome = await fetchPage(http, "12");
    expect(outcome.kind).toBe("item");
    if (outcome.kind !== "item") return;
    expect(outcome.item.contentHtml).toContain("<p>small</p>");
    expect(outcome.item.contentHtml).not.toContain("ccccc");
  });

  // KEIKO-0453: the file header states a 401 is always run-fatal. A 401 during the footer-comment
  // fetch was previously swallowed (fetchCommentBodies ignored walkPaginatedList's outcome), so
  // the page composed without comments and the run reported completed. The header invariant must
  // hold — a 401 on the comment lane fails the run fatally with `auth-failed`.
  it("propagates a 401 on the footer-comments fetch as run-fatal auth-failed (KEIKO-0453 — byte accounting)", async () => {
    const http = createInMemoryConfluenceFixture({
      baseUrl: BASE_URL,
      spaces: [space("ENG", "100", [fixturePage(13, { comments: ["<p>never served</p>"] })])],
      override: (request) => {
        if (new URL(request.url).pathname.endsWith("/footer-comments")) {
          return { kind: "response", status: 401, bodyText: "", bodyBytes: 0, truncated: false };
        }
        return undefined;
      },
    });
    expect(await fetchPage(http, "13")).toEqual({ kind: "fatal", reason: "auth-failed" });
  });

  // KEIKO-0467: `page.payload.storageBody.length` was UTF-16 code-unit length. A CJK body of
  // 3 bytes per character was under-reported by ~3x, over-budgeting the comment allowance and
  // letting the composed item overflow the per-item byte ceiling. After the fix the composed
  // item's byteLength is measured in UTF-8 bytes and either fits the cap or is skipped as
  // bounds-exceeded — never over-cap.
  it("measures the composed item byteLength in UTF-8 bytes (CJK never overflows the per-item cap)", async () => {
    // 500 000 CJK chars (each 3 UTF-8 bytes) = ~1.5 MB body — fits under the 2 MB transport cap.
    // Plus one 200 000-char comment (~600 KB) that would push the composed item to ~2.1 MB.
    // Pre-fix: `.length` reports 500 000, allowance stays at 1.5 MB, comment fits, composed
    // byteLength ~2.1 MB > 2 MB cap. Post-fix: bodyBytes measured at 1.5 MB, allowance falls to
    // ~500 KB, 600 KB comment rejected, composed fits (or is skipped bounds-exceeded).
    const cjkBody = "你".repeat(500_000);
    const cjkComment = "你".repeat(200_000);
    const http = createInMemoryConfluenceFixture({
      baseUrl: BASE_URL,
      spaces: [
        space("ENG", "100", [fixturePage(14, { storageBody: cjkBody, comments: [cjkComment] })]),
      ],
    });
    const outcome = await fetchPage(http, "14");
    if (outcome.kind === "item") {
      expect(outcome.item.byteLength).toBeLessThanOrEqual(ATLASSIAN_SYNC_ITEM_MAX_BYTES);
    } else {
      // A per-page skip is the acceptable degradation for an oversized composed item.
      expect(outcome).toEqual({ kind: "skipped", reason: "bounds-exceeded" });
    }
  });
});
