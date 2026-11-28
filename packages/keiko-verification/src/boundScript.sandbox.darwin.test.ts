// The bound package-script step through the PRODUCTION macOS isolation: the backend the host selects
// for an execution-root step (a Docker or Podman container when a runtime answers, the Seatbelt
// profile of `sandbox-exec` otherwise), no fake spawn and no fake backend availability. It shows that the
// `$PWD`-derived root, the `node_modules/.bin` PATH, the package folder as cwd and the exit code all
// work inside the sandbox. Hermetic: a tiny fixture in a temp folder, no network, no repository.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { scriptTableDigest } from "./detect.js";
import { runVerification } from "./orchestrator.js";
import { DEFAULT_VERIFICATION_LIMITS, type VerificationPlan } from "./types.js";

function sandboxExecUsable(): boolean {
  if (process.platform !== "darwin") return false;
  const probe = spawnSync("sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]);
  return probe.status === 0;
}

const darwin = sandboxExecUsable() ? describe : describe.skip;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(scripts: Record<string, string>): WorkspaceInfo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-bound-darwin-")));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", scripts }));
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const tool = join(bin, "fake-tool");
  writeFileSync(tool, '#!/bin/sh\necho "$1" >> "$PWD/out.txt"\n');
  chmodSync(tool, 0o755);
  return {
    root,
    selectedRoot: root,
    name: "demo",
    version: undefined,
    testFramework: "node-test",
    sourceDirs: [],
    testDirs: [],
    languages: ["javascript"],
    ignoreLines: [],
  };
}

async function runTest(
  workspace: WorkspaceInfo,
  scripts: Record<string, string>,
): Promise<Awaited<ReturnType<typeof runVerification>>> {
  const plan: VerificationPlan = {
    workspaceRoot: workspace.root,
    steps: [
      {
        kind: "test",
        scriptName: "test",
        command: "npm",
        args: ["test"],
        limits: DEFAULT_VERIFICATION_LIMITS,
      },
    ],
  };
  return runVerification(plan, {
    workspace,
    networkEnforcement: "enforce-or-fail-closed",
    enforcedNetworkAvailable: true,
    approvedScriptsDigest: scriptTableDigest(scripts),
  });
}

darwin("a bound script step through the production macOS sandbox", () => {
  it("runs pre and the script with the .bin tool, the package root and the exit code", async () => {
    const scripts = {
      pretest: "fake-tool pre",
      test: 'fake-tool "$npm_lifecycle_event"; pwd >> out.txt; echo "$INIT_CWD" >> out.txt',
    };
    const workspace = fixture(scripts);
    const report = await runTest(workspace, scripts);
    expect(report.results[0]?.status).toBe("passed");
    // The step ran under the enforced egress sandbox, not inherited.
    expect(
      report.results[0]?.appliedLimits.find((limit) => limit.dimension === "network")?.enforced,
    ).toBe(true);
    const lines = readFileSync(join(workspace.root, "out.txt"), "utf8").trim().split("\n");
    expect(lines).toEqual(["pre", "test", workspace.root, workspace.root]);
  });

  it("reports the exit code of a failing script and runs nothing after it", async () => {
    const scripts = { test: "fake-tool main; exit 7", posttest: "fake-tool post" };
    const workspace = fixture(scripts);
    const report = await runTest(workspace, scripts);
    expect(report.results[0]?.status).toBe("failed");
    expect(report.results[0]?.exitCode).toBe(7);
    expect(readFileSync(join(workspace.root, "out.txt"), "utf8")).toBe("main\n");
  });

  it("negative control: a bound script cannot write outside the workspace root", async () => {
    const outside = realpathSync(mkdtempSync(join(homedir(), ".keiko-bound-outside-")));
    roots.push(outside);
    const target = join(outside, "escape.txt");
    const scripts = { test: `fake-tool before; echo escaped > '${target}'` };
    const workspace = fixture(scripts);
    const report = await runTest(workspace, scripts);
    // The same fixture writes inside the root (the first test), so the failure is the sandbox's.
    expect(report.results[0]?.status).toBe("failed");
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(workspace.root, "out.txt"), "utf8")).toBe("before\n");
  });

  it("refuses, without running anything, scripts rewritten after the approval", async () => {
    const scripts = { test: "fake-tool approved" };
    const workspace = fixture(scripts);
    const approved = scriptTableDigest(scripts);
    writeFileSync(
      join(workspace.root, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "fake-tool stolen" } }),
    );
    const report = await runVerification(
      {
        workspaceRoot: workspace.root,
        steps: [
          {
            kind: "test",
            scriptName: "test",
            command: "npm",
            args: ["test"],
            limits: DEFAULT_VERIFICATION_LIMITS,
          },
        ],
      },
      {
        workspace,
        networkEnforcement: "enforce-or-fail-closed",
        enforcedNetworkAvailable: true,
        approvedScriptsDigest: approved,
      },
    );
    expect(report.results[0]?.status).toBe("denied");
    expect(() => readFileSync(join(workspace.root, "out.txt"), "utf8")).toThrow();
  });
});
