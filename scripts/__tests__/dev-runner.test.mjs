// Unit tests for the preflight helpers exported by scripts/dev-runner.mjs (Item #29).
//
// checkNextPortFree — TCP-level probe: resolves true when the port is available,
//                     false when something is already listening on it.
// readNextLockInfo  — Reads and validates the Next.js dev-server lock-file JSON.
//
// The tests spin up a real in-process TCP server so the port-in-use path is
// fully exercised without mocking. All servers are closed in afterEach.

import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalLocalhostRedirectLocation,
  checkNextPortFree,
  copyHeadersSafely,
  forwardedUpstreamHeaders,
  normalizeUpstreamLocation,
  publicBrowserUrl,
  readNextLockInfo,
} from "../dev-runner.mjs";

// ---------------------------------------------------------------------------
// checkNextPortFree
// ---------------------------------------------------------------------------

describe("checkNextPortFree — port is free", () => {
  it("resolves true when nothing is listening on the port", async () => {
    // Port 0 causes the OS to assign an ephemeral port; we then immediately close
    // the server so the port is free by the time checkNextPortFree runs.
    const tempServer = createServer();
    await new Promise((resolve) => tempServer.listen(0, "127.0.0.1", resolve));
    const { port } = tempServer.address();
    await new Promise((resolve) => tempServer.close(resolve));

    const free = await checkNextPortFree("127.0.0.1", port, 500);
    expect(free).toBe(true);
  });
});

describe("checkNextPortFree — port is in use", () => {
  let server;
  let assignedPort;

  beforeEach(async () => {
    server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    assignedPort = server.address().port;
  });

  afterEach(async () => {
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("resolves false when a server is already listening on the port", async () => {
    const free = await checkNextPortFree("127.0.0.1", assignedPort, 500);
    expect(free).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readNextLockInfo
// ---------------------------------------------------------------------------

describe("readNextLockInfo", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dev-runner-lock-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when the lock file does not exist", async () => {
    const result = await readNextLockInfo(join(tmpDir, "nonexistent", "lock"));
    expect(result).toBeUndefined();
  });

  it("returns undefined when the lock file contains invalid JSON", async () => {
    const lockPath = join(tmpDir, "lock");
    writeFileSync(lockPath, "not-json", "utf8");
    const result = await readNextLockInfo(lockPath);
    expect(result).toBeUndefined();
  });

  it("returns undefined when the lock file JSON is missing required numeric fields", async () => {
    const lockPath = join(tmpDir, "lock");
    writeFileSync(lockPath, JSON.stringify({ appUrl: "http://localhost:3000" }), "utf8");
    const result = await readNextLockInfo(lockPath);
    expect(result).toBeUndefined();
  });

  it("returns undefined when pid is present but not a number", async () => {
    const lockPath = join(tmpDir, "lock");
    writeFileSync(lockPath, JSON.stringify({ pid: "12345", port: 3000 }), "utf8");
    const result = await readNextLockInfo(lockPath);
    expect(result).toBeUndefined();
  });

  it("returns the parsed object when the lock file contains valid Next.js dev-server JSON", async () => {
    const lockPath = join(tmpDir, "lock");
    const content = { pid: 12345, port: 3000, appUrl: "http://localhost:3000" };
    writeFileSync(lockPath, JSON.stringify(content), "utf8");
    const result = await readNextLockInfo(lockPath);
    expect(result).toEqual({ pid: 12345, port: 3000, appUrl: "http://localhost:3000" });
  });

  it("returns the parsed object when appUrl is absent (only pid+port are required)", async () => {
    const lockPath = join(tmpDir, "lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 9999, port: 3001 }), "utf8");
    const result = await readNextLockInfo(lockPath);
    expect(result).toMatchObject({ pid: 9999, port: 3001 });
  });

  it("returns undefined when the lock file contains a non-object JSON value", async () => {
    const lockPath = join(tmpDir, "lock");
    writeFileSync(lockPath, "42", "utf8");
    const result = await readNextLockInfo(lockPath);
    expect(result).toBeUndefined();
  });
});

describe("canonical localhost browser URL", () => {
  function req({ url = "/", method = "GET", host = "127.0.0.1:1983", accept = "text/html" } = {}) {
    return {
      method,
      url,
      headers: {
        host,
        accept,
      },
    };
  }

  it("uses localhost for the public browser URL", () => {
    expect(publicBrowserUrl(1983)).toBe("http://localhost:1983");
  });

  it("redirects 127.0.0.1 document navigations to localhost", () => {
    expect(canonicalLocalhostRedirectLocation(req(), 1983)).toBe("http://localhost:1983/");
    expect(canonicalLocalhostRedirectLocation(req({ url: "/workspace?chat=1" }), 1983)).toBe(
      "http://localhost:1983/workspace?chat=1",
    );
  });

  it("does not redirect requests that are already on localhost", () => {
    expect(
      canonicalLocalhostRedirectLocation(req({ host: "localhost:1983" }), 1983),
    ).toBeUndefined();
  });

  it("does not redirect API calls or static asset requests", () => {
    expect(canonicalLocalhostRedirectLocation(req({ url: "/api/health" }), 1983)).toBeUndefined();
    expect(
      canonicalLocalhostRedirectLocation(req({ url: "/_next/static/chunk.js" }), 1983),
    ).toBeUndefined();
    expect(
      canonicalLocalhostRedirectLocation(req({ url: "/assets/keiko-logo.svg" }), 1983),
    ).toBeUndefined();
  });

  it("does not redirect state-changing requests", () => {
    expect(canonicalLocalhostRedirectLocation(req({ method: "POST" }), 1983)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normalizeUpstreamLocation — proxy `Location` header rewriting
//
// The proxy MUST rebase same-origin upstream redirects onto the PUBLIC proxy
// origin (e.g. http://localhost:1983) instead of the internal upstream port,
// otherwise the browser leaves the proxy and can no longer route /api/* to the
// BFF (regression previously caught in review of #2341).
// ---------------------------------------------------------------------------

describe("normalizeUpstreamLocation", () => {
  const NEXT_PORT = 3000;
  const PUBLIC_PORT = 1983;
  const PUBLIC_ORIGIN = "http://localhost:1983";

  it("rebases a relative same-origin redirect onto the public proxy origin", () => {
    expect(normalizeUpstreamLocation("/dashboard", NEXT_PORT, PUBLIC_PORT)).toBe(
      `${PUBLIC_ORIGIN}/dashboard`,
    );
  });

  it("preserves the query string and hash when rebasing a same-origin redirect", () => {
    expect(normalizeUpstreamLocation("/workspace?tab=chat#panel", NEXT_PORT, PUBLIC_PORT)).toBe(
      `${PUBLIC_ORIGIN}/workspace?tab=chat#panel`,
    );
  });

  it("rebases an absolute same-origin redirect onto the public proxy origin", () => {
    expect(
      normalizeUpstreamLocation("http://127.0.0.1:3000/api/foo?x=1", NEXT_PORT, PUBLIC_PORT),
    ).toBe(`${PUBLIC_ORIGIN}/api/foo?x=1`);
  });

  it("drops cross-origin locations (defense against open-redirect via upstream)", () => {
    expect(
      normalizeUpstreamLocation("http://evil.com/path", NEXT_PORT, PUBLIC_PORT),
    ).toBeUndefined();
    expect(normalizeUpstreamLocation("//evil.com/path", NEXT_PORT, PUBLIC_PORT)).toBeUndefined();
  });

  it("drops locations pointing at a different upstream port", () => {
    expect(
      normalizeUpstreamLocation("http://127.0.0.1:9999/foo", NEXT_PORT, PUBLIC_PORT),
    ).toBeUndefined();
  });

  it("drops malformed and non-string location values", () => {
    expect(
      normalizeUpstreamLocation("javascript:alert(1)", NEXT_PORT, PUBLIC_PORT),
    ).toBeUndefined();
    expect(normalizeUpstreamLocation("not a url", NEXT_PORT, PUBLIC_PORT)).toBe(
      // "not a url" is a valid relative reference; the resolved URL still lives on the upstream
      // host, so it must rebase onto the public origin as any other same-origin path would.
      `${PUBLIC_ORIGIN}/not%20a%20url`,
    );
    expect(normalizeUpstreamLocation(undefined, NEXT_PORT, PUBLIC_PORT)).toBeUndefined();
    expect(normalizeUpstreamLocation(null, NEXT_PORT, PUBLIC_PORT)).toBeUndefined();
    expect(normalizeUpstreamLocation(42, NEXT_PORT, PUBLIC_PORT)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// copyHeadersSafely — prototype-pollution defence for header spreads
// ---------------------------------------------------------------------------

describe("copyHeadersSafely", () => {
  it("returns a prototype-less object that mirrors own-enumerable string keys", () => {
    const copy = copyHeadersSafely({ "content-type": "application/json", accept: "*/*" });
    expect(Object.getPrototypeOf(copy)).toBeNull();
    expect(copy["content-type"]).toBe("application/json");
    expect(copy.accept).toBe("*/*");
  });

  it("drops prototype-pollution header names regardless of casing", () => {
    const copy = copyHeadersSafely({
      __proto__: "polluted",
      constructor: "polluted",
      prototype: "polluted",
      Prototype: "polluted",
      accept: "text/html",
    });
    expect(copy.accept).toBe("text/html");
    expect(copy.__proto__).toBeUndefined();
    expect(copy.constructor).toBeUndefined();
    expect(copy.prototype).toBeUndefined();
    expect(copy.Prototype).toBeUndefined();
  });

  it("returns an empty prototype-less object for null / non-object inputs", () => {
    expect(Object.getPrototypeOf(copyHeadersSafely(null))).toBeNull();
    expect(Object.getPrototypeOf(copyHeadersSafely(undefined))).toBeNull();
    expect(Object.getPrototypeOf(copyHeadersSafely(42))).toBeNull();
    expect(Object.keys(copyHeadersSafely({}))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// forwardedUpstreamHeaders — rebase or drop the upstream `Location` on the way
// back to the client so the browser stays inside the proxy origin.
// ---------------------------------------------------------------------------

describe("forwardedUpstreamHeaders", () => {
  const NEXT_PORT = 3000;

  it("rebases a same-origin location back to the public proxy origin", () => {
    const out = forwardedUpstreamHeaders(
      { "content-type": "text/html", location: "/dashboard" },
      NEXT_PORT,
    );
    expect(out["content-type"]).toBe("text/html");
    expect(out.location).toBe("http://localhost:1983/dashboard");
  });

  it("drops a cross-origin location entirely (fail-closed)", () => {
    const out = forwardedUpstreamHeaders({ location: "http://evil.com/steal" }, NEXT_PORT);
    expect(out.location).toBeUndefined();
    expect("location" in out).toBe(false);
  });

  it("passes non-location headers through untouched", () => {
    const out = forwardedUpstreamHeaders(
      { "content-type": "application/json", "cache-control": "no-store" },
      NEXT_PORT,
    );
    expect(out["content-type"]).toBe("application/json");
    expect(out["cache-control"]).toBe("no-store");
  });

  it("drops __proto__/constructor/prototype header keys from the upstream response too", () => {
    const out = forwardedUpstreamHeaders(
      { __proto__: "polluted", constructor: "polluted", "x-safe": "ok" },
      NEXT_PORT,
    );
    expect(out["x-safe"]).toBe("ok");
    expect(out.__proto__).toBeUndefined();
    expect(out.constructor).toBeUndefined();
  });
});
