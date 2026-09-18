import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FAILURE_SURFACE_INVENTORY_RELATIVE_PATH } from "../lib/activity-log-failure-surfaces.mjs";
import { activityLogScenarioFiles, main, vitestRunner } from "../run-activity-log-scenarios.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CRASH_SCENARIO = "tests/activity-log-scenarios/lifecycle-crash.test.ts";
const LOSS_SCENARIO = "tests/activity-log-scenarios/bff.test.ts";

function quietMain(readInventory, passed = true) {
  const lines = [];
  const runs = [];
  const code = main({
    readInventory,
    run: (files) => {
      runs.push(files);
      return passed;
    },
    write: (line) => lines.push(line),
  });
  return { code, lines, runs };
}

describe("activity-log scenario execution", () => {
  it("runs each resolved scenario file exactly once, in codepoint order", () => {
    expect(
      activityLogScenarioFiles({
        scenarios: {
          "lifecycle-crash.crash": [CRASH_SCENARIO],
          "bff.loss": [LOSS_SCENARIO, CRASH_SCENARIO],
          "ui.rejection": [],
        },
      }),
    ).toEqual([LOSS_SCENARIO, CRASH_SCENARIO]);
  });

  it("derives its file set from the checked-in inventory, not from a second discovery", () => {
    const checkedIn = JSON.parse(
      readFileSync(join(repoRoot, FAILURE_SURFACE_INVENTORY_RELATIVE_PATH), "utf8"),
    );
    expect(new Set(activityLogScenarioFiles(checkedIn))).toEqual(
      new Set(Object.values(checkedIn.scenarios).flat()),
    );
  });

  it.each([
    ["a missing scenarios map", { proofs: {} }],
    ["a scenarios list", { scenarios: [CRASH_SCENARIO] }],
    ["a non-test path", { scenarios: { "bff.loss": ["packages/keiko-server/src/server.ts"] } }],
    ["an escaping path", { scenarios: { "bff.loss": ["../outside/evil.test.ts"] } }],
    ["a non-array entry", { scenarios: { "bff.loss": CRASH_SCENARIO } }],
  ])("fails closed on %s", (_label, value) => {
    expect(() => activityLogScenarioFiles(value)).toThrow(TypeError);
  });

  it("passes only when the resolved scenarios ran green", () => {
    const green = quietMain(() => ({ scenarios: { "lifecycle-crash.crash": [CRASH_SCENARIO] } }));
    expect(green.code).toBe(0);
    expect(green.runs).toEqual([[CRASH_SCENARIO]]);
    expect(green.lines.at(-1)).toMatch(/^activity-log scenarios PASS — ran the 1 scenario test/u);
    const red = quietMain(
      () => ({ scenarios: { "lifecycle-crash.crash": [CRASH_SCENARIO] } }),
      false,
    );
    expect(red.code).toBe(1);
    expect(red.lines.at(-1)).toMatch(/^activity-log scenarios FAIL/u);
  });

  it("fails when the inventory resolves no scenario instead of passing vacuously", () => {
    const empty = quietMain(() => ({ scenarios: { "lifecycle-crash.crash": [] } }));
    expect(empty.code).toBe(1);
    expect(empty.runs).toEqual([]);
  });

  it("reads the checked-in inventory by default", () => {
    const checkedIn = JSON.parse(
      readFileSync(join(repoRoot, FAILURE_SURFACE_INVENTORY_RELATIVE_PATH), "utf8"),
    );
    const runs = [];
    main({ run: (files) => runs.push(files) > 0, write: () => undefined });
    expect(runs).toEqual([activityLogScenarioFiles(checkedIn)]);
  });

  it("runs the repository's vitest without a shell and accepts only a clean exit", () => {
    const calls = [];
    const outcome = (result) =>
      vitestRunner((command, args, options) => {
        calls.push({ command, args, options });
        return result;
      })([CRASH_SCENARIO]);
    expect(outcome({ status: 0, signal: null })).toBe(true);
    expect(calls[0].command).toBe(process.execPath);
    expect(calls[0].args.slice(-2)).toEqual(["run", CRASH_SCENARIO]);
    expect(calls[0].args[0]).toBe(join(repoRoot, "node_modules", "vitest", "vitest.mjs"));
    expect(calls[0].options).toEqual({ cwd: repoRoot, shell: false, stdio: "inherit" });
    expect(outcome({ status: 1, signal: null })).toBe(false);
    expect(outcome({ status: null, signal: "SIGKILL" })).toBe(false);
    expect(outcome({ status: null, signal: null, error: new Error("spawn failed") })).toBe(false);
  });
});
