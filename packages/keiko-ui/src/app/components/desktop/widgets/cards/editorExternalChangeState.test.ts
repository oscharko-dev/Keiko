import { describe, expect, it } from "vitest";
import type { EditorM7WatchEvent } from "@oscharko-dev/keiko-contracts";

import {
  IDLE_EXTERNAL_CHANGE_STATE,
  editorExternalChangeReducer,
  type EditorExternalChangeState,
} from "./editorExternalChangeState";

function event(change: Partial<EditorM7WatchEvent> = {}): EditorM7WatchEvent {
  return {
    schemaVersion: "1",
    sequence: 1,
    kind: "changed",
    relativePath: "src/app.ts",
    metadataHash: "0123456789abcdef",
    ...change,
  };
}

function observe(
  state: EditorExternalChangeState,
  change: Partial<EditorM7WatchEvent>,
  dirty = false,
): EditorExternalChangeState {
  return editorExternalChangeReducer(state, {
    type: "observed",
    event: event(change),
    activePath: "src/app.ts",
    dirty,
    saving: false,
    originatedByKeiko: false,
  });
}

describe("editorExternalChangeReducer", () => {
  it("classifies clean and dirty external edits without overwriting the buffer", () => {
    expect(observe(IDLE_EXTERNAL_CHANGE_STATE, {}, false)).toMatchObject({
      status: "cleanChanged",
      relativePath: "src/app.ts",
    });
    expect(observe(IDLE_EXTERNAL_CHANGE_STATE, {}, true)).toMatchObject({
      status: "dirtyChanged",
      relativePath: "src/app.ts",
    });
  });

  it("handles delete, rename, recreate, save-in-flight, and event-gap states explicitly", () => {
    expect(observe(IDLE_EXTERNAL_CHANGE_STATE, { kind: "deleted" })).toMatchObject({
      status: "deleted",
    });
    expect(
      observe(IDLE_EXTERNAL_CHANGE_STATE, {
        kind: "renamed",
        relativePath: "src/renamed.ts",
        oldRelativePath: "src/app.ts",
      }),
    ).toMatchObject({ status: "renamed", oldRelativePath: "src/app.ts" });
    expect(observe(IDLE_EXTERNAL_CHANGE_STATE, { kind: "created" })).toMatchObject({
      status: "cleanChanged",
    });
    expect(
      editorExternalChangeReducer(IDLE_EXTERNAL_CHANGE_STATE, {
        type: "observed",
        event: event(),
        activePath: "src/app.ts",
        dirty: false,
        saving: true,
        originatedByKeiko: false,
      }),
    ).toMatchObject({ status: "dirtyChanged" });
    expect(
      observe(IDLE_EXTERNAL_CHANGE_STATE, {
        kind: "overflow",
        relativePath: "",
        reason: "sequence-gap",
      }),
    ).toMatchObject({ status: "rescanRequired", reason: "sequence-gap" });
  });

  it("ignores unrelated files and self-originated duplicate watch events", () => {
    const dirtyState = observe(IDLE_EXTERNAL_CHANGE_STATE, {}, true);
    expect(observe(dirtyState, { relativePath: "src/other.ts" })).toBe(dirtyState);
    expect(
      editorExternalChangeReducer(IDLE_EXTERNAL_CHANGE_STATE, {
        type: "observed",
        event: event(),
        activePath: "src/app.ts",
        dirty: false,
        saving: false,
        originatedByKeiko: true,
      }),
    ).toBe(IDLE_EXTERNAL_CHANGE_STATE);
  });

  it("keeps explicit user choices separate from destructive reload", () => {
    const changed = observe(IDLE_EXTERNAL_CHANGE_STATE, {}, true);
    expect(editorExternalChangeReducer(changed, { type: "compareOpened" })).toMatchObject({
      compareOpen: true,
    });
    expect(editorExternalChangeReducer(changed, { type: "keepLocal" })).toBe(
      IDLE_EXTERNAL_CHANGE_STATE,
    );
    expect(editorExternalChangeReducer(changed, { type: "reloadStarted" })).toBe(
      IDLE_EXTERNAL_CHANGE_STATE,
    );
  });
});
