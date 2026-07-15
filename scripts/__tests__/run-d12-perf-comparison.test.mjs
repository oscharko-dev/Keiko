import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildHarnessArguments, runD12Comparison } from "../run-d12-perf-comparison.mjs";
import { createD12RuntimeEnvironment } from "../d12-runtime-environment.mjs";

const BASELINE_COMMIT = "bbda3c43c39fabe6c743b8be5d144abccd866397";
const CANDIDATE_COMMIT = "6c3d061e6c3d061e6c3d061e6c3d061e6c3d061e";
const SOURCE_DIGESTS = { baseline: "a".repeat(64), candidate: "b".repeat(64) };
const HARNESS_DIGEST = "c".repeat(64);
const roots = [];

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function provenance() {
  return {
    platform: "linux",
    architecture: "x64",
    osRelease: "6.8.0-test",
    nodeVersion: "24.18.0",
    npmVersion: "11.16.0",
    lockfileSha256: "d".repeat(64),
    playwrightVersion: "1.61.1",
    zlibVersion: "1.3.1",
    chromiumVersion: "140.0.7339.16",
    hardware: { cpuModel: "Test CPU", logicalCores: 4, memoryBytes: 16_000_000_000 },
  };
}

function rawArtifact(revision, sequence) {
  return {
    commit: revision === "baseline" ? BASELINE_COMMIT : CANDIDATE_COMMIT,
    measuredAtIso: `2026-07-15T12:00:${String(sequence * 2).padStart(2, "0")}.000Z`,
    sourceTreeSha256: SOURCE_DIGESTS[revision],
    measurementHarnessSha256: HARNESS_DIGEST,
    provenance: provenance(),
  };
}

function fixture(names = {}) {
  const root = mkdtempSync(join(tmpdir(), "keiko-d12-runner-"));
  roots.push(root);
  const baselineRoot = join(root, names.baseline ?? "baseline");
  const candidateRoot = join(root, names.candidate ?? "candidate");
  mkdirSync(baselineRoot);
  mkdirSync(candidateRoot);
  writeFileSync(join(baselineRoot, "package-lock.json"), "{}\n", "utf8");
  writeFileSync(join(candidateRoot, "package-lock.json"), "{}\n", "utf8");
  return { root, baselineRoot, candidateRoot };
}

function invocation({ root, baselineRoot, candidateRoot }) {
  return [
    "--baseline-root",
    baselineRoot,
    "--candidate-root",
    candidateRoot,
    "--baseline-bundle",
    join(root, "baseline-bundle.json"),
    "--candidate-bundle",
    join(root, "candidate-bundle.json"),
    "--output",
    join(root, "comparison.json"),
    "--artifacts-root",
    join(root, "artifacts"),
  ];
}

function setOption(args, option, value) {
  const index = args.indexOf(option);
  if (index < 0) throw new Error(`missing test option ${option}`);
  args[index + 1] = value;
  return args;
}

function preflightDependencies(paths) {
  return {
    computeDigest: ({ root }) =>
      root === paths.baselineRoot ? SOURCE_DIGESTS.baseline : SOURCE_DIGESTS.candidate,
    computeHarnessDigest: () => HARNESS_DIGEST,
    cleanCheckout: () => undefined,
    getHead: (root) => (root === paths.baselineRoot ? BASELINE_COMMIT : CANDIDATE_COMMIT),
    isAncestor: () => true,
    listDirtyPaths: () => [],
    listDirtyToolchainPaths: () => [],
    provisionDependencies: () => undefined,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("D12 performance comparison runner", () => {
  it("uses a deterministic allowlist instead of ambient Node, npm, or Keiko inputs", () => {
    expect(
      createD12RuntimeEnvironment(
        {
          HOME: "/home/keiko",
          KEIKO_UNBOUND_FEATURE: "enabled",
          NODE_OPTIONS: "--require /tmp/inject.cjs",
          PATH: "/usr/bin",
          PLAYWRIGHT_BROWSERS_PATH: "/opt/browsers",
          npm_config_registry: "https://unbound.invalid",
        },
        { KEIKO_PERF_RUNS: "10" },
      ),
    ).toEqual({
      HOME: "/home/keiko",
      KEIKO_PERF_RUNS: "10",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NO_COLOR: "1",
      PATH: "/usr/bin",
      PLAYWRIGHT_BROWSERS_PATH: "/opt/browsers",
      TZ: "UTC",
    });
  });

  it("selects only the intended Playwright evidence scenarios for each harness", () => {
    expect(buildHarnessArguments("common", "/playwright/cli.js", "/tmp/common.config.mjs")).toEqual(
      [
        "/playwright/cli.js",
        "test",
        "--config",
        "/tmp/common.config.mjs",
        "--project=chromium",
        "--grep",
        "@release-evidence",
      ],
    );
    expect(buildHarnessArguments("cap", "/playwright/cli.js", "/tmp/cap.config.mjs")).toEqual([
      "/playwright/cli.js",
      "test",
      "--config",
      "/tmp/cap.config.mjs",
      "--project=chromium",
      "--grep",
      "D12",
    ]);
  });

  it("keeps user-selected paths with spaces and shell metacharacters out of the webServer command", async () => {
    const paths = fixture({
      baseline: "baseline path [safe]",
      candidate: "candidate path;$(touch SHOULD_NOT_EXIST)&",
    });
    const dangerousArtifacts = join(paths.root, "artifacts path;$(touch SHOULD_NOT_EXIST)&");
    const args = setOption(invocation(paths), "--artifacts-root", dangerousArtifacts);
    let config;

    await expect(
      runD12Comparison(args, {
        ...preflightDependencies(paths),
        runHarness: (context) => {
          config = context.config;
          throw new Error("captured generated launcher");
        },
      }),
    ).rejects.toThrow(/captured generated launcher/u);

    expect(config.webServer.command).toBe("node web-server-launcher.mjs");
    expect(config.webServer.command).not.toContain(paths.baselineRoot);
    expect(config.webServer.command).not.toContain(paths.candidateRoot);
    expect(config.webServer.command).not.toContain("$");
    expect(config.webServer.command).not.toContain(";");
    expect(config.webServer.cwd).toBe(dirname(config.webServer.launcherPath));
    expect(readFileSync(config.webServer.launcherPath, "utf8")).toBe(
      config.webServer.launcherSource,
    );
    expect(() =>
      execFileSync(process.execPath, ["--check", config.webServer.launcherPath]),
    ).not.toThrow();
    expect(config.webServer.launcherSource).toContain(JSON.stringify(paths.baselineRoot));
    expect(config.webServer.launcherSource).toContain('execFileSync("npm", ["run", script]');
    expect(config.webServer.launcherSource).toContain("shell: false");
    expect(existsSync(join(paths.root, "SHOULD_NOT_EXIST"))).toBe(false);
  });

  it("executes warm-ups and three recorded pairs in alternating actual order", async () => {
    const paths = fixture();
    const calls = [];
    const lifecycleCalls = [];
    const provisioningCalls = [];
    const dependencyCalls = [];
    let clock = Date.parse("2026-07-15T12:00:00.000Z");
    const result = await runD12Comparison(invocation(paths), {
      buildComparison: (args) => ({ args }),
      computeDigest: ({ root }) =>
        root === paths.baselineRoot ? SOURCE_DIGESTS.baseline : SOURCE_DIGESTS.candidate,
      computeHarnessDigest: () => HARNESS_DIGEST,
      cleanCheckout: ({ revision, root }) => {
        lifecycleCalls.push(`clean:${revision}:${root}`);
      },
      createProvisioning: ({ adapterFixturePath, root, stateDir }) => {
        provisioningCalls.push({ adapterFixturePath, root, stateDir });
        return `provisioning:${root}`;
      },
      getHead: (root) => (root === paths.baselineRoot ? BASELINE_COMMIT : CANDIDATE_COMMIT),
      isAncestor: () => true,
      listDirtyPaths: () => [],
      listDirtyToolchainPaths: () => [],
      now: () => {
        const value = new Date(clock);
        clock += 1_000;
        return value;
      },
      provisionDependencies: (plan) => {
        dependencyCalls.push(plan);
        lifecycleCalls.push(`provision:${plan.revision}:${plan.root}`);
      },
      runHarness: (context) => {
        const { config, kind, outputPath, recorded, revision, root, sequence } = context;
        calls.push({
          command: config.webServer.command,
          cwd: config.webServer.cwd,
          fixtureConfigPath: config.webServer.fixtureConfigPath,
          kind,
          launcherPath: config.webServer.launcherPath,
          launcherSource: config.webServer.launcherSource,
          recorded,
          revision,
          root,
          serverRoot: config.webServer.root,
          source: config.source,
          sequence,
        });
        lifecycleCalls.push(`harness:${revision}:${kind}`);
        if (recorded) {
          const artifact = `${JSON.stringify(rawArtifact(revision, sequence))}\n`;
          writeFileSync(outputPath, artifact, "utf8");
        }
      },
    });

    expect(
      calls.map(({ kind, recorded, revision, sequence }) => ({
        kind,
        recorded,
        revision,
        sequence,
      })),
    ).toEqual([
      { kind: "common", recorded: false, revision: "baseline", sequence: 0 },
      { kind: "common", recorded: false, revision: "candidate", sequence: 0 },
      { kind: "cap", recorded: false, revision: "candidate", sequence: 0 },
      { kind: "common", recorded: true, revision: "baseline", sequence: 1 },
      { kind: "common", recorded: true, revision: "candidate", sequence: 2 },
      { kind: "cap", recorded: true, revision: "candidate", sequence: 2 },
      { kind: "common", recorded: true, revision: "candidate", sequence: 3 },
      { kind: "cap", recorded: true, revision: "candidate", sequence: 3 },
      { kind: "common", recorded: true, revision: "baseline", sequence: 4 },
      { kind: "common", recorded: true, revision: "baseline", sequence: 5 },
      { kind: "common", recorded: true, revision: "candidate", sequence: 6 },
      { kind: "cap", recorded: true, revision: "candidate", sequence: 6 },
    ]);
    expect(lifecycleCalls.slice(0, 5)).toEqual([
      `provision:baseline:${paths.baselineRoot}`,
      `provision:candidate:${paths.candidateRoot}`,
      `clean:baseline:${paths.baselineRoot}`,
      `clean:candidate:${paths.candidateRoot}`,
      "harness:baseline:common",
    ]);
    for (const call of calls) {
      expect(call.command).toBe("node web-server-launcher.mjs");
      expect(call.cwd).toBe(dirname(call.launcherPath));
      expect(call.serverRoot).toBe(call.root);
      expect(call.source).toContain(`"cwd":${JSON.stringify(call.cwd)}`);
      expect(call.source).not.toContain("playwright.editor-performance.config");
      expect(call.fixtureConfigPath).toBe(
        join(call.root, "tests", "e2e", "fixtures", "keiko.e2e.config.json"),
      );
      expect(readFileSync(call.launcherPath, "utf8")).toBe(call.launcherSource);
      expect(call.launcherSource).toContain(JSON.stringify(call.root));
      if (call.revision === "baseline") {
        expect(call.launcherSource).toContain(paths.baselineRoot);
        expect(call.launcherSource).not.toContain(paths.candidateRoot);
      } else {
        expect(call.launcherSource).toContain(paths.candidateRoot);
        expect(call.launcherSource).not.toContain(paths.baselineRoot);
      }
    }
    expect(provisioningCalls).toHaveLength(8);
    expect(dependencyCalls).toEqual([
      {
        command: "npm",
        args: ["ci", "--ignore-scripts"],
        revision: "baseline",
        root: paths.baselineRoot,
      },
      {
        command: "npm",
        args: ["ci", "--ignore-scripts"],
        revision: "candidate",
        root: paths.candidateRoot,
      },
    ]);
    for (const call of provisioningCalls) {
      expect(call.root).toBe(paths.candidateRoot);
      expect(call.adapterFixturePath).toBe(
        join(
          call.root,
          "tests",
          "e2e",
          "fixtures",
          "editor-debugging-2348",
          "dap-socket-adapter.fixture",
        ),
      );
    }
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    expect(readFileSync(join(result.artifactsRoot, ".keiko-d12-runner-owned"), "utf8")).toBe(
      "keiko-d12-performance-runner-v1\n",
    );
    expect(manifest.schemaVersion).toBe("3");
    expect(manifest.dependencyProvisioning).toEqual({
      command: "npm",
      args: ["ci", "--ignore-scripts"],
      lockfileSha256: sha256("{}\n"),
    });
    expect(result.comparison.args).toContain("--self-check");
    expect(manifest.repetitions.map((entry) => entry.order)).toEqual([
      ["baseline", "candidate"],
      ["candidate", "baseline"],
      ["baseline", "candidate"],
    ]);
    const runs = manifest.repetitions.flatMap((entry) =>
      entry.order.map((revision) => entry[revision]),
    );
    expect(runs.map((run) => run.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(runs.every((run) => run.measurementHarnessSha256 === HARNESS_DIGEST)).toBe(true);
    expect(manifest.repetitions.map((entry) => entry.candidate.capEvidence.artifact)).toEqual([
      "runs/candidate-cap-1.json",
      "runs/candidate-cap-2.json",
      "runs/candidate-cap-3.json",
    ]);
    for (const run of runs) {
      const artifact = readFileSync(join(result.artifactsRoot, run.artifact), "utf8");
      expect(run.artifactSha256).toBe(sha256(artifact));
      expect(Date.parse(run.completedAtIso)).toBeGreaterThan(Date.parse(run.startedAtIso));
      if (run.capEvidence !== undefined) {
        const capArtifact = readFileSync(
          join(result.artifactsRoot, run.capEvidence.artifact),
          "utf8",
        );
        expect(run.capEvidence.artifactSha256).toBe(sha256(capArtifact));
        expect(run.capEvidence.sequence).toBe(run.sequence);
        expect(Date.parse(run.capEvidence.startedAtIso)).toBeGreaterThanOrEqual(
          Date.parse(run.commonCompletedAtIso),
        );
        expect(run.capEvidence.completedAtIso).toBe(run.completedAtIso);
      }
    }
  });

  it.each([
    [
      "dirty baseline",
      (paths) => (root) => (root === paths.baselineRoot ? ["src/x.ts"] : []),
      /baseline performance subject is dirty/u,
    ],
    [
      "dirty candidate",
      (paths) => (root) => (root === paths.candidateRoot ? ["tests/new.spec.ts"] : []),
      /candidate performance subject is dirty/u,
    ],
  ])("fails closed for a %s before executing the harness", async (_name, dirtyPaths, expected) => {
    const paths = fixture();
    let executed = false;
    await expect(
      runD12Comparison(invocation(paths), {
        computeDigest: ({ root }) =>
          root === paths.baselineRoot ? SOURCE_DIGESTS.baseline : SOURCE_DIGESTS.candidate,
        computeHarnessDigest: () => HARNESS_DIGEST,
        getHead: (root) => (root === paths.baselineRoot ? BASELINE_COMMIT : CANDIDATE_COMMIT),
        isAncestor: () => true,
        listDirtyPaths: dirtyPaths(paths),
        runHarness: () => {
          executed = true;
        },
      }),
    ).rejects.toThrow(expected);
    expect(executed).toBe(false);
  });

  it("rejects a baseline checkout that is not the pinned commit", async () => {
    const paths = fixture();
    await expect(
      runD12Comparison(invocation(paths), {
        getHead: (root) => (root === paths.baselineRoot ? CANDIDATE_COMMIT : CANDIDATE_COMMIT),
        isAncestor: () => true,
        listDirtyPaths: () => [],
      }),
    ).rejects.toThrow(/baseline HEAD .* does not match pinned baseline/u);
  });

  it("rejects non-ancestor generation before executing either harness", async () => {
    const paths = fixture();
    let executed = false;
    await expect(
      runD12Comparison(invocation(paths), {
        getHead: (root) => (root === paths.baselineRoot ? BASELINE_COMMIT : CANDIDATE_COMMIT),
        isAncestor: () => false,
        listDirtyPaths: () => [],
        runHarness: () => {
          executed = true;
        },
      }),
    ).rejects.toThrow(/pinned baseline commit is not an ancestor/u);
    expect(executed).toBe(false);
  });

  it("rejects dirty or untracked D12 toolchain paths before Playwright", async () => {
    const paths = fixture();
    let executed = false;
    await expect(
      runD12Comparison(invocation(paths), {
        getHead: (root) => (root === paths.baselineRoot ? BASELINE_COMMIT : CANDIDATE_COMMIT),
        isAncestor: () => true,
        listDirtyPaths: () => [],
        listDirtyToolchainPaths: () => [
          "scripts/check-perf-evidence.mjs",
          "scripts/__tests__/run-d12-perf-comparison.test.mjs",
        ],
        runHarness: () => {
          executed = true;
        },
      }),
    ).rejects.toThrow(
      /candidate D12 measurement toolchain is dirty: scripts\/check-perf-evidence\.mjs/u,
    );
    expect(executed).toBe(false);
  });

  it("discovers an untracked toolchain path through the default Git preflight", async () => {
    const paths = fixture();
    execFileSync("git", ["init", "--quiet"], { cwd: paths.candidateRoot });
    execFileSync("git", ["add", "package-lock.json"], { cwd: paths.candidateRoot });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Keiko Test",
        "-c",
        "user.email=keiko-test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
      { cwd: paths.candidateRoot },
    );
    mkdirSync(join(paths.candidateRoot, "scripts"));
    writeFileSync(
      join(paths.candidateRoot, "scripts", "check-perf-evidence.mjs"),
      "// untracked\n",
      "utf8",
    );

    await expect(
      runD12Comparison(invocation(paths), {
        getHead: (root) => (root === paths.baselineRoot ? BASELINE_COMMIT : CANDIDATE_COMMIT),
        isAncestor: () => true,
        listDirtyPaths: () => [],
      }),
    ).rejects.toThrow(
      /candidate D12 measurement toolchain is dirty: scripts\/check-perf-evidence\.mjs/u,
    );
  });

  it("rejects the removed post-hoc candidate cap evidence argument", async () => {
    const paths = fixture();
    const args = invocation(paths);
    args.push("--candidate-cap-evidence", join(paths.root, "post-hoc.json"));
    await expect(runD12Comparison(args)).rejects.toThrow(/unexpected argument/u);
  });

  it("rejects non-equivalent lockfiles before dependency provisioning", async () => {
    const paths = fixture();
    writeFileSync(join(paths.candidateRoot, "package-lock.json"), '{"changed":true}\n', "utf8");
    const provisionDependencies = vi.fn();

    await expect(
      runD12Comparison(invocation(paths), {
        ...preflightDependencies(paths),
        provisionDependencies,
      }),
    ).rejects.toThrow(/package-lock\.json digests differ/u);
    expect(provisionDependencies).not.toHaveBeenCalled();
  });

  it.each([
    ["filesystem root", ({ root }) => parse(root).root, /filesystem root/u],
    ["output ancestor", ({ root }) => dirname(root), /output parent or one of its ancestors/u],
    ["output parent", ({ root }) => root, /output parent or one of its ancestors/u],
    ["comparison output", ({ root }) => join(root, "comparison.json"), /comparison output path/u],
    ["baseline checkout", ({ baselineRoot }) => baselineRoot, /baseline checkout/u],
    [
      "candidate descendant",
      ({ candidateRoot }) => join(candidateRoot, "artifacts"),
      /candidate checkout/u,
    ],
  ])(
    "rejects the dangerous %s without deleting existing content",
    async (_name, select, expected) => {
      const paths = fixture();
      const dangerous = select(paths);
      const sentinel = join(paths.root, `sentinel-${_name.replaceAll(" ", "-")}`);
      writeFileSync(sentinel, "preserve\n", "utf8");
      const args = setOption(invocation(paths), "--artifacts-root", dangerous);

      await expect(runD12Comparison(args, preflightDependencies(paths))).rejects.toThrow(expected);
      expect(readFileSync(sentinel, "utf8")).toBe("preserve\n");
    },
  );

  it("refuses to recursively delete an existing directory without its exact ownership marker", async () => {
    const paths = fixture();
    const artifactsRoot = join(paths.root, "unowned-artifacts");
    mkdirSync(artifactsRoot);
    const sentinel = join(artifactsRoot, "preserve.txt");
    writeFileSync(sentinel, "preserve\n", "utf8");
    const args = setOption(invocation(paths), "--artifacts-root", artifactsRoot);
    const provisionDependencies = vi.fn();

    await expect(
      runD12Comparison(args, { ...preflightDependencies(paths), provisionDependencies }),
    ).rejects.toThrow(/artifacts root is not runner-owned/u);
    expect(provisionDependencies).not.toHaveBeenCalled();
    expect(readFileSync(sentinel, "utf8")).toBe("preserve\n");
  });

  it("recursively resets an existing directory only when the exact runner marker is present", async () => {
    const paths = fixture();
    const artifactsRoot = join(paths.root, "owned-artifacts");
    mkdirSync(artifactsRoot);
    writeFileSync(
      join(artifactsRoot, ".keiko-d12-runner-owned"),
      "keiko-d12-performance-runner-v1\n",
      "utf8",
    );
    const sentinel = join(artifactsRoot, "remove-me.txt");
    writeFileSync(sentinel, "runner-owned\n", "utf8");
    const args = setOption(invocation(paths), "--artifacts-root", artifactsRoot);

    await expect(
      runD12Comparison(args, {
        ...preflightDependencies(paths),
        runHarness: () => {
          throw new Error("stop after owned reset");
        },
      }),
    ).rejects.toThrow(/stop after owned reset/u);
    expect(existsSync(sentinel)).toBe(false);
    expect(readFileSync(join(artifactsRoot, ".keiko-d12-runner-owned"), "utf8")).toBe(
      "keiko-d12-performance-runner-v1\n",
    );
  });

  it("rejects a lockfile changed by the injected provisioning step before any measurement", async () => {
    const paths = fixture();
    const runHarness = vi.fn();

    await expect(
      runD12Comparison(invocation(paths), {
        ...preflightDependencies(paths),
        provisionDependencies: ({ revision }) => {
          if (revision === "candidate") {
            writeFileSync(join(paths.candidateRoot, "package-lock.json"), '{"changed":true}\n');
          }
        },
        runHarness,
      }),
    ).rejects.toThrow(/candidate package-lock\.json changed during dependency provisioning/u);
    expect(runHarness).not.toHaveBeenCalled();
  });
});
