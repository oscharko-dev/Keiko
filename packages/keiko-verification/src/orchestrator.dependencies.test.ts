import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { SpawnFn } from "@oscharko-dev/keiko-tools";
import { classifyScripts } from "./detect.js";
import { buildVerificationPlan } from "./plan.js";
import {
  runVerification,
  type VerificationDeps,
  type VerificationStepOutput,
} from "./orchestrator.js";
import type { VerificationResult } from "./types.js";
import { fakeMonitor, makeFakeChild, scriptChildClose } from "./_support.js";
import { DEPENDENCY_APPROVED_REGISTRY } from "./dependencies.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// Unlike _support.ts's makeWorkspace (which never declares dependencies), the dependency-bootstrap
// integration needs a real package.json that DOES declare a dependency, so planDependencyBootstrap
// (real disk, via the orchestrator's default nodeWorkspaceFs) yields "install" rather than "none".
function makeDependencyWorkspace(scripts: Readonly<Record<string, string>>): WorkspaceInfo {
  const root = mkdtempSync(join(tmpdir(), "keiko-verify-deps-"));
  roots.push(root);
  const pkg = { name: "demo", scripts, dependencies: { "left-pad": "1.0.0" } };
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg), "utf8");
  return {
    root,
    selectedRoot: root,
    name: pkg.name,
    version: undefined,
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

type ScriptCloseOptions = Parameters<typeof scriptChildClose>[1];

interface SequencedSpawn {
  readonly fn: SpawnFn;
  readonly calls: () => readonly { readonly command: string; readonly args: readonly string[] }[];
}

// Each call to `spawn()` creates and schedules the close of its OWN fresh fake child at the moment
// it is actually spawned. Pre-scheduling every child's close upfront (before runVerification even
// starts) is unsafe here: the bootstrap install and the script step spawn sequentially, and a close
// event queued for a child that has not been spawned yet (no listeners attached) is silently lost.
function sequencedSpawn(outcomes: readonly ScriptCloseOptions[]): SequencedSpawn {
  const calls: { command: string; args: readonly string[] }[] = [];
  let index = 0;
  return {
    calls: () => calls,
    fn: (command, args): ChildProcess => {
      calls.push({ command, args: [...args] });
      const child = makeFakeChild(9_000 + index);
      const outcome = outcomes[index] ?? {};
      index += 1;
      scriptChildClose(child, outcome);
      return child as unknown as ChildProcess;
    },
  };
}

// npm's hidden lockfile as a successful install leaves it: one package, from the approved registry.
function writeInstalledTree(root: string): void {
  mkdirSync(join(root, "node_modules"), { recursive: true });
  const entry = {
    version: "1.3.0",
    resolved: `${DEPENDENCY_APPROVED_REGISTRY}left-pad/-/left-pad-1.3.0.tgz`,
    integrity: `sha512-${"A".repeat(86)}==`,
  };
  writeFileSync(
    join(root, "node_modules", ".package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/left-pad": entry } }),
    "utf8",
  );
}

function testDeps(
  workspace: WorkspaceInfo,
  spawn: SpawnFn,
  extra: Partial<VerificationDeps> = {},
): VerificationDeps {
  return {
    workspace,
    spawn,
    monitor: fakeMonitor(),
    now: () => 1_000,
    networkEnforcement: "inherit",
    ...extra,
  };
}

// Shared by the multi-step dependency-failure case below to keep that test's own cyclomatic
// complexity within the repository's limit (each optional-chained field access is a branch).
function expectSkippedForMissingDependencies(
  result: VerificationResult | undefined,
  kind: string,
): void {
  expect(result?.kind).toBe(kind);
  expect(result?.status).toBe("skipped");
  expect(result?.detail).toContain("dependencies unavailable");
}

describe("runVerification — dependency bootstrap integration (ADR-0043 D17)", () => {
  it("runs the dependency install before the first script step when dependencyBootstrap is 'auto'", async () => {
    const workspace = makeDependencyWorkspace({ test: "vitest run" });
    const catalog = {
      scripts: { test: "vitest run" },
      mapping: classifyScripts({ test: "vitest run" }),
    };
    const plan = buildVerificationPlan(workspace, catalog, { only: ["test"] });

    const spawn = sequencedSpawn([
      { stdout: "added 1 package\n", exitCode: 0 }, // the dependency install
      { stdout: "1 passed\n", exitCode: 0 }, // the plan's "test" step
    ]);
    // npm leaves its hidden lockfile behind; the bootstrap reads the installed tree back from it.
    const npm: SpawnFn = (command, args, options) => {
      if (args[0] === "install") writeInstalledTree(workspace.root);
      return spawn.fn(command, args, options);
    };
    const report = await runVerification(
      plan,
      testDeps(workspace, npm, { dependencyBootstrap: "auto" }),
    );

    expect(spawn.calls()).toHaveLength(2);
    expect(spawn.calls()[0]?.args[0]).toBe("install");
    expect(spawn.calls()[1]?.args).toEqual(["test"]);
    expect(report.dependencies?.state).toBe("installed");
    expect(report.results[0]?.status).toBe("passed");
    expect(report.overallStatus).toBe("passed");
  });

  it("skips every planned step and never spawns a script when the dependency install fails", async () => {
    // Two script kinds (SCRIPT_KINDS orders lint before test, as the later "forwards
    // onStepOutput" test in this file also relies on) so this proves the skip applies to every
    // planned step, not just a single one.
    const workspace = makeDependencyWorkspace({ test: "vitest run", lint: "eslint ." });
    const catalog = {
      scripts: { test: "vitest run", lint: "eslint ." },
      mapping: classifyScripts({ test: "vitest run", lint: "eslint ." }),
    };
    const plan = buildVerificationPlan(workspace, catalog, { only: ["test", "lint"] });

    const spawn = sequencedSpawn([{ stderr: "npm ERR! network failure\n", exitCode: 1 }]);
    const outputs: VerificationStepOutput[] = [];
    const deps = testDeps(workspace, spawn.fn, {
      dependencyBootstrap: "auto",
      onStepOutput: (output) => outputs.push(output),
    });
    const report = await runVerification(plan, deps);

    // Only the failed install spawns a process; neither planned script step ever does.
    expect(spawn.calls()).toHaveLength(1);
    expect(spawn.calls()[0]?.args[0]).toBe("install");
    expect(report.results).toHaveLength(2);
    expectSkippedForMissingDependencies(report.results[0], "lint");
    expectSkippedForMissingDependencies(report.results[1], "test");
    expect(report.overallStatus).toBe("failed");
    expect(report.dependencies?.state).toBe("failed");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.step).toBe("dependencies");
    expect(outputs[0]?.excerpt).toContain("npm ERR! network failure");
  });

  it("never bootstraps dependencies when dependencyBootstrap is left unset", async () => {
    const workspace = makeDependencyWorkspace({ test: "vitest run" });
    const catalog = {
      scripts: { test: "vitest run" },
      mapping: classifyScripts({ test: "vitest run" }),
    };
    const plan = buildVerificationPlan(workspace, catalog, { only: ["test"] });

    const spawn = sequencedSpawn([{ stdout: "1 passed\n", exitCode: 0 }]);
    const report = await runVerification(plan, testDeps(workspace, spawn.fn));

    expect(spawn.calls()).toHaveLength(1);
    expect(spawn.calls()[0]?.args).toEqual(["test"]);
    expect(report.dependencies).toBeUndefined();
    expect("dependencies" in report).toBe(false);
  });

  it("forwards onStepOutput for a failing script step and stays silent for a passing one", async () => {
    const workspace = makeDependencyWorkspace({ test: "vitest run", lint: "eslint ." });
    const catalog = {
      scripts: { test: "vitest run", lint: "eslint ." },
      mapping: classifyScripts({ test: "vitest run", lint: "eslint ." }),
    };
    // SCRIPT_KINDS orders lint before test, so the plan (and spawn order) runs lint first.
    const plan = buildVerificationPlan(workspace, catalog, { only: ["test", "lint"] });

    const spawn = sequencedSpawn([
      { stderr: "problem at src/a.ts\n", exitCode: 1 }, // lint fails
      { stdout: "1 passed\n", exitCode: 0 }, // test passes
    ]);
    const outputs: VerificationStepOutput[] = [];
    const deps = testDeps(workspace, spawn.fn, { onStepOutput: (output) => outputs.push(output) });
    const report = await runVerification(plan, deps);

    expect(report.results[0]?.kind).toBe("lint");
    expect(report.results[0]?.status).toBe("failed");
    expect(report.results[1]?.kind).toBe("test");
    expect(report.results[1]?.status).toBe("passed");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.step).toBe("lint");
    expect(outputs[0]?.excerpt).toContain("problem at src/a.ts");
  });
});
