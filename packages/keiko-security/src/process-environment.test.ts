import { afterEach, describe, expect, it, vi } from "vitest";
import { environmentVariableNames, environmentVariableValue } from "./process-environment.js";

afterEach(() => vi.restoreAllMocks());

describe("shared process environment lookup (#4408)", () => {
  it.each(["darwin", "linux"] as const)("retains exact names on %s", (platform) => {
    const env = { Path: "mixed", PATH: "upper" };
    expect(environmentVariableNames(env, "Path", platform)).toEqual(["Path"]);
    expect(environmentVariableValue(env, "Path", platform)).toBe("mixed");
    expect(environmentVariableValue(env, "path", platform)).toBeUndefined();
  });

  it.each([
    { path: "lower", PATH: "upper", Path: "mixed" },
    { Path: "mixed", PATH: "upper", path: "lower" },
  ])("selects Windows aliases by code-unit order, never insertion order", (env) => {
    expect(environmentVariableNames(env, "pAtH", "win32")).toEqual(["PATH", "Path", "path"]);
    expect(environmentVariableValue(env, "pAtH", "win32")).toBe("upper");
  });

  it("reads the actual platform by default and preserves an undefined first alias", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(environmentVariableNames({ Path: "mixed" }, "PATH")).toEqual(["Path"]);
    expect(environmentVariableValue({ PATH: undefined, Path: "mixed" }, "PATH")).toBeUndefined();
    expect(environmentVariableValue({}, "PATH")).toBeUndefined();
  });
});
