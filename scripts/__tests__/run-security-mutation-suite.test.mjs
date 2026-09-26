import { describe, expect, it, vi } from "vitest";

import {
  runSecurityMutationSuite,
  securityMutationSteps,
} from "../run-security-mutation-suite.mjs";

describe("security mutation suite runner", () => {
  it("runs both Stryker reports and both repository ratchets", () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    const log = vi.fn();

    expect(runSecurityMutationSuite({ error: vi.fn(), log, spawn })).toBe(0);

    expect(spawn).toHaveBeenCalledTimes(4);
    expect(securityMutationSteps.map((step) => step.label)).toEqual([
      "general security mutation run",
      "debug-launch security mutation run",
      "general security mutation baseline ratchet",
      "debug-launch security mutation strict ratchet",
    ]);
    expect(spawn.mock.calls.map(([, args]) => args.join(" "))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("stryker.security.conf.json"),
        expect.stringContaining("stryker.debug-launch.security.conf.json"),
        "scripts/check-mutation-quality.mjs",
      ]),
    );
    expect(spawn.mock.calls[3]?.[1]).toEqual([
      "scripts/check-mutation-quality.mjs",
      "--strict",
      "--report",
      "reports/mutation/debug-launch-security/mutation-report.json",
      "--minimum-score",
      "100",
      "--maximum-survived",
      "0",
      "--maximum-no-coverage",
      "0",
    ]);
    expect(log).toHaveBeenCalledWith(
      "mutation-security: PASS - debug-launch security mutation strict ratchet",
    );
  });

  it("does not short-circuit when an earlier Stryker run fails", () => {
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce({ status: 0 });
    const error = vi.fn();

    expect(runSecurityMutationSuite({ error, log: vi.fn(), spawn })).toBe(1);

    expect(spawn).toHaveBeenCalledTimes(4);
    expect(error).toHaveBeenCalledWith(
      "mutation-security: FAIL - general security mutation run; general security mutation baseline ratchet",
    );
  });

  it("uses default sinks and treats a spawn without an exit status as failed", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(runSecurityMutationSuite({ spawn: vi.fn(() => ({ status: null })) })).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("mutation-security: FAIL"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("mutation-security: RUN"));
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
