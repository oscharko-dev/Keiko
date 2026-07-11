import { describe, expect, it } from "vitest";

import { canonicalizeWindowsPath, restoreWindowsPath } from "./process-environment.js";

describe("canonicalizeWindowsPath", () => {
  it("copies the case-insensitive Windows Path key for worker-thread consumers", () => {
    const environment: NodeJS.ProcessEnv = { Path: "C:\\node;C:\\npm" };

    canonicalizeWindowsPath(environment, "win32");

    expect(environment.PATH).toBe("C:\\node;C:\\npm");
    expect(environment.Path).toBeUndefined();
  });

  it("does not replace an explicit PATH value", () => {
    const environment: NodeJS.ProcessEnv = { PATH: "trusted", Path: "fallback" };

    canonicalizeWindowsPath(environment, "win32");

    expect(environment.PATH).toBe("trusted");
    expect(environment.Path).toBeUndefined();
  });

  it("does not add PATH on POSIX hosts", () => {
    const environment: NodeJS.ProcessEnv = { Path: "windows-only" };

    canonicalizeWindowsPath(environment, "linux");

    expect(environment.PATH).toBeUndefined();
  });

  it("restores a captured Windows PATH after a test framework deletes every casing", () => {
    const environment: NodeJS.ProcessEnv = {};

    canonicalizeWindowsPath(environment, "win32", "C:\\node;C:\\npm");

    expect(environment.PATH).toBe("C:\\node;C:\\npm");
  });

  it("replaces a stale stub path with the captured Windows worker path", () => {
    const environment: NodeJS.ProcessEnv = {
      PATH: "C:\\temporary-fake-bin",
      Path: "C:\\stale-system-bin",
    };

    restoreWindowsPath(environment, "C:\\node;C:\\npm", "win32");

    expect(environment.PATH).toBe("C:\\node;C:\\npm");
    expect(environment.Path).toBeUndefined();
  });
});
