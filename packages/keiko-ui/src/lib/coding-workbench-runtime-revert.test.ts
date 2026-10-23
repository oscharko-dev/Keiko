import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";

import {
  createInitialCodingWorkbenchRuntimeState,
  type CodingWorkbenchRuntimeState,
} from "./coding-workbench-live-state";
import {
  getCodingWorkbenchRuntimeRevertState,
  revertCodingWorkbenchRuntime,
} from "./coding-workbench-runtime-api";
import { createRevertMutation } from "./coding-workbench-runtime-mutations";

const UPDATED_AT = "2026-07-13T12:00:00.000Z";

function snapshot(
  overrides: Partial<CodingWorkbenchRuntimeSnapshot> = {},
): CodingWorkbenchRuntimeSnapshot {
  return {
    schemaVersion: "1",
    state: "running",
    revision: 4,
    updatedAt: UPDATED_AT,
    runId: "run-1",
    ...overrides,
  } as CodingWorkbenchRuntimeSnapshot;
}

function stateWithRun(run: CodingWorkbenchRuntimeSnapshot | null): CodingWorkbenchRuntimeState {
  return {
    ...createInitialCodingWorkbenchRuntimeState(),
    run: { status: "ready", value: run, error: null },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("turn revert API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the closed revert body to the run's revert route and reads back the snapshot", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(snapshot())));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      revertCodingWorkbenchRuntime("run-1", {
        requestId: "request-1",
        expectedRevision: 4,
        action: "undo",
      }),
    ).resolves.toMatchObject({ runId: "run-1", revision: 4 });

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/coding-workbench/runtime/runs/run-1/revert",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ requestId: "request-1", expectedRevision: 4, action: "undo" }),
      }),
    );
  });

  it("reads the counts over the revert channel and validates them against the contract", async () => {
    const revert = { staged: true, fileCount: 2, additions: 12, deletions: 4 };
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ session: "active", revert })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCodingWorkbenchRuntimeRevertState("run-1")).resolves.toEqual({
      session: "active",
      revert,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/coding-workbench/runtime/runs/run-1/revert");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
  });

  it.each([
    [
      "a path smuggled into the counts",
      {
        session: "active",
        revert: { staged: false, fileCount: 1, additions: 1, deletions: 0, path: "a.ts" },
      },
    ],
    [
      "counts on an unpaired answer",
      { session: "unpaired", revert: { staged: false, fileCount: 1, additions: 1, deletions: 0 } },
    ],
    [
      "a negative count",
      { session: "active", revert: { staged: false, fileCount: -1, additions: 0, deletions: 0 } },
    ],
    ["an unknown session facet", { session: "other" }],
  ])("rejects %s as a contract violation", async (_name, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(body))),
    );

    await expect(getCodingWorkbenchRuntimeRevertState("run-1")).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
    });
  });
});

describe("createRevertMutation", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(snapshot({ revision: 5 })))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["undo", "restore"] as const)(
    "binds a %s to the observed run and revision with a fresh request id",
    async (action) => {
      const command = createRevertMutation(action, stateWithRun(snapshot({ revision: 4 })));

      expect(command.expected).toEqual({ runId: "run-1", revision: 4 });
      expect(command.mayInstallNewRun).toBe(false);
      await expect(command.run()).resolves.toMatchObject({ revision: 5 });

      const fetchMock = vi.mocked(fetch);
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe("/api/coding-workbench/runtime/runs/run-1/revert");
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({
        requestId: command.requestId,
        expectedRevision: 4,
        action,
      });
    },
  );

  it("sends a different request id for every attempt", () => {
    const state = stateWithRun(snapshot());

    expect(createRevertMutation("undo", state).requestId).not.toBe(
      createRevertMutation("undo", state).requestId,
    );
  });

  it.each(["running", "paused"] as const)("is admitted against a %s run", (runState) => {
    expect(() =>
      createRevertMutation("undo", stateWithRun(snapshot({ state: runState }))),
    ).not.toThrow();
  });

  it.each([
    "starting",
    "ready",
    "awaiting-approval",
    "stopping",
    "succeeded",
    "failed",
    "cancelled",
    "recovery-required",
  ] as const)("refuses to build a request for a run that is %s", (runState) => {
    expect(() =>
      createRevertMutation("undo", stateWithRun(snapshot({ state: runState }))),
    ).toThrowError(expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses to build a request without a run", () => {
    expect(() => createRevertMutation("restore", stateWithRun(null))).toThrowError(
      expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }),
    );
  });
});
