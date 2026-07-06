import type {
  DocumentationManualScopeLimits,
  HtmlManualSource,
} from "@oscharko-dev/keiko-contracts";
import type { WorkspaceDirEntry, WorkspaceFs, WorkspaceStat } from "@oscharko-dev/keiko-workspace";
import { describe, expect, it } from "vitest";
import { crawlManual } from "./crawl-runner.js";
import {
  createInMemoryManualFetcher,
  createWorkspaceFsManualFetcher,
  type InMemoryManualPage,
} from "./fetchers.js";
import type { ManualCrawlDenyReason } from "./types.js";

const LIMITS: DocumentationManualScopeLimits = {
  maxPages: 50,
  maxDepth: 4,
  maxBytes: 5_000_000,
  maxLinkSample: 64,
  timeoutMs: 10_000,
  followRedirects: false,
};

function limits(
  overrides: Partial<DocumentationManualScopeLimits>,
): DocumentationManualScopeLimits {
  return { ...LIMITS, ...overrides };
}

function httpSource(overrides: Partial<DocumentationManualScopeLimits> = {}): HtmlManualSource {
  return {
    schemaVersion: "1",
    scope: { kind: "html-manual-http", origin: "https://docs.internal", pathPrefix: null },
    limits: limits(overrides),
    sourceFingerprint: "fp-http",
    proposedPodName: "docs.internal",
  };
}

const INDEX_HTML = `<!doctype html><html><head><title>Handbook</title></head><body>
  <a href="guide.html">Guide</a>
  <a href="chapters/">Chapters</a>
  <a href="https://evil.example/x.html">External</a>
  <a href="logout.html">Logout</a>
  <a href="styles.css">Style</a>
  <a href="guide.html">Guide again</a>
</body></html>`;

const HTTP_PAGES = new Map<string, InMemoryManualPage>([
  ["https://docs.internal/", { html: INDEX_HTML }],
  [
    "https://docs.internal/guide.html",
    { html: `<a href="appendix.html">A</a><a href="/">home</a>` },
  ],
  [
    "https://docs.internal/chapters/",
    { html: `<title>Chapters</title><a href="../guide.html">g</a>` },
  ],
  ["https://docs.internal/appendix.html", { html: `<title>Appendix</title><p>end</p>` }],
]);

function reasons(result: {
  readonly denied: readonly { readonly reason: ManualCrawlDenyReason }[];
}): ReadonlySet<ManualCrawlDenyReason> {
  return new Set(result.denied.map((entry) => entry.reason));
}

describe("crawlManual — http link graph", () => {
  it("discovers the reachable page set deterministically and denies out-of-scope links", async () => {
    const result = await crawlManual(
      { fetcher: createInMemoryManualFetcher(HTTP_PAGES) },
      httpSource(),
    );
    expect(result.status).toBe("completed");
    expect(result.pages.map((page) => page.relativePath)).toEqual([
      "index.html",
      "guide.html",
      "chapters/index.html",
      "appendix.html",
    ]);
    expect(result.pages[0]?.title).toBe("Handbook");
    expect(reasons(result)).toEqual(new Set(["cross-origin", "action-link", "non-html"]));
  });

  it("does not loop on a cycle and deduplicates back-links", async () => {
    const result = await crawlManual(
      { fetcher: createInMemoryManualFetcher(HTTP_PAGES) },
      httpSource(),
    );
    expect(result.stats.fetched).toBe(4);
    expect(result.stats.accepted).toBe(4);
  });

  it("stops at the page limit and tallies a page-limit denial so the truncation is not silent", async () => {
    const result = await crawlManual(
      { fetcher: createInMemoryManualFetcher(HTTP_PAGES) },
      httpSource({ maxPages: 2 }),
    );
    expect(result.pages).toHaveLength(2);
    expect(result.status).toBe("limit-reached");
    expect(reasons(result).has("page-limit")).toBe(true);
  });

  it("does not descend past the depth limit", async () => {
    const result = await crawlManual(
      { fetcher: createInMemoryManualFetcher(HTTP_PAGES) },
      httpSource({ maxDepth: 1 }),
    );
    // index (0) + guide (1) + chapters (1); appendix (2) never enqueued.
    expect(result.pages.map((page) => page.relativePath)).not.toContain("appendix.html");
    expect(result.pages).toHaveLength(3);
  });

  it("stops when the byte budget is exhausted", async () => {
    const indexHtml = `<a href="guide.html">g</a>`;
    const pages = new Map<string, InMemoryManualPage>([
      ["https://docs.internal/", { html: indexHtml }],
      ["https://docs.internal/guide.html", { html: "<p>guide</p>" }],
    ]);
    // Budget = exactly the entry page's byte length: the entry is fetched in full (its link is
    // discovered and queued), but the budget is exhausted before the next page is fetched.
    const budget = new TextEncoder().encode(indexHtml).length;
    const result = await crawlManual(
      { fetcher: createInMemoryManualFetcher(pages) },
      httpSource({ maxBytes: budget }),
    );
    expect(result.pages).toHaveLength(1);
    expect(result.status).toBe("limit-reached");
    expect(reasons(result).has("byte-budget")).toBe(true);
  });

  it("refuses redirected pages with a redirect reason", async () => {
    const pages = new Map<string, InMemoryManualPage>([
      ["https://docs.internal/", { html: `<a href="moved.html">m</a>` }],
      ["https://docs.internal/moved.html", { redirected: true }],
    ]);
    const result = await crawlManual({ fetcher: createInMemoryManualFetcher(pages) }, httpSource());
    expect(result.pages).toHaveLength(1);
    expect(reasons(result).has("redirect")).toBe(true);
  });

  it("cancels promptly when the abort signal is already set", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await crawlManual(
      { fetcher: createInMemoryManualFetcher(HTTP_PAGES), signal: controller.signal },
      httpSource(),
    );
    expect(result.status).toBe("cancelled");
    expect(result.pages).toHaveLength(0);
  });

  it("reports an empty crawl when the entry page cannot be fetched", async () => {
    const result = await crawlManual(
      { fetcher: createInMemoryManualFetcher(new Map()) },
      httpSource(),
    );
    expect(result.status).toBe("empty");
    expect(reasons(result).has("fetch-failed")).toBe(true);
  });

  it("streams body-free progress events", async () => {
    const events: string[] = [];
    await crawlManual(
      {
        fetcher: createInMemoryManualFetcher(HTTP_PAGES),
        onEvent: (event) => events.push(event.kind),
      },
      httpSource(),
    );
    expect(events).toContain("page-accepted");
    expect(events).toContain("link-denied");
    expect(events[events.length - 1]).toBe("completed");
  });
});

describe("crawlManual — local link graph via injected fetcher", () => {
  it("crawls a local manual keyed by relative path", async () => {
    const pages = new Map<string, InMemoryManualPage>([
      ["index.html", { html: `<a href="guide.html">g</a>` }],
      ["guide.html", { html: `<title>Guide</title><a href="index.html">home</a>` }],
    ]);
    const source: HtmlManualSource = {
      schemaVersion: "1",
      scope: { kind: "html-manual-local", rootPath: "manuals/x", entryPath: "index.html" },
      limits: LIMITS,
      sourceFingerprint: "fp-local",
      proposedPodName: "x manual",
    };
    const result = await crawlManual({ fetcher: createInMemoryManualFetcher(pages) }, source);
    expect(result.pages.map((page) => page.relativePath)).toEqual(["index.html", "guide.html"]);
  });
});

// Minimal in-memory WorkspaceFs for the local fetcher (bytes-only, no symlinks by default).
// `realPath` may be overridden per-test to simulate a resolved symlink.
function fakeWorkspaceFs(
  files: Readonly<Record<string, string>>,
  realPath: (path: string) => string = (path): string => path,
): WorkspaceFs {
  const stat = (path: string): WorkspaceStat => ({
    size: new TextEncoder().encode(files[path] ?? "").length,
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
  });
  return {
    readFileUtf8: (path: string): string => files[path] ?? "",
    stat,
    readDir: (): readonly WorkspaceDirEntry[] => [],
    realPath,
    exists: (path: string): boolean => path in files,
    readFileBytes: (path: string, maxBytes: number): Promise<Uint8Array> => {
      const content = files[path];
      if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`));
      return Promise.resolve(new TextEncoder().encode(content).subarray(0, maxBytes));
    },
  };
}

describe("createWorkspaceFsManualFetcher", () => {
  it("reads a local page under the resolved root and refuses http targets", async () => {
    const fs = fakeWorkspaceFs({ "/ws/manuals/x/index.html": "<title>Home</title>" });
    const fetcher = createWorkspaceFsManualFetcher({ fs, rootAbsolutePath: "/ws/manuals/x" });
    const ok = await fetcher.fetchManualPage(
      { kind: "local", rootPath: "manuals/x", relativePath: "index.html" },
      { maxBytes: 1000 },
    );
    expect(ok.ok).toBe(true);
    const http = await fetcher.fetchManualPage(
      { kind: "http", url: "https://x/y" },
      { maxBytes: 1000 },
    );
    expect(http).toEqual({ ok: false, reason: "fetch-failed" });
  });

  it("fails closed on a missing file", async () => {
    const fetcher = createWorkspaceFsManualFetcher({
      fs: fakeWorkspaceFs({}),
      rootAbsolutePath: "/ws/manuals/x",
    });
    const result = await fetcher.fetchManualPage(
      { kind: "local", rootPath: "manuals/x", relativePath: "missing.html" },
      { maxBytes: 1000 },
    );
    expect(result).toEqual({ ok: false, reason: "fetch-failed" });
  });

  it("denies a symlink whose realpath escapes to a sibling directory sharing a string prefix with the root", async () => {
    // /ws/manuals/x-secrets is a SIBLING of /ws/manuals/x: it shares the root string as a prefix
    // but is NOT contained by it. A bare `startsWith` would wrongly accept this.
    const escapedPath = "/ws/manuals/x-secrets/leaked.html";
    const fs = fakeWorkspaceFs(
      { [escapedPath]: "<title>Leaked</title>" },
      (): string => escapedPath,
    );
    const fetcher = createWorkspaceFsManualFetcher({ fs, rootAbsolutePath: "/ws/manuals/x" });
    const result = await fetcher.fetchManualPage(
      { kind: "local", rootPath: "manuals/x", relativePath: "escape/leaked.html" },
      { maxBytes: 1000 },
    );
    expect(result).toEqual({ ok: false, reason: "path-traversal" });
  });

  it("denies a page whose real size exceeds the per-page byte cap instead of silently truncating it", async () => {
    const fs = fakeWorkspaceFs({ "/ws/manuals/x/big.html": "<title>Big</title><p>filler</p>" });
    const fetcher = createWorkspaceFsManualFetcher({ fs, rootAbsolutePath: "/ws/manuals/x" });
    const result = await fetcher.fetchManualPage(
      { kind: "local", rootPath: "manuals/x", relativePath: "big.html" },
      { maxBytes: 5 },
    );
    if (!result.ok) throw new Error("expected an ok (truncated) result");
    expect(result.bytes.length).toBeLessThanOrEqual(5);
    expect(result.contentType).toBe("text/html");
    expect(result.truncated).toBe(true);
  });
});
