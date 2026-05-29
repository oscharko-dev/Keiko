import { describe, expect, it } from "vitest";
import { buildBugContext } from "../../../src/workflows/bug-investigation/context.js";
import { parseFailureEvidence } from "../../../src/workflows/bug-investigation/failure-parse.js";
import { DEFAULT_BUG_WORKFLOW_LIMITS } from "../../../src/workflows/bug-investigation/types.js";
import { memFs } from "../../workspace/_memfs.js";
import { makeWorkspaceInfo } from "./_support.js";

const ROOT = "/repo";

describe("buildBugContext (AC #9 context selection)", () => {
  it("includes the implicated source file seeded from a failure frame", () => {
    const fs = memFs(ROOT, {
      "package.json": JSON.stringify({ name: "demo", devDependencies: { vitest: "^4" } }),
      "src/buggy.ts": "export const half = (n: number): number => n / 3;",
      "tests/buggy.test.ts": "import { half } from '../src/buggy';\ntest('half', () => {});",
    });
    const ws = makeWorkspaceInfo({ root: ROOT, testDirs: ["tests"] });
    const evidence = parseFailureEvidence({ stackTrace: "    at half (src/buggy.ts:1:40)" });
    const pack = buildBugContext(
      ws,
      "half returns the wrong value",
      evidence,
      DEFAULT_BUG_WORKFLOW_LIMITS,
      {
        fs,
      },
    );
    expect(pack.selected.map((e) => e.path)).toContain("src/buggy.ts");
  });

  it("includes a developer-provided target file even without a failure frame", () => {
    const fs = memFs(ROOT, {
      "package.json": "{}",
      "src/other.ts": "export const x = 1;",
    });
    const ws = makeWorkspaceInfo({ root: ROOT });
    const evidence = parseFailureEvidence({ targetFiles: ["src/other.ts"] });
    const pack = buildBugContext(ws, undefined, evidence, DEFAULT_BUG_WORKFLOW_LIMITS, { fs });
    expect(pack.selected.map((e) => e.path)).toContain("src/other.ts");
  });

  it("respects the configured context byte budget", () => {
    const fs = memFs(ROOT, {
      "package.json": "{}",
      "src/buggy.ts": "export const half = () => 1;",
    });
    const ws = makeWorkspaceInfo({ root: ROOT });
    const evidence = parseFailureEvidence({ description: "bug" });
    const pack = buildBugContext(
      ws,
      "bug",
      evidence,
      { ...DEFAULT_BUG_WORKFLOW_LIMITS, contextBudgetBytes: 4_096 },
      { fs },
    );
    expect(pack.budgetBytes).toBe(4_096);
    expect(pack.usedBytes).toBeLessThanOrEqual(4_096);
  });
});
