// #3347 owner P1 — the WorkspaceFs capability admitted for a patch apply must survive to the
// verification EFFECT, not stop at detection and planning.
//
// postApplyVerification.test.ts's existing `defaultPostApplyVerification` case passes an EMPTY
// applied-file list, so `planDirectTargetedTests` returns zero steps and the function returns
// `not-run` BEFORE `executeVerificationEnforced` is ever reached: that case cannot observe what the
// execution call forwards. This suite builds a RUNNABLE-framework workspace (a real vitest package
// with a real test file on disk) so exactly one targeted-test step is planned, and captures the
// deps `runVerification` is actually invoked with. Only `runVerification` is replaced; every other
// export of the module — including `planDirectTargetedTests`, which must stay genuine for the step
// to be planned at all — delegates to the real implementation.

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type {
  VerificationDeps,
  VerificationPlan,
  VerificationReport,
} from "@oscharko-dev/keiko-verification";

interface CapturedRun {
  readonly plan: VerificationPlan;
  readonly deps: VerificationDeps;
}

// Declared before the mock factory purely for readability: the factory's inner closure runs only
// from inside an `it()` body, long after this module's own top-level code has finished (the same
// importOriginal-plus-delegating-wrapper pattern gitDelivery/execution.test.ts uses).
const runs: CapturedRun[] = [];

vi.mock("@oscharko-dev/keiko-verification", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oscharko-dev/keiko-verification")>();
  return {
    ...actual,
    runVerification: (
      plan: VerificationPlan,
      deps: VerificationDeps,
    ): Promise<VerificationReport> => {
      runs.push({ plan, deps });
      return Promise.resolve(emptyReport(plan.workspaceRoot));
    },
  };
});

import { defaultPostApplyVerification } from "./postApplyVerification.js";

function emptyReport(workspaceRoot: string): VerificationReport {
  return {
    workspaceRoot,
    results: [],
    overallStatus: "failed",
    startedAtMs: 0,
    durationMs: 1,
    counts: {
      passed: 0,
      failed: 0,
      skipped: 0,
      denied: 0,
      "timed-out": 0,
      cancelled: 0,
      "resource-exceeded": 0,
    },
  };
}

// A runnable-framework workspace: package.json declares vitest (so detectWorkspaceAt reports the
// `vitest` framework) and the applied test file exists (so planDirectTargetedTests resolves it).
async function createRunnableWorkspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "keiko-postapply-cap-")));
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "0.0.0", devDependencies: { vitest: "^3.0.0" } })}\n`,
    "utf8",
  );
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "applied.test.ts"), "export {};\n", "utf8");
  return root;
}

async function createNodeTestWorkspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "keiko-postapply-node-test-")));
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", scripts: { test: "node --test" } })}\n`,
    "utf8",
  );
  await mkdir(join(root, "test"), { recursive: true });
  await writeFile(join(root, "test", "applied.test.js"), "export {};\n", "utf8");
  return root;
}

describe("defaultPostApplyVerification — the admitted capability reaches the spawn boundary", () => {
  it("plans the exact Node native target through the same verification boundary", async () => {
    runs.length = 0;
    const root = await createNodeTestWorkspace();
    try {
      const result = await defaultPostApplyVerification({
        realRoot: root,
        fs: nodeWorkspaceFs,
        appliedTestFiles: ["test/applied.test.js"],
        signal: new AbortController().signal,
        correlationId: undefined,
      });

      expect(result.command).toBe("node --test");
      expect(runs[0]?.plan.steps).toEqual([
        expect.objectContaining({
          kind: "targeted-test",
          command: "node",
          args: ["--test", "test/applied.test.js"],
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forwards the injected WorkspaceFs to runVerification for a planned targeted-test step", async () => {
    runs.length = 0;
    const root = await createRunnableWorkspace();
    // A distinct object identity over the same node implementation: identity is what proves the
    // ADMITTED capability arrived, rather than the orchestrator's nodeWorkspaceFs default.
    const injectedFs: WorkspaceFs = { ...nodeWorkspaceFs };
    try {
      const result = await defaultPostApplyVerification({
        realRoot: root,
        fs: injectedFs,
        appliedTestFiles: ["src/applied.test.ts"],
        signal: new AbortController().signal,
        correlationId: undefined,
      });

      expect(result.command).toBe("npx vitest run");
      expect(runs).toHaveLength(1);
      const run = runs[0];
      // The runnable-framework requirement: a step was actually planned, so the execution call was
      // genuinely reached (the zero-step case returns before it).
      expect(run?.plan.steps).toHaveLength(1);
      expect(run?.deps.fs).toBe(injectedFs);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
