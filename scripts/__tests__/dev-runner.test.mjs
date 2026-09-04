// Unit tests for the preflight helpers exported by scripts/dev-runner.mjs (Item #29).
//
// checkNextPortFree — TCP-level probe: resolves true when the port is available,
//                     false when something is already listening on it.
// readNextLockInfo  — Reads and validates the Next.js dev-server lock-file JSON.
//
// The tests spin up a real in-process TCP server so the port-in-use path is
// fully exercised without mocking. All servers are closed in afterEach.

import { createServer } from "node:net";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout } from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEV_RUNNER_SHUTDOWN_GRACE_MS,
  bffChildEnv,
  bffProcessArgs,
  canonicalLocalhostRedirectLocation,
  checkNextPortFree,
  copyHeadersSafely,
  findAvailableNextPort,
  forwardedUpstreamHeaders,
  normalizeUpstreamLocation,
  microphoneAllowanceAfterChildExit,
  packageBuildWatchArgs,
  preflightNextRespawn,
  proxyHttp,
  probeApiReadiness,
  publicBrowserUrl,
  readNextLockInfo,
  createRestartBudget,
  restartNextChildWithRetry,
  resolveConfiguredNextBundler,
  resolveNextBundler,
  upstreamAllowsSameOriginMicrophone,
  writeAtomicUtf8File,
  writeState,
} from "../dev-runner.mjs";

function readinessResponse(status, body, permissionsPolicy) {
  const values = permissionsPolicy === undefined ? {} : { "permissions-policy": permissionsPolicy };
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: { entries: () => Object.entries(values)[Symbol.iterator]() },
  };
}

describe("atomic state persistence", () => {
  let stateDirectory;

  beforeEach(() => {
    stateDirectory = mkdtempSync(join(tmpdir(), "dev-runner-state-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(stateDirectory, { recursive: true, force: true });
  });

  it("replaces an existing state file without exposing a partial document", () => {
    const stateFile = join(stateDirectory, "dev-ui.pid.json");
    const temporaryStateFile = `${stateFile}.${String(process.pid)}.tmp`;
    const nextState = `${JSON.stringify({ nextPort: 3001 })}\n`;
    const files = new Map([[stateFile, '{"nextPort":3000}\n']]);
    const operations = {
      writeFileSync: vi.fn((path, contents, encoding) => {
        expect(path).toBe(temporaryStateFile);
        expect(contents).toBe(nextState);
        expect(encoding).toBe("utf8");
        files.set(path, contents);
      }),
      renameSync: vi.fn((from, to) => {
        expect(from).toBe(temporaryStateFile);
        expect(to).toBe(stateFile);
        expect(files.get(stateFile)).toBe('{"nextPort":3000}\n');
        files.set(to, files.get(from));
        files.delete(from);
      }),
      rmSync: vi.fn(),
    };
    writeFileSync(stateFile, '{"nextPort":3000}\n', "utf8");

    writeAtomicUtf8File(stateFile, nextState, operations);

    expect(JSON.parse(String(files.get(stateFile)))).toEqual({ nextPort: 3001 });
    expect(files.has(temporaryStateFile)).toBe(false);
    expect(operations.rmSync).not.toHaveBeenCalled();
  });

  it("cleans up the temporary file and preserves the persistence error", () => {
    const stateFile = join(stateDirectory, "dev-ui.pid.json");
    const temporaryStateFile = `${stateFile}.${String(process.pid)}.tmp`;
    const failure = new Error("rename failed");
    const operations = {
      writeFileSync: vi.fn(),
      renameSync: vi.fn(() => {
        throw failure;
      }),
      rmSync: vi.fn(),
    };

    expect(() => writeAtomicUtf8File(stateFile, "{}\n", operations)).toThrow(failure);
    expect(operations.rmSync).toHaveBeenCalledWith(temporaryStateFile, { force: true });
  });

  it("preserves the persistence error when temporary-file cleanup also fails", () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stateFile = join(stateDirectory, "dev-ui.pid.json");
    const failure = new Error("rename failed");
    const operations = {
      writeFileSync: vi.fn(),
      renameSync: vi.fn(() => {
        throw failure;
      }),
      rmSync: vi.fn(() => {
        throw new Error("cleanup failed");
      }),
    };

    expect(() => writeAtomicUtf8File(stateFile, "{}\n", operations)).toThrow(failure);
    expect(reportError).toHaveBeenCalledWith(
      "[dev] failed to remove an incomplete state-file replacement.",
    );
  });

  it("uses atomic persistence for the runner's complete state document", () => {
    const stateFile = join(stateDirectory, "nested", "dev-ui.pid.json");

    writeState({ ready: false, starting: "waiting for API and UI" }, stateFile);

    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({
      runnerPid: process.pid,
      publicPort: 1983,
      bffPort: 1984,
      nextPort: 3000,
      stateDir: expect.any(String),
      nextBundler: "turbopack",
      appUrl: "http://localhost:1983",
      children: [],
      updatedAt: expect.any(String),
      ready: false,
      starting: "waiting for API and UI",
    });
    expect(existsSync(`${stateFile}.${String(process.pid)}.tmp`)).toBe(false);
  });
});

describe("proxyHttp request target validation", () => {
  it.each([
    "http://evil.example/path",
    "//evil.example/path",
    "/safe#fragment",
    "/safe\r\nX-Injected: yes",
    "/safe path",
    "/safe\\path",
    "/café",
    "*",
    "",
    undefined,
    null,
    42,
  ])("returns a bounded 400 before proxying invalid target %j", (target) => {
    const response = { end: vi.fn(), writeHead: vi.fn() };
    proxyHttp({ url: target }, response, 3000);
    expect(response.writeHead).toHaveBeenCalledWith(400, {
      "content-type": "text/plain; charset=utf-8",
    });
    expect(response.end).toHaveBeenCalledWith("Invalid development proxy request path.");
  });

  it("forwards a valid encoded origin-form target byte-for-byte", async () => {
    let receivedTarget;
    const upstream = createHttpServer((request, response) => {
      receivedTarget = request.url;
      response.end("proxied");
    });
    try {
      await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
      const address = upstream.address();
      if (address === null || typeof address === "string") throw new Error("Expected TCP address.");

      const request = new PassThrough();
      Object.assign(request, {
        headers: {},
        method: "GET",
        url: "/api/search?q=a%2Fb&limit=2",
      });
      const response = new PassThrough();
      response.writeHead = vi.fn();
      const completed = new Promise((resolve) => response.on("end", resolve));

      proxyHttp(request, response, address.port);
      request.end();
      response.resume();
      await completed;

      expect(receivedTarget).toBe("/api/search?q=a%2Fb&limit=2");
      expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    } finally {
      await new Promise((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("closes a streaming upstream when the downstream browser disconnects", async () => {
    let upstreamClosed;
    const upstreamClosedPromise = new Promise((resolve) => {
      upstreamClosed = resolve;
    });
    const upstream = createHttpServer((request, response) => {
      request.once("close", () => upstreamClosed(true));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: ready\ndata: {}\n\n");
    });
    const proxy = createHttpServer((request, response) => {
      const address = upstream.address();
      if (address === null || typeof address === "string") throw new Error("Expected TCP address.");
      proxyHttp(request, response, address.port);
    });
    try {
      await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
      await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
      const proxyAddress = proxy.address();
      if (proxyAddress === null || typeof proxyAddress === "string") {
        throw new Error("Expected TCP address.");
      }
      await new Promise((resolve, reject) => {
        const request = httpRequest(
          { hostname: "127.0.0.1", port: proxyAddress.port, path: "/api/events" },
          (response) => {
            response.once("data", () => {
              response.destroy();
              resolve();
            });
          },
        );
        request.once("error", reject);
        request.end();
      });
      const closed = await Promise.race([
        upstreamClosedPromise,
        new Promise((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      expect(closed).toBe(true);
    } finally {
      proxy.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => proxy.close(resolve)),
        new Promise((resolve) => upstream.close(resolve)),
      ]);
    }
  });
});

describe("bffProcessArgs", () => {
  it("keeps watch mode for interactive development", () => {
    expect(bffProcessArgs("/repo/scripts/dev-bff.mjs", true)).toEqual([
      "--watch",
      "--watch-preserve-output",
      "/repo/scripts/dev-bff.mjs",
    ]);
  });

  it("uses a stable one-shot process for hermetic tests", () => {
    expect(bffProcessArgs("/repo/scripts/dev-bff.mjs", false)).toEqual([
      "/repo/scripts/dev-bff.mjs",
    ]);
  });
});

describe("packageBuildWatchArgs", () => {
  it("uses the governed TypeScript 7 compiler for the package watcher", () => {
    expect(packageBuildWatchArgs()).toEqual([
      join(process.cwd(), "node_modules", "@typescript", "native", "bin", "tsc"),
      "-b",
      "tsconfig.packages.json",
      "--watch",
      "--preserveWatchOutput",
    ]);
  });
});

describe("resolveNextBundler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts auto mode with Turbopack and keeps explicit overrides", () => {
    expect(resolveNextBundler("auto")).toBe("turbopack");
    expect(resolveNextBundler("turbopack")).toBe("turbopack");
    expect(resolveNextBundler("webpack")).toBe("webpack");
  });

  it("rejects unsupported preferences", () => {
    expect(() => resolveNextBundler("wepback")).toThrow(TypeError);
    expect(() => resolveNextBundler("")).toThrow(TypeError);
  });

  it("reports invalid configured preferences and exits with status 2", () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    expect(() => resolveConfiguredNextBundler("wepback")).toThrow("exit");
    expect(reportError).toHaveBeenCalledWith(
      "Invalid KEIKO_DEV_NEXT_BUNDLER: wepback. Use auto, turbopack, or webpack.",
    );
    expect(exit).toHaveBeenCalledWith(2);
  });
});

describe("bffChildEnv", () => {
  // #2475: the dev lane mirrors the packaged CLI's KEIKO_UI_PORT export so coding-runtime
  // activation can compose its loopback gateway URL against the public proxy port.
  it("exports the public UI port alongside the BFF listen port and state dir", () => {
    expect(bffChildEnv(1984, 1983, "/state/dir")).toEqual({
      KEIKO_CODING_RUNTIME_DEV_LANE: "1",
      KEIKO_DEV_BFF_PORT: "1984",
      KEIKO_UI_PORT: "1983",
      KEIKO_STATE_DIR: "/state/dir",
    });
  });

  it("gives runtime disposal its complete bounded shutdown window", () => {
    expect(DEV_RUNNER_SHUTDOWN_GRACE_MS).toBeGreaterThan(30_000);
  });
});

describe("restart supervision", () => {
  it("resets a component restart budget only after a stable restarted child", () => {
    const scheduled = [];
    const budget = createRestartBudget(1, 60_000, (callback) => {
      scheduled.push(callback);
      return { unref: () => undefined };
    });

    expect(budget.recordExit("next")).toEqual({ allowed: true, count: 1 });
    expect(budget.recordExit("next")).toEqual({ allowed: false, count: 2 });

    budget.recordStableRestart("next");
    scheduled[0]();

    expect(budget.recordExit("next")).toEqual({ allowed: true, count: 1 });
  });

  it("retries an actual Next preflight failure instead of dropping the respawn loop", async () => {
    const retry = vi.fn();
    const start = vi.fn();
    const waitForReadiness = vi.fn();
    const reportError = vi.fn();

    const result = await restartNextChildWithRetry({
      currentPort: 3000,
      lockPath: "/tmp/next-lock",
      preflight: async () => Promise.reject(new Error("lock changed")),
      isShuttingDown: () => false,
      selectPort: vi.fn(),
      start,
      waitForReadiness,
      retry,
      reportError,
    });

    expect(result).toEqual({ retried: true, started: false });
    expect(retry).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error));
    expect(start).not.toHaveBeenCalled();
    expect(waitForReadiness).not.toHaveBeenCalled();
  });

  it("reports a readiness failure without leaving an unhandled restart promise", async () => {
    const readinessFailure = new Error("readiness unavailable");
    const reportError = vi.fn();
    const result = await restartNextChildWithRetry({
      currentPort: 3000,
      lockPath: "/tmp/next-lock",
      preflight: async () => ({ nextPort: 3000, reselected: false }),
      isShuttingDown: () => false,
      selectPort: vi.fn(),
      start: vi.fn(),
      waitForReadiness: async () => Promise.reject(readinessFailure),
      retry: vi.fn(),
      reportError,
    });

    expect(result).toEqual({ retried: false, started: true });
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(readinessFailure));
  });
});

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

describe("Next.js respawn preflight", () => {
  it("reselects a contended child port without probing the public proxy port", async () => {
    const checkPortFree = vi.fn(async (_host, port) => port === 3001);

    const result = await preflightNextRespawn(3000, "/tmp/next-lock", {
      checkPortFree,
      lockExists: async () => false,
      readLock: async () => undefined,
    });

    expect(result).toEqual({ nextPort: 3001, reselected: true });
    expect(checkPortFree).toHaveBeenCalledWith("127.0.0.1", 3000);
    expect(checkPortFree).toHaveBeenCalledWith("127.0.0.1", 3001);
    expect(checkPortFree).not.toHaveBeenCalledWith("127.0.0.1", 1983);
  });

  it("removes a stale Next.js lock before reusing the child port", async () => {
    const removeLock = vi.fn(async () => undefined);

    const result = await preflightNextRespawn(3000, "/tmp/next-lock", {
      checkPortFree: async () => true,
      lockExists: async () => true,
      processIsAlive: () => false,
      readLock: async () => ({ pid: 12345, port: 3000 }),
      removeLock,
    });

    expect(result).toEqual({ nextPort: 3000, reselected: false });
    expect(removeLock).toHaveBeenCalledWith("/tmp/next-lock");
  });

  it("refuses to remove a lock owned by a live Next.js process", async () => {
    const removeLock = vi.fn(async () => undefined);

    await expect(
      preflightNextRespawn(3000, "/tmp/next-lock", {
        checkPortFree: async () => true,
        lockExists: async () => true,
        processIsAlive: () => true,
        readLock: async () => ({ pid: 12345, port: 3000 }),
        removeLock,
      }),
    ).rejects.toThrow("Next.js lock is held by live process 12345");
    expect(removeLock).not.toHaveBeenCalled();
  });

  it("keeps a live lock owned by a different Next.js port", async () => {
    const removeLock = vi.fn(async () => undefined);

    const result = await preflightNextRespawn(3000, "/tmp/next-lock", {
      checkPortFree: async () => true,
      lockExists: async () => true,
      processIsAlive: () => true,
      readLock: async () => ({ pid: 12345, port: 3001 }),
      removeLock,
    });

    expect(result).toEqual({ nextPort: 3000, reselected: false });
    expect(removeLock).not.toHaveBeenCalled();
  });

  it("fails closed for an unreadable lock instead of deleting unknown ownership", async () => {
    const removeLock = vi.fn(async () => undefined);

    await expect(
      preflightNextRespawn(3000, "/tmp/next-lock", {
        checkPortFree: async () => true,
        lockExists: async () => true,
        readLock: async () => undefined,
        removeLock,
      }),
    ).rejects.toThrow("Next.js lock ownership could not be validated");
    expect(removeLock).not.toHaveBeenCalled();
  });

  it("refuses stale-lock removal when the validated lock has been replaced", async () => {
    const removeLock = vi.fn(async () => undefined);
    const readLock = vi
      .fn()
      .mockResolvedValueOnce({ pid: 12345, port: 3000 })
      .mockResolvedValueOnce({ pid: 67890, port: 3000 });

    await expect(
      preflightNextRespawn(3000, "/tmp/next-lock", {
        checkPortFree: async () => true,
        lockExists: async () => true,
        processIsAlive: () => false,
        readLock,
        removeLock,
      }),
    ).rejects.toThrow("Next.js lock changed before stale-lock removal");
    expect(removeLock).not.toHaveBeenCalled();
  });

  it("treats PID zero as stale without signalling the process group", async () => {
    const removeLock = vi.fn(async () => undefined);

    await preflightNextRespawn(3000, "/tmp/next-lock", {
      checkPortFree: async () => true,
      lockExists: async () => true,
      readLock: async () => ({ pid: 0, port: 3000 }),
      removeLock,
    });

    expect(removeLock).toHaveBeenCalledWith("/tmp/next-lock");
  });

  it("fails closed after one hundred unavailable child-port candidates", async () => {
    await expect(findAvailableNextPort(3000, async () => false)).rejects.toThrow(
      "No free Next.js port found at or above 3000",
    );
  });

  it("does not probe invalid TCP ports", async () => {
    const checkPortFree = vi.fn(async () => true);

    await expect(findAvailableNextPort(65_536, checkPortFree)).rejects.toThrow(
      "Invalid Next.js port: 65536",
    );
    expect(checkPortFree).not.toHaveBeenCalled();
  });

  it("probes the valid upper TCP boundary once", async () => {
    const checkPortFree = vi.fn(async () => true);

    await expect(findAvailableNextPort(65_535, checkPortFree)).resolves.toBe(65_535);
    expect(checkPortFree).toHaveBeenCalledTimes(1);
    expect(checkPortFree).toHaveBeenCalledWith("127.0.0.1", 65_535);
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

  it.each([
    { pid: 0, port: 3000 },
    { pid: 12345, port: 0 },
    { pid: 12345, port: 65_536 },
  ])("returns undefined for invalid lock ownership %j", async (content) => {
    const lockPath = join(tmpDir, "lock");
    writeFileSync(lockPath, JSON.stringify(content), "utf8");

    await expect(readNextLockInfo(lockPath)).resolves.toBeUndefined();
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

  // KEIKO-0607: pre-fix, `npm run dev:start` served the entire app shell with zero CSP or
  // security headers on Next.js-routed responses. Now every proxied response carries the same
  // baseline the production BFF applies, with a documented narrow relaxation for the two CSP
  // directives Next.js Fast Refresh/HMR requires. The pins below prove the invariant on the
  // path that used to be bare (the /dashboard route routed to NEXT_PORT).
  it("applies the dev security header baseline on every proxied response (KEIKO-0607)", () => {
    const out = forwardedUpstreamHeaders(
      { "content-type": "text/html", location: "/dashboard" },
      NEXT_PORT,
    );
    expect(out["content-security-policy"]).toMatch(/default-src 'self'/);
    expect(out["x-content-type-options"]).toBe("nosniff");
    expect(out["x-frame-options"]).toBe("DENY");
    expect(out["referrer-policy"]).toBe("no-referrer");
    expect(out["cross-origin-opener-policy"]).toBe("same-origin");
    expect(out["cross-origin-resource-policy"]).toBe("same-origin");
    expect(out["permissions-policy"]).toMatch(/microphone=\(\)/);
  });

  it("allows same-origin microphone capture when the BFF advertises voice capability", () => {
    const out = forwardedUpstreamHeaders({ "content-type": "text/html" }, NEXT_PORT, {
      allowMicrophone: true,
    });
    expect(out["permissions-policy"]).toBe(
      "camera=(), geolocation=(), microphone=(self), payment=(), usb=()",
    );
    expect(out["permissions-policy"]).not.toContain("microphone=*");
  });

  it.each([undefined, null, "", "microphone=*", "microphone=(*)", "microphone=(self)junk"])(
    "rejects an invalid microphone policy value (%j)",
    (value) => {
      const headers = value === undefined ? {} : { "permissions-policy": value };
      expect(upstreamAllowsSameOriginMicrophone(headers)).toBe(false);
    },
  );

  it("clears a prior allowance on BFF exit without coupling it to unrelated child exits", () => {
    expect(microphoneAllowanceAfterChildExit("bff", true)).toBe(false);
    expect(microphoneAllowanceAfterChildExit("next", true)).toBe(true);
  });

  it("keeps microphone capability disabled after failed health probes", async () => {
    const unavailable = await probeApiReadiness("http://127.0.0.1/api/health", () =>
      Promise.resolve(readinessResponse(503, "unavailable", "microphone=(self)")),
    );
    const rejected = await probeApiReadiness("http://127.0.0.1/api/health", () =>
      Promise.reject(new Error("connection refused")),
    );

    expect(unavailable).toEqual({
      result: "HTTP 503",
      allowSameOriginMicrophone: false,
    });
    expect(rejected).toEqual({
      result: "connection refused",
      allowSameOriginMicrophone: false,
    });
  });

  it.each(["", "microphone=*", "microphone=(*)", "microphone=(self)junk"])(
    "keeps a healthy response fail-closed for policy %j",
    async (policy) => {
      const result = await probeApiReadiness("http://127.0.0.1/api/health", () =>
        Promise.resolve(readinessResponse(200, { status: "ok" }, policy)),
      );

      expect(result).toEqual({ result: "ok", allowSameOriginMicrophone: false });
    },
  );

  it("keeps HMR-only CSP relaxations scoped to script-src/style-src/connect-src (KEIKO-0607)", () => {
    const out = forwardedUpstreamHeaders({ "content-type": "text/html" }, NEXT_PORT);
    const csp = out["content-security-policy"];
    // The dev CSP allows unsafe-eval/unsafe-inline in script-src (Fast Refresh) and inline styles
    // in style-src, plus ws:/wss: in connect-src for the HMR socket — nothing else is relaxed.
    expect(csp).toMatch(/script-src [^;]*'unsafe-eval'/);
    expect(csp).toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(csp).toMatch(/style-src [^;]*'unsafe-inline'/);
    expect(csp).toMatch(/connect-src [^;]*ws:/);
    expect(csp).toMatch(/connect-src [^;]*wss:/);
    // Production directives that must NOT be relaxed:
    expect(csp).toMatch(/object-src 'none'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/base-uri 'self'/);
    expect(csp).toMatch(/form-action 'self'/);
  });

  it("overrides an upstream-supplied CSP so the last edge to the browser owns the policy (KEIKO-0607)", () => {
    const out = forwardedUpstreamHeaders(
      { "content-security-policy": "default-src *; script-src *" },
      NEXT_PORT,
    );
    expect(out["content-security-policy"]).toMatch(/default-src 'self'/);
    // The dev baseline's script-src has 'unsafe-eval'; a permissive upstream `script-src *`
    // must not survive.
    expect(out["content-security-policy"]).not.toMatch(/script-src \*/);
  });
});
