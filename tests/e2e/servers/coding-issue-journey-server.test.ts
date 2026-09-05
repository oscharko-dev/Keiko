// #3390 audit F15: the launched-process-env helper is the only pure, directly testable piece of
// this harness entry point -- the rest of the file launches the real `keiko ui` production
// composition and is exercised by the live Playwright lane itself, never by a unit test. This
// proves the resolved, already-validated spend budget is threaded into the launched process env
// as the exact validated number, not a re-parse of the original (possibly differently formatted)
// environment string.
import { describe, expect, it } from "vitest";

import { launchedEnv } from "./coding-issue-journey-server.mjs";

describe("launchedEnv", () => {
  it("threads the resolved spend budget into the launched process env", () => {
    const result = launchedEnv({ PATH: "/usr/bin", KEIKO_QUALIFICATION_SPEND_BUDGET_USD: "bogus" }, 25);
    expect(result.KEIKO_QUALIFICATION_SPEND_BUDGET_USD).toBe("25");
    expect(result.PATH).toBe("/usr/bin");
  });

  it("does not mutate the base env", () => {
    const base = { KEIKO_QUALIFICATION_SPEND_BUDGET_USD: "10" };
    launchedEnv(base, 40);
    expect(base.KEIKO_QUALIFICATION_SPEND_BUDGET_USD).toBe("10");
  });
});
