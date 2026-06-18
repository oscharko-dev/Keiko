import { describe, expect, it } from "vitest";

import { KEIKO_EDITOR_PACKAGE } from "./version.js";

describe("KEIKO_EDITOR_PACKAGE", () => {
  it("identifies the editor package by its published workspace name", () => {
    expect(KEIKO_EDITOR_PACKAGE).toBe("@oscharko-dev/keiko-editor");
  });
});
