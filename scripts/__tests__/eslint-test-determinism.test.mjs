import { RuleTester } from "eslint";
import { describe, expect, it } from "vitest";

import { testDeterminismPlugin } from "../lib/eslint-test-determinism.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2024, sourceType: "module" } });
const { rules } = testDeterminismPlugin;

describe("testDeterminismPlugin", () => {
  it("exports exactly the three determinism rules, each a problem with its own message", () => {
    expect(Object.keys(rules).sort()).toEqual([
      "no-fixed-sleep",
      "no-short-hex-negative-substring",
      "no-unguarded-wall-clock-assertion",
    ]);
    for (const rule of Object.values(rules)) {
      expect(rule.meta.type).toBe("problem");
      expect(Object.keys(rule.meta.messages)).toHaveLength(1);
    }
  });
});

tester.run("no-unguarded-wall-clock-assertion", rules["no-unguarded-wall-clock-assertion"], {
  valid: [
    // An injected clock is deterministic.
    "expect(result.durationMs).toBeLessThan(5000);",
    "const elapsed = clock.now() - started; expect(elapsed).toBeLessThan(10);",
    // A clock read that is not compared by size.
    "expect(Date.now()).toEqual(expect.any(Number));",
    // Timestamps ordered against each other do not depend on load.
    "const before = Date.now(); expect(order).toBeGreaterThanOrEqual(before);",
    "expect(order).toBeLessThanOrEqual(Date.now());",
    "const [s] = process.hrtime(); expect(s).toBeGreaterThan(0);",
    // Guarded by the budget switch, in every guard form the repository uses.
    'if (process.env.KEIKO_ENFORCE_WALL_CLOCK_BUDGETS === "1") expect(Date.now() - t).toBeLessThan(5);',
    "ENFORCE_WALL_CLOCK_BUDGETS && expect(performance.now() - t).toBeLessThan(5);",
    'it.skipIf(process.env.KEIKO_ENFORCE_WALL_CLOCK_BUDGETS !== "1")("x", () => { expect(performance.now() - t).toBeLessThan(5); });',
    'it.runIf(process.env.KEIKO_ENFORCE_WALL_CLOCK_BUDGETS === "1")("x", () => { expect(performance.now() - t).toBeLessThan(5); });',
    "if (!ENFORCE_WALL_CLOCK_BUDGETS) {} else { expect(Date.now() - t).toBeLessThan(5); }",
    "!ENFORCE_WALL_CLOCK_BUDGETS || expect(Date.now() - t).toBeLessThan(5);",
    "ENFORCE_WALL_CLOCK_BUDGETS ? expect(Date.now() - t).toBeLessThan(5) : null;",
    // Not an expect chain.
    "assert(Date.now() - t < 5);",
    "check(Date.now()).toBeLessThan(5);",
  ],
  invalid: [
    // CodeRabbit on #4513: the guard's polarity and branch decide, not its mere presence.
    ...[
      "if (ENFORCE_WALL_CLOCK_BUDGETS) {} else { expect(Date.now() - t).toBeLessThan(5); }",
      "ENFORCE_WALL_CLOCK_BUDGETS || expect(Date.now() - t).toBeLessThan(5);",
      'if (process.env.KEIKO_ENFORCE_WALL_CLOCK_BUDGETS !== "1") expect(Date.now() - t).toBeLessThan(5);',
      'it.skipIf(process.env.KEIKO_ENFORCE_WALL_CLOCK_BUDGETS === "1")("x", () => { expect(performance.now() - t).toBeLessThan(5); });',
      "ENFORCE_WALL_CLOCK_BUDGETS ? null : expect(Date.now() - t).toBeLessThan(5);",
      // Only the enabling value "1" enforces the budgets.
      'if (process.env.KEIKO_ENFORCE_WALL_CLOCK_BUDGETS === "0") expect(Date.now() - t).toBeLessThan(5);',
      'it.skipIf(process.env.KEIKO_ENFORCE_WALL_CLOCK_BUDGETS !== "0")("x", () => { expect(performance.now() - t).toBeLessThan(5); });',
    ].map((code) => ({ code, errors: [{ messageId: "unguarded" }] })),
    {
      code: "expect(Date.now() - started).toBeLessThan(5000);",
      errors: [{ messageId: "unguarded" }],
    },
    {
      code: "expect(performance.now() - t).toBeLessThanOrEqual(500);",
      errors: [{ messageId: "unguarded" }],
    },
    {
      code: "const elapsed = performance.now() - started; expect(elapsed).toBeLessThan(2000);",
      errors: [{ messageId: "unguarded" }],
    },
    {
      code: "const [s] = process.hrtime(start); expect(s).toBeGreaterThan(1);",
      errors: [{ messageId: "unguarded" }],
    },
    {
      code: "const t = process.hrtime.bigint(); expect(t - t0).toBeGreaterThanOrEqual(1n);",
      errors: [{ messageId: "unguarded" }],
    },
    // The clock read on the matcher side, and through `.not` and `expect.soft`.
    {
      code: "expect(budget).toBeGreaterThan(Date.now() - t);",
      errors: [{ messageId: "unguarded" }],
    },
    {
      code: "expect(Date.now() - t).not.toBeGreaterThan(5);",
      errors: [{ messageId: "unguarded" }],
    },
    { code: "expect.soft(Date.now() - t).toBeLessThan(5);", errors: [{ messageId: "unguarded" }] },
    // A condition that does not name the budget switch is no guard.
    {
      code: "if (process.env.CI) expect(Date.now() - t).toBeLessThan(5);",
      errors: [{ messageId: "unguarded" }],
    },
  ],
});

tester.run("no-fixed-sleep", rules["no-fixed-sleep"], {
  valid: [
    // Yielding one turn of the event loop is not a timed wait.
    "await new Promise((resolve) => setTimeout(resolve, 0));",
    // A timer that is not the promise's resolve: a delayed fixture answer, a timeout guard.
    "await new Promise((resolve) => setTimeout(() => respond(), 50));",
    "setTimeout(resolve, 100);",
    "const timer = setTimeout(abort, 1000);",
    // A delay taken from a named bound is outside this rule's literal check.
    "await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));",
    // A local function called setTimeout that is not the timers/promises one.
    "const setTimeout = (n) => n; await setTimeout(10);",
    "await page.waitForTimeout(0);",
    // Polling a condition with a short pause between checks is awaiting the condition.
    'import { setTimeout as delay } from "node:timers/promises"; while (!ready()) await delay(20);',
    "for (let i = 0; i < 50 && !done; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));",
    'import { setTimeout as delay } from "node:timers/promises"; for (let i = 0; i < 50; i += 1) { if (await ready()) break; await delay(20); }',
    "await page.waitForSelector('#x');",
  ],
  invalid: [
    {
      code: "await new Promise((resolve) => setTimeout(resolve, 50));",
      errors: [{ messageId: "fixedSleep" }],
    },
    {
      code: "await new Promise((r) => { setTimeout(r, 1_000); });",
      errors: [{ messageId: "fixedSleep" }],
    },
    {
      // The loop is outside the sleeping function, so it does not re-check a condition here.
      code: "for (const step of steps) { step(); } const pause = () => new Promise((resolve) => setTimeout(resolve, 5)); while (x) { await pause(); }",
      errors: [{ messageId: "fixedSleep" }],
    },
    {
      code: "await new Promise(function (done) { setTimeout(() => done(), 25); });",
      errors: [{ messageId: "fixedSleep" }],
    },
    {
      code: 'import { setTimeout as sleep } from "node:timers/promises"; await sleep(100);',
      errors: [{ messageId: "fixedSleep" }],
    },
    {
      code: 'import { setTimeout } from "timers/promises"; await setTimeout(10);',
      errors: [{ messageId: "fixedSleep" }],
    },
    { code: "await page.waitForTimeout(500);", errors: [{ messageId: "fixedSleep" }] },
    {
      // CodeRabbit on #4513: a loop that only counts sleeps a fixed total time.
      code: 'import { setTimeout as delay } from "node:timers/promises"; for (let i = 0; i < 10; i++) await delay(100);',
      errors: [{ messageId: "fixedSleep" }],
    },
    {
      code: "for (const step of steps) { step(); await new Promise((resolve) => setTimeout(resolve, 50)); }",
      errors: [{ messageId: "fixedSleep" }],
    },
  ],
});

tester.run("no-short-hex-negative-substring", rules["no-short-hex-negative-substring"], {
  valid: [
    // A positive match cannot fail by chance.
    'expect(prompt).toContain("9999");',
    // Long enough, or not hexadecimal, so a digest cannot carry it by chance.
    'expect(prompt).not.toContain("75000");',
    'expect(prompt).not.toContain("123456789");',
    'expect(prompt).not.toContain("Unverified interval");',
    'expect(prompt).not.toContain("secret");',
    // Word boundaries, as #4481 repaired it.
    "expect(prompt).not.toMatch(/\\b9999\\b/u);",
    'notExpect(prompt).not.toContain("ab");',
    // Element equality on an evident array.
    'expect(["a", "b"]).not.toContain("c");',
    'expect(findings.map((f) => f.id)).not.toContain("D7");',
    'expect(line.split(" ")).not.toContain("ab");',
  ],
  invalid: [
    { code: 'expect(prompt).not.toContain("9999");', errors: [{ messageId: "shortHex" }] },
    { code: 'expect(text).not.toContain("BEEF");', errors: [{ messageId: "shortHex" }] },
    { code: 'expect(text).not.toMatch("a1");', errors: [{ messageId: "shortHex" }] },
    { code: 'expect.soft(text).not.toContain("f");', errors: [{ messageId: "shortHex" }] },
  ],
});
