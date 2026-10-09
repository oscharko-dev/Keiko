import { describe, expect, it, vi } from "vitest";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { WORKSPACE_PATH_DISCOVERY_TRUNCATION_REASONS } from "@oscharko-dev/keiko-contracts/runtime/workspace";
import { activityLogEventRegistration } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import type { WorkspaceRootAccess } from "../task-workspace/workspace-root-access.js";
import { createCodingToolReadEditPorts } from "./codingToolReadEditPorts.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

const ROOT = "/workbench-discovery-fixture";
const SOURCE_COUNT = 96;
const REQUEST = {
  action: "discover",
  actionId: "discover-lifecycle",
  idempotencyKey: "discover-lifecycle-key",
  query: "*",
  maxResults: 100,
} as const;

function discoveryFixture(
  rootFailure?: Error,
  failedDirectory?: "root" | "nested",
): {
  readonly ports: ReturnType<typeof createCodingToolReadEditPorts>;
  readonly rootReads: () => number;
  readonly sourceStats: () => number;
  readonly events: readonly ServerLogEvent[];
} {
  const files: Record<string, string> = { "package.json": '{"name":"fixture"}\n' };
  if (failedDirectory === "nested") files["nested/component.tsx"] = "export {};\n";
  for (let index = 0; index < SOURCE_COUNT; index += 1) {
    files[`source-${String(index).padStart(3, "0")}.tsx`] = "export {};\n";
  }
  const base = memFs(ROOT, files);
  let rootReads = 0;
  let sourceStats = 0;
  const events: ServerLogEvent[] = [];
  const fs: WorkspaceFs = {
    ...base,
    readDir: (path, limit) => {
      if (path === ROOT) rootReads += 1;
      if (path === (failedDirectory === "root" ? ROOT : `${ROOT}/nested`)) {
        throw new Error("private-directory-read-failure");
      }
      return base.readDir(path, limit);
    },
    stat: (path) => {
      if (/\/source-\d+\.tsx$/u.test(path)) sourceStats += 1;
      return base.stat(path);
    },
  };
  return {
    ports: createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: vi.fn() },
      editorAgentClient: { action: vi.fn() },
      resolveEditorActionContext: vi.fn(),
      resolveWorkspaceRoot: () => ROOT,
      resolveWorkspaceRootAccess: (): WorkspaceRootAccess => {
        if (rootFailure !== undefined) throw rootFailure;
        return { kind: "ordinary", canonicalRoot: ROOT, fs };
      },
      activityLog: { write: (event): void => void events.push(event) },
    }),
    rootReads: () => rootReads,
    sourceStats: () => sourceStats,
    events,
  };
}

describe("Coding Workbench cooperative discovery", () => {
  it("serves a queued event-loop callback before a repository inventory completes", async () => {
    const { ports } = discoveryFixture();
    let callbackRan = false;
    const queued = new Promise<void>((resolve) => {
      setImmediate(() => {
        callbackRan = true;
        resolve();
      });
    });
    const result = await ports.repositoryDiscover.execute(REQUEST, undefined, {
      check: () => true,
    });
    const responsive = callbackRan;
    await queued;

    expect(result).toMatchObject({ status: "completed", read: { totalLines: SOURCE_COUNT + 1 } });
    expect(responsive).toBe(true);
  });

  it("rejects a canceled partial inventory and stops before scanning every source", async () => {
    const { ports, sourceStats, events } = discoveryFixture();
    const controller = new AbortController();
    const cancelled = new Promise<void>((resolve) => {
      setImmediate(() => {
        controller.abort();
        resolve();
      });
    });
    const result = await ports.repositoryDiscover.execute(REQUEST, controller.signal, {
      check: () => true,
    });
    await cancelled;

    expect(result).toEqual({ status: "failed" });
    expect(sourceStats()).toBeGreaterThan(0);
    expect(sourceStats()).toBeLessThan(SOURCE_COUNT);
    const line = formatActivityLogProofLine(events.at(-1) ?? {});
    expectActivityLogProof("coding-runtime.workspace-discovery.emitted-line", line);
    expect(JSON.parse(line)).toMatchObject({
      correlationId: "unknown-correlation-id",
      errorKind: "cancelled",
      state: "failed",
      reason: "cancelled",
      cooperative: true,
      sourceLanguageScan: false,
    });
    expect(line).not.toContain(ROOT);
  });

  it("enumerates the directory once without an unrelated language-detection inventory", async () => {
    const { ports, rootReads, events } = discoveryFixture();
    const result = await ports.repositoryDiscover.execute(REQUEST, undefined, {
      check: () => true,
    });

    expect(result).toMatchObject({ status: "completed", read: { totalLines: SOURCE_COUNT + 1 } });
    expect(rootReads()).toBe(1);
    const line = formatActivityLogProofLine(events.at(-1) ?? {});
    expectActivityLogProof("coding-runtime.workspace-discovery.emitted-line", line);
    expect(JSON.parse(line)).toMatchObject({
      state: "completed",
      reason: "none",
      cooperative: true,
      sourceLanguageScan: false,
      directorySortStrategy: "retained-results-only",
      discovered: SOURCE_COUNT + 1,
      returnedPathCount: SOURCE_COUNT + 1,
      matchedCount: SOURCE_COUNT + 1,
      coverageIncomplete: false,
      truncationReasons: [],
    });
    expect(line).not.toContain("source-000.tsx");
    const event = events.at(-1);
    expect(
      event === undefined
        ? undefined
        : activityLogEventRegistration(event)?.fields.truncationReasons,
    ).toMatchObject({ values: WORKSPACE_PATH_DISCOVERY_TRUNCATION_REASONS });
  });

  it("discards a completed inventory after scheduled authority revocation", async () => {
    const { ports, events } = discoveryFixture();
    let authorized = true;
    const revoked = new Promise<void>((resolve) => {
      setImmediate(() => {
        authorized = false;
        resolve();
      });
    });
    const result = await ports.repositoryDiscover.execute(REQUEST, undefined, {
      check: () => authorized,
    });
    await revoked;

    expect(result).toEqual({ status: "failed" });
    const line = formatActivityLogProofLine(events.at(-1) ?? {});
    expectActivityLogProof("coding-runtime.workspace-discovery.emitted-line", line);
    expect(JSON.parse(line)).toMatchObject({
      state: "failed",
      reason: "authority-denied",
      errorKind: "authority-denied",
    });
    expect(line).not.toContain(ROOT);
  });

  it("records technical discovery failures without exception text or workspace paths", async () => {
    const sentinel = "private-discovery-failure";
    const failure = new Error(sentinel, { cause: new TypeError("private-cause") });
    const { ports, events } = discoveryFixture(failure);
    const result = await ports.repositoryDiscover.execute(REQUEST, undefined, {
      check: () => true,
    });

    expect(result).toEqual({ status: "failed" });
    expect(events.at(-1)?.extra?.frames).toEqual(expect.any(Array));
    const line = formatActivityLogProofLine(events.at(-1) ?? {});
    expectActivityLogProof("coding-runtime.workspace-discovery.emitted-line", line);
    expect(JSON.parse(line)).toMatchObject({
      state: "failed",
      reason: "inventory-failed",
      errorKind: "internal",
      causeChain: ["TypeError"],
    });
    expect(line).not.toContain(sentinel);
    expect(line).not.toContain(ROOT);
    expect(line).not.toContain("private-cause");
  });

  it.each(["root", "nested"] as const)(
    "refuses a successful empty or partial inventory when the %s directory cannot be read",
    async (failedDirectory) => {
      const { ports, events } = discoveryFixture(undefined, failedDirectory);
      const result = await ports.repositoryDiscover.execute(REQUEST, undefined, {
        check: () => true,
      });

      expect(result).toEqual({ status: "failed" });
      const line = formatActivityLogProofLine(events.at(-1) ?? {});
      expectActivityLogProof("coding-runtime.workspace-discovery.emitted-line", line);
      expect(JSON.parse(line)).toMatchObject({
        state: "failed",
        reason: "inventory-failed",
        errorKind: "internal",
      });
      expect(line).not.toContain(ROOT);
      expect(line).not.toContain("private-directory-read-failure");
    },
  );
});
