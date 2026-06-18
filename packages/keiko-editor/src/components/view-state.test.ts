import { describe, expect, it, vi } from "vitest";

import { applyViewState, captureViewState } from "./view-state.js";

interface FakeState {
  readonly scrollTop: number;
}

function fakeEditor(initial: FakeState | null): {
  saveViewState: () => FakeState | null;
  restoreViewState: (state: FakeState) => void;
  restored: FakeState[];
} {
  const restored: FakeState[] = [];
  return {
    saveViewState: () => initial,
    restoreViewState: (state: FakeState): void => {
      restored.push(state);
    },
    restored,
  };
}

describe("captureViewState / applyViewState", () => {
  it("round-trips the captured state through restore", () => {
    const captured = captureViewState(fakeEditor({ scrollTop: 42 }));
    expect(captured).toEqual({ scrollTop: 42 });

    const target = fakeEditor(null);
    applyViewState(target, captured);
    expect(target.restored).toEqual([{ scrollTop: 42 }]);
  });

  it("treats a null captured state as a no-op restore (first mount)", () => {
    const restore = vi.fn();
    applyViewState({ saveViewState: () => null, restoreViewState: restore }, null);
    expect(restore).not.toHaveBeenCalled();
  });

  it("returns null when the editor has no view state yet", () => {
    expect(captureViewState(fakeEditor(null))).toBeNull();
  });
});
