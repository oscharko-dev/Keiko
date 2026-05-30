import { describe, expect, it } from "vitest";
import { isCommandAllowed } from "../../src/tools/index.js";
import { VERIFICATION_COMMAND_RULES } from "../../src/verification/orchestrator.js";
import { buildVerificationPlan, resolveTargetedTests } from "../../src/verification/plan.js";
import type { ScriptCatalog } from "../../src/verification/types.js";
import { makeWorkspace } from "./_support.js";

function catalogOf(mapping: Partial<ScriptCatalog["mapping"]>): ScriptCatalog {
  return {
    scripts: {},
    mapping: {
      test: mapping.test,
      typecheck: mapping.typecheck,
      lint: mapping.lint,
      build: mapping.build,
    },
  };
}

describe("buildVerificationPlan", () => {
  it("emits a step per script-backed kind in run order", () => {
    const ws = makeWorkspace();
    const plan = buildVerificationPlan(
      ws.info,
      catalogOf({ test: "test", typecheck: "typecheck", lint: "lint", build: "build" }),
    );
    expect(plan.steps.map((s) => s.kind)).toEqual(["typecheck", "lint", "test", "build"]);
    expect(plan.workspaceRoot).toBe(ws.info.root);
  });

  it("uses `npm test` for the test kind and `npm run <script>` for the rest", () => {
    const ws = makeWorkspace();
    const plan = buildVerificationPlan(
      ws.info,
      catalogOf({ test: "test", lint: "lint", typecheck: "typecheck", build: "build" }),
    );
    const test = plan.steps.find((s) => s.kind === "test");
    const lint = plan.steps.find((s) => s.kind === "lint");
    expect(test?.args).toEqual(["test"]);
    expect(lint?.args).toEqual(["run", "lint"]);
  });

  it("marks a kind skipped (with reason, no scriptName) when no script is detected (D4)", () => {
    const ws = makeWorkspace();
    const plan = buildVerificationPlan(ws.info, catalogOf({ test: "test" }));
    const lint = plan.steps.find((s) => s.kind === "lint");
    expect(lint?.scriptName).toBeUndefined();
    expect(lint?.skipReason).toContain("no lint script");
  });

  it("honours --only by including only the requested kinds", () => {
    const ws = makeWorkspace();
    const plan = buildVerificationPlan(
      ws.info,
      catalogOf({ test: "test", typecheck: "typecheck", lint: "lint", build: "build" }),
      { only: ["typecheck", "test"] },
    );
    expect(plan.steps.map((s) => s.kind)).toEqual(["typecheck", "test"]);
  });

  it("merges per-step limit overrides over the defaults", () => {
    const ws = makeWorkspace();
    const plan = buildVerificationPlan(ws.info, catalogOf({ test: "test" }), {
      only: ["test"],
      limits: { wallTimeMs: 5_000, maxMemoryBytes: 256 * 1024 * 1024 },
    });
    const test = plan.steps[0];
    expect(test?.limits.wallTimeMs).toBe(5_000);
    expect(test?.limits.maxMemoryBytes).toBe(256 * 1024 * 1024);
    expect(test?.limits.maxOutputBytes).toBe(1_048_576);
    expect(test?.limits.network).toBe("none");
  });
});

describe("resolveTargetedTests", () => {
  it("finds a sibling test file and builds a vitest run invocation", () => {
    const ws = makeWorkspace({ testFramework: "vitest" });
    ws.writeFile("src/math.ts", "export const add = 1;");
    ws.writeFile("src/math.test.ts", "test('x', () => {});");
    const steps = resolveTargetedTests(ws.info, ["src/math.ts"]);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.kind).toBe("targeted-test");
    expect(steps[0]?.command).toBe("npx");
    expect(steps[0]?.args).toEqual(["vitest", "run", "src/math.test.ts"]);
  });

  it("finds a mirrored test under a testDir", () => {
    const ws = makeWorkspace({ testFramework: "jest" });
    ws.writeFile("src/util.ts", "export const u = 1;");
    ws.writeFile("tests/util.spec.ts", "it('x', () => {});");
    const steps = resolveTargetedTests(ws.info, ["src/util.ts"]);
    expect(steps[0]?.command).toBe("npx");
    expect(steps[0]?.args).toEqual(["jest", "tests/util.spec.ts"]);
  });

  it("preserves the source subdirectory for mirrored tests under a testDir", () => {
    const ws = makeWorkspace({ testFramework: "vitest" });
    ws.writeFile("src/nested/math.ts", "export const add = 1;");
    ws.writeFile("tests/nested/math.test.ts", "test('x', () => {});");
    const steps = resolveTargetedTests(ws.info, ["src/nested/math.ts"]);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.args).toEqual(["vitest", "run", "tests/nested/math.test.ts"]);
  });

  it("returns no step when no test file resolves", () => {
    const ws = makeWorkspace();
    ws.writeFile("src/orphan.ts", "export const o = 1;");
    expect(resolveTargetedTests(ws.info, ["src/orphan.ts"])).toEqual([]);
  });

  it("returns no step for an unknown framework even if a test file exists", () => {
    const ws = makeWorkspace({ testFramework: "mocha" });
    ws.writeFile("src/m.ts", "export const m = 1;");
    ws.writeFile("src/m.test.ts", "");
    expect(resolveTargetedTests(ws.info, ["src/m.ts"])).toEqual([]);
  });

  it("deduplicates and ignores extensionless changed files", () => {
    const ws = makeWorkspace({ testFramework: "vitest" });
    ws.writeFile("src/a.ts", "");
    ws.writeFile("src/a.test.ts", "");
    const steps = resolveTargetedTests(ws.info, ["src/a.ts", "src/a.ts", "README"]);
    expect(steps[0]?.args).toEqual(["vitest", "run", "src/a.test.ts"]);
  });
});

describe("planned invocations pass the #6 allowlist", () => {
  it("every script-backed step passes isCommandAllowed", () => {
    const ws = makeWorkspace();
    const plan = buildVerificationPlan(
      ws.info,
      catalogOf({ test: "test", typecheck: "typecheck", lint: "lint", build: "build" }),
    );
    for (const step of plan.steps) {
      expect(isCommandAllowed(VERIFICATION_COMMAND_RULES, step.command, step.args).allowed).toBe(
        true,
      );
    }
  });

  it("the targeted-test npx vitest invocation passes isCommandAllowed", () => {
    const ws = makeWorkspace({ testFramework: "vitest" });
    ws.writeFile("src/x.ts", "");
    ws.writeFile("src/x.test.ts", "");
    const steps = resolveTargetedTests(ws.info, ["src/x.ts"]);
    expect(steps).toHaveLength(1);
    for (const step of steps) {
      expect(isCommandAllowed(VERIFICATION_COMMAND_RULES, step.command, step.args).allowed).toBe(
        true,
      );
    }
  });
});
