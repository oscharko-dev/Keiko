import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { SpawnFn } from "@oscharko-dev/keiko-tools";
import { classifyScripts } from "./detect.js";
import { buildVerificationPlan, ISOLATION_UNAVAILABLE_DENIAL_PREFIX } from "./plan.js";
import {
  runVerification,
  type VerificationDeps,
  type VerificationStepOutput,
} from "./orchestrator.js";
import type { VerificationResult } from "./types.js";
import {
  verificationSandboxDeps,
  fakeMonitor,
  makeFakeChild,
  scriptChildClose,
} from "./_support.js";
import { isVerificationReport } from "@oscharko-dev/keiko-contracts/runtime/verification";
import { DEPENDENCY_APPROVED_REGISTRY, DEPENDENCY_HOST_SHELL_ARGS } from "./dependencies.js";

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
  readonly calls: () => readonly {
    readonly command: string;
    readonly args: readonly string[];
  }[];
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
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "node_modules/left-pad": entry },
    }),
    "utf8",
  );
}

function testDeps(
  workspace: WorkspaceInfo,
  spawn: SpawnFn,
  extra: Partial<VerificationDeps> = {},
): VerificationDeps {
  return {
    ...verificationSandboxDeps(),
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
    expect(spawn.calls()[1]?.args.slice(-2)).toEqual(["/abs/npm", "test"]);
    expect(report.dependencies?.state).toBe("installed");
    expect(report.results[0]?.status).toBe("passed");
    expect(report.overallStatus).toBe("passed");
  });

  it("never runs scripts when npm leaves node_modules linked outside the workspace", async () => {
    const workspace = makeDependencyWorkspace({
      test: "vitest run",
      lint: "eslint .",
    });
    const outside = makeDependencyWorkspace({});
    writeInstalledTree(outside.root);
    const scripts = { test: "vitest run", lint: "eslint ." };
    const plan = buildVerificationPlan(
      workspace,
      { scripts, mapping: classifyScripts(scripts) },
      { only: ["lint", "test"] },
    );
    const spawned = sequencedSpawn([{ exitCode: 0 }, { exitCode: 0 }, { exitCode: 0 }]);
    const npm: SpawnFn = (command, args, options) => {
      if (args[0] === "install")
        symlinkSync(
          join(outside.root, "node_modules"),
          join(workspace.root, "node_modules"),
          "junction",
        );
      return spawned.fn(command, args, options);
    };
    const report = await runVerification(
      plan,
      testDeps(workspace, npm, { dependencyBootstrap: "auto" }),
    );
    expect(spawned.calls()).toHaveLength(1);
    expect(report.dependencies?.state).toBe("failed");
    expect(report.dependencies?.completionRecorded).toBe(false);
    expect(report.overallStatus).toBe("failed");
    expectSkippedForMissingDependencies(report.results[0], "lint");
    expectSkippedForMissingDependencies(report.results[1], "test");
  });

  it("skips every planned step and never spawns a script when the dependency install fails", async () => {
    // Two script kinds (SCRIPT_KINDS orders lint before test, as the later "forwards
    // onStepOutput" test in this file also relies on) so this proves the skip applies to every
    // planned step, not just a single one.
    const workspace = makeDependencyWorkspace({
      test: "vitest run",
      lint: "eslint .",
    });
    const catalog = {
      scripts: { test: "vitest run", lint: "eslint ." },
      mapping: classifyScripts({ test: "vitest run", lint: "eslint ." }),
    };
    const plan = buildVerificationPlan(workspace, catalog, {
      only: ["test", "lint"],
    });

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
    expect(spawn.calls()[0]?.args.slice(-2)).toEqual(["/abs/npm", "test"]);
    expect(report.dependencies).toBeUndefined();
    expect("dependencies" in report).toBe(false);
  });

  // #4519: on a Mac without a container runtime no step can run isolated. Installing for steps that
  // are refused anyway spent a registry read, and a failed install then named missing dependencies
  // as the cause instead of the missing isolation.
  it("never bootstraps dependencies when no step can run without isolation (#4519)", async () => {
    const workspace = makeDependencyWorkspace({ test: "vitest run" });
    const catalog = {
      scripts: { test: "vitest run" },
      mapping: classifyScripts({ test: "vitest run" }),
    };
    const plan = buildVerificationPlan(workspace, catalog, { only: ["test"] });

    const spawn = sequencedSpawn([{ stdout: "added 1 package\n", exitCode: 0 }]);
    const report = await runVerification(
      plan,
      testDeps(workspace, spawn.fn, {
        dependencyBootstrap: "auto",
        networkEnforcement: "enforce-or-fail-closed",
        enforcedNetworkAvailable: false,
      }),
    );

    expect(spawn.calls()).toEqual([]);
    expect(report.dependencies).toBeUndefined();
    expect(report.results.map((result) => result.status)).toEqual(["denied"]);
    expect(report.results[0]?.detail).toMatch(
      new RegExp(`^${ISOLATION_UNAVAILABLE_DENIAL_PREFIX}`),
    );
  });

  it("still bootstraps dependencies for a step the host can isolate (#4519)", async () => {
    const workspace = makeDependencyWorkspace({ test: "vitest run" });
    const catalog = {
      scripts: { test: "vitest run" },
      mapping: classifyScripts({ test: "vitest run" }),
    };
    const plan = buildVerificationPlan(workspace, catalog, { only: ["test"] });

    const spawn = sequencedSpawn([
      { stdout: "added 1 package\n", exitCode: 0 },
      { stdout: "1 passed\n", exitCode: 0 },
    ]);
    const npm: SpawnFn = (command, args, options) => {
      if (args[0] === "install") writeInstalledTree(workspace.root);
      return spawn.fn(command, args, options);
    };
    const report = await runVerification(
      plan,
      testDeps(workspace, npm, {
        dependencyBootstrap: "auto",
        networkEnforcement: "enforce-or-fail-closed",
        enforcedNetworkAvailable: true,
      }),
    );

    expect(spawn.calls()[0]?.args[0]).toBe("install");
    expect(report.dependencies?.state).toBe("installed");
  });

  it("forwards onStepOutput for a failing script step and stays silent for a passing one", async () => {
    const workspace = makeDependencyWorkspace({
      test: "vitest run",
      lint: "eslint .",
    });
    const catalog = {
      scripts: { test: "vitest run", lint: "eslint ." },
      mapping: classifyScripts({ test: "vitest run", lint: "eslint ." }),
    };
    // SCRIPT_KINDS orders lint before test, so the plan (and spawn order) runs lint first.
    const plan = buildVerificationPlan(workspace, catalog, {
      only: ["test", "lint"],
    });

    const spawn = sequencedSpawn([
      { stderr: "problem at src/a.ts\n", exitCode: 1 }, // lint fails
      { stdout: "1 passed\n", exitCode: 0 }, // test passes
    ]);
    const outputs: VerificationStepOutput[] = [];
    const deps = testDeps(workspace, spawn.fn, {
      onStepOutput: (output) => outputs.push(output),
    });
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

const TARGET_RUNTIME: NonNullable<VerificationDeps["dependencyInstallTarget"]> = {
  os: "linux",
  cpu: "arm64",
  libc: "glibc",
  nodeVersion: "v24.18.0",
  nodeAbi: "137",
  napiVersion: "10",
  runtimeIdentitySha256: "a".repeat(64),
};

function dependencyTestPlan(workspace: WorkspaceInfo): ReturnType<typeof buildVerificationPlan> {
  const scripts = { test: "vitest run" };
  return buildVerificationPlan(
    workspace,
    { scripts, mapping: classifyScripts(scripts) },
    { only: ["test"] },
  );
}

describe("runVerification measured dependency target", () => {
  it("forwards the lazy server resolver to the canonical bootstrap", async () => {
    const workspace = makeDependencyWorkspace({ test: "vitest run" });
    const spawn = sequencedSpawn([{ exitCode: 0 }, { exitCode: 0 }]);
    const npm: SpawnFn = (command, args, options) => {
      if (args[0] === "install") writeInstalledTree(workspace.root);
      return spawn.fn(command, args, options);
    };
    const report = await runVerification(
      dependencyTestPlan(workspace),
      testDeps(workspace, npm, {
        dependencyBootstrap: "auto",
        resolveDependencyInstallTarget: () => Promise.resolve(TARGET_RUNTIME),
      }),
    );
    expect(report.overallStatus).toBe("passed");
    expect(spawn.calls()[0]?.args).toContain("--os=linux");
    expect(spawn.calls()[0]?.args).toContain("--libc=glibc");
  });

  it("does not spawn install or test commands when the selected runtime probe fails", async () => {
    const workspace = makeDependencyWorkspace({ test: "vitest run" });
    const spawn = sequencedSpawn([]);
    const failures: string[] = [];
    const report = await runVerification(
      dependencyTestPlan(workspace),
      testDeps(workspace, spawn.fn, {
        dependencyBootstrap: "auto",
        resolveDependencyInstallTarget: () => Promise.reject(new Error("probe unavailable")),
        onDependencyBootstrapFailure: (failure) => {
          failures.push(failure.stage);
        },
      }),
    );
    expect(report.dependencies?.state).toBe("failed");
    expect(report.overallStatus).toBe("failed");
    expect(report.results[0]?.status).toBe("skipped");
    expect(failures).toEqual(["target-probe"]);
    expect(spawn.calls()).toHaveLength(0);
  });

  it.each(["off", "none", "refused", "skipped"] as const)(
    "does not measure a %s bootstrap",
    async (kind) => {
      const workspace = makeDependencyWorkspace({ test: "vitest run" });
      if (kind === "none")
        writeFileSync(
          join(workspace.root, "package.json"),
          JSON.stringify({ scripts: { test: "vitest run" } }),
        );
      if (kind === "refused")
        writeFileSync(join(workspace.root, ".npmrc"), "registry=https://example.invalid");
      let probes = 0;
      const spawn = sequencedSpawn([{ exitCode: 0 }]);
      const plan = dependencyTestPlan(workspace);
      const selected =
        kind === "skipped"
          ? {
              ...plan,
              steps: plan.steps.map((step) => ({
                ...step,
                skipReason: "not selected",
              })),
            }
          : plan;
      await runVerification(
        selected,
        testDeps(workspace, spawn.fn, {
          dependencyBootstrap: kind === "off" ? "off" : "auto",
          resolveDependencyInstallTarget: () => {
            probes += 1;
            return Promise.resolve(TARGET_RUNTIME);
          },
        }),
      );
      expect(probes).toBe(0);
    },
  );
});

describe("runVerification static measured dependency target", () => {
  it("reuses the same validated static target after the canonical initial plan", async () => {
    const workspace = makeDependencyWorkspace({ test: "vitest run" });
    const spawn = sequencedSpawn([{ exitCode: 0 }, { exitCode: 0 }, { exitCode: 0 }]);
    const npm: SpawnFn = (command, args, options) => {
      if (args[0] === "install") writeInstalledTree(workspace.root);
      return spawn.fn(command, args, options);
    };
    const deps = testDeps(workspace, npm, {
      dependencyBootstrap: "auto",
      dependencyInstallTarget: TARGET_RUNTIME,
    });
    const first = await runVerification(dependencyTestPlan(workspace), deps);
    const second = await runVerification(dependencyTestPlan(workspace), deps);
    expect(first.dependencies?.state).toBe("installed");
    expect(spawn.calls()[0]?.args).toContain("--os=linux");
    expect(second.dependencies?.state).toBe("current");
    expect(second.overallStatus).toBe("passed");
    expect(spawn.calls()).toHaveLength(3);
  });
});

// #4522: on a Mac without a container runtime no governed step can run, and the native runtime's own
// shell runs the project's check instead. The bootstrap then installs for that shell, on this host,
// for this host's target: no probe of the steps' execution root, `--no-save`, the same registry
// proxy, and the steps keep their isolation reason whatever the install did.
describe("runVerification — install for the run's own shell (#4522)", () => {
  const HOST_SHELL: Partial<VerificationDeps> = {
    dependencyBootstrap: "auto",
    networkEnforcement: "enforce-or-fail-closed",
    enforcedNetworkAvailable: false,
    sharedHostPlatform: { os: "darwin", cpu: "arm64" },
  };

  function expectIsolationDenied(result: VerificationResult | undefined): void {
    expect(result?.status).toBe("denied");
    expect(result?.detail).toMatch(new RegExp(`^${ISOLATION_UNAVAILABLE_DENIAL_PREFIX}`));
  }

  function writeFile(root: string, name: string, value: unknown): void {
    writeFileSync(join(root, name), JSON.stringify(value), "utf8");
  }

  // The line a tree Keiko did not install leaves: nothing installed, and no receipt of this process.
  const LEFT_ALONE = {
    state: "none",
    completionReceipt: "missing",
    completionRecorded: false,
    consumer: "host-shell",
  };

  it("installs for the host shell on this host when no governed step can run", async () => {
    const workspace = makeDependencyWorkspace({ test: "vitest run" });
    const spawn = sequencedSpawn([{ stdout: "added 1 package\n", exitCode: 0 }]);
    const npm: SpawnFn = (command, args, options) => {
      if (args[0] === "install") writeInstalledTree(workspace.root);
      return spawn.fn(command, args, options);
    };
    let probes = 0;
    const report = await runVerification(
      dependencyTestPlan(workspace),
      testDeps(workspace, npm, {
        ...HOST_SHELL,
        resolveDependencyInstallTarget: () => {
          probes += 1;
          return Promise.resolve(TARGET_RUNTIME);
        },
      }),
    );

    expect(probes).toBe(0);
    expect(spawn.calls()).toHaveLength(1);
    expect(spawn.calls()[0]?.args).toEqual([...DEPENDENCY_HOST_SHELL_ARGS]);
    expect(report.dependencies).toMatchObject({ state: "installed", consumer: "host-shell" });
    expect(report.results).toHaveLength(1);
    expectIsolationDenied(report.results[0]);
  });

  it("keeps the steps' isolation reason and forwards npm's tail when the host-shell install fails", async () => {
    const workspace = makeDependencyWorkspace({ test: "vitest run" });
    const spawn = sequencedSpawn([{ stderr: "npm ERR! code E404\n", exitCode: 1 }]);
    const outputs: VerificationStepOutput[] = [];
    const report = await runVerification(
      dependencyTestPlan(workspace),
      testDeps(workspace, spawn.fn, {
        ...HOST_SHELL,
        onStepOutput: (output) => outputs.push(output),
      }),
    );

    expect(report.dependencies).toMatchObject({ state: "failed", consumer: "host-shell" });
    expectIsolationDenied(report.results[0]);
    expect(report.overallStatus).toBe("failed");
    expect(outputs.map((output) => output.step)).toEqual(["dependencies"]);
    expect(outputs[0]?.excerpt).toContain("npm ERR! code E404");
  });

  it("refuses a project whose own install script the install never runs, until a tree exists", async () => {
    const workspace = makeDependencyWorkspace({ test: "vitest run", postinstall: "node build.js" });
    const refusedSpawn = sequencedSpawn([]);
    const refused = await runVerification(
      dependencyTestPlan(workspace),
      testDeps(workspace, refusedSpawn.fn, HOST_SHELL),
    );
    expect(refusedSpawn.calls()).toEqual([]);
    expect(refused.dependencies).toMatchObject({
      state: "refused",
      refusalReason: "install-scripts-required",
      consumer: "host-shell",
    });
    expectIsolationDenied(refused.results[0]);

    // The person's own install may have run the script: a tree Keiko did not install is left alone.
    writeInstalledTree(workspace.root);
    const leftSpawn = sequencedSpawn([]);
    const left = await runVerification(
      dependencyTestPlan(workspace),
      testDeps(workspace, leftSpawn.fn, HOST_SHELL),
    );
    expect(leftSpawn.calls()).toEqual([]);
    expect(left.dependencies).toMatchObject(LEFT_ALONE);
    expect(isVerificationReport(left)).toBe(true);
  });

  // A native addon of the project itself: npm would run `node-gyp rebuild` as its install script.
  it("refuses a project whose binding.gyp the install never builds", async () => {
    const workspace = makeDependencyWorkspace({ test: "vitest run" });
    writeFileSync(join(workspace.root, "binding.gyp"), "{}", "utf8");
    const spawn = sequencedSpawn([]);
    const report = await runVerification(
      dependencyTestPlan(workspace),
      testDeps(workspace, spawn.fn, HOST_SHELL),
    );
    expect(spawn.calls()).toEqual([]);
    expect(report.dependencies).toMatchObject({
      state: "refused",
      refusalReason: "install-scripts-required",
      consumer: "host-shell",
    });
  });

  // npm writes its hidden lockfile last in a completed install: a folder without it is no tree.
  it("installs into an empty node_modules, which holds no tree", async () => {
    const workspace = makeDependencyWorkspace({ test: "vitest run" });
    mkdirSync(join(workspace.root, "node_modules"));
    const spawn = sequencedSpawn([{ exitCode: 0 }]);
    const npm: SpawnFn = (command, args, options) => {
      if (args[0] === "install") writeInstalledTree(workspace.root);
      return spawn.fn(command, args, options);
    };
    const report = await runVerification(
      dependencyTestPlan(workspace),
      testDeps(workspace, npm, HOST_SHELL),
    );
    expect(spawn.calls()).toHaveLength(1);
    expect(report.dependencies).toMatchObject({ state: "installed", consumer: "host-shell" });
  });

  // A tree the shell installed through the repository credential relay (ADR-0184) names that
  // registry, which the public-registry install would refuse as a source and a firewalled network
  // would refuse to reach: the shell already uses it, so Keiko neither installs nor refuses.
  it("leaves a tree it did not install alone, whatever registry it came from", async () => {
    const workspace = makeDependencyWorkspace({ test: "vitest run" });
    mkdirSync(join(workspace.root, "node_modules"), { recursive: true });
    writeFile(workspace.root, join("node_modules", ".package-lock.json"), {
      lockfileVersion: 3,
      packages: {
        "node_modules/left-pad": {
          version: "1.0.0",
          resolved: "http://127.0.0.1:4873/left-pad/-/left-pad-1.0.0.tgz",
          integrity: `sha512-${"A".repeat(86)}==`,
        },
      },
    });
    const spawn = sequencedSpawn([]);
    const report = await runVerification(
      dependencyTestPlan(workspace),
      testDeps(workspace, spawn.fn, HOST_SHELL),
    );
    expect(spawn.calls()).toEqual([]);
    expect(report.dependencies).toMatchObject(LEFT_ALONE);
    expect(isVerificationReport(report)).toBe(true);
    expectIsolationDenied(report.results[0]);
  });

  it("refreshes a tree it installed itself once that tree is no longer current", async () => {
    const workspace = makeDependencyWorkspace({ test: "vitest run" });
    const spawn = sequencedSpawn([{ exitCode: 0 }, { exitCode: 0 }]);
    const npm: SpawnFn = (command, args, options) => {
      if (args[0] === "install") writeInstalledTree(workspace.root);
      return spawn.fn(command, args, options);
    };
    const deps = testDeps(workspace, npm, HOST_SHELL);
    const first = await runVerification(dependencyTestPlan(workspace), deps);
    const second = await runVerification(dependencyTestPlan(workspace), deps);
    expect([first.dependencies?.state, second.dependencies?.state]).toEqual([
      "installed",
      "current",
    ]);
    const manifest = {
      name: "demo",
      scripts: { test: "vitest run" },
      dependencies: { "left-pad": "1.3.0" },
    };
    writeFile(workspace.root, "package.json", manifest);
    const touched = new Date(Date.now() + 60_000);
    utimesSync(join(workspace.root, "package.json"), touched, touched);
    const third = await runVerification(dependencyTestPlan(workspace), deps);
    expect(third.dependencies?.state).toBe("installed");
    expect(spawn.calls()).toHaveLength(2);
  });

  it("refuses a lockfile that no longer records what package.json declares", async () => {
    const workspace = makeDependencyWorkspace({ test: "vitest run" });
    writeFile(workspace.root, "package-lock.json", {
      name: "demo",
      lockfileVersion: 3,
      packages: {
        "": { name: "demo", dependencies: { "left-pad": "1.1.0" } },
        "node_modules/left-pad": {
          version: "1.1.0",
          resolved: `${DEPENDENCY_APPROVED_REGISTRY}left-pad/-/left-pad-1.1.0.tgz`,
          integrity: `sha512-${"A".repeat(86)}==`,
        },
      },
    });
    const spawn = sequencedSpawn([]);
    const report = await runVerification(
      dependencyTestPlan(workspace),
      testDeps(workspace, spawn.fn, HOST_SHELL),
    );
    expect(spawn.calls()).toEqual([]);
    expect(report.dependencies).toMatchObject({
      state: "refused",
      refusalReason: "lockfile-mismatch",
      consumer: "host-shell",
    });
  });

  it("refuses a pnpm project without its tree and leaves one with its tree alone", async () => {
    const workspace = makeDependencyWorkspace({ test: "vitest run" });
    writeFileSync(join(workspace.root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const spawn = sequencedSpawn([]);
    const refused = await runVerification(
      dependencyTestPlan(workspace),
      testDeps(workspace, spawn.fn, HOST_SHELL),
    );
    expect(spawn.calls()).toEqual([]);
    expect(refused.dependencies).toMatchObject({
      state: "refused",
      refusalReason: "package-manager-unsupported",
      consumer: "host-shell",
    });
    expectIsolationDenied(refused.results[0]);

    mkdirSync(join(workspace.root, "node_modules"));
    const present = await runVerification(
      dependencyTestPlan(workspace),
      testDeps(workspace, spawn.fn, HOST_SHELL),
    );
    expect(spawn.calls()).toEqual([]);
    expect(present.dependencies).toBeUndefined();
  });

  // ADR-0043 D17: the shell is the consumer on macOS only, and only for a check the host would run
  // but cannot isolate. Linux isolates its steps with the bubblewrap the native runtime needs, and
  // Windows enables its own consumer with its own proof (#4496).
  it("installs for the host shell on macOS only", async () => {
    for (const os of ["linux", "win32"] as const) {
      const workspace = makeDependencyWorkspace({ test: "vitest run" });
      const spawn = sequencedSpawn([]);
      const report = await runVerification(
        dependencyTestPlan(workspace),
        testDeps(workspace, spawn.fn, { ...HOST_SHELL, sharedHostPlatform: { os, cpu: "x64" } }),
      );
      expect(spawn.calls()).toEqual([]);
      expect(report.dependencies).toBeUndefined();
      expectIsolationDenied(report.results[0]);
    }
  });

  it("installs nothing for the host shell when every step is skipped for another reason", async () => {
    const workspace = makeDependencyWorkspace({ test: "vitest run" });
    const plan = dependencyTestPlan(workspace);
    const skipped: ReturnType<typeof buildVerificationPlan> = {
      ...plan,
      steps: plan.steps.map((step) => ({ ...step, skipReason: "no test script" })),
    };
    const spawn = sequencedSpawn([]);
    const report = await runVerification(skipped, testDeps(workspace, spawn.fn, HOST_SHELL));
    expect(spawn.calls()).toEqual([]);
    expect(report.dependencies).toBeUndefined();
  });

  it("keeps the governed steps' measured target, and its foreign refusal, when a step can run", async () => {
    const workspace = makeDependencyWorkspace({ test: "vitest run" });
    const spawn = sequencedSpawn([]);
    const report = await runVerification(
      dependencyTestPlan(workspace),
      testDeps(workspace, spawn.fn, {
        ...HOST_SHELL,
        enforcedNetworkAvailable: true,
        resolveDependencyInstallTarget: () => Promise.resolve(TARGET_RUNTIME),
      }),
    );
    expect(spawn.calls()).toEqual([]);
    expect(report.dependencies?.refusalReason).toBe("install-target-foreign");
    expect(report.dependencies?.consumer).toBeUndefined();
  });
});
