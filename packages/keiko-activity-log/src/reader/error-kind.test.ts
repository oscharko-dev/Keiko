import { SafeArtifactFileError } from "@oscharko-dev/keiko-security/fs-hardening";
import { describe, expect, it } from "vitest";
import { describeErrorKind } from "./error-kind.js";

// Relocated from the retired bundle exporter's suite (#3534): the closed kind printed and logged
// for a file failure must never carry the error's message, a path, or a code that is one.
describe("describeErrorKind", () => {
  it("reports the fs error's code when it has one, never the message or a path", () => {
    const error = Object.assign(new Error("ENOENT: no such file or directory, open '/secret'"), {
      code: "ENOENT",
    });

    expect(describeErrorKind(error)).toBe("ENOENT");
  });

  it("falls back to the error's constructor name when there is no code", () => {
    expect(describeErrorKind(new TypeError("boom"))).toBe("TypeError");
  });

  it("falls back to the error's constructor name when code is not a short identifier", () => {
    const error = Object.assign(new Error("boom"), { code: "/absolute/path/leak" });

    expect(describeErrorKind(error)).toBe("Error");
  });

  it("falls back to the generic Error kind for a thrown non-Error value", () => {
    expect(describeErrorKind("not an error")).toBe("Error");
  });

  it("reports a hardened-primitive refusal by its closed kind, never its constructor name", () => {
    expect(describeErrorKind(new SafeArtifactFileError("activity-log", "unsafe-target"))).toBe(
      "unsafe-target",
    );
  });
});
