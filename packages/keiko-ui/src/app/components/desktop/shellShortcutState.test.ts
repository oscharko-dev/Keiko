import { describe, expect, it } from "vitest";

import { resolveShellShortcutState } from "./shellShortcutState";

describe("shellShortcutState", () => {
  it("resolves global bindings and labels from editor setting overrides", () => {
    const state = resolveShellShortcutState(["1|quick-access.files|CtrlOrMeta+Shift+O"]);

    expect(state.bindings).toContainEqual({
      commandId: "quick-access.files",
      chord: { key: "o", mod: ["cmd", "shift"] },
    });
    expect(state.labels.get("quick-access.files")).toMatch(/O$/u);
  });
});
