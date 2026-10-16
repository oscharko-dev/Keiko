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
import {
  policyDigest,
  collectPolicyInventory,
  selectPolicyScope,
} from "../lib/code-quality-inventory.mjs";
import {
  assessPolicyDiagnostics,
  POLICY_PROGRESS_LIMITS,
  policyProgressLine,
  lastPolicyProgress,
} from "../lib/code-quality-policy.mjs";
import { assertRepositoryQualification } from "./code-quality-repository-qualification.mjs";
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
const STATIC_POLICY_SMOKE_COMMAND = `node --input-type=module -e 'import os from "node:os"; console.log(JSON.stringify({ arch: os.arch(), logicalCpus: os.cpus().length, availableParallelism: os.availableParallelism(), totalMemoryBytes: os.totalmem() }));'
/usr/bin/time -v npm run check:code-quality-policy:repository
`;

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
    expect(production.responsibilities).toHaveLength(49);
    expect(
      production.rules
        .filter((rule) => rule.activeScopes.includes(CONTRACTS_SCOPE))
        .map((rule) => rule.id),
    ).toEqual([
      "anti-slop/no-chained-type-assertions",
      "anti-slop/no-reflect-get",
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

  it("rejects native contracts reflection outside the qualified observation coordinate", async () => {
    const root = contractsAssertionFixture();
    const path = "packages/alpha/src/index.ts";
    const original = read("packages/keiko-contracts/src/memory-fixtures.ts");
    writeFileSync(join(root, path), original);
    const inventory = await collectPolicyInventory(root);
    const scope = selectPolicyScope(inventory.files, CONTRACTS_SCOPE, false);
    const policy = JSON.parse(readFileSync(join(root, "scripts/code-quality-policy.json"), "utf8"));
    const id = "anti-slop/no-reflect-get";
    expect(policy.rules.find((rule) => rule.id === id).activeScopes).toEqual([CONTRACTS_SCOPE]);
    const inactive = structuredClone(policy);
    inactive.rules.find((rule) => rule.id === id).activeScopes = [];
    try {
      writeFileSync(
        join(root, path),
        original +
          "\nexport function outsideObservation(value: object, key: PropertyKey): unknown { return Reflect.get(value, key); }\n",
      );
      const scan = runNativePolicy(root, scope.files);
      expect(scan.visited).toBe(scope.files.length);
      const introduced = scan.diagnostics.filter(
        (finding) => finding.rule === id && finding.path === path,
      );
      expect(introduced).toHaveLength(1);
      const baseline = assessPolicyDiagnostics(scan.diagnostics, scope.files, inactive);
      const activated = assessPolicyDiagnostics(scan.diagnostics, scope.files, policy);
      expect(baseline.census).toEqual(activated.census);
      expect(baseline.violations.filter((finding) => finding.rule === id)).toEqual([]);
      expect(activated.violations.filter((finding) => finding.rule === id)).toEqual(introduced);
    } finally {
      writeFileSync(join(root, path), original);
    }
    const restored = runNativePolicy(root, scope.files);
    expect(restored.visited).toBe(scope.files.length);
    expect(restored.diagnostics.filter((finding) => finding.rule === id)).toEqual([]);
    expect(assessPolicyDiagnostics(restored.diagnostics, scope.files, policy).violations).toEqual(
      [],
    );
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
      "node scripts/__tests__/code-quality-repository-qualification.mjs",
    );
    expect(manifest.scripts["check:code-quality-policy:cli-smoke"]).toBe(
      "node --test scripts/__tests__/code-quality-wiring-smoke.mjs",
    );
    expect(commands.indexOf("npm run check:code-quality-policy:repository")).toBe(2);
    expect(
      commands.filter((command) => command === "npm run check:code-quality-policy"),
    ).toHaveLength(0);
    expect(commands[0]).toBe("npm run build:packages");
    expect(commands.slice(1)).toEqual([
      "npm run check:code-quality-policy:cli-smoke",
      "npm run check:code-quality-policy:repository",
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

  it("runs bounded CLI integration then complete qualification in both required hosted ARM policy legs", async () => {
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
    const smoke = policy.steps.filter((step) => step.run === STATIC_POLICY_SMOKE_COMMAND);
    expect(smoke).toHaveLength(1);
    expect(smoke[0].if).toBeUndefined();
    expect(smoke[0]["continue-on-error"]).toBeUndefined();
    const policyRuns = policy.steps.map((step) => step.run);
    expect(
      policyRuns.filter((run) => run?.includes("npm run check:code-quality-policy:repository")),
    ).toEqual([STATIC_POLICY_SMOKE_COMMAND]);
    const fullIndex = policyRuns.indexOf(STATIC_POLICY_SMOKE_COMMAND);
    expect(policyRuns[fullIndex - 1]).toBe("npm run check:code-quality-policy:cli-smoke");
    expect(policy.steps[fullIndex - 1].if).toBeUndefined();
    expect(policy.steps[fullIndex - 1]["continue-on-error"]).toBeUndefined();
    expect(policyRuns[fullIndex + 1]).toBe("npm run check:code-quality-policy:raw-reader");
    expect(policy.steps[fullIndex + 1].if).toBeUndefined();
    expect(policy.steps[fullIndex + 1]["continue-on-error"]).toBeUndefined();
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
        "scripts/__tests__/code-quality-repository-qualification.mjs",
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

const progressObservation = Object.freeze({
  version: 1,
  phase: "native-scan",
  state: "started",
  elapsedMs: 9,
});

function malformedProgressLines(line) {
  return [
    line.slice(0, -1),
    line.replace('"version":1', '"version":2'),
    line.replace('"native-scan"', '"private-path"'),
    line.replace('"started"', '"pending"'),
    line.replace('"elapsedMs":9', '"elapsedMs":-1'),
    line.replace('"elapsedMs":9', '"elapsedMs":0.5'),
    line.replace('"elapsedMs":9', '"elapsedMs":null'),
    line.replace('"elapsedMs":9', '"elapsedMs":NaN'),
    line.replace('"elapsedMs":9', '"elapsedMs":Infinity'),
    line.replace('"elapsedMs":9', '"elapsedMs":2147483648'),
    line.replace('"elapsedMs":9', '"elapsedMs":"9"'),
    line.replaceAll("}", ',"path":"fixture-private-body"}'),
    line.replace('"version":1', '"version":1,"version":1'),
    line.replace('"elapsedMs":9', '"elapsedMs":9,"count":1'),
    `${line.trimEnd()}${"x".repeat(POLICY_PROGRESS_LIMITS.line)}\n`,
    `${line.trimEnd()}\r\n`,
  ];
}

function progressChildSource() {
  const entry = new URL("../lib/code-quality-policy.mjs", import.meta.url).href;
  return `const { policyProgressLine } = await import(${JSON.stringify(entry)});
    process.stderr.write(policyProgressLine(${JSON.stringify(progressObservation)}));
    setInterval(() => undefined, 1000);`;
}

async function actualFixturePolicy(root, progress) {
  const entry = new URL("../check-code-quality-policy.mjs", import.meta.url).href;
  const flags = ["--json", ...(progress ? ["--progress"] : [])];
  const source = `const { codeQualityPolicyMain } = await import(${JSON.stringify(entry)});
    process.exitCode = await codeQualityPolicyMain(${JSON.stringify(flags)}, ${JSON.stringify(root)});`;
  return executePolicyWithDiagnostics(["--input-type=module", "-e", source], {
    encoding: "utf8",
    timeout: 15_000,
    killSignal: "SIGKILL",
    maxBuffer: 32 * 1024 * 1024,
  });
}

describe("closed opt-in policy phase diagnostics", () => {
  it("admits only the explicit progress switch and retains duplicate refusal", async () => {
    const { parsePolicyArguments } = await import("../check-code-quality-policy.mjs");
    expect(parsePolicyArguments(["--json", "--progress"], false)).toEqual({
      mode: "enforce",
      scope: "repository",
      json: true,
      progress: true,
    });
    expect(() => parsePolicyArguments(["--progress", "--progress"], false)).toThrow(
      "invalid-arguments",
    );
    expect(() => parsePolicyArguments(["--progress", "yes"], false)).toThrow("invalid-arguments");
  });

  it("projects only the producer's complete four-field canonical frame", () => {
    const line = policyProgressLine(progressObservation);
    expect(lastPolicyProgress(line)).toEqual(progressObservation);
    expect(Object.keys(lastPolicyProgress(line))).toEqual([
      "version",
      "phase",
      "state",
      "elapsedMs",
    ]);
    for (const invalid of malformedProgressLines(line))
      expect(lastPolicyProgress(invalid)).toBeNull();
    expect(
      policyProgressLine({ ...progressObservation, extra: "fixture-private-body" }),
    ).toBeNull();
    expect(policyProgressLine({ ...progressObservation, elapsedMs: Number.NaN })).toBeNull();
    expect(lastPolicyProgress(undefined)).toBeNull();
    expect(lastPolicyProgress("fixture-private-body\n")).toBeNull();
  });

  it("keeps tail and line bounds and never reconstructs a truncated frame", () => {
    const line = policyProgressLine(progressObservation);
    const noise = "fixture-private-body".repeat(POLICY_PROGRESS_LIMITS.tail);
    expect(lastPolicyProgress(noise + "\n" + line)).toEqual(progressObservation);
    expect(lastPolicyProgress(line + noise)).toBeNull();
    expect(lastPolicyProgress(noise + line.slice(1))).toBeNull();
    const frames = Array.from({ length: POLICY_PROGRESS_LIMITS.frames + 1 }, (_, elapsedMs) =>
      policyProgressLine({ ...progressObservation, elapsedMs }),
    ).join("");
    expect(lastPolicyProgress(frames)).toEqual({
      ...progressObservation,
      elapsedMs: POLICY_PROGRESS_LIMITS.frames,
    });
  });

  it("retains the actual last phase after a real child reaches the deadline before JSON", async () => {
    const failure = executePolicyWithDiagnostics(
      ["--input-type=module", "-e", progressChildSource()],
      {
        encoding: "utf8",
        timeout: 1000,
        killSignal: "SIGKILL",
        maxBuffer: 1024,
      },
      true,
    );
    await expect(failure).rejects.toHaveProperty("cause.killed", true);
    await expect(failure).rejects.toHaveProperty("cause.signal", "SIGKILL");
    await expect(failure).rejects.toHaveProperty("cause.stdoutBytes", 0);
    const cause = await failure.catch((error) => error.cause);
    expect(cause.stderrBytes).toBeGreaterThan(0);
    expect(cause.progress).toEqual(progressObservation);
  });

  it("retains unavailable progress rather than exposing actual malformed child stderr", async () => {
    const line = policyProgressLine(progressObservation);
    const malformed = malformedProgressLines(line)[11];
    const source = `process.stderr.write(${JSON.stringify(malformed)}); process.exit(7);`;
    const failure = executePolicyWithDiagnostics(
      ["-e", source],
      {
        encoding: "utf8",
        timeout: 1000,
        killSignal: "SIGKILL",
        maxBuffer: 1024,
      },
      true,
    );
    await expect(failure).rejects.toHaveProperty("cause.progress", "unavailable");
    await expect(failure).rejects.toHaveProperty("cause.code", 7);
    try {
      await failure;
    } catch (error) {
      expect(error.message).not.toContain("fixture-private-body");
      expect(JSON.stringify(error.cause)).not.toContain("fixture-private-body");
    }
  });

  it("passes the opt-in through the actual isolated CLI failure path", async () => {
    const root = enforcingFixture();
    const path = join(root, "scripts/code-quality-policy.json");
    const policy = JSON.parse(readFileSync(path, "utf8"));
    policy.version = -1;
    writeFileSync(path, JSON.stringify(policy));
    const failure = isolatedPolicyReport(root, 15_000, true);
    await expect(failure).rejects.toHaveProperty("cause.code", 1);
    await expect(failure).rejects.toHaveProperty("cause.stdoutBytes", 0);
    await expect(failure).rejects.toHaveProperty("cause.progress", {
      version: 1,
      phase: "policy-validation",
      state: "started",
      elapsedMs: expect.any(Number),
    });
    const error = await failure.catch((value) => value);
    expect(error.cause.stderrBytes).toBeGreaterThan(0);
    expect(error.message).not.toContain(root);
    expect(error.message).not.toContain("code-quality-policy: FAIL");
  }, 20_000);

  it("observes the actual in-process opt-in CLI writer without replacing the producer", async () => {
    const root = enforcingFixture();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await codeQualityPolicyMain(["--json", "--progress"], root)).toBe(0);
      expect(output.mock.calls).toHaveLength(1);
      const report = JSON.parse(output.mock.calls[0][0]);
      expect(report.counts.visited).toBe(report.counts.expected);
      expect(report.enforcementOutcome).toBe("passed");
      expect(stderr.mock.calls.length).toBeGreaterThan(0);
      expect(stderr.mock.calls.length).toBeLessThanOrEqual(POLICY_PROGRESS_LIMITS.frames);
      for (const [line] of stderr.mock.calls) {
        expect(lastPolicyProgress(line)).not.toBeNull();
      }
      expect(lastPolicyProgress(stderr.mock.calls.map(([line]) => line).join(""))).toMatchObject({
        phase: "report-serialization",
        state: "completed",
      });
    } finally {
      stderr.mockRestore();
      output.mockRestore();
    }
  }, 20_000);

  it("keeps actual fixture JSON stdout byte-identical and quiet by default", async () => {
    const root = enforcingFixture();
    const quiet = await actualFixturePolicy(root, false);
    const observed = await actualFixturePolicy(root, true);
    expect(quiet.stderr).toBe("");
    expect(observed.stdout).toBe(quiet.stdout);
    expect(JSON.parse(observed.stdout).counts.visited).toBe(
      JSON.parse(quiet.stdout).counts.expected,
    );
    const lines = observed.stderr.split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(POLICY_PROGRESS_LIMITS.frames);
    for (const line of lines) {
      expect(line.length + 1).toBeLessThanOrEqual(POLICY_PROGRESS_LIMITS.line);
      expect(lastPolicyProgress(`${line}\n`)).not.toBeNull();
    }
    expect(lastPolicyProgress(observed.stderr)).toMatchObject({
      phase: "report-serialization",
      state: "completed",
    });
  }, 40_000);
});

describe("Workbench question and research responsibility wiring (#3918)", () => {
  it("binds four public parameter-zero obligations to their actual public proofs", () => {
    const policy = JSON.parse(read("scripts/code-quality-policy.json"));
    const records = policy.responsibilities.slice(-4);
    expect(records.map((record) => record.id)).toEqual([
      "coding-runtime-question-answer-public-parser",
      "coding-runtime-questions-response-public-parser",
      "coding-runtime-questions-channel-public-parser",
      "coding-runtime-research-channel-public-parser",
    ]);
    expect(records.map((record) => record.consumer.exportName)).toEqual([
      "parsePublicRuntimeQuestionAnswer",
      "parsePublicRuntimeQuestionsResponse",
      "parsePublicRuntimeQuestionsChannel",
      "parsePublicRuntimeResearchChannel",
    ]);
    for (const record of records) {
      expect(record.kind).toBe("public-parser");
      expect(record.rules).toEqual(["anti-slop/no-unknown-parameters"]);
      expect(record.input.parameterIndex).toBe(0);
      expect(record.transform).toEqual(record.output);
      expect(record.input).toEqual({ ...record.transform, parameterIndex: 0 });
      expect(record.consumer).toMatchObject({
        consumerPath: record.input.consumerPath,
        specifier: record.input.specifier,
        kind: "public-api-proof",
        owner: record.owner,
      });
      expect(record.proofs).toContain(record.input.consumerPath);
      for (const assertion of record.proofAssertions) {
        expect(record.proofs).toContain(assertion.path);
        expect(assertion.testName.length).toBeGreaterThan(0);
      }
    }
    expect(records[1].proofAssertions).toContainEqual({
      path: "packages/keiko-server/src/coding-runtime/productionCodingRuntimeQuestionPort.test.ts",
      testName:
        "public runtime question response admission (#3918) refuses a real malformed runtime projection before returning a list",
    });
  });
});

// Constructed validator inputs test refusal only; they are never semantic-execution evidence.
function qualificationValidatorFixture() {
  const policyBytes = read("scripts/code-quality-policy.json");
  const policy = JSON.parse(policyBytes);
  const report = {
    outcome: "passed",
    enforcementOutcome: "passed",
    mode: "enforce",
    scope: { id: "repository", partial: false },
    subject: "a".repeat(40),
    policySha256: policyDigest(policyBytes),
    inventory: { subject: "a".repeat(40), files: [{ path: "constructed.ts" }] },
    counts: { expected: 1, visited: 1, packages: 27, violations: 0 },
    pack: Array.from({ length: 27 }, () => ({})),
    rules: policy.rules,
    violations: [],
    responsibilities: {
      counts: { ready: 49, incomplete: 0, invalid: 0, qualified: 49, pending: 0, rejected: 0 },
      assessments: policy.responsibilities.map((record) => ({
        id: record.id,
        owner: record.owner,
        kind: record.kind,
        rules: record.rules,
        structural: "ready",
        semantic: "qualified",
        reasons: [],
        obligations: [],
        proofs: record.proofs.map((path) => ({ path, executed: true })),
        proofAssertions: record.proofAssertions.map((selector) => ({
          ...selector,
          status: "passed",
        })),
      })),
      execution: {
        status: "passed",
        invocationCount: 1,
        process: { directChildClosed: true, groupAbsent: true },
      },
    },
  };
  return { report, policy, policyBytes };
}

function assertPolicyOperationOrder(job) {
  const steps = job.steps.filter(({ run }) => run);
  const full = steps.findIndex(({ run }) => run === STATIC_POLICY_SMOKE_COMMAND);
  expect(full).toBeGreaterThan(0);
  expect(
    steps.filter(({ run }) => run?.includes("npm run check:code-quality-policy:repository")),
  ).toHaveLength(1);
  expect(steps.slice(full - 1, full + 2).map(({ run }) => run)).toEqual([
    "npm run check:code-quality-policy:cli-smoke",
    STATIC_POLICY_SMOKE_COMMAND,
    "npm run check:code-quality-policy:raw-reader",
  ]);
  for (const step of steps.slice(full - 1, full + 2)) {
    expect(step.if).toBeUndefined();
    expect(step["continue-on-error"]).toBeUndefined();
  }
}

describe("complete production qualification owner", () => {
  it("admits a constructed exact validator shape without claiming proof execution", () => {
    const { report, policy, policyBytes } = qualificationValidatorFixture();
    expect(() => assertRepositoryQualification(report, policy, policyBytes)).not.toThrow();
  });
  it.each([
    [
      "default pending report",
      (r) => {
        r.outcome = "failed";
        r.responsibilities.counts.qualified = 0;
        r.responsibilities.counts.pending = 49;
        for (const a of r.responsibilities.assessments) {
          a.semantic = "pending";
          a.proofs.forEach((p) => {
            p.executed = false;
          });
        }
      },
    ],
    [
      "pending despite passing headline",
      (r) => {
        r.responsibilities.counts.pending = 1;
      },
    ],
    [
      "missing cohort record",
      (r) => {
        r.responsibilities.assessments.pop();
      },
    ],
    [
      "missing proof path",
      (r) => {
        r.responsibilities.assessments[0].proofs.pop();
      },
    ],
    [
      "unexecuted proof",
      (r) => {
        r.responsibilities.assessments[0].proofs[0].executed = false;
      },
    ],
    [
      "missing exact selector",
      (r) => {
        r.responsibilities.assessments[0].proofAssertions.pop();
      },
    ],
    [
      "nonpassing selected assertion",
      (r) => {
        r.responsibilities.assessments[0].proofAssertions[0].status = "failed";
      },
    ],
    [
      "wrong scope",
      (r) => {
        r.scope.id = "package:alpha";
      },
    ],
    [
      "partial scope",
      (r) => {
        r.scope.partial = true;
      },
    ],
    [
      "incomplete visitation",
      (r) => {
        r.counts.visited = 0;
      },
    ],
    [
      "failed execution",
      (r) => {
        r.responsibilities.execution.status = "failed";
      },
    ],
    [
      "duplicate invocation",
      (r) => {
        r.responsibilities.execution.invocationCount = 2;
      },
    ],
    [
      "unclosed child",
      (r) => {
        r.responsibilities.execution.process.directChildClosed = false;
      },
    ],
    [
      "unavailable drain",
      (r) => {
        r.responsibilities.execution.process.groupAbsent = null;
      },
    ],
    [
      "wrong policy digest",
      (r) => {
        r.policySha256 = "0".repeat(64);
      },
    ],
  ])("refuses constructed %s", (_name, mutate) => {
    const { report, policy, policyBytes } = qualificationValidatorFixture();
    mutate(report);
    expect(() => assertRepositoryQualification(report, policy, policyBytes)).toThrow();
  });
  it("retains finite fixture watchdogs and the full owner output cap without a replacement timer", () => {
    const fixture = read("scripts/__tests__/code-quality-wiring-smoke.mjs");
    expect(fixture).toContain("timeout = 180_000");
    expect(fixture).toContain("{ timeout: 375_000 }");
    expect(fixture).toContain("isolatedPolicyReport(own.root, 360_000, true)");
    expect(fixture).toContain("maxBuffer: 32 * 1024 * 1024");
    expect(fixture).toContain('createCollectiveParserFixture("direct")');
    expect(fixture).toContain('throw new Error("default proof must not execute")');
    const owner = read("scripts/__tests__/code-quality-repository-qualification.mjs");
    expect(owner).toContain(
      '[fileURLToPath(entry), "--qualify-responsibilities", "--json", "--progress"]',
    );
    expect(owner).toContain("maxBuffer: 32 * 1024 * 1024");
    expect(owner).not.toContain("timeout:");
  });
  it("requires serial mandatory fixture full qualification and raw reader", () => {
    assertPolicyOperationOrder(parse(read(".github/workflows/ci.yml")).jobs["code-quality-policy"]);
  });
  it.each(["missing", "conditional", "continued", "partial"])(
    "refuses %s qualification workflow mutation",
    (kind) => {
      const job = parse(read(".github/workflows/ci.yml")).jobs["code-quality-policy"];
      const index = job.steps.findIndex(({ run }) => run === STATIC_POLICY_SMOKE_COMMAND);
      if (kind === "missing") job.steps.splice(index, 1);
      if (kind === "conditional") job.steps[index].if = "false";
      if (kind === "continued") job.steps[index]["continue-on-error"] = true;
      if (kind === "partial")
        job.steps[index].run = "npm run check:code-quality-policy -- --package alpha";
      expect(() => assertPolicyOperationOrder(job)).toThrow();
    },
  );
});
