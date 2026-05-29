import { describe, expect, it } from "vitest";
import { buildTestGenContext } from "../../../src/workflows/unit-tests/context.js";
import { DEFAULT_WORKFLOW_LIMITS } from "../../../src/workflows/unit-tests/types.js";
import type { UnitTestWorkflowInput } from "../../../src/workflows/unit-tests/types.js";
import { memFs } from "../../workspace/_memfs.js";
import { makeWorkspaceInfo } from "./_support.js";

const ROOT = "/repo";

function input(overrides: Partial<UnitTestWorkflowInput> = {}): UnitTestWorkflowInput {
  return {
    workspaceRoot: ROOT,
    target: { kind: "file", filePath: "src/add.ts" },
    modelId: "m",
    ...overrides,
  };
}

describe("buildTestGenContext (AC #9)", () => {
  it("includes the target source file and a nearby test file", () => {
    const fs = memFs(ROOT, {
      "package.json": JSON.stringify({ name: "demo", devDependencies: { vitest: "^4" } }),
      "src/add.ts": "export const add = (a: number, b: number): number => a + b;",
      "tests/add.test.ts": "import { add } from '../src/add';\ntest('adds', () => {});",
    });
    const ws = makeWorkspaceInfo({ root: ROOT, testDirs: ["tests"] });
    const pack = buildTestGenContext(ws, input(), DEFAULT_WORKFLOW_LIMITS, { fs });
    const paths = pack.selected.map((e) => e.path);
    expect(paths).toContain("src/add.ts");
    expect(paths).toContain("tests/add.test.ts");
  });

  it("marks the nearby test entry with the 'test' selection reason", () => {
    const fs = memFs(ROOT, {
      "package.json": "{}",
      "src/add.ts": "export const add = () => 1;",
      "tests/add.test.ts": "test('x', () => {});",
    });
    const ws = makeWorkspaceInfo({ root: ROOT });
    const pack = buildTestGenContext(ws, input(), DEFAULT_WORKFLOW_LIMITS, { fs });
    const testEntry = pack.selected.find((e) => e.path === "tests/add.test.ts");
    expect(testEntry?.selectionReason).toBe("test");
  });

  it("respects the configured context byte budget", () => {
    const fs = memFs(ROOT, {
      "package.json": "{}",
      "src/add.ts": "export const add = () => 1;",
    });
    const ws = makeWorkspaceInfo({ root: ROOT });
    const pack = buildTestGenContext(
      ws,
      input(),
      { ...DEFAULT_WORKFLOW_LIMITS, contextBudgetBytes: 4_096 },
      { fs },
    );
    expect(pack.budgetBytes).toBe(4_096);
    expect(pack.usedBytes).toBeLessThanOrEqual(4_096);
  });
});
