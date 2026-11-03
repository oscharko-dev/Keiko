import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";

import {
  createInitialCodingWorkbenchRuntimeState,
  type CodingWorkbenchRuntimeState,
} from "./coding-workbench-live-state";
import {
  fetchCodingWorkbenchRuntimeInbox,
  submitCodingWorkbenchRuntimeInboxAction,
} from "./coding-workbench-runtime-api";
import { createInboxMutation } from "./coding-workbench-runtime-mutations";

const UPDATED_AT = "2026-10-24T12:00:00.000Z";
const ITEM = "msg_16b08469d001DaT0xxHG2PAKe6";

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

describe("pending messages API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the closed action body to the run's inbox route and reads back the snapshot", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(snapshot())));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      submitCodingWorkbenchRuntimeInboxAction("run-1", {
        requestId: "request-1",
        expectedRevision: 4,
        action: "cancel",
        itemId: ITEM,
      }),
    ).resolves.toMatchObject({ runId: "run-1", revision: 4 });

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/coding-workbench/runtime/runs/run-1/inbox",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          requestId: "request-1",
          expectedRevision: 4,
          action: "cancel",
          itemId: ITEM,
        }),
      }),
    );
  });

  it("reads the waiting messages over the inbox channel and validates them against the contract", async () => {
    const items = [
      { itemId: ITEM, delivery: "steer", preview: "Use the new logger" },
      { itemId: "msg_16b08469d002DaT0xxHG2PAKe6", delivery: "queue", preview: "" },
    ];
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ session: "active", items })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCodingWorkbenchRuntimeInbox("run-1")).resolves.toEqual({
      session: "active",
      items,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/coding-workbench/runtime/runs/run-1/inbox");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("method", "POST");
  });

  it("encodes the run id into the path and forwards the abort signal", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ session: "active" })));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await fetchCodingWorkbenchRuntimeInbox("run/with space", { signal: controller.signal });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/coding-workbench/runtime/runs/run%2Fwith%20space/inbox",
    );
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["a run that offers none", { session: "active" }],
    ["an empty list", { session: "active", items: [] }],
    ["an unpaired window", { session: "unpaired" }],
  ])("accepts %s as the contract states it", async (_name, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(body))),
    );

    await expect(fetchCodingWorkbenchRuntimeInbox("run-1")).resolves.toEqual(body);
  });

  it.each([
    [
      "the full text smuggled beside the preview",
      {
        session: "active",
        items: [{ itemId: ITEM, delivery: "queue", preview: "x", text: "the whole message" }],
      },
    ],
    [
      "an item id that is not a message id",
      { session: "active", items: [{ itemId: "ses_x", delivery: "queue", preview: "x" }] },
    ],
    [
      "an unknown delivery",
      { session: "active", items: [{ itemId: ITEM, delivery: "later", preview: "x" }] },
    ],
    [
      "a repeated item",
      {
        session: "active",
        items: [
          { itemId: ITEM, delivery: "queue", preview: "x" },
          { itemId: ITEM, delivery: "steer", preview: "y" },
        ],
      },
    ],
    [
      "a preview with a text-reordering override",
      { session: "active", items: [{ itemId: ITEM, delivery: "queue", preview: "a\u202eb" }] },
    ],
    [
      "items on an unpaired answer",
      { session: "unpaired", items: [{ itemId: ITEM, delivery: "queue", preview: "x" }] },
    ],
    ["an unknown session facet", { session: "other" }],
  ])("rejects %s as a contract violation", async (_name, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(body))),
    );

    await expect(fetchCodingWorkbenchRuntimeInbox("run-1")).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
    });
  });
});

describe("createInboxMutation", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(snapshot({ revision: 5 })))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["cancel", "promote"] as const)(
    "binds a %s to the observed run and revision with a fresh request id",
    async (action) => {
      const command = createInboxMutation(action, ITEM, stateWithRun(snapshot({ revision: 4 })));

      expect(command.expected).toEqual({ runId: "run-1", revision: 4 });
      expect(command.mayInstallNewRun).toBe(false);
      await expect(command.run(new AbortController().signal)).resolves.toMatchObject({
        revision: 5,
      });

      const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
      expect(url).toBe("/api/coding-workbench/runtime/runs/run-1/inbox");
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({
        requestId: command.requestId,
        expectedRevision: 4,
        action,
        itemId: ITEM,
      });
    },
  );

  it("sends a different request id for every attempt", () => {
    const state = stateWithRun(snapshot());

    expect(createInboxMutation("cancel", ITEM, state).requestId).not.toBe(
      createInboxMutation("cancel", ITEM, state).requestId,
    );
  });

  it.each(["paused", "ready", "awaiting-approval", "succeeded", "failed", "cancelled"] as const)(
    "refuses a %s run: only a running turn holds a waiting message",
    (runState) => {
      expect(() =>
        createInboxMutation("cancel", ITEM, stateWithRun(snapshot({ state: runState }))),
      ).toThrow(/while the task's turn is running/u);
    },
  );

  it("refuses when there is no run, and sends nothing", () => {
    expect(() => createInboxMutation("promote", ITEM, stateWithRun(null))).toThrow(
      /while the task's turn is running/u,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
