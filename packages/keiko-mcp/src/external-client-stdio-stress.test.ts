import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ExternalMcpConnection,
  ManagedMcpInvocationContext,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { ManagedMcpError } from "./definitions.js";
import { connectExternalMcp } from "./external-client.js";

/**
 * Real stdio transport against a fixture-owned server process: the one path where the SDK's frame
 * buffer, not our result bound, decides whether the shared connection survives.
 */
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start(): Promise<ExternalMcpConnection> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-mcp-stress-")));
  const connection = await connectExternalMcp({
    signal: new AbortController().signal,
    correlationId: "stdio-stress",
    log: { write: (): void => undefined },
    transport: {
      kind: "local",
      command: [
        process.execPath,
        fileURLToPath(new URL("./__tests__/stress-server.fixture.ts", import.meta.url)),
      ],
      cwd: root,
      environment: {},
    },
  });
  cleanups.push(async () => {
    await connection.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });
  return connection;
}
function context(signal = new AbortController().signal): ManagedMcpInvocationContext {
  return {
    invocationId: "stress-invocation",
    correlationId: "stdio-stress",
    signal,
    beforeEffect: () => true,
  };
}
async function rejection(promise: Promise<unknown>): Promise<ManagedMcpError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ManagedMcpError);
  return error as ManagedMcpError;
}

describe.skipIf(process.platform === "win32")("stdio stress", () => {
  it.each([1_500_000, 10_000_000])(
    "refuses a %i byte result without closing the shared connection",
    async (bytes) => {
      const connection = await start();
      const error = await rejection(connection.call("big", { bytes }, context()));
      expect(error.reason).toBe("result-too-large");
      expect(connection.signal.aborted).toBe(false);
      // The next consumer of the same connection is unaffected.
      expect(await connection.call("small", {}, context())).toMatchObject({
        content: [{ text: "STRESS_SMALL_OK" }],
      });
    },
    30_000,
  );

  it("delivers a result just under the bound intact", async () => {
    const connection = await start();
    const result = await connection.call("big", { bytes: 900_000 }, context());
    expect(JSON.stringify(result)).toContain("x".repeat(1000));
    expect(connection.signal.aborted).toBe(false);
  }, 30_000);

  it("reports a server that dies mid-call as closed, possibly applied, and refuses the next call", async () => {
    const connection = await start();
    const error = await rejection(connection.call("crash", {}, context()));
    expect(error.reason).toBe("closed");
    expect(error.effect).toBe("possible");
    await expect.poll(() => connection.signal.aborted).toBe(true);
    const next = await rejection(connection.call("small", {}, context()));
    expect(next.effect).toBe("none");
  }, 30_000);

  it("cancels one stalled call on the caller's abort and keeps the connection for others", async () => {
    const connection = await start();
    const caller = new AbortController();
    const stalled = rejection(connection.call("stall", {}, context(caller.signal)));
    // The sibling call is served while the stalled one is still open.
    expect(await connection.call("small", {}, context())).toMatchObject({
      content: [{ text: "STRESS_SMALL_OK" }],
    });
    caller.abort();
    expect((await stalled).reason).toBe("aborted");
    expect(connection.signal.aborted).toBe(false);
    expect(await connection.call("small", {}, context())).toMatchObject({
      content: [{ text: "STRESS_SMALL_OK" }],
    });
  }, 30_000);
});
