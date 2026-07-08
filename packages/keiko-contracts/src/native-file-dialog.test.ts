import { describe, expect, it } from "vitest";
import {
  NATIVE_FILE_DIALOG_MAX_SELECTIONS,
  nativeFileDialogExpectedKind,
  nativeFileDialogSelectionBounds,
  validateNativeFileDialogRequest,
} from "./native-file-dialog.js";

describe("validateNativeFileDialogRequest", () => {
  it("accepts a bounded open-directory request and trims hint fields", () => {
    expect(
      validateNativeFileDialogRequest({
        mode: "open-directory",
        title: "  Ordner wählen  ",
        defaultPath: " /Users/example/Projekte ",
      }),
    ).toEqual({
      ok: true,
      value: {
        mode: "open-directory",
        title: "Ordner wählen",
        defaultPath: "/Users/example/Projekte",
      },
    });
  });

  it("accepts open-files with filters and normalizes extensions", () => {
    const result = validateNativeFileDialogRequest({
      mode: "open-files",
      filters: [{ name: "Archives", extensions: [".TAR.GZ", "Zip", "7z"] }],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        mode: "open-files",
        filters: [{ name: "Archives", extensions: ["tar.gz", "zip", "7z"] }],
      },
    });
  });

  it("omits empty optional fields instead of carrying empty strings", () => {
    expect(
      validateNativeFileDialogRequest({
        mode: "open-file",
        title: "   ",
        defaultPath: "",
        filters: [],
      }),
    ).toEqual({ ok: true, value: { mode: "open-file" } });
  });

  it("strips bidi and zero-width characters from the dialog title", () => {
    const result = validateNativeFileDialogRequest({
      mode: "open-file",
      title: "Select‮ ​file",
    });
    expect(result).toEqual({ ok: true, value: { mode: "open-file", title: "Select file" } });
  });

  it.each([
    [null, "request must be an object"],
    [[], "request must be an object"],
    [{ mode: "save-file" }, "mode is invalid"],
    [{ mode: 7 }, "mode is invalid"],
    [{}, "mode is invalid"],
    [{ mode: "open-file", title: 3 }, "title must be a string"],
    [{ mode: "open-file", title: "x".repeat(121) }, "title is too long"],
    [{ mode: "open-file", defaultPath: 3 }, "defaultPath must be a string"],
    [{ mode: "open-file", defaultPath: `/${"x".repeat(4096)}` }, "defaultPath is too long"],
    [{ mode: "open-directory", defaultPath: "/tmp/a\0b" }, "defaultPath must not contain NUL"],
    [{ mode: "open-file", filters: "png" }, "filters must be an array"],
    [
      {
        mode: "open-file",
        filters: Array.from({ length: 9 }, () => ({ name: "F", extensions: ["a"] })),
      },
      "filters contains too many entries",
    ],
    [{ mode: "open-file", filters: [null] }, "filters[0] must be an object"],
    [{ mode: "open-file", filters: [{ extensions: ["png"] }] }, "filters[0].name must be a string"],
    [
      { mode: "open-file", filters: [{ name: "  ", extensions: ["png"] }] },
      "filters[0].name is required",
    ],
    [
      { mode: "open-file", filters: [{ name: "x".repeat(65), extensions: ["png"] }] },
      "filters[0].name is too long",
    ],
    [
      { mode: "open-file", filters: [{ name: "Evil|*.exe|Sneaky", extensions: ["png"] }] },
      "filters[0].name contains an invalid character",
    ],
    [
      { mode: "open-file", filters: [{ name: "F", extensions: "png" }] },
      "filters[0].extensions must be an array",
    ],
    [
      { mode: "open-file", filters: [{ name: "F", extensions: [] }] },
      "filters[0].extensions has invalid size",
    ],
    [
      {
        mode: "open-file",
        filters: [{ name: "F", extensions: Array.from({ length: 25 }, () => "a") }],
      },
      "filters[0].extensions has invalid size",
    ],
    [
      { mode: "open-file", filters: [{ name: "F", extensions: [7] }] },
      "filters[0].extensions[0] must be a string",
    ],
    [
      { mode: "open-file", filters: [{ name: "F", extensions: ["*"] }] },
      "filters[0].extensions[0] is invalid",
    ],
    [
      { mode: "open-file", filters: [{ name: "F", extensions: ["../png"] }] },
      "filters[0].extensions[0] is invalid",
    ],
    [
      { mode: "open-file", filters: [{ name: "F", extensions: ["a\0b"] }] },
      "filters[0].extensions[0] is invalid",
    ],
    [
      { mode: "open-file", filters: [{ name: "F", extensions: ["x".repeat(17)] }] },
      "filters[0].extensions[0] is invalid",
    ],
  ])("rejects hostile or malformed input %#", (input, error) => {
    expect(validateNativeFileDialogRequest(input)).toEqual({ ok: false, error });
  });

  it("never echoes rejected values inside error messages", () => {
    const hostile = "/secret/customer\0name";
    const result = validateNativeFileDialogRequest({
      mode: "open-directory",
      defaultPath: hostile,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("secret");
      expect(result.error).not.toContain("customer");
    }
  });
});

describe("nativeFileDialogSelectionBounds", () => {
  it("bounds single-selection modes to exactly one path", () => {
    expect(nativeFileDialogSelectionBounds("open-file")).toEqual({ min: 1, max: 1 });
    expect(nativeFileDialogSelectionBounds("open-directory")).toEqual({ min: 1, max: 1 });
  });

  it("bounds open-files to the shared selection cap", () => {
    expect(nativeFileDialogSelectionBounds("open-files")).toEqual({
      min: 1,
      max: NATIVE_FILE_DIALOG_MAX_SELECTIONS,
    });
  });
});

describe("nativeFileDialogExpectedKind", () => {
  it("maps file modes to file and the folder mode to directory", () => {
    expect(nativeFileDialogExpectedKind("open-file")).toBe("file");
    expect(nativeFileDialogExpectedKind("open-files")).toBe("file");
    expect(nativeFileDialogExpectedKind("open-directory")).toBe("directory");
  });
});
