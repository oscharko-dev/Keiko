import type { Route } from "@playwright/test";
import { describe, expect, it } from "vitest";

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

describe("parseFixtureEditorSnapshotRequest", (): void => {
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
