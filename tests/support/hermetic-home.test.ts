import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMemoryDbPath } from "@oscharko-dev/keiko-memory-vault";

describe("hermetic test home", () => {
  it("does not resolve the home directory of the account running the suite", () => {
    expect(homedir()).not.toBe(userInfo().homedir);
    expect(homedir()).toMatch(/keiko-test-home-/u);
  });

  it("keeps the memory vault's default path inside that home", () => {
    const env = { ...process.env };
    delete env["KEIKO_MEMORY_DIR"];
    delete env["KEIKO_STATE_DIR"];
    expect(resolveMemoryDbPath(undefined, env)).toBe(
      join(homedir(), ".keiko", "memory", "keiko-memory.db"),
    );
  });
});
