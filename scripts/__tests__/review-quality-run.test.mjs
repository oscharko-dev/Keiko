import { describe, expect, it } from "vitest";

import { gateSteps, runGateSteps } from "../testing/review-quality/run.mjs";

describe("offline review gate entry", () => {
  // R4130-039: on Windows the npm step started npm.cmd without a shell, which Node refuses since
  // the CVE-2024-27980 fix, so the gate failed before its build.
  it("shells only the npm step on Windows", () => {
    const steps = gateSteps(["--set", "seeds"], "win32", "C:\\node\\node.exe");

    expect(steps.map((step) => [step.command, step.shell])).toEqual([
      ["npm.cmd", true],
      ["C:\\node\\node.exe", false],
      ["C:\\node\\node.exe", false],
      ["C:\\node\\node.exe", false],
    ]);
  });

  it("starts npm without a shell elsewhere and passes the gate arguments last", () => {
    const steps = gateSteps(["--set", "seeds"], "darwin", "/usr/bin/node");

    expect(steps.map((step) => step.shell)).toEqual([false, false, false, false]);
    expect(steps[0]?.command).toBe("npm");
    expect(steps.at(-1)?.args).toEqual([
      "tests/review-quality/dist/tests/review-quality/gate.js",
      "--set",
      "seeds",
    ]);
  });

  it("stops at the first failing step and returns its status", () => {
    const started = [];
    const spawn = (command, _args, options) => {
      started.push([command, options.shell]);
      return { status: started.length === 2 ? 3 : 0 };
    };

    expect(runGateSteps(gateSteps([], "win32", "node.exe"), spawn)).toBe(3);
    expect(started).toEqual([
      ["npm.cmd", true],
      ["node.exe", false],
    ]);
  });

  it("throws a spawn error instead of reporting success", () => {
    const failure = new Error("spawnSync npm.cmd EINVAL");

    expect(() => runGateSteps(gateSteps([], "win32"), () => ({ error: failure }))).toThrow(failure);
  });
});
