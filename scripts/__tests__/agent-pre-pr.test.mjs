import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  commandText,
  computeStepInputDigest,
  createPrePrSteps,
  runPrePrGate,
} from "../agent-pre-pr.mjs";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "agent-pre-pr.mjs");

const REQUIRED_LINUX_COMMANDS = [
  "npm run typecheck",
  "npm run lint",
  "npm run format:check",
  "npm run check:qodo-config",
  "npm run check:ui-i18n",
  "npm run check:sonar-scope",
  "npm run check:shell-spawn-guardrails",
  "npm run check:native:macos",
  "npm run typecheck --workspace @oscharko-dev/keiko-ui",
  "npm run lint --workspace @oscharko-dev/keiko-ui",
  "npm test",
  "npm run test:coverage:quality",
  "npm run check:lcov-source-mapping",
  "npm run arch:check",
  "npm run arch:check:negative",
  "npm run check:adr-index",
  "npm run check:dependency-hygiene",
  "npm run check:knip",
  "npm run clean",
  "npm run build",
  "npm run prepare:bin",
  "npm run build:ui",
  "npm run check:editor-release-evidence",
  "npm run check:perf-evidence:editor",
  "npm run prune:package-build-artifacts",
  "npm run prune:package-native-optionals",
  "npm run check:package-surface",
  "npm run check:editor-bundle-size -- --require-static-export",
  "npm run test:e2e:editor-debugging-2348",
  "npm run smoke:install",
  "npm run test:e2e:smoke",
];

function pathWithFakeNpm(binDir) {
  return [binDir, process.env.PATH ?? ""].filter(Boolean).join(delimiter);
}

function runCli(args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("close", (code) => resolveRun({ code: code ?? 0, stderr, stdout }));
    child.once("error", (error) => resolveRun({ code: 1, error, stderr, stdout }));
  });
}

async function installFakeNpm(binDir) {
  await mkdir(binDir, { recursive: true });
  const shim = join(binDir, "npm");
  await writeFile(
    shim,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync } from "node:fs";',
      'const args = process.argv.slice(2).join(" ");',
      "appendFileSync(process.env.KEIKO_FAKE_NPM_LOG, `${args}\\n`);",
      "if (process.env.KEIKO_FAKE_NPM_FAIL_COMMAND !== undefined &&",
      "  args.includes(process.env.KEIKO_FAKE_NPM_FAIL_COMMAND)) process.exit(23);",
    ].join("\n"),
    "utf8",
  );
  await chmod(shim, 0o755);
}

describe("agent pre-PR gate", () => {
  it("pins the local-first command order used before push, PR updates, and merge", () => {
    const commands = createPrePrSteps({ env: {}, platform: "linux" }).map((step) =>
      commandText(step),
    );

    expect(commands).toEqual(REQUIRED_LINUX_COMMANDS);
  });

  it("limits the knip cache digest to analysis inputs instead of hashing the whole repository", () => {
    const knip = createPrePrSteps({ env: {}, platform: "linux" }).find(
      (step) => step.id === "knip",
    );

    expect(knip?.cacheScope).toEqual([
      "packages/",
      "src/",
      "tests/",
      "scripts/",
      "native/",
      "knip.json",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "tsconfig.base.json",
      "tsconfig.build.json",
      "tsconfig.packages.json",
      "vitest.config.ts",
      "vitest.coverage.packages.config.ts",
      "vitest.coverage.scripts.config.ts",
    ]);
  });

  it("invalidates knip for source changes but not unrelated documentation", async () => {
    const repo = await mkdtemp(join(tmpdir(), "keiko-agent-pre-pr-knip-cache-"));
    const knip = createPrePrSteps({ env: {}, platform: "linux" }).find(
      (step) => step.id === "knip",
    );

    try {
      await mkdir(join(repo, "docs"), { recursive: true });
      await mkdir(join(repo, "packages", "fixture"), { recursive: true });
      await writeFile(join(repo, "docs", "note.md"), "initial\n", "utf8");
      await writeFile(join(repo, "packages", "fixture", "index.ts"), "export {};\n", "utf8");
      spawnSync("git", ["init", "--quiet"], { cwd: repo, stdio: "ignore" });

      const initial = computeStepInputDigest(knip, { cwd: repo });
      await writeFile(join(repo, "docs", "note.md"), "changed\n", "utf8");
      expect(computeStepInputDigest(knip, { cwd: repo })).toBe(initial);

      await writeFile(
        join(repo, "packages", "fixture", "index.ts"),
        "export const changed = true;\n",
        "utf8",
      );
      expect(computeStepInputDigest(knip, { cwd: repo })).not.toBe(initial);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  it("keeps Linux-authoritative editor release evidence explicit on non-Linux hosts", () => {
    const evidence = createPrePrSteps({ env: {}, platform: "darwin" }).find(
      (step) => step.id === "editor-release-evidence",
    );

    expect(evidence?.required).toBe(false);
    expect(evidence?.skipReason).toContain("Linux-authoritative");
  });

  it("documents the governed editor debugging E2E skip on non-Linux hosts", () => {
    const debugging = createPrePrSteps({ env: {}, platform: "darwin" }).find(
      (step) => step.id === "editor-debugging-e2e",
    );

    expect(debugging?.required).toBe(false);
    expect(debugging?.skipReason).toContain("Linux Bubblewrap qualification boundary");
  });

  it("does not duplicate the lint heap flag when NODE_OPTIONS already contains it", () => {
    const lint = createPrePrSteps({
      env: { NODE_OPTIONS: "--max-old-space-size=8192" },
      platform: "linux",
    }).find((step) => step.id === "lint");

    expect(lint?.env.NODE_OPTIONS).toBe("--max-old-space-size=8192");
  });

  it("supports a dry run that writes the planned local gate report without running commands", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-agent-pre-pr-"));
    const reportPath = join(tempDir, "report.json");

    try {
      const report = await runPrePrGate({
        dryRun: true,
        env: {},
        platform: "darwin",
        reportPath,
      });
      const persisted = JSON.parse(await readFile(reportPath, "utf8"));

      expect(report.summary.failed).toBe(0);
      expect(report.summary.planned).toBeGreaterThan(0);
      expect(report.summary.skipped).toBe(3);
      expect(persisted.results.map((result) => result.id)).toEqual(
        createPrePrSteps({ env: {}, platform: "darwin" }).map((step) => step.id),
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("executes live steps sequentially and records the report", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-agent-pre-pr-"));
    const binDir = join(tempDir, "bin");
    const reportPath = join(tempDir, "report.json");
    const logPath = join(tempDir, "npm.log");

    try {
      await installFakeNpm(binDir);
      const report = await runPrePrGate({
        cwd: tempDir,
        env: { KEIKO_FAKE_NPM_LOG: logPath, PATH: pathWithFakeNpm(binDir) },
        platform: "darwin",
        reportPath,
      });
      const executed = (await readFile(logPath, "utf8")).trim().split("\n");
      const persisted = JSON.parse(await readFile(reportPath, "utf8"));

      expect(report.summary).toEqual({ cached: 0, failed: 0, passed: 28, planned: 0, skipped: 3 });
      expect(executed.at(0)).toBe("run typecheck");
      expect(executed.at(-1)).toBe("run test:e2e:smoke");
      expect(persisted.results).toHaveLength(createPrePrSteps({ platform: "darwin" }).length);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("caches unchanged scoped steps and reruns them when their inputs change", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keiko-agent-pre-pr-cache-"));
    const repo = join(workspace, "repo");
    const binDir = join(workspace, "bin");
    const reportPath = join(workspace, "report.json");
    const logPath = join(workspace, "npm.log");
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    const git = (...args) => spawnSync("git", args, { cwd: repo, env: gitEnv, stdio: "ignore" });

    try {
      await installFakeNpm(binDir);
      await mkdir(join(repo, "packages"), { recursive: true });
      await mkdir(join(repo, "dist", "ui", "static"), { recursive: true });
      await writeFile(join(repo, "packages", "module.ts"), "export const value = 1;\n", "utf8");
      git("init", "--quiet");
      git("add", "packages/module.ts");
      git(
        "-c",
        "user.name=Keiko Test",
        "-c",
        "user.email=test@invalid",
        "commit",
        "-m",
        "f",
        "--quiet",
      );
      const env = { KEIKO_FAKE_NPM_LOG: logPath, PATH: pathWithFakeNpm(binDir) };

      const first = await runPrePrGate({ cwd: repo, env, platform: "darwin", reportPath });
      expect(first.summary.cached).toBe(0);

      const second = await runPrePrGate({ cwd: repo, env, platform: "darwin", reportPath });
      const statusOf = (id) => second.results.find((result) => result.id === id)?.status;
      expect(statusOf("typecheck")).toBe("cached");
      expect(statusOf("unit-tests")).toBe("cached");
      expect(statusOf("e2e-smoke")).toBe("cached");
      expect(second.summary.cached).toBeGreaterThan(0);

      await writeFile(join(repo, "packages", "module.ts"), "export const value = 2;\n", "utf8");
      const third = await runPrePrGate({ cwd: repo, env, platform: "darwin", reportPath });
      const thirdStatus = (id) => third.results.find((result) => result.id === id)?.status;
      expect(thirdStatus("typecheck")).toBe("passed");
      expect(thirdStatus("build")).toBe("passed");
      expect(thirdStatus("adr-index")).toBe("cached");

      // Root config that changes what a step enforces must bust exactly that step's cached
      // verdict, even though it lives outside the packages/src/tests/scripts trees: tsconfig
      // busts typecheck (not lint), and the ESLint config busts lint (not typecheck).
      await runPrePrGate({ cwd: repo, env, platform: "darwin", reportPath });
      await writeFile(join(repo, "tsconfig.json"), '{ "compilerOptions": {} }\n', "utf8");
      const afterTs = await runPrePrGate({ cwd: repo, env, platform: "darwin", reportPath });
      const afterTsStatus = (id) => afterTs.results.find((result) => result.id === id)?.status;
      expect(afterTsStatus("typecheck")).toBe("passed");
      expect(afterTsStatus("lint")).toBe("cached");
      expect(afterTsStatus("adr-index")).toBe("cached");

      await runPrePrGate({ cwd: repo, env, platform: "darwin", reportPath });
      await writeFile(join(repo, "eslint.config.js"), "export default [];\n", "utf8");
      const afterEslint = await runPrePrGate({ cwd: repo, env, platform: "darwin", reportPath });
      const afterEslintStatus = (id) =>
        afterEslint.results.find((result) => result.id === id)?.status;
      expect(afterEslintStatus("lint")).toBe("passed");
      expect(afterEslintStatus("typecheck")).toBe("cached");

      const fourth = await runPrePrGate({
        cwd: repo,
        env,
        noCache: true,
        platform: "darwin",
        reportPath,
      });
      expect(fourth.summary.cached).toBe(0);
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("stops live execution after the first failing required step", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-agent-pre-pr-"));
    const binDir = join(tempDir, "bin");
    const reportPath = join(tempDir, "report.json");
    const logPath = join(tempDir, "npm.log");

    try {
      await installFakeNpm(binDir);
      const report = await runPrePrGate({
        cwd: tempDir,
        env: {
          KEIKO_FAKE_NPM_FAIL_COMMAND: "run lint",
          KEIKO_FAKE_NPM_LOG: logPath,
          PATH: pathWithFakeNpm(binDir),
        },
        platform: "darwin",
        reportPath,
      });

      expect(report.summary).toEqual({ cached: 0, failed: 1, passed: 1, planned: 0, skipped: 0 });
      expect(report.results.map((result) => result.id)).toEqual(["typecheck", "lint"]);
      expect(report.results.at(-1)?.exitCode).toBe(23);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});

describe("agent pre-PR gate step construction", () => {
  it.each([
    { expected: "npm", platform: "linux" },
    { expected: "npm", platform: "darwin" },
    { expected: "npm.cmd", platform: "win32" },
  ])("uses $expected as the npm binary on $platform", ({ expected, platform }) => {
    const steps = createPrePrSteps({ env: {}, platform });

    expect(steps.every((step) => step.command === expected)).toBe(true);
  });

  it("seeds the lint heap flag when NODE_OPTIONS is unset", () => {
    const lint = createPrePrSteps({ env: {}, platform: "linux" }).find(
      (step) => step.id === "lint",
    );

    expect(lint?.env.NODE_OPTIONS).toBe("--max-old-space-size=8192");
  });

  it("appends the lint heap flag without dropping unrelated NODE_OPTIONS entries", () => {
    const lint = createPrePrSteps({
      env: { NODE_OPTIONS: "--enable-source-maps" },
      platform: "linux",
    }).find((step) => step.id === "lint");

    expect(lint?.env.NODE_OPTIONS).toBe("--enable-source-maps --max-old-space-size=8192");
  });

  it("keeps the editor release evidence step required on linux hosts", () => {
    const evidence = createPrePrSteps({ env: {}, platform: "linux" }).find(
      (step) => step.id === "editor-release-evidence",
    );

    expect(evidence?.required).toBe(true);
    expect(evidence?.skipReason).toBeUndefined();
  });

  it.each([
    { command: "npm run check:native:macos", platform: "darwin", required: true },
    { command: "npm.cmd run check:native:windows", platform: "win32", required: true },
    { command: "npm run check:native:macos", platform: "linux", required: false },
  ])("selects the governed native quality step on $platform", ({ command, platform, required }) => {
    const native = createPrePrSteps({ env: {}, platform }).find(
      (step) => step.id === "native-quality",
    );

    expect(native === undefined ? undefined : commandText(native)).toBe(command);
    expect(native?.required).toBe(required);
    expect(native?.skipReason === undefined).toBe(required);
  });
});

describe("agent pre-PR gate failure modes", () => {
  it("records an error result when the npm binary cannot be spawned", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-agent-pre-pr-"));
    const reportPath = join(tempDir, "report.json");

    try {
      const report = await runPrePrGate({
        cwd: tempDir,
        env: { PATH: join(tempDir, "empty") },
        platform: "linux",
        reportPath,
      });
      const persisted = JSON.parse(await readFile(reportPath, "utf8"));

      expect(report.summary.failed).toBe(1);
      expect(report.summary.passed).toBe(0);
      expect(report.results).toHaveLength(1);
      expect(report.results.at(0)?.status).toBe("failed");
      expect(report.results.at(0)?.error).toBeTypeOf("string");
      expect(persisted.results.at(0)?.id).toBe("typecheck");
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("still records durationMs on a failed live step", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-agent-pre-pr-"));
    const binDir = join(tempDir, "bin");
    const reportPath = join(tempDir, "report.json");
    const logPath = join(tempDir, "npm.log");

    try {
      await installFakeNpm(binDir);
      const report = await runPrePrGate({
        cwd: tempDir,
        env: {
          KEIKO_FAKE_NPM_FAIL_COMMAND: "run typecheck",
          KEIKO_FAKE_NPM_LOG: logPath,
          PATH: pathWithFakeNpm(binDir),
        },
        platform: "linux",
        reportPath,
      });

      const failed = report.results.at(-1);
      expect(failed?.id).toBe("typecheck");
      expect(failed?.status).toBe("failed");
      expect(failed?.durationMs).toBeTypeOf("number");
      expect(failed?.exitCode).toBe(23);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});

describe("agent pre-PR gate CLI entrypoint", () => {
  it("parses --dry-run and --report, prints the report, and exits zero", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-agent-pre-pr-"));
    const reportPath = join(tempDir, "cli-dry-run.json");

    try {
      const result = await runCli(["--dry-run", "--report", reportPath]);
      const persisted = JSON.parse(await readFile(reportPath, "utf8"));

      expect(result.code).toBe(0);
      expect(persisted.dryRun).toBe(true);
      expect(persisted.summary.failed).toBe(0);
      expect(result.stdout).toContain("[agent:pre-pr] Local gate report");
      expect(result.stdout).toContain(`[agent:pre-pr] Report written to ${reportPath}`);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("sets exit code 1 and formats step durations when a live step fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-agent-pre-pr-"));
    const binDir = join(tempDir, "bin");
    const reportPath = join(tempDir, "cli-fail.json");
    const logPath = join(tempDir, "npm.log");

    try {
      await installFakeNpm(binDir);
      const result = await runCli(["--no-cache", "--report", reportPath], {
        cwd: tempDir,
        env: {
          KEIKO_FAKE_NPM_FAIL_COMMAND: "run typecheck",
          KEIKO_FAKE_NPM_LOG: logPath,
          PATH: pathWithFakeNpm(binDir),
        },
      });

      expect(result.code).toBe(1);
      expect(result.stdout).toContain("failed: typecheck");
      expect(result.stdout).toMatch(/\(\d+\.\ds\)/u);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
