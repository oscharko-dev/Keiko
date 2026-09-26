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

  // Review on PR #3452: a name is text the error chose, so only the closed vocabulary survives.
  it("keeps a known error class and reports any other name as Error", () => {
    const known = new Error("missing --ed-background");
    known.name = "SyntaxError";
    const foreign = new Error("x");
    foreign.name = "AliceSmithPassword";
    const blank = new Error("x");
    blank.name = "  ";
    expect(runtimeErrorClass(known)).toBe("SyntaxError");
    expect(runtimeErrorClass(foreign)).toBe("Error");
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
