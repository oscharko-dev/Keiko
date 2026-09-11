import { describe, expect, it } from "vitest";
import {
  HOST_EDIT_IGNORED_NOTICE,
  MODEL_OWNERSHIP_CHANGED_NOTICE,
  runtimeErrorClass,
  runtimeFailureNotice,
} from "./runtime-notice.js";

describe("editor runtime notices (F29)", () => {
  it("names an error by its class and never quotes its message", () => {
    const error = new TypeError("/Users/alice/project/.env could not be read");
    expect(runtimeFailureNotice("blame-read-failed", error)).toBe(
      "blame-read-failed (error=TypeError)",
    );
  });

  it("keeps a custom error class and falls back to Error for a blank name", () => {
    const custom = new Error("missing --ed-background");
    custom.name = "ThemeTokenError";
    const blank = new Error("x");
    blank.name = "  ";
    expect(runtimeErrorClass(custom)).toBe("ThemeTokenError");
    expect(runtimeErrorClass(blank)).toBe("Error");
  });

  it("names a thrown non-Error by its type only", () => {
    expect(runtimeFailureNotice("git-gutter-refresh-failed", "token=sk-secret")).toBe(
      "git-gutter-refresh-failed (error=string)",
    );
    expect(runtimeErrorClass({ message: "x" })).toBe("object");
    expect(runtimeErrorClass(undefined)).toBe("undefined");
  });

  it("states the fixed notices as closed codes", () => {
    expect(HOST_EDIT_IGNORED_NOTICE).toBe("host-edit-ignored (reason=read-only)");
    expect(MODEL_OWNERSHIP_CHANGED_NOTICE).toBe("model-ownership-changed");
  });
});
