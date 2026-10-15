import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync, globSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { parse } from "yaml";
import {
  EXPECTED_NODE_BASELINE,
  EXPECTED_NODE_COMPATIBILITY_BASELINE,
} from "../check-runtime-toolchain.mjs";
import { Linter } from "eslint";
import coveragePlugin from "../code-quality-coverage-plugin.mjs";
import { codeQualityPolicyMain } from "../check-code-quality-policy.mjs";
import { collectPolicyInventory, selectPolicyScope } from "../lib/code-quality-inventory.mjs";
import { assessPolicyDiagnostics } from "../lib/code-quality-policy.mjs";
import { runNativePolicy } from "../lib/code-quality-runner.mjs";
import { evaluatePolicyPackages } from "../lib/code-quality-packages.mjs";
import {
  capturedByteCount,
  closedChildStatus,
  executePolicyWithDiagnostics,
  isolatedPolicyReport,
} from "./code-quality-wiring-smoke.mjs";
import {
  configureEnforcingPolicyFixture,
  createPolicyFixtureRepository,
  createRuntimePolicyFixture,
  fixtureOwnedPolicy,
} from "./support/code-quality-fixture.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function enforcingFixture() {
  const root = createPolicyFixtureRepository();
  roots.push(root);
  configureEnforcingPolicyFixture(root);
  const manifestPath = join(root, "packages/alpha/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version = "0.0.0";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  mkdirSync(join(root, "packages/alpha/dist"));
  writeFileSync(join(root, "packages/alpha/dist/index.js"), "export const value = 1;");
  return root;
}

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const CONTRACTS_SCOPE = "package:@oscharko-dev/keiko-contracts";

function contractsAssertionFixture() {
  const root = enforcingFixture();
  const path = join(root, "packages/alpha/package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.name = "@oscharko-dev/keiko-contracts";
  writeFileSync(path, JSON.stringify(manifest));
  configureEnforcingPolicyFixture(root);
  return root;
}

describe("production code-quality invocation wiring (#3915)", () => {
  it("keeps synthetic fixture scope projection separate from the real contracts policy", () => {
    const production = JSON.parse(read("scripts/code-quality-policy.json"));
    const synthetic = fixtureOwnedPolicy();
    expect(synthetic.rules).toEqual(
      production.rules.map((rule) => ({
        ...rule,
        activeScopes: rule.activeScopes.filter((scope) => scope !== CONTRACTS_SCOPE),
      })),
    );
    expect(production.responsibilities).toHaveLength(18);
    expect(
      production.rules
        .filter((rule) => rule.activeScopes.includes(CONTRACTS_SCOPE))
        .map((rule) => rule.id),
    ).toEqual([
      "anti-slop/no-chained-type-assertions",
      "anti-slop/require-safety-comment-for-type-assertion",
    ]);
  });

  it.each([
    [
      "anti-slop/no-chained-type-assertions",
      (source) => source.replace('"u-1" as UserId', '("u-1" as UserId) as UserId'),
    ],
    [
      "anti-slop/require-safety-comment-for-type-assertion",
      (source) =>
        source.replace(
          "// SAFETY: This bounded ID literal supplies an erased brand; defaults are validated.\n",
          "",
        ),
    ],
  ])("actually rejects %s and admits restored justified source", async (id, mutate) => {
    const root = contractsAssertionFixture();
    const path = "packages/alpha/src/index.ts";
    const original = read("packages/keiko-contracts/src/memory-fixtures.ts");
    writeFileSync(join(root, path), original);
    const inventory = await collectPolicyInventory(root);
    const scope = selectPolicyScope(inventory.files, CONTRACTS_SCOPE, false);
    const policy = JSON.parse(readFileSync(join(root, "scripts/code-quality-policy.json"), "utf8"));
    expect(policy.rules.find((rule) => rule.id === id).activeScopes).toEqual([CONTRACTS_SCOPE]);
    const assess = () => {
      const scan = runNativePolicy(root, scope.files);
      expect(scan.visited).toBe(scope.files.length);
      return { scan, result: assessPolicyDiagnostics(scan.diagnostics, scope.files, policy) };
    };
    writeFileSync(join(root, path), mutate(original));
    const bad = assess();
    expect(
      bad.result.violations.some((finding) => finding.rule === id && finding.path === path),
    ).toBe(true);
    const inactive = structuredClone(policy);
    inactive.rules.find((rule) => rule.id === id).activeScopes = [];
    expect(
      assessPolicyDiagnostics(bad.scan.diagnostics, scope.files, inactive).violations.some(
        (finding) => finding.rule === id,
      ),
    ).toBe(false);
    writeFileSync(join(root, path), original);
    expect(assess().result.violations).toEqual([]);
  });

  it("retains genuine finite child failures with body-free status", async () => {
    const options = { encoding: "utf8", timeout: 1000, killSignal: "SIGKILL", maxBuffer: 1024 };
    const failure = executePolicyWithDiagnostics(
      ["-e", 'process.stdout.write("é"); process.stderr.write("bad"); process.exit(7);'],
      options,
    );
    await expect(failure).rejects.toThrow(
      'policy child failed: {"code":7,"signal":null,"killed":false,"stdoutBytes":2,"stderrBytes":3}',
    );
    await expect(failure).rejects.toHaveProperty("cause", {
      code: 7,
      signal: null,
      killed: false,
      stdoutBytes: 2,
      stderrBytes: 3,
    });
    const healthy = await executePolicyWithDiagnostics(
      ["-e", 'process.stdout.write("healthy");'],
      options,
    );
    expect(healthy.stdout).toBe("healthy");
  });
  it("reports an actual deadline kill without manufacturing an exit code", async () => {
    await expect(
      executePolicyWithDiagnostics(["-e", "setInterval(() => undefined, 1000);"], {
        encoding: "utf8",
        timeout: 1000,
        killSignal: "SIGKILL",
        maxBuffer: 1024,
      }),
    ).rejects.toThrow(
      'policy child failed: {"code":null,"signal":"SIGKILL","killed":true,"stdoutBytes":0,"stderrBytes":0}',
    );
  });
  it("retains native buffer overflow status without captured output bodies", async () => {
    const failure = executePolicyWithDiagnostics(["-e", 'process.stdout.write("x".repeat(64));'], {
      encoding: "utf8",
      timeout: 1000,
      killSignal: "SIGKILL",
      maxBuffer: 8,
    });
    await expect(failure).rejects.toHaveProperty("cause.code", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    await expect(failure).rejects.toHaveProperty("cause.stdoutBytes", 8);
    await expect(failure).rejects.toHaveProperty("cause.stderrBytes", 0);
  });
  it("keeps missing child metadata explicitly unavailable", () => {
    expect(closedChildStatus(undefined)).toBe("unavailable");
    expect(closedChildStatus("raw unbounded text")).toBe("unavailable");
    expect(closedChildStatus("X".repeat(1000))).toBe("unavailable");
    expect(capturedByteCount(undefined)).toBe("unavailable");
  });

  it("emits exactly one receipt from the real parser on empty input", () => {
    const messages = new Linter().verify("", [
      {
        plugins: { "keiko-coverage": coveragePlugin },
        rules: { "keiko-coverage/program": "warn" },
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toBe("keiko-program-visited-v1");
  });

  it("rejects omitted packages and unpacked exports with a reachable positive control", () => {
    const packages = [{ name: "alpha", exports: [{ target: "./dist/index.js" }] }];
    const packed = [{ name: "alpha", files: [{ path: "dist/index.js" }] }];
    expect(evaluatePolicyPackages(packed, packages)).toMatchObject([
      { name: "alpha", fileCount: 1 },
    ]);
    expect(() => evaluatePolicyPackages([], packages)).toThrow("pack-inventory-mismatch");
    expect(() => evaluatePolicyPackages([{ name: "alpha", files: [] }], packages)).toThrow(
      "unpacked-export-target",
    );
  });

  it("isolates a real completed policy receipt from a later parent console capture", async () => {
    const root = createRuntimePolicyFixture("testing/logic.ts", "test-only");
    roots.push(root);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const report = await isolatedPolicyReport(root, 15_000);
      expect(report.enforcementOutcome).toBe("passed");
      expect(report.outcome).toBe("failed");
      expect(report.responsibilities.assessments).toEqual([]);
      expect(report.responsibilities.counts).toMatchObject({ pending: 0, qualified: 0 });
      expect(
        report.inventory.files.find((file) => file.path === "packages/alpha/src/testing/logic.ts")
          .production,
      ).toBe(false);
      expect(report.counts.expected).toBe(report.counts.visited);
      expect(report.pack[0].files).toContain("dist/testing/logic.js");
      expect(output).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
    }
  }, 20_000);

  it("returns an explicit failed verdict for malformed invocation", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await codeQualityPolicyMain(["--mode", "wrong"])).toBe(1);
      expect(error.mock.calls[0][0]).toContain("invalid-mode");
    } finally {
      error.mockRestore();
    }
  });

  it("reports an actual active violation through the human-readable CLI on a hermetic repository", async () => {
    const root = enforcingFixture();
    writeFileSync(
      join(root, "packages/alpha/src/index.ts"),
      "export const value = Reflect.apply(Math.max, null, [1]);",
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await codeQualityPolicyMain([], root)).toBe(1);
      expect(output.mock.calls[0][0]).toContain("FAILED");
      expect(JSON.parse(output.mock.calls[1][0])).toMatchObject({
        path: "packages/alpha/src/index.ts",
        rule: "anti-slop/no-reflect-apply",
      });
    } finally {
      output.mockRestore();
    }
  }, 60_000);
  it.each([
    ["logic.ts", "runtime", true],
    ["testing/logic.ts", "runtime", true],
    ["_support.ts", "runtime", true],
    ["testing/logic.ts", "transitive", true],
    ["testing/logic.ts", "late-alias", true],
    ["testing/logic.ts", "wrapped-alias", true],
    ["testing/logic.ts", "public", true],
    ["testing/logic.ts", "test-only", false],
    ["testing/logic.ts", "type", false],
    ["testing/logic.ts", "named-type", true],
    ["testing/logic.ts", "named-type-export", true],
  ])(
    "reconciles compiled/packed %s via %s with real analyzer evidence",
    async (helper, linkage, production) => {
      const root = createRuntimePolicyFixture(helper, linkage);
      roots.push(root);
      const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        expect(await codeQualityPolicyMain(["--json"], root)).toBe(production ? 1 : 0);
        const report = JSON.parse(output.mock.calls[0][0]);
        const path = `packages/alpha/src/${helper}`;
        expect(report.inventory.files.find((file) => file.path === path).production).toBe(
          production,
        );
        expect(
          report.census.filter(
            (finding) => finding.path === path && finding.rule === "anti-slop/no-reflect-apply",
          ),
        ).toHaveLength(1);
        expect(report.counts.violations).toBe(production ? 1 : 0);
        expect(report.counts.visited).toBe(report.counts.expected);
        expect(report.pack[0].files).toContain(`dist/${helper.replace(/\.ts$/u, ".js")}`);
        if (linkage.startsWith("named-type")) {
          const emitted = readFileSync(join(root, "packages/alpha/dist/index.js"), "utf8");
          expect(emitted).toContain('{} from "./testing/logic.js"');
          expect(
            execFileSync(
              process.execPath,
              [
                "--input-type=module",
                "-e",
                `const runtime = await import(${JSON.stringify(pathToFileURL(join(root, "packages/alpha/dist/index.js")).href)}); console.log(JSON.stringify(runtime.value));`,
              ],
              { encoding: "utf8", timeout: 10_000 },
            ).trim(),
          ).toBe(linkage === "named-type" ? '{"value":1}' : "1");
        }
        if (production && !linkage.startsWith("named-type")) {
          const entry = linkage === "public" ? "dist/testing/logic.js" : "dist/index.js";
          const target = pathToFileURL(join(root, "packages/alpha", entry)).href;
          const executed = execFileSync(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `const runtime = await import(${JSON.stringify(target)}); console.log(await runtime.maximum());`,
            ],
            { encoding: "utf8", timeout: 10_000 },
          );
          expect(executed.trim()).toBe("2");
        }
      } finally {
        output.mockRestore();
      }
    },
    60_000,
  );

  it.each([false, true])(
    "qualifies the actual native owner through the real CLI with violation=%s",
    async (violating) => {
      const root = enforcingFixture();
      if (violating)
        writeFileSync(
          join(root, "native/opencode-service-host/violation.mjs"),
          'export const value = { _tag: "Ready", value: 1 };',
        );
      const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        expect(await codeQualityPolicyMain(["--json"], root)).toBe(violating ? 1 : 0);
        const report = JSON.parse(output.mock.calls[0][0]);
        expect(report.counts.expected).toBe(report.counts.visited);
        const native = report.inventory.files.filter((file) => file.scope === "native-host");
        expect(native).toHaveLength(violating ? 4 : 3);
        expect(native.every((file) => file.production)).toBe(true);
        expect(report.counts.violations).toBe(violating ? 1 : 0);
        if (violating)
          expect(report.violations).toContainEqual(
            expect.objectContaining({
              path: "native/opencode-service-host/violation.mjs",
              rule: "anti-slop-effect/no-manual-tagged-construction",
            }),
          );
      } finally {
        output.mockRestore();
      }
    },
    60_000,
  );

  it("refuses malformed native owner input through the actual CLI parser", async () => {
    const root = enforcingFixture();
    writeFileSync(join(root, "native/opencode-service-host/entry.mjs"), "export const broken = (");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await codeQualityPolicyMain(["--json"], root)).toBe(1);
      expect(error.mock.calls[0][0]).toContain("invalid-production-source");
      expect(output).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
      error.mockRestore();
    }
  }, 60_000);

  it("retains full local lint and requires hosted policy before typed Core lint", () => {
    const manifest = JSON.parse(read("package.json"));
    expect(manifest.scripts["check:code-quality-policy"]).toBe(
      "node scripts/check-code-quality-policy.mjs",
    );
    const commands = manifest.scripts.lint.split(" && ");
    expect(manifest.scripts["check:code-quality-policy:repository"]).toBe(
      "node --test scripts/__tests__/code-quality-wiring-smoke.mjs",
    );
    expect(commands.indexOf("npm run check:code-quality-policy:repository")).toBe(1);
    expect(
      commands.filter((command) => command === "npm run check:code-quality-policy"),
    ).toHaveLength(0);
    expect(commands[0]).toBe("npm run build:packages");
    expect(commands.slice(2)).toEqual([
      "npm run check:code-quality-policy:raw-reader",
      "npm run lint:typed",
    ]);
    expect(manifest.scripts["check:code-quality-policy:raw-reader"]).toBe(
      "node --test scripts/__tests__/code-quality-raw-reader-smoke.mjs",
    );
    expect(manifest.scripts["lint:typed"]).toContain("eslint/bin/eslint.js . --max-warnings=0");
    expect(manifest.scripts["lint:typed"]).toContain(
      "npm --workspace @oscharko-dev/keiko-ui run lint",
    );
    const workflow = parse(read(".github/workflows/ci.yml"));
    const core = Object.values(workflow.jobs).find((job) => job.name === "Core quality");
    expect(core.needs).toContain("code-quality-policy");
    expect(core.steps.filter((step) => step.run === "npm run lint:typed")).toHaveLength(1);
    expect(core.steps.filter((step) => step.run === "npm run lint")).toHaveLength(0);
  });

  it("runs the uncollected repository smoke in both required hosted ARM policy legs", async () => {
    const workflow = parse(read(".github/workflows/ci.yml"));
    const compatibility = workflow.jobs["node-26-compatibility"];
    const runs = compatibility.steps.map((step) => step.run);
    expect(runs).toContain("npm test -- --shard=${{ matrix.shard }}/2");
    expect(runs).not.toContain("npm run check:code-quality-policy:repository");
    const policy = workflow.jobs["code-quality-policy"];
    expect(policy["runs-on"]).toBe("ubuntu-24.04-arm");
    expect(policy.strategy.matrix.node).toEqual([
      EXPECTED_NODE_BASELINE,
      EXPECTED_NODE_COMPATIBILITY_BASELINE,
    ]);
    const smoke = policy.steps.filter(
      (step) => step.run === "npm run check:code-quality-policy:repository",
    );
    expect(smoke).toHaveLength(1);
    expect(smoke[0].if).toBeUndefined();
    const policyRuns = policy.steps.map((step) => step.run);
    const fullIndex = policyRuns.indexOf("npm run check:code-quality-policy:repository");
    expect(policyRuns[fullIndex + 1]).toBe("npm run check:code-quality-policy:raw-reader");
    expect(policy.steps[fullIndex + 1].if).toBeUndefined();
    expect(workflow.jobs.ci.needs).toContain("code-quality-policy");
    const cwd = fileURLToPath(new URL("../../", import.meta.url));
    for (const name of [
      "vitest.config.ts",
      "vitest.coverage.packages.config.ts",
      "vitest.coverage.scripts.config.ts",
    ]) {
      const loaded = await import(join(cwd, name));
      const config =
        typeof loaded.default === "function" ? await loaded.default({}) : loaded.default;
      const included = config.test.include.flatMap((pattern) =>
        globSync(pattern, { cwd, exclude: config.test.exclude }),
      );
      for (const smokePath of [
        "scripts/__tests__/code-quality-wiring-smoke.mjs",
        "scripts/__tests__/code-quality-raw-reader-smoke.mjs",
      ]) {
        expect(included.map((path) => path.replaceAll("\\", "/"))).not.toContain(smokePath);
      }
    }
  });
});

describe("explicit responsibility qualification arguments", () => {
  it("keeps default static options and admits only the explicit switch", async () => {
    const { parsePolicyArguments } = await import("../check-code-quality-policy.mjs");
    expect(parsePolicyArguments([], false)).toEqual({
      mode: "enforce",
      scope: "repository",
      json: false,
    });
    expect(parsePolicyArguments(["--qualify-responsibilities", "--json"], false)).toEqual({
      mode: "enforce",
      scope: "repository",
      json: true,
      qualifyResponsibilities: true,
    });
    expect(() =>
      parsePolicyArguments(["--qualify-responsibilities", "--qualify-responsibilities"], false),
    ).toThrow("invalid-arguments");
    expect(() =>
      parsePolicyArguments(["--mode", "census", "--qualify-responsibilities"], false),
    ).toThrow("invalid-mode");
  });
});
