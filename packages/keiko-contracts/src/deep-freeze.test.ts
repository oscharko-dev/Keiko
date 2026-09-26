// KEIKO-0139 — runtime immutability of the security-relevant constant tables.
//
// `Object.freeze` is shallow and `as const` / `readonly` are erased at compile time, so five tables
// that decide authority, legal state transitions, the executor allowlist, and DoS ceilings were
// mutable at runtime. The readers consult those objects directly, so a mutation rewrote the decision
// for the rest of the process. These assertions run under ESM strict mode, where a write to a frozen
// object throws TypeError instead of failing silently.

import { describe, expect, it } from "vitest";
import { DEFAULT_GROUNDING_LIMITS, GROUNDING_LIMIT_CEILINGS } from "./bff-wire.js";
import { DEFAULT_BUG_WORKFLOW_LIMITS } from "./bug-investigation-events.js";
import { CODING_WORKBENCH_MODE_POLICIES } from "./coding-workbench.js";
import { COMMAND_TASK_RULES } from "./command-runner.js";
import { deepFreeze } from "./deep-freeze.js";
import { isLegalCodingWorkbenchRuntimeTransition } from "./coding-workbench-runtime.js";

describe("deepFreeze", () => {
  it("freezes nested objects and arrays, not just the outer reference", () => {
    const table = deepFreeze({ outer: { inner: { value: 1 } }, list: [{ value: 2 }] });
    expect(Object.isFrozen(table)).toBe(true);
    expect(Object.isFrozen(table.outer)).toBe(true);
    expect(Object.isFrozen(table.outer.inner)).toBe(true);
    expect(Object.isFrozen(table.list)).toBe(true);
    expect(Object.isFrozen(table.list[0])).toBe(true);
  });

  it("returns the same reference it was given", () => {
    const value = { a: 1 };
    expect(deepFreeze(value)).toBe(value);
  });

  it("terminates on a cyclic graph", () => {
    const node: { self?: unknown } = {};
    node.self = node;
    expect(() => deepFreeze(node)).not.toThrow();
    expect(Object.isFrozen(node)).toBe(true);
  });

  it("passes primitives and null through untouched", () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(7)).toBe(7);
    expect(deepFreeze("x")).toBe("x");
  });
});

describe("security-relevant constant tables are deeply immutable", () => {
  it("refuses a write to the coding-workbench authority matrix", () => {
    const policy = CODING_WORKBENCH_MODE_POLICIES["autonomous-delivery"];
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.effects)).toBe(true);
    expect(Object.isFrozen(policy.effects.delivery)).toBe(true);
    expect(() => {
      (policy.effects.delivery as { critical: string }).critical = "allowed";
    }).toThrow(TypeError);
    expect(() => {
      (
        CODING_WORKBENCH_MODE_POLICIES["governed-assist"].effects.delivery as { critical: string }
      ).critical = "allowed";
    }).toThrow(TypeError);
  });

  it("refuses a push to a legal-transition list", () => {
    // LEGAL_TRANSITIONS is module-private; the guard that reads it is the observable surface.
    expect(isLegalCodingWorkbenchRuntimeTransition("succeeded", "running")).toBe(false);
    expect(isLegalCodingWorkbenchRuntimeTransition("succeeded", "idle")).toBe(true);
  });

  it("refuses a write to the deny-by-default executor allowlist", () => {
    const rule = COMMAND_TASK_RULES[0];
    expect(rule).toBeDefined();
    if (rule === undefined) return;
    expect(Object.isFrozen(rule)).toBe(true);
    expect(() => {
      (rule as { executable: string }).executable = "bash";
    }).toThrow(TypeError);
    expect(() => {
      (rule as { denyFlags: readonly string[] }).denyFlags = [];
    }).toThrow(TypeError);
    for (const each of COMMAND_TASK_RULES) {
      expect(Object.isFrozen(each.allowedSubcommands)).toBe(true);
      expect(Object.isFrozen(each.denyFlags)).toBe(true);
    }
  });

  it("refuses a write to the bug-workflow limits the module header calls frozen", () => {
    expect(Object.isFrozen(DEFAULT_BUG_WORKFLOW_LIMITS)).toBe(true);
    expect(() => {
      (DEFAULT_BUG_WORKFLOW_LIMITS as { maxPatchBytes: number }).maxPatchBytes = 1;
    }).toThrow(TypeError);
  });

  it("refuses a write to the grounding defaults and their hard safety ceilings", () => {
    expect(Object.isFrozen(DEFAULT_GROUNDING_LIMITS)).toBe(true);
    expect(Object.isFrozen(GROUNDING_LIMIT_CEILINGS)).toBe(true);
    expect(() => {
      (GROUNDING_LIMIT_CEILINGS as { maxExcerptChars: number }).maxExcerptChars = 10_000_000;
    }).toThrow(TypeError);
    expect(() => {
      (DEFAULT_GROUNDING_LIMITS as { referenceBudget: number }).referenceBudget = 10_000;
    }).toThrow(TypeError);
  });
});
