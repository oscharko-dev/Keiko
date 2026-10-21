import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const fixture = fileURLToPath(
  new URL("../../tests/fixtures/coordinator-owned-wait.c", import.meta.url),
);

describe.skipIf(process.platform === "win32")(
  "actual POSIX coordinator owned-wait deadline",
  () => {
    let root;
    let executable;
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "keiko-coordinator-wait-"));
      executable = join(root, "fixture");
      const result = spawnSync(
        process.platform === "darwin" ? "/usr/bin/clang" : "cc",
        [
          "-std=c17",
          "-D_GNU_SOURCE",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-Wno-deprecated-declarations",
          fixture,
          "-o",
          executable,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
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
      ["owned wait completes exactly at expiry", 1],
      ["owned wait completes after expiry", 2],
      ["owned child is missing", 3],
      ["interruptions exhaust the original deadline", 4],
      ["clock becomes unavailable after wait", 8],
      ["another child identity is returned", 9],
    ])("refuses success when %s", (_name, scenario) => {
      expect(run(scenario).admitted).toBe(0);
    });

    it.each([
      ["deadline has already been reached", 6],
      ["clock is unavailable before wait", 7],
    ])("does not dispatch when %s", (_name, scenario) => {
      expect(run(scenario)).toMatchObject({ admitted: 0, waits: 0 });
    });

    it.each([
      ["owned child exits immediately", 0],
      ["owned wait completes one millisecond before expiry", 5],
      ["interrupted wait completes inside its original grant", 10],
    ])("retains success when %s", (_name, scenario) => {
      expect(run(scenario).admitted).toBe(1);
    });
  },
);
