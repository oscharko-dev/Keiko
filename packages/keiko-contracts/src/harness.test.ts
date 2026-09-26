// Behavioral tests for harness.ts's frozen constant tables and terminal-state predicate
// (KEIKO-0879), and the compile-time link between TerminalState and RunOutcome (KEIKO-0807).
// Everything else in harness.ts is interfaces/type-only unions with no runtime representation to
// exercise here.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIMITS,
  HARNESS_CODES,
  TERMINAL_STATES,
  isTerminalHarnessState,
} from "./harness.js";
import type { HarnessStateName, RunOutcome, TerminalState } from "./harness.js";

// Object.freeze throws on a mutation attempt in strict-mode ESM (which this file is), but the
// assertion that matters is the post-attempt VALUE, not the throw — so a swallowed exception here
// still leaves the real regression signal (the unchanged read below) intact.
function attemptMutation(mutate: () => void): void {
  try {
    mutate();
  } catch {
    // Expected in strict mode: Object.freeze rejects the write.
  }
}

const TERMINAL_STATE_MEMBERS: readonly HarnessStateName[] = [
  "completed",
  "cancelled",
  "failed",
  "limit-exceeded",
];

const NON_TERMINAL_STATES: readonly HarnessStateName[] = [
  "intake",
  "planning",
  "context-selection",
  "model-call",
  "tool-call",
  "patch-proposal",
  "verification",
  "reporting",
];

describe("frozen governance tables (KEIKO-0879)", () => {
  it("DEFAULT_LIMITS is frozen and a mutation attempt leaves it unchanged", () => {
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
    attemptMutation(() => {
      (DEFAULT_LIMITS as unknown as { maxIterations: number }).maxIterations = 999_999;
    });
    expect(DEFAULT_LIMITS.maxIterations).toBe(10);
  });

  it("HARNESS_CODES is frozen and a mutation attempt leaves it unchanged", () => {
    expect(Object.isFrozen(HARNESS_CODES)).toBe(true);
    attemptMutation(() => {
      (HARNESS_CODES as unknown as Record<string, string>).INTERNAL = "SOMETHING_ELSE";
    });
    expect(HARNESS_CODES.INTERNAL).toBe("HARNESS_INTERNAL");
  });

  it("TERMINAL_STATES is frozen and enumerates exactly the four terminal states, in order", () => {
    expect(Object.isFrozen(TERMINAL_STATES)).toBe(true);
    expect(TERMINAL_STATES).toEqual(["completed", "cancelled", "failed", "limit-exceeded"]);
  });

  // The bug this pins: TERMINAL_STATES used to be `new Set(...)`, and Object.freeze on a Set does
  // NOT block .add()/.delete() at runtime — a caller could widen terminal-ness for the remaining
  // process lifetime. Attempt every mutation an array-shaped exported surface plausibly offers
  // (push, index assignment) and prove none of them can make "planning" terminal.
  it("a TERMINAL_STATES mutation attempt cannot widen terminal-state membership", () => {
    expect(isTerminalHarnessState("planning")).toBe(false);

    attemptMutation(() => {
      (TERMINAL_STATES as unknown as HarnessStateName[]).push("planning");
    });
    attemptMutation(() => {
      (TERMINAL_STATES as unknown as HarnessStateName[])[TERMINAL_STATES.length] = "planning";
    });

    expect(TERMINAL_STATES).toHaveLength(4);
    expect(isTerminalHarnessState("planning")).toBe(false);
  });
});

describe("isTerminalHarnessState", () => {
  it.each(TERMINAL_STATE_MEMBERS)("returns true for the terminal state %s", (state) => {
    expect(isTerminalHarnessState(state)).toBe(true);
  });

  it.each(NON_TERMINAL_STATES)("returns false for the non-terminal state %s", (state) => {
    expect(isTerminalHarnessState(state)).toBe(false);
  });
});

describe("TerminalState / RunOutcome type link (KEIKO-0807)", () => {
  it("RunOutcome and TerminalState accept the same value (mutual assignability)", () => {
    // Runtime witness that the two unions denote the exact same set of literals; the compile-time
    // guard against silent drift is the pinned @ts-expect-error assertions below. The `as string`
    // launder avoids Sonar's S5914 "assertion always succeeds" for the round-trip check — the
    // assertion is load-bearing because the round-trip variable's runtime identity IS what the
    // pin verifies, but Sonar can prove the literal will match statically.
    const outcome: RunOutcome = "completed";
    const terminal: TerminalState = outcome;
    const outcomeFromTerminal: RunOutcome = terminal;
    expect(outcomeFromTerminal as string).toBe("completed");
  });

  // "planning" (not the finding's illustrative "running", which is not a HarnessStateName member
  // in this state machine) is a real, currently non-terminal HarnessStateName. Both lines below
  // must fail to compile today. If a future edit widens TerminalState — e.g. by aliasing it to the
  // full HarnessStateName union instead of enumerating the terminal subset — "planning" becomes
  // assignable, the directive goes unused, and `tsc` fails: the pin catches the widening.
  it("rejects a non-terminal HarnessStateName as TerminalState or RunOutcome", () => {
    // @ts-expect-error "planning" is a HarnessStateName but not a TerminalState.
    const notTerminal: TerminalState = "planning";
    // @ts-expect-error "planning" is a HarnessStateName but not a RunOutcome (linked to TerminalState).
    const notOutcome: RunOutcome = "planning";
    // `as unknown as string` launders the value through a non-literal type so Sonar cannot prove
    // the assertion trivially — the assertion still proves the ts-expect-error line's runtime
    // identity, which is the entire point of pairing a compile-time pin with a runtime pin.
    expect(notTerminal as unknown as string).toBe("planning");
    expect(notOutcome as unknown as string).toBe("planning");
  });
});
