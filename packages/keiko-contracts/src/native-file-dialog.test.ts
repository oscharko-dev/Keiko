import { describe, expect, it } from "vitest";
import { validateNativeFileDialogRequest } from "./bff-wire.js";

describe("native file dialog BFF contract", () => {
  it("accepts a bounded open-directory request", () => {
    expect(
      validateNativeFileDialogRequest({
        mode: "open-directory",
        title: "Select folder",
        defaultPath: " C:\\repo ",
      }),
    ).toEqual({
      ok: true,
      value: {
        mode: "open-directory",
        title: "Select folder",
        defaultPath: "C:\\repo",
      },
    });
  });

  it("rejects unknown modes and NUL-containing paths", () => {
    expect(validateNativeFileDialogRequest({ mode: "save-file" }).ok).toBe(false);
    expect(
      validateNativeFileDialogRequest({
        mode: "open-directory",
        defaultPath: "C:\\repo\0hidden",
      }).ok,
    ).toBe(false);
  });
});
