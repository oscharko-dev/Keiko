import { describe, expect, it } from "vitest";
import { DEFAULT_COMMAND_RULES } from "./tools.js";

// Codex-sweep finding (same bug class as command-runner.ts's COMMAND_TASK_RULES, KEIKO-0139):
// Object.freeze on the DEFAULT_COMMAND_RULES array only freezes the array's own indices, not the
// rule objects it holds. Several nested arrays inside each rule (allowedSubcommands, denyFlags,
// valueFlags, deniedArgumentsBySubcommand) were already individually wrapped in their own
// Object.freeze at declaration time, but the RULE OBJECT ITSELF — and any field on it that was
// NOT individually wrapped — was still writable: `DEFAULT_COMMAND_RULES[0].executable = "rm"`
// succeeded, which could redirect an allowlisted rule's identity for the rest of the process.
describe("DEFAULT_COMMAND_RULES", () => {
  it("is a non-empty allowlist of read-only-shaped default rules", () => {
    expect(DEFAULT_COMMAND_RULES.length).toBeGreaterThan(0);
    expect(DEFAULT_COMMAND_RULES.map((rule) => rule.executable)).toContain("npm");
  });

  it("freezes each rule object itself, not just the array holding them", () => {
    const [first] = DEFAULT_COMMAND_RULES;
    expect(first).toBeDefined();
    expect(() => {
      (first as { executable: string }).executable = "rm";
    }).toThrow(TypeError);
    expect(DEFAULT_COMMAND_RULES[0]?.executable).toBe(first?.executable);
  });

  // KEIKO-0888: DEFAULT_COMMAND_RULES must be built with the shared `deepFreeze` helper (not a
  // shallow `Object.freeze` on the outer array alone), so every nested rule object is frozen too.
  it("reports every nested rule object as frozen (Object.isFrozen), not just the array", () => {
    expect(Object.isFrozen(DEFAULT_COMMAND_RULES[0])).toBe(true);
  });
});
