import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeWorkspaceFs, type WorkspaceDirEntry } from "@oscharko-dev/keiko-workspace/internal/fs";
import { CODING_REPOSITORY_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/coding-repository-search";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import { formatServerLogLine } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
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

function settledProof(events: readonly ServerLogEvent[]): Record<string, unknown> {
  return expectActivityLogProof(
    "coding-repository-handler.settled.emitted-line",
    formatActivityLogProofLine(events[1] ?? {}),
  );
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
  it.each(["invalid-request", "authority-stale", "backend-unavailable", "failed"] as const)(
    "records unavailable progress rather than zero work for %s",
    async (reason) => {
      const ready = (): boolean => reason !== "authority-stale";
      const { readFileBytes: _read, ...unavailableFs } = nodeWorkspaceFs;
      const { handler, events } = fixture(ready, {
        ...(reason === "backend-unavailable" ? { fs: unavailableFs } : {}),
        ...(reason === "failed"
          ? {
              fs: {
                ...nodeWorkspaceFs,
                readFileBytes: (): Promise<Uint8Array> =>
                  Promise.reject(new TypeError("private search failure")),
              },
            }
          : {}),
      });
      expect(await handler.invoke(reason === "invalid-request" ? {} : request, context())).toEqual({
        ok: false,
        reason,
      });
      const line = settledProof(events);
      expect(line).toMatchObject({
        correlationId: context().correlationId,
        state: "failed",
        reason,
        progressStatus: "unavailable",
      });
      expect(line).not.toHaveProperty("filesScanned");
      expect(line).not.toHaveProperty("policyMode");
      expect(JSON.stringify(line)).not.toContain("private search failure");
    },
  );

  it("records ranged-read progress as not applicable to recursive search", async () => {
    const { handler, events } = fixture();
    await handler.invoke(
      { kind: "read", path: "src/example.ts", startLine: 2, endLine: 2, maxBytes: 512 },
      context(),
    );
    expect(settledProof(events)).toMatchObject({
      state: "completed",
      progressStatus: "not-applicable",
      resultCount: 1,
      truncationReasons: [],
    });
  });

  it("records unreadable and oversized exclusions from the real workspace producer", async () => {
    const read = nodeWorkspaceFs.readFileBytes;
    if (read === undefined) throw new Error("fixture byte reader missing");
    const { root, handler, events } = fixture(() => true, {
      fs: {
        ...nodeWorkspaceFs,
        readFileBytes: async (path, ...args): Promise<Uint8Array> => {
          if (path.endsWith("unreadable.ts"))
            throw Object.assign(new Error("private denied body"), { code: "EACCES" });
          return read(path, ...args);
        },
      },
    });
    writeFileSync(join(root, "src/unreadable.ts"), "parseConfig");
    writeFileSync(
      join(root, "src/oversized.ts"),
      "x".repeat(CODING_REPOSITORY_LIMITS.fileBytes + 1),
    );
    const result = await handler.invoke(request, context());
    expect(result).toMatchObject({ ok: true, truncationReasons: ["file-too-large", "io-error"] });
    const line = settledProof(events);
    expect(line).toMatchObject({
      progressStatus: "available",
      coverageIncomplete: true,
      coverageReasons: ["io-error"],
      oversizedFilesSkipped: 1,
      unreadableFilesSkipped: 1,
      truncationReasons: ["file-too-large", "io-error"],
    });
    expect(JSON.stringify(line)).not.toContain(root);
    expect(JSON.stringify(line)).not.toContain("unreadable.ts");
  });

  it("sums primary and rescue exclusions in a Git workspace without claiming explicit scope", async () => {
    const { root, handler, events } = fixture();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "src/example.ts"), "unrelated source");
    for (const prefix of ["src", "dist"]) {
      writeFileSync(join(root, prefix, "image.png"), "image");
      writeFileSync(
        join(root, prefix, "large.txt"),
        "x".repeat(CODING_REPOSITORY_LIMITS.fileBytes + 1),
      );
    }
    writeFileSync(join(root, "dist/generated.ts"), "export const parseConfig = true;");
    const result = await handler.invoke(request, context());
    expect(result).toMatchObject({ ok: true, hits: [{ path: "dist/generated.ts" }] });
    expect(settledProof(events)).toMatchObject({
      policyMode: "workspace-root-default",
      lowValuePolicyApplied: true,
      lowValueRescueApplied: true,
      binaryFilesSkipped: 2,
      oversizedFilesSkipped: 2,
      coverageIncomplete: false,
      coverageReasons: [],
      truncationReasons: ["file-too-large"],
    });
  });

  it("keeps include-glob filtering inside the bound root policy rather than fabricating selected scope", async () => {
    const { handler, events } = fixture();
    await handler.invoke({ ...request, includeGlobs: ["src/**"] }, context());
    expect(settledProof(events)).toMatchObject({ policyMode: "workspace-root-default" });
  });

  it("records incomplete rescue coverage when a listed path disappears during realpath admission", async () => {
    let disappeared = 0;
    const { root, handler, events } = fixture(() => true, {
      fs: {
        ...nodeWorkspaceFs,
        realPath: (path): string => {
          if (path.endsWith("/dist/vanished.ts")) {
            disappeared += 1;
            rmSync(path, { force: true });
          }
          return nodeWorkspaceFs.realPath(path);
        },
      },
    });
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "src/example.ts"), "unrelated source");
    writeFileSync(join(root, "dist/valid.ts"), "export const parseConfig = true;");
    writeFileSync(join(root, "dist/vanished.ts"), "export const parseConfig = false;");
    expect(await handler.invoke(request, context())).toMatchObject({
      ok: true,
      hits: [{ path: "dist/valid.ts" }],
      truncationReasons: ["io-error"],
    });
    expect(disappeared).toBeGreaterThan(0);
    expect(settledProof(events)).toMatchObject({
      lowValuePolicyApplied: true,
      lowValueRescueApplied: true,
      coverageIncomplete: true,
      coverageReasons: ["io-error"],
      truncationReasons: ["io-error"],
    });
  });

  it("records a soft scan stop as a completed partial result inside the hard deadline", async () => {
    let now = 0;
    const read = nodeWorkspaceFs.readFileBytes;
    if (read === undefined) throw new Error("fixture byte reader missing");
    let firstReadCompleted!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      firstReadCompleted = resolve;
    });
    const { root, handler, events } = fixture(() => true, {
      nowMs: () => now,
      deadlineAtMs: 100,
      fs: {
        ...nodeWorkspaceFs,
        readFileBytes: async (...args): Promise<Uint8Array> => {
          const bytes = await read(...args);
          firstReadCompleted();
          return bytes;
        },
        iterateDirectory: async function* (path): AsyncGenerator<WorkspaceDirEntry> {
          for (const entry of nodeWorkspaceFs.readDir(path)) {
            yield entry;
            if (entry.name === "example.ts") {
              await firstRead;
              await new Promise<void>((resolve) => setImmediate(resolve));
              now = 60;
            }
          }
        },
      },
    });
    writeFileSync(join(root, "src/z-late.ts"), "parseConfig late");
    expect(await handler.invoke(request, context())).toMatchObject({
      ok: true,
      hits: [{ path: "src/example.ts" }],
      truncationReasons: ["time-limit"],
    });
    expect(settledProof(events)).toMatchObject({
      state: "completed",
      progressStatus: "available",
      resultCount: 1,
      coverageIncomplete: true,
      coverageReasons: ["timeout"],
      truncationReasons: ["time-limit"],
      durationMs: 60,
    });
  });

  it("records actual closed search policy and exclusions without a sampled path dependency", async () => {
    const { root, handler, events } = fixture();
    writeFileSync(join(root, "src", "ignored.png"), "binary image");
    const result = await handler.invoke(request, context());
    expect(result.ok).toBe(true);
    expect(events[1]?.extra).toMatchObject({
      progressStatus: "available",
      policyMode: "workspace-root-default",
      lowValuePolicyApplied: false,
      lowValueRescueApplied: false,
      coverageIncomplete: false,
      coverageReasons: [],
      binaryFilesSkipped: 1,
      oversizedFilesSkipped: 0,
      unreadableFilesSkipped: 0,
    });
  });

  it("preserves actual partial scan counters when cancellation follows a safe file read", async () => {
    const controller = new AbortController();
    const read = nodeWorkspaceFs.readFileBytes;
    if (read === undefined) throw new Error("fixture byte reader missing");
    const { handler, events } = fixture(() => true, {
      fs: {
        ...nodeWorkspaceFs,
        readFileBytes: async (...args): Promise<Uint8Array> => {
          const bytes = await read(...args);
          controller.abort();
          return bytes;
        },
      },
    });
    expect(await handler.invoke(request, { ...context(), signal: controller.signal })).toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect(events[1]?.extra).toMatchObject({
      progressStatus: "available",
      candidatesDiscovered: 1,
      coverageIncomplete: true,
      coverageReasons: ["aborted"],
    });
  });

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
    const startedProof = expectActivityLogProof(
      "coding-repository-handler.started.emitted-line",
      formatActivityLogProofLine(events[0] ?? {}),
    );
    expect(startedProof).toMatchObject({ correlationId: context().correlationId });
    const settledProof = expectActivityLogProof(
      "coding-repository-handler.settled.emitted-line",
      formatActivityLogProofLine(events[1] ?? {}),
    );
    expect(settledProof).toMatchObject({
      state: "completed",
      reason: "none",
      filesScanned: 1,
      resultCount: 1,
      resultPathSha256: [createHash("sha256").update("src/example.ts").digest("hex")],
    });
  });
  it("keeps lexical source-language queries free of synthetic nonmatching windows", async () => {
    const { handler } = fixture();
    const result = await handler.invoke(
      { ...request, mode: "lexical", query: "find TypeScript source files that call createQuote" },
      context(),
    );
    expect(result).toMatchObject({ ok: true, kind: "search", hits: [] });
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
      errorKind: "authority-denied",
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
    expect(events[1]?.errorKind).toBe("validation-failed");
  });
  it("records cancellation from either parent signal with a single terminal event", async () => {
    const controller = new AbortController();
    controller.abort();
    const { handler, events } = fixture(() => true, { signal: controller.signal });
    expect(await handler.invoke(request, context())).toEqual({ ok: false, reason: "cancelled" });
    expect(events[1]).toMatchObject({ errorKind: "cancelled" });
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
      errorKind: "internal",
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
