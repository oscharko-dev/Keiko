import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { parse } from "yaml";
import { Linter } from "eslint";
import coveragePlugin from "../code-quality-coverage-plugin.mjs";
import { codeQualityPolicyMain } from "../check-code-quality-policy.mjs";
import { evaluatePolicyPackages } from "../lib/code-quality-packages.mjs";
import {
  configureEnforcingPolicyFixture,
  createPolicyFixtureRepository,
  createRuntimePolicyFixture,
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

const executePolicy = promisify(execFile);
async function isolatedPolicyReport(repositoryRoot, timeout = 180_000) {
  const entry = new URL("../check-code-quality-policy.mjs", import.meta.url);
  const args =
    repositoryRoot === undefined
      ? [fileURLToPath(entry), "--json"]
      : [
          "--input-type=module",
          "-e",
          `const { codeQualityPolicyMain } = await import(${JSON.stringify(entry.href)}); process.exitCode = await codeQualityPolicyMain(["--json"], ${JSON.stringify(repositoryRoot)});`,
        ];
  const { stdout } = await executePolicy(process.execPath, args, {
    cwd: new URL("../../", import.meta.url),
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
describe("production code-quality invocation wiring (#3915)", () => {
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

  it("reports a full actual candidate verdict through the enforcing CLI owner", async () => {
    const report = await isolatedPolicyReport();
    expect(report).toMatchObject({
      outcome: "passed",
      mode: "enforce",
      scope: { id: "repository", partial: false },
    });
    expect(report.counts.expected).toBe(report.counts.visited);
    expect(report.counts.packages).toBe(27);
    expect(report.counts.violations).toBe(0);
    expect(report.rules).toHaveLength(22);
    expect(report.pack).toHaveLength(27);
  }, 195_000);

  it("isolates a real completed policy receipt from a later parent console capture", async () => {
    const root = createRuntimePolicyFixture("testing/logic.ts", "test-only");
    roots.push(root);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const report = await isolatedPolicyReport(root, 15_000);
      expect(report.outcome).toBe("passed");
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

  it("executes the whole enforcing policy before typed root/UI lint in required Core quality", () => {
    const manifest = JSON.parse(read("package.json"));
    expect(manifest.scripts["check:code-quality-policy"]).toBe(
      "node scripts/check-code-quality-policy.mjs",
    );
    const commands = manifest.scripts.lint.split(" && ");
    expect(commands.indexOf("npm run check:code-quality-policy")).toBe(1);
    expect(commands[0]).toBe("npm run build:packages");
    expect(commands.slice(2).join(" && ")).toContain("eslint/bin/eslint.js . --max-warnings=0");
    expect(commands.slice(2).join(" && ")).toContain(
      "npm --workspace @oscharko-dev/keiko-ui run lint",
    );
    const workflow = parse(read(".github/workflows/ci.yml"));
    const core = Object.values(workflow.jobs).find((job) => job.name === "Core quality");
    expect(core.steps.filter((step) => step.run === "npm run lint")).toHaveLength(1);
  });
});
