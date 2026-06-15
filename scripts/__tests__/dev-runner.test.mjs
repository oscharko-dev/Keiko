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

import { checkNextPortFree, readNextLockInfo } from "../dev-runner.mjs";

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
