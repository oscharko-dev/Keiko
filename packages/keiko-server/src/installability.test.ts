// ADR-0024 D10 — cross-platform installability gates (issue #127). Each describe block
// exercises ONE installability criterion over a live in-process server that serves real PWA
// assets from packages/keiko-ui/public. No new runtime dependencies: vitest + node:http +
// globalThis.fetch only. The test boots on an ephemeral port and tears down after each suite.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCspHeader } from "./csp.js";
import { buildRedactor, createInMemoryUiStore } from "./index.js";
import { createRunRegistry } from "./runs.js";
import { createUiServer, UI_HOST } from "./server.js";

// The real keiko-ui public directory — contains manifest, icons, and sw.js produced by the
// prior children (#123/#125/#126). Using the real assets is load-bearing: this test must
// exercise the actual on-wire content, not a stub.
const here = dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = resolve(here, "../../../packages/keiko-ui/public");

// ─── Server lifecycle ──────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

async function listen(s: Server, port: number): Promise<void> {
  await new Promise<void>((resolve) => s.listen(port, UI_HOST, resolve));
}

async function closeServer(s: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    s.close(() => {
      resolve();
    });
  });
}

beforeAll(async () => {
  const store = createInMemoryUiStore();
  const handlerDeps = {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: (): string => "",
      list: (): readonly string[] => [],
      get: (): undefined => undefined,
      delete: (): undefined => undefined,
    },
    env: process.env,
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    store,
  };

  // Two-step ephemeral-port allocation (matches browser-routes.test.ts pattern).
  const probe = createUiServer({
    staticRoot: STATIC_ROOT,
    csp: buildCspHeader([]),
    port: 0,
    handlerDeps,
  });
  await listen(probe, 0);
  const port = (probe.address() as AddressInfo).port;
  await closeServer(probe);

  server = createUiServer({
    staticRoot: STATIC_ROOT,
    csp: buildCspHeader([]),
    port,
    handlerDeps,
  });
  await listen(server, port);
  baseUrl = `http://${UI_HOST}:${String(port)}`;
});

afterAll(async () => {
  await closeServer(server);
});

function url(path: string): string {
  return `${baseUrl}${path}`;
}

// ─── Gate 1: manifest reachable + correct Content-Type + D4 field contract ────

describe("Gate 1 — manifest reachable and conformant (ADR-0024 D4)", () => {
  it("GET /manifest.webmanifest returns 200", async () => {
    const res = await fetch(url("/manifest.webmanifest"));
    expect(res.status).toBe(200);
  });

  it("Content-Type includes application/manifest+json", async () => {
    const res = await fetch(url("/manifest.webmanifest"));
    expect(res.headers.get("content-type")).toContain("application/manifest+json");
  });

  it.each([
    ["name", "Keiko"],
    ["short_name", "Keiko"],
    ["start_url", "/"],
    ["scope", "/"],
    ["display", "standalone"],
    ["theme_color", "#4EBA87"],
    ["background_color", "#1B1E23"],
    ["lang", "en"],
    ["dir", "ltr"],
  ] as const)("manifest field %s is the exact D4 value %s", async (field, expected) => {
    const res = await fetch(url("/manifest.webmanifest"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body[field]).toBe(expected);
  });

  // uiux-fix F038 C376: "business" leads — the install surface follows the official
  // knowledge-work positioning (README), not the historical developer-tools framing.
  it("categories is exactly ['business', 'productivity', 'developer-tools']", async () => {
    const res = await fetch(url("/manifest.webmanifest"));
    const body = (await res.json()) as { categories: unknown };
    expect(body.categories).toEqual(["business", "productivity", "developer-tools"]);
  });

  it("icons array contains exactly four entries (192/512 standard + 192/512 maskable)", async () => {
    const res = await fetch(url("/manifest.webmanifest"));
    const body = (await res.json()) as { icons: unknown[] };
    expect(body.icons).toHaveLength(4);
  });
});

// ─── Gate 2: service worker reachable + Content-Type + cache constant ─────────

describe("Gate 2 — service worker reachable and conformant (ADR-0024 D6)", () => {
  it("GET /sw.js returns 200", async () => {
    const res = await fetch(url("/sw.js"));
    expect(res.status).toBe(200);
  });

  it("Content-Type is text/javascript", async () => {
    const res = await fetch(url("/sw.js"));
    const ct = res.headers.get("content-type") ?? "";
    expect(ct.includes("text/javascript") || ct.includes("application/javascript")).toBe(true);
  });

  it("body declares a versioned cache name (keiko-shell-v<n>)", async () => {
    const res = await fetch(url("/sw.js"));
    const body = await res.text();
    // Version-agnostic: the cache name is bumped whenever the cache policy changes (e.g. v1 -> v2
    // for the network-first shell strategy), so pin the SHAPE, not a specific number — matching the
    // sw-cache-policy.test.ts convention so a deliberate bump never breaks this gate.
    expect(body).toMatch(/CACHE_NAME\s*=\s*"keiko-shell-v\d+"/);
  });
});

// ─── Gate 3: CSP header on / includes worker-src + manifest-src ──────────────

describe("Gate 3 — CSP wire headers include worker-src and manifest-src (ADR-0024 D6 / csp.ts)", () => {
  it("GET / returns a Content-Security-Policy header", async () => {
    const res = await fetch(url("/"));
    expect(res.headers.get("content-security-policy")).not.toBeNull();
  });

  it("CSP contains worker-src 'self'", async () => {
    const res = await fetch(url("/"));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("worker-src 'self'");
  });

  it("CSP contains manifest-src 'self'", async () => {
    const res = await fetch(url("/"));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("manifest-src 'self'");
  });
});

// ─── Gate 4: all seven icon assets are reachable with correct Content-Type ────

const ICON_ASSETS: readonly { path: string; expectedContentType: string }[] = [
  { path: "/icon-192.png", expectedContentType: "image/png" },
  { path: "/icon-512.png", expectedContentType: "image/png" },
  { path: "/icon-192-maskable.png", expectedContentType: "image/png" },
  { path: "/icon-512-maskable.png", expectedContentType: "image/png" },
  { path: "/apple-touch-icon.png", expectedContentType: "image/png" },
  { path: "/favicon.svg", expectedContentType: "image/svg+xml" },
  { path: "/favicon.ico", expectedContentType: "image/x-icon" },
];

describe("Gate 4 — all seven icon assets reachable with correct Content-Type (ADR-0024 D5)", () => {
  it.each(ICON_ASSETS)("GET $path returns 200", async ({ path }) => {
    const res = await fetch(url(path));
    expect(res.status).toBe(200);
  });

  it.each(ICON_ASSETS)(
    "GET $path Content-Type includes $expectedContentType",
    async ({ path, expectedContentType }) => {
      const res = await fetch(url(path));
      expect(res.headers.get("content-type")).toContain(expectedContentType);
    },
  );

  it.each(ICON_ASSETS)("GET $path response body is non-empty", async ({ path }) => {
    const res = await fetch(url(path));
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(0);
  });
});

// ─── Gate 5: /api/* responses are not cache-eligible ─────────────────────────

describe("Gate 5 — /api/* responses carry Cache-Control: no-store (headers.ts D5)", () => {
  it("GET /api/health is reachable (status 200)", async () => {
    const res = await fetch(url("/api/health"));
    expect(res.status).toBe(200);
  });

  it("GET /api/health Cache-Control header does not contain 'public'", async () => {
    const res = await fetch(url("/api/health"));
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc.toLowerCase()).not.toContain("public");
  });

  it("GET /api/health Cache-Control is no-store (applySecurityHeaders, headers.ts)", async () => {
    const res = await fetch(url("/api/health"));
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc.toLowerCase()).toContain("no-store");
  });
});

// ─── Gate 6: static assets are cacheable (no no-store on manifest) ────────────

describe("Gate 6 — static assets have no Cache-Control: no-store (SW can populate cache)", () => {
  it("GET /manifest.webmanifest does NOT set Cache-Control: no-store", async () => {
    const res = await fetch(url("/manifest.webmanifest"));
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc.toLowerCase()).not.toContain("no-store");
  });

  it("GET /sw.js does NOT set Cache-Control: no-store", async () => {
    const res = await fetch(url("/sw.js"));
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc.toLowerCase()).not.toContain("no-store");
  });

  it("GET /icon-192.png does NOT set Cache-Control: no-store", async () => {
    const res = await fetch(url("/icon-192.png"));
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc.toLowerCase()).not.toContain("no-store");
  });
});
