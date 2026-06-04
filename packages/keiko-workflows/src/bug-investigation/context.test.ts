import { describe, expect, it } from "vitest";
import { buildBugContext } from "./context.js";
import { parseFailureEvidence } from "./failure-parse.js";
import { DEFAULT_BUG_WORKFLOW_LIMITS } from "./types.js";
import { memFs } from "../../../../packages/keiko-workspace/src/_memfs.js";
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

  it("maps absolute stack-frame paths under the workspace back to relative context paths", () => {
    const fs = memFs(ROOT, {
      "package.json": "{}",
      "src/absolute.ts": "export const x = 1;",
    });
    const ws = makeWorkspaceInfo({ root: ROOT });
    const evidence = parseFailureEvidence({ stackTrace: `at x (${ROOT}/src/absolute.ts:1:20)` });
    const pack = buildBugContext(ws, undefined, evidence, DEFAULT_BUG_WORKFLOW_LIMITS, { fs });
    expect(pack.selected.map((e) => e.path)).toContain("src/absolute.ts");
  });

  it("prioritizes implicated source and nearby test files under a tight budget", () => {
    const fs = memFs(ROOT, {
      "package.json": JSON.stringify({ name: "demo", devDependencies: { vitest: "^4" } }),
      "src/a.ts": "a".repeat(2_000),
      "src/b.ts": "b".repeat(2_000),
      "src/z.ts": "export const z = (): number => 1;\n",
      "tests/z.test.ts": "import { z } from '../src/z';\ntest('z', () => expect(z()).toBe(2));\n",
    });
    const ws = makeWorkspaceInfo({ root: ROOT, testDirs: ["tests"] });
    const evidence = parseFailureEvidence({ targetFiles: ["src/z.ts"] });
    const pack = buildBugContext(
      ws,
      undefined,
      evidence,
      { ...DEFAULT_BUG_WORKFLOW_LIMITS, contextBudgetBytes: 256, maxBytesPerFile: 128 },
      { fs },
    );
    expect(pack.selected.map((e) => e.path).slice(0, 2)).toEqual(["src/z.ts", "tests/z.test.ts"]);
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

  it("omits unrelated source files when evidence-targeted context exists", () => {
    const fs = memFs(ROOT, {
      "package.json": "{}",
      "src/buggy.ts": "export const buggy = () => 1;",
      "src/unrelated.ts": "export const unrelated = () => 1;",
      "tests/buggy.test.ts": "test('buggy', () => {});",
    });
    const ws = makeWorkspaceInfo({ root: ROOT, testDirs: ["tests"] });
    const evidence = parseFailureEvidence({ targetFiles: ["src/buggy.ts"] });
    const pack = buildBugContext(ws, "buggy fails", evidence, DEFAULT_BUG_WORKFLOW_LIMITS, { fs });
    expect(pack.selected.map((entry) => entry.path)).not.toContain("src/unrelated.ts");
  });
});
