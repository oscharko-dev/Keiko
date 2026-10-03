import type { Route } from "@playwright/test";
import { describe, expect, it } from "vitest";
import {
  EDITOR_AGENT_BRIDGE_DECISION_CAPABILITY_ENCODED_CHARS,
  parseEditorAgentSnapshotRequest,
  type EditorAgentSessionSnapshot,
} from "@oscharko-dev/keiko-contracts/editor-agent";

import { createRuntimeFixture } from "./coding-workbench-live-runtime-fixtures.js";
import {
  handleEditorSnapshotRoute,
  parseFixtureEditorSnapshotRequest,
} from "./coding-workbench-live-runtime-routes.js";

type RouteFulfillOptions = NonNullable<Parameters<Route["fulfill"]>[0]>;

interface CapturedRoute {
  readonly route: Route;
  readonly fulfillment: () => RouteFulfillOptions | undefined;
}

function capturedRoute(payload: string | null): CapturedRoute {
  let fulfillment: RouteFulfillOptions | undefined;
  const route = {
    request: () => ({
      method: (): string => "POST",
      postData: (): string | null => payload,
    }),
    fulfill: (options: RouteFulfillOptions): Promise<void> => {
      fulfillment = options;
      return Promise.resolve();
    },
  } as unknown as Route;
  return { route, fulfillment: () => fulfillment };
}

function editorSnapshot(): EditorAgentSessionSnapshot {
  return {
    schemaVersion: "1",
    sessionId: "fixture-editor-session",
    windowId: "fixture-editor-window",
    workspaceRoot: "/fixture-workspace",
    activePaneId: "pane-1",
    panes: [{ paneId: "pane-1", activeFile: null, openFiles: [] }],
    dirtyFiles: [],
    activeFile: null,
    cursor: null,
    selection: null,
    diagnosticsSummary: null,
    textMode: "none",
    updatedAt: 1,
  };
}

const PASSIVE_REQUESTS = [
  { schemaVersion: "1", kind: "buffer-snapshot", snapshot: editorSnapshot() },
  {
    schemaVersion: "1",
    kind: "buffer-release",
    sessionId: "fixture-editor-session",
    bufferSnapshotCapability: "A".repeat(EDITOR_AGENT_BRIDGE_DECISION_CAPABILITY_ENCODED_CHARS),
  },
];

describe("parseFixtureEditorSnapshotRequest", (): void => {
  it.each(PASSIVE_REQUESTS)(
    "does not model passive $kind requests as executable bridge registrations",
    async (request): Promise<void> => {
      expect(parseEditorAgentSnapshotRequest(request).ok).toBe(true);
      const fixture = createRuntimeFixture({});
      const captured = capturedRoute(JSON.stringify(request));
      await handleEditorSnapshotRoute(captured.route, "/api/editor/agent/snapshot", fixture);
      expect(captured.fulfillment()?.status).toBe(400);
      expect(fixture.editorSnapshotRegistrations).toBe(0);
      expect(fixture.validationErrors).toEqual([
        "passive buffer requests are outside the Workbench bridge fixture",
      ]);
    },
  );

  it("keeps existing Workbench bridge snapshot registration", async (): Promise<void> => {
    const fixture = createRuntimeFixture({});
    const snapshot = editorSnapshot();
    const request = capturedRoute(
      JSON.stringify({ schemaVersion: "1", kind: "snapshot", snapshot }),
    );
    await handleEditorSnapshotRoute(request.route, "/api/editor/agent/snapshot", fixture);
    expect(request.fulfillment()?.status).toBe(200);
    expect(fixture.editorSnapshotRegistrations).toBe(1);
    expect(fixture.validationErrors).toEqual([]);
  });

  it("delegates decoded requests to the production contract parser", (): void => {
    expect(parseFixtureEditorSnapshotRequest('{"schemaVersion":"1"}')).toEqual({
      ok: true,
      value: {
        schemaVersion: "1",
        textMode: "none",
      },
    });
  });

  it.each([null, "", '{"schemaVersion":'])(
    "rejects an absent or malformed JSON body (%j)",
    (payload): void => {
      expect(parseFixtureEditorSnapshotRequest(payload)).toEqual({
        ok: false,
        errors: ["request body must contain valid JSON"],
      });
    },
  );

  it("preserves semantic contract validation after JSON decoding", (): void => {
    expect(parseFixtureEditorSnapshotRequest("null")).toEqual({
      ok: false,
      errors: ["request must be an object"],
    });
  });

  it.each([
    ["absent", null],
    ["empty", ""],
    ["syntactically invalid", '{"schemaVersion":'],
  ])("returns 400 and records an %s request body", async (_label, payload): Promise<void> => {
    const fixture = createRuntimeFixture({});
    const request = capturedRoute(payload);

    await expect(
      handleEditorSnapshotRoute(request.route, "/api/editor/agent/snapshot", fixture),
    ).resolves.toBe(true);

    expect(request.fulfillment()).toEqual({
      status: 400,
      contentType: "application/json",
      body: "{}",
    });
    expect(fixture.validationErrors).toEqual(["request body must contain valid JSON"]);
    expect(fixture.editorSnapshotRegistrations).toBe(0);
  });
});
