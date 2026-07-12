import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commandText, createPrePrSteps, runPrePrGate } from "../codex-pre-pr.mjs";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "codex-pre-pr.mjs");

const REQUIRED_LINUX_COMMANDS = [
  "npm run typecheck",
  "npm run lint",
  "npm run format:check",
  "npm run typecheck --workspace @oscharko-dev/keiko-ui",
  "npm run lint --workspace @oscharko-dev/keiko-ui",
  "npm test",
  "npm run test:coverage:quality",
  "npm run check:lcov-source-mapping",
  "npm run arch:check",
  "npm run arch:check:negative",
  "npm run check:adr-index",
  "npm run check:dependency-hygiene",
  "npm run clean",
  "npm run build",
  "npm run prepare:bin",
  "npm run build:ui",
  "npm run check:editor-release-evidence",
  "npm run prune:package-build-artifacts",
  "npm run check:package-surface",
  "npm run check:editor-bundle-size -- --require-static-export",
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

describe("codex pre-PR gate", () => {
  it("pins the local-first command order used before push, PR updates, and merge", () => {
    const commands = createPrePrSteps({ env: {}, platform: "linux" }).map((step) =>
      commandText(step),
    );

    expect(commands).toEqual(REQUIRED_LINUX_COMMANDS);
  });

  it("keeps Linux-authoritative editor release evidence explicit on non-Linux hosts", () => {
    const evidence = createPrePrSteps({ env: {}, platform: "darwin" }).find(
      (step) => step.id === "editor-release-evidence",
    );

    expect(evidence?.required).toBe(false);
    expect(evidence?.skipReason).toContain("Linux-authoritative");
  });

  it("does not duplicate the lint heap flag when NODE_OPTIONS already contains it", () => {
    const lint = createPrePrSteps({
      env: { NODE_OPTIONS: "--max-old-space-size=8192" },
      platform: "linux",
    }).find((step) => step.id === "lint");

    expect(lint?.env.NODE_OPTIONS).toBe("--max-old-space-size=8192");
  });

  it("supports a dry run that writes the planned local gate report without running commands", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-codex-pre-pr-"));
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
      expect(report.summary.skipped).toBe(1);
      expect(persisted.results.map((result) => result.id)).toEqual(
        createPrePrSteps({ env: {}, platform: "darwin" }).map((step) => step.id),
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("executes live steps sequentially and records the report", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-codex-pre-pr-"));
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

      expect(report.summary).toEqual({ failed: 0, passed: 20, planned: 0, skipped: 1 });
      expect(executed.at(0)).toBe("run typecheck");
      expect(executed.at(-1)).toBe("run test:e2e:smoke");
      expect(persisted.results).toHaveLength(createPrePrSteps({ platform: "darwin" }).length);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("stops live execution after the first failing required step", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-codex-pre-pr-"));
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

      expect(report.summary).toEqual({ failed: 1, passed: 1, planned: 0, skipped: 0 });
      expect(report.results.map((result) => result.id)).toEqual(["typecheck", "lint"]);
      expect(report.results.at(-1)?.exitCode).toBe(23);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});

describe("codex pre-PR gate step construction", () => {
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
});

describe("codex pre-PR gate failure modes", () => {
  it("records an error result when the npm binary cannot be spawned", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-codex-pre-pr-"));
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
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-codex-pre-pr-"));
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

describe("codex pre-PR gate CLI entrypoint", () => {
  it("parses --dry-run and --report, prints the report, and exits zero", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-codex-pre-pr-"));
    const reportPath = join(tempDir, "cli-dry-run.json");

    try {
      const result = await runCli(["--dry-run", "--report", reportPath]);
      const persisted = JSON.parse(await readFile(reportPath, "utf8"));

      expect(result.code).toBe(0);
      expect(persisted.dryRun).toBe(true);
      expect(persisted.summary.failed).toBe(0);
      expect(result.stdout).toContain("[codex:pre-pr] Local gate report");
      expect(result.stdout).toContain(`[codex:pre-pr] Report written to ${reportPath}`);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("sets exit code 1 and formats step durations when a live step fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-codex-pre-pr-"));
    const binDir = join(tempDir, "bin");
    const reportPath = join(tempDir, "cli-fail.json");
    const logPath = join(tempDir, "npm.log");

    try {
      await installFakeNpm(binDir);
      const result = await runCli(["--report", reportPath], {
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
