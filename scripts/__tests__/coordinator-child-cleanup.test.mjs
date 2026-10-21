import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const fixture = fileURLToPath(
  new URL("../../tests/fixtures/coordinator-child-cleanup.c", import.meta.url),
);

describe.skipIf(process.platform === "win32")("actual coordinator child cleanup", () => {
  let root;
  let executable;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "keiko-coordinator-cleanup-"));
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

  function run(owner, scenario) {
    const directory = mkdtempSync(join(root, "case-"));
    const result = spawnSync(executable, [owner, String(scenario), directory], {
      encoding: "utf8",
      timeout: 1000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    return JSON.parse(result.stdout);
  }

  describe.each(["reconcile", "probe"])("%s owner", (owner) => {
    it.each([
      ["wait completes at expiry", 1],
      ["wait completes after expiry", 2],
      ["clock fails after consuming the child", 3],
      ["child was already reaped", 4],
      ["child returns a failure status", 7],
    ])("refuses proof without signalling a released identity when %s", (_name, scenario) => {
      expect(run(owner, scenario)).toMatchObject({ admitted: 0, kills: 0, unsafeKills: 0 });
    });

    it.each([
      ["deadline was already reached", 6],
      ["clock is unavailable before spawn", 8],
    ])("does not dispatch when %s", (_name, scenario) => {
      expect(run(owner, scenario)).toMatchObject({ admitted: 0, waits: 0, spawned: 0, kills: 0 });
    });

    it("preserves a successful completion", () => {
      expect(run(owner, 0)).toMatchObject({ admitted: 1, kills: 0, unsafeKills: 0, waits: 1 });
    });

    it("bounds cleanup of a still-owned child that never terminates", () => {
      expect(run(owner, 5)).toMatchObject({ admitted: 0, kills: 1, unsafeKills: 0 });
    });
  });

  it("retains owned cleanup after a malformed reconcile response", () => {
    expect(run("reconcile", 9)).toMatchObject({ admitted: 0, kills: 1, unsafeKills: 0 });
  });
  it.each(["reconcile", "probe"])(
    "retains owned cleanup after %s loses its clock before wait",
    (owner) => {
      expect(run(owner, 10)).toMatchObject({ admitted: 0, kills: 1, unsafeKills: 0 });
    },
  );
});
