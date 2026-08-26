import { describe, expect, it } from "vitest";
import { flagValue, readNamedValueFlags } from "./cli-arg-parsing.js";

describe("flagValue", () => {
  it("returns undefined when the flag is absent", () => {
    expect(flagValue(["--other", "x"], "--model")).toBeUndefined();
    expect(flagValue([], "--model")).toBeUndefined();
  });

  it("returns the following argument when the flag has a value", () => {
    expect(flagValue(["--model", "gpt-5"], "--model")).toBe("gpt-5");
    expect(flagValue(["--a", "1", "--model", "gpt-5", "--b", "2"], "--model")).toBe("gpt-5");
  });

  it("returns null when the flag is immediately followed by another flag", () => {
    expect(flagValue(["--model", "--json"], "--model")).toBeNull();
  });

  it("returns null when the flag is the very last argument", () => {
    expect(flagValue(["--json", "--model"], "--model")).toBeNull();
  });

  it("treats a value that merely starts with -- as missing, not the value", () => {
    expect(flagValue(["--model", "--"], "--model")).toBeNull();
  });
});

describe("readNamedValueFlags", () => {
  const FLAGS = ["--suite", "--fixture", "--model"] as const;

  it("returns undefined for every absent flag", () => {
    expect(readNamedValueFlags([], FLAGS)).toStrictEqual({
      "--suite": undefined,
      "--fixture": undefined,
      "--model": undefined,
    });
  });

  it("reads a value for each flag that is present", () => {
    expect(readNamedValueFlags(["--suite", "unit-tests", "--model", "gpt-5"], FLAGS)).toStrictEqual(
      {
        "--suite": "unit-tests",
        "--fixture": undefined,
        "--model": "gpt-5",
      },
    );
  });

  it("returns null as soon as one listed flag is present but missing its value", () => {
    expect(readNamedValueFlags(["--suite", "--fixture", "x"], FLAGS)).toBeNull();
  });

  it("returns null when the offending flag is the last argument", () => {
    expect(readNamedValueFlags(["--suite", "unit-tests", "--model"], FLAGS)).toBeNull();
  });

  it("ignores flags outside the supplied list", () => {
    expect(readNamedValueFlags(["--json", "--live"], FLAGS)).toStrictEqual({
      "--suite": undefined,
      "--fixture": undefined,
      "--model": undefined,
    });
  });
});
