import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import type { ServerLogEvent } from "../observability/server-log.js";
import { formatServerLogLine } from "../observability/server-log.js";
import {
  createCodingRepositorySearchHandler,
  type CodingRepositorySearchHandlerOptions,
} from "./codingRepositorySearchHandler.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(
  isCurrent: () => boolean = () => true,
  options: Partial<Omit<CodingRepositorySearchHandlerOptions, "workspace" | "isCurrent">> = {},
): {
  readonly root: string;
  readonly events: ServerLogEvent[];
  readonly handler: ReturnType<typeof createCodingRepositorySearchHandler>;
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-h1-handler-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "src", "example.ts"),
    'const token = "private-credential-value";\nexport const parseConfig = true;\n',
  );
  const workspace: WorkspaceInfo = {
    root,
    selectedRoot: root,
    name: "handler",
    version: "1",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: [],
    languages: ["typescript"],
    ignoreLines: [],
  };
  const events: ServerLogEvent[] = [];
  return {
    root,
    events,
    handler: createCodingRepositorySearchHandler({
      ...options,
      workspace,
      isCurrent,
      log: options.log ?? {
        write: (event): void => {
          events.push(event);
        },
      },
    }),
  };
}

function context(): { correlationId: string; signal: AbortSignal } {
  return { correlationId: "h1-handler-invocation", signal: new AbortController().signal };
}

function terminalLine(events: readonly ServerLogEvent[]): string {
  const event = events[1];
  if (event === undefined) throw new Error("terminal event missing");
  return formatServerLogLine(event);
}

const request = {
  kind: "search",
  mode: "literal",
  query: "parseConfig",
  caseSensitive: false,
  includeGlobs: [],
  excludeGlobs: [],
  maxResults: 50,
};

describe("production coding repository handler composition", () => {
  it("uses the real workspace producer and records a reconstructable body-free operation", async () => {
    const { root, handler, events } = fixture();
    expect(handler.readiness()).toBe("ready");
    const result = await handler.invoke(request, context());
    expect(result.ok && result.kind === "search" && result.hits[0]).toMatchObject({
      path: "src/example.ts",
      startLine: 2,
      snippet: "export const parseConfig = true;",
    });
    expect(events.map((event) => event.op)).toEqual([
      "coding-repository-handler.started",
      "coding-repository-handler.settled",
    ]);
    expect(events[1]).toMatchObject({
      correlationId: context().correlationId,
      extra: {
        state: "completed",
        filesScanned: 1,
        resultCount: 1,
        resultPathSha256: [createHash("sha256").update("src/example.ts").digest("hex")],
      },
    });
    const lines = events.map((event) => formatServerLogLine(event)).join("\n");
    expect(JSON.parse(terminalLine(events))).toMatchObject({
      correlationId: context().correlationId,
      state: "completed",
      filesScanned: 1,
      resultCount: 1,
      outputBytes: expect.any(Number) as unknown,
    });
    for (const body of [root, "example.ts", "parseConfig", "private-credential-value"])
      expect(lines).not.toContain(body);
  });
  it("fails closed before work when the bound authority is unavailable", async () => {
    const { handler, events } = fixture(() => false);
    expect(handler.readiness()).toBe("unavailable");
    expect(await handler.invoke(request, context())).toEqual({
      ok: false,
      reason: "authority-stale",
    });
    expect(events[1]).toMatchObject({
      correlationId: context().correlationId,
      errorKind: "CodingRepositorySearchError",
      extra: {
        reason: "authority-stale",
        frames: expect.any(Array) as unknown,
        causeChain: expect.any(Array) as unknown,
      },
    });
  });
  it("withholds results when authority is revoked during the handler call", async () => {
    let checks = 0;
    const { handler, events } = fixture(() => {
      checks += 1;
      return checks === 1;
    });
    expect(await handler.invoke(request, context())).toEqual({
      ok: false,
      reason: "authority-stale",
    });
    expect(events.filter((event) => event.op.endsWith("settled"))).toHaveLength(1);
  });
  it.each([".env", "src/link.ts", "src/hard.ts"])(
    "rejects protected or aliased ranged reads: %s",
    async (path) => {
      const { root, handler } = fixture();
      const outside = mkdtempSync(join(tmpdir(), "keiko-h1-outside-"));
      roots.push(outside);
      writeFileSync(join(outside, "private.ts"), "private external body");
      writeFileSync(join(root, ".env"), "PRIVATE_KEY=external-value");
      symlinkSync(join(outside, "private.ts"), join(root, "src/link.ts"));
      linkSync(join(outside, "private.ts"), join(root, "src/hard.ts"));
      expect(
        await handler.invoke(
          { kind: "read", path, startLine: 1, endLine: 1, maxBytes: 512 },
          context(),
        ),
      ).toEqual({ ok: false, reason: "scope-denied" });
    },
  );
  it("rejects authority-bearing request fields without filesystem work", async () => {
    const { handler, events } = fixture();
    expect(
      await handler.invoke({ ...request, root: "/private", policy: "allow" }, context()),
    ).toEqual({ ok: false, reason: "invalid-request" });
    expect(events[1]?.errorKind).toBe("CodingRepositorySearchError");
  });
  it("records cancellation from either parent signal with a single terminal event", async () => {
    const controller = new AbortController();
    controller.abort();
    const { handler, events } = fixture(() => true, { signal: controller.signal });
    expect(await handler.invoke(request, context())).toEqual({ ok: false, reason: "cancelled" });
    expect(events[1]).toMatchObject({ errorKind: "CodingRepositorySearchError" });
    expect(events).toHaveLength(2);
  });
  it("uses the canonical correlation fallback and records unexpected authority failure", async () => {
    const { handler, events } = fixture(() => {
      throw new TypeError("private failure body");
    });
    expect(
      await handler.invoke(request, { ...context(), correlationId: "private bad id" }),
    ).toEqual({ ok: false, reason: "failed" });
    const line = terminalLine(events);
    expect(JSON.parse(line)).toMatchObject({
      correlationId: "unknown-correlation-id",
      errorKind: "TypeError",
    });
    expect(line).not.toContain("private");
  });
  it("propagates a terminal logging failure without retrying or claiming completion", async () => {
    let writes = 0;
    const failure = new Error("log unavailable");
    const { handler } = fixture(() => true, {
      log: {
        write: (): void => {
          writes += 1;
          if (writes === 2) throw failure;
        },
      },
    });
    await expect(handler.invoke(request, context())).rejects.toBe(failure);
    expect(writes).toBe(2);
  });
});
