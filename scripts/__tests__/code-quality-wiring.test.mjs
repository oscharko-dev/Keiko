import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { URL } from "node:url";
import { parse } from "yaml";
import { Linter } from "eslint";
import coveragePlugin from "../code-quality-coverage-plugin.mjs";
import { codeQualityPolicyMain } from "../check-code-quality-policy.mjs";
import { evaluatePolicyPackages } from "../lib/code-quality-packages.mjs";
import { createPolicyFixtureRepository } from "./support/code-quality-fixture.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function enforcingFixture() {
  const root = createPolicyFixtureRepository();
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  writeFileSync(
    join(root, "scripts/code-quality-policy.json"),
    read("scripts/code-quality-policy.json"),
  );
  const manifestPath = join(root, "packages/alpha/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version = "0.0.0";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  mkdirSync(join(root, "packages/alpha/dist"));
  writeFileSync(join(root, "packages/alpha/dist/index.js"), "export const value = 1;");
  return root;
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
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await codeQualityPolicyMain(["--json"])).toBe(0);
      const report = JSON.parse(output.mock.calls[0][0]);
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
    } finally {
      output.mockRestore();
    }
  }, 60_000);

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
