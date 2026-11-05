import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMemoryDir } from "@oscharko-dev/keiko-memory-vault";
import { resolveUiDbPath } from "../../packages/keiko-server/src/store/paths.js";

const realStateRoot = join(homedir(), ".keiko");

// The default-path fallbacks stay reachable for a test that passes its own environment; what must
// never happen is a test that configures nothing landing on the runner's real files.
describe("a test process that configures no state path", () => {
  it("does not resolve the runner's real memory vault", () => {
    expect(resolveMemoryDir(undefined, process.env).startsWith(realStateRoot)).toBe(false);
  });

  it("does not resolve the runner's real UI database", () => {
    expect(resolveUiDbPath(undefined, process.env).startsWith(realStateRoot)).toBe(false);
  });
});
