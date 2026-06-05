import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const SW_PATH = resolve(here, "..", "public", "sw.js");
const SW_RAW: string = readFileSync(SW_PATH, "utf8");

// Strip JS comments so static regex checks scan actual code, not documentation. The
// sw.js header comment legitimately mentions `/api/`, `skipWaiting()`, and `clients.claim()`
// while explaining the forbidden patterns — without this strip the assertions would fire
// on the comment text and not on the real code. Doing this in-test (rather than asking the
// SW file to drop the explanation) keeps the documentation-in-source convention intact.
function stripComments(src: string): string {
  // Remove /* ... */ blocks (non-greedy) then // line comments. Strings in this file do
  // not contain `//` or `/*` sequences (the file is small and easy to keep that way).
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/[ \t]+\/\/.*$/gm, "");
}
const SW_SOURCE: string = stripComments(SW_RAW);

// ---------------------------------------------------------------------------
// 1) Static text analysis — protects the file against drift.
//    These tests are deliberately byte-level so a future commit that pastes
//    `/api/...` into the pre-cache list or removes the early-return is caught
//    by the test alone, even before the sandbox eval runs.
// ---------------------------------------------------------------------------

describe("sw.js cache policy — static source analysis (issue #126, ADR-0024 D6/D9)", () => {
  it("declares a versioned cache name matching keiko-shell-v<digit>", () => {
    const match = SW_SOURCE.match(/CACHE_NAME\s*=\s*"(keiko-shell-v\d+)"/);
    expect(match).not.toBeNull();
  });

  it("does NOT include any /api/ pathname in the pre-cache list", () => {
    // Scope the scan to PRECACHE_URLS — that's where a forbidden entry would land. The
    // bare `/api/` literal appears legitimately inside `isApiRequest` as the deny check;
    // forbidding it there would be wrong, so we anchor the assertion to the array body.
    const match = SW_SOURCE.match(/PRECACHE_URLS\s*=\s*\[([\s\S]*?)\]/);
    expect(match).not.toBeNull();
    const body = match === null ? "" : (match[1] ?? "");
    expect(body).not.toMatch(/\/api\b/);
  });

  it("treats /api/ as networkOnly via an early-return BEFORE any event.respondWith()", () => {
    // The early-return must appear before the first `event.respondWith(` in the file —
    // if a future change moved `respondWith` above the `isApiRequest` check, an /api/
    // request could be served from cache.
    const apiCheck = SW_SOURCE.search(/if\s*\(\s*isApiRequest\s*\(\s*url\s*\)\s*\)\s*return/);
    const firstRespondWith = SW_SOURCE.indexOf("event.respondWith");
    expect(apiCheck).toBeGreaterThan(-1);
    expect(firstRespondWith).toBeGreaterThan(-1);
    expect(apiCheck).toBeLessThan(firstRespondWith);
  });

  it("does not call skipWaiting() or clients.claim() (safe-default update strategy)", () => {
    expect(SW_SOURCE).not.toMatch(/skipWaiting\s*\(/);
    expect(SW_SOURCE).not.toMatch(/clients\.claim\s*\(/);
  });

  it("only caches responses with type === 'basic' (rejects opaque cross-origin)", () => {
    expect(SW_SOURCE).toMatch(/response\.type\s*===\s*"basic"/);
  });

  it("does not list /api/ in the cacheable-prefix allow-list", () => {
    // Extract the CACHEABLE_PREFIXES array body and assert /api/ is not present. The
    // regex tolerates whitespace and trailing comma variations.
    const match = SW_SOURCE.match(/CACHEABLE_PREFIXES\s*=\s*\[([\s\S]*?)\]/);
    expect(match).not.toBeNull();
    const body = match === null ? "" : (match[1] ?? "");
    expect(body).not.toMatch(/\/api\b/);
  });
});

// ---------------------------------------------------------------------------
// 2) Sandboxed evaluation — exercise the actual fetch handler logic.
//    We construct a minimal `self` / `caches` / `fetch` shim, evaluate sw.js
//    inside `vm`, and dispatch synthetic FetchEvents. This catches a class of
//    bugs the text scan cannot: e.g. an `if (isApiRequest(url)) return;` that
//    is followed by a stray `event.respondWith(fetch(request));`.
// ---------------------------------------------------------------------------

interface SwSandbox {
  readonly handlers: Map<string, (event: SyntheticEvent) => void>;
  readonly respondWithCalls: Array<Response | Promise<Response>>;
  readonly putCalls: Array<{ key: string; response: unknown }>;
  readonly fetchCalls: Array<string>;
}

interface SyntheticEvent {
  readonly type: string;
  readonly request: { readonly method: string; readonly url: string };
  respondWith(value: Response | Promise<Response>): void;
  waitUntil(value: Promise<unknown>): void;
}

function makeSandbox(): { context: vm.Context; sandbox: SwSandbox } {
  const handlers = new Map<string, (event: SyntheticEvent) => void>();
  const respondWithCalls: Array<Response | Promise<Response>> = [];
  const putCalls: Array<{ key: string; response: unknown }> = [];
  const fetchCalls: Array<string> = [];

  const cacheStub = {
    addAll: async (_urls: readonly string[]): Promise<void> => undefined,
    put: async (req: { url: string } | string, response: unknown): Promise<void> => {
      const key = typeof req === "string" ? req : req.url;
      putCalls.push({ key, response });
    },
    match: async (_req: unknown): Promise<undefined> => undefined,
  };

  const cachesShim = {
    open: async (_name: string): Promise<typeof cacheStub> => cacheStub,
    keys: async (): Promise<readonly string[]> => [],
    delete: async (_name: string): Promise<boolean> => true,
    match: async (_req: unknown): Promise<undefined> => undefined,
  };

  const selfShim = {
    addEventListener: (event: string, handler: (e: SyntheticEvent) => void): void => {
      handlers.set(event, handler);
    },
    location: { origin: "http://localhost:3000" },
  };

  const fetchShim = async (req: { url: string } | string): Promise<Response> => {
    const url = typeof req === "string" ? req : req.url;
    fetchCalls.push(url);
    // Return a `basic` shaped Response so the cacheable-response gate passes for the
    // happy-path assertion below.
    return {
      ok: true,
      status: 200,
      type: "basic",
      clone(): unknown {
        return this;
      },
    } as unknown as Response;
  };

  const context = vm.createContext({
    self: selfShim,
    caches: cachesShim,
    fetch: fetchShim,
    URL,
    Promise,
    console,
  });

  return {
    context,
    sandbox: { handlers, respondWithCalls, putCalls, fetchCalls },
  };
}

function makeEvent(type: string, url: string, sandbox: SwSandbox): SyntheticEvent {
  return {
    type,
    request: { method: "GET", url },
    respondWith(value: Response | Promise<Response>): void {
      sandbox.respondWithCalls.push(value);
    },
    waitUntil(_value: Promise<unknown>): void {
      // no-op in tests
    },
  };
}

describe("sw.js cache policy — sandboxed fetch-handler evaluation", () => {
  it("does NOT call event.respondWith for /api/* requests", () => {
    const { context, sandbox } = makeSandbox();
    vm.runInContext(SW_SOURCE, context);

    const fetchHandler = sandbox.handlers.get("fetch");
    expect(fetchHandler).toBeDefined();

    const event = makeEvent("fetch", "http://localhost:3000/api/runs/123", sandbox);
    fetchHandler?.(event);

    expect(sandbox.respondWithCalls).toHaveLength(0);
  });

  it("does NOT call event.respondWith for the /api root literal", () => {
    const { context, sandbox } = makeSandbox();
    vm.runInContext(SW_SOURCE, context);

    const fetchHandler = sandbox.handlers.get("fetch");
    const event = makeEvent("fetch", "http://localhost:3000/api", sandbox);
    fetchHandler?.(event);

    expect(sandbox.respondWithCalls).toHaveLength(0);
  });

  it("DOES call event.respondWith for /manifest.webmanifest (static asset)", () => {
    const { context, sandbox } = makeSandbox();
    vm.runInContext(SW_SOURCE, context);

    const fetchHandler = sandbox.handlers.get("fetch");
    const event = makeEvent("fetch", "http://localhost:3000/manifest.webmanifest", sandbox);
    fetchHandler?.(event);

    expect(sandbox.respondWithCalls).toHaveLength(1);
  });

  it("DOES call event.respondWith for /_next/static/*.js (static asset)", () => {
    const { context, sandbox } = makeSandbox();
    vm.runInContext(SW_SOURCE, context);

    const fetchHandler = sandbox.handlers.get("fetch");
    const event = makeEvent("fetch", "http://localhost:3000/_next/static/chunk.js", sandbox);
    fetchHandler?.(event);

    expect(sandbox.respondWithCalls).toHaveLength(1);
  });

  it("does NOT call event.respondWith for cross-origin requests (same-origin guard)", () => {
    const { context, sandbox } = makeSandbox();
    vm.runInContext(SW_SOURCE, context);

    const fetchHandler = sandbox.handlers.get("fetch");
    const event = makeEvent("fetch", "https://example.com/some.js", sandbox);
    fetchHandler?.(event);

    expect(sandbox.respondWithCalls).toHaveLength(0);
  });

  it("never writes to the cache for an /api/* request even via the runtime path", async () => {
    // Defence-in-depth: drive the handler through a full async cycle for an /api/* URL
    // and assert nothing ever lands in cache.put.
    const { context, sandbox } = makeSandbox();
    vm.runInContext(SW_SOURCE, context);

    const fetchHandler = sandbox.handlers.get("fetch");
    const event = makeEvent("fetch", "http://localhost:3000/api/runs/123", sandbox);
    fetchHandler?.(event);

    // Allow any queued microtasks to run.
    await Promise.resolve();
    await Promise.resolve();

    expect(sandbox.putCalls).toHaveLength(0);
  });
});
