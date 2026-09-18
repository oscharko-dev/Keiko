import { describe, expect, it } from "vitest";

import { parseFixtureEditorSnapshotRequest } from "./coding-workbench-live-runtime-routes.js";

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
});
