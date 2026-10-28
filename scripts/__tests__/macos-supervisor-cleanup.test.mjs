import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileMacOwnedWaitFixture } from "./support/macos-owned-wait-fixture.mjs";

const source = fileURLToPath(
  new URL("../../native/runtime-supervisor/macos/keiko_runtime_supervisor.c", import.meta.url),
);

describe.skipIf(process.platform === "win32")(
  "actual supervisor main and consumed root cleanup",
  () => {
    let root;
    let executable;
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "keiko-supervisor-cleanup-"));
      executable = compileMacOwnedWaitFixture(root, readFileSync(source, "utf8"));
    });
    afterAll(() => {
      if (root !== undefined) rmSync(root, { recursive: true, force: true });
    });

    function run(scenario) {
      const result = spawnSync(executable, [String(scenario)], {
        encoding: "utf8",
        timeout: 3000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      return JSON.parse(result.stdout);
    }

    it.each([
      ["terminal wait reaches expiry", 1],
      ["terminal wait exceeds expiry", 2],
      ["reaped response cannot be written", 3],
      ["child is already reaped", 4],
      ["clock fails after consuming the child", 8],
    ])("does not signal a consumed or unknown PID when %s", (_name, scenario) => {
      expect(run(scenario)).toMatchObject({ exitCode: 1, kills: 0, unsafeKills: 0, stops: 1 });
    });

    it.each([
      ["still-owned child times out", 5],
      ["monitor reply fails before reaping", 6],
      ["launch response fails before reaping", 7],
    ])("retains owned cleanup when %s", (_name, scenario) => {
      expect(run(scenario)).toMatchObject({ exitCode: 1, kills: 1, unsafeKills: 0, stops: 1 });
    });

    it("preserves a successful reaped response without cleanup signals", () => {
      expect(run(0)).toMatchObject({ exitCode: 0, kills: 0, unsafeKills: 0, reapedFrames: 1 });
    });
  },
);
