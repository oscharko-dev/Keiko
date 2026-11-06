import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveMemoryDir } from "@oscharko-dev/keiko-memory-vault";
import { resolveUiDbPath } from "../../packages/keiko-server/src/store/paths.js";

// `userInfo` reads the account database, so it names the runner's home whatever `homedir` answers.
const realStateRoot = join(userInfo().homedir, ".keiko");

describe.each([
  ["its own environment", process.env],
  ["an empty environment", {}],
])("a test process that configures no state path, with %s", (_name, env) => {
  it("does not resolve the runner's real memory vault", () => {
    expect(resolveMemoryDir(undefined, env).startsWith(realStateRoot)).toBe(false);
  });

  it("does not resolve the runner's real UI database", () => {
    expect(resolveUiDbPath(undefined, env).startsWith(realStateRoot)).toBe(false);
  });
});

describe("homedir in a test process", () => {
  it("is not the runner's home", () => {
    expect(homedir()).not.toBe(userInfo().homedir);
  });

  it("follows a test that sets HOME itself", () => {
    vi.stubEnv("HOME", "/synthetic/home");
    try {
      expect(homedir()).toBe("/synthetic/home");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
