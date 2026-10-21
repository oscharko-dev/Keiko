import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const native = fileURLToPath(new URL("../../native/runtime-supervisor/macos/", import.meta.url));
const fixture = fileURLToPath(
  new URL("../../tests/fixtures/macos-supervisor-owned-wait.c", import.meta.url),
);

describe.skipIf(process.platform === "win32")("actual macOS supervisor owned-child proof", () => {
  let root;
  let executable;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "keiko-owned-wait-"));
    executable = join(root, "fixture");
    const compiled = spawnSync(
      process.platform === "darwin" ? "/usr/bin/clang" : "cc",
      ["-std=c17", "-Wall", "-Wextra", "-Werror", "-I", native, fixture, "-o", executable],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(compiled.error).toBeUndefined();
    expect(compiled.status, compiled.stderr).toBe(0);
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
    ["owned child unavailable", 1],
    ["unexpected child identity", 2],
    ["interruption exhausts the original wait deadline", 4],
    ["wait completes exactly at expiry", 6],
    ["wait completes after expiry", 7],
    ["monotonic clock unavailable", 8],
    ["child is stopped rather than terminated", 11],
    ["actual owned child has already been reaped", 22],
  ])("refuses a reaped proof when %s", (_name, scenario) => {
    expect(run(scenario)).toMatchObject({ accepted: 0, frames: 0 });
  });

  it.each([
    ["observed child exits", 0, 7],
    ["interruption is followed by the owned exit", 3, 7],
    ["owned child is pending before exit", 5, 7],
    ["owned wait finishes one millisecond before expiry", 9, 7],
    ["owned child is terminated by a signal", 10, 137],
    ["actual owned child exits", 20, 7],
    ["actual owned child is terminated by a signal", 21, 137],
  ])("preserves success when %s", (_name, scenario, exitStatus) => {
    expect(run(scenario)).toMatchObject({ accepted: 1, frames: 1, kind: 2, exitStatus });
  });
});
