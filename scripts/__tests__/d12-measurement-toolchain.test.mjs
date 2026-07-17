import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  computeD12MeasurementToolchainDigest,
  D12_MEASUREMENT_TOOLCHAIN_PATHS,
  selectD12MeasurementToolchainPaths,
} from "../d12-measurement-toolchain.mjs";

describe("D12 measurement toolchain binding", () => {
  it("gives baseline and candidate identical common-run preconditioning", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../../tests/e2e/editor-performance.spec.ts"),
      "utf8",
    );

    expect(source).toContain("const D12_COMPARISON = D12_REVISION !== undefined");
    expect(source).toContain("const navigation = D12_COMPARISON");
    expect(source).not.toContain("D12_COMMON_COMPARISON");
  });

  it("contains the runner, producers, checker, configs, specs, fixtures, support, and direct tests", () => {
    expect(D12_MEASUREMENT_TOOLCHAIN_PATHS).toEqual(
      expect.arrayContaining([
        "scripts/run-d12-perf-comparison.mjs",
        "scripts/build-d12-perf-comparison.mjs",
        "scripts/build-d12-bundle-input.mjs",
        "scripts/check-perf-evidence.mjs",
        "scripts/d12-measurement-toolchain.mjs",
        "scripts/d12-runtime-environment.mjs",
        "scripts/editor-bundle-size.mjs",
        "scripts/editor-release-evidence.mjs",
        "scripts/__tests__/run-d12-perf-comparison.test.mjs",
        "scripts/__tests__/build-d12-perf-comparison.test.mjs",
        "scripts/__tests__/build-d12-bundle-input.test.mjs",
        "scripts/__tests__/check-perf-evidence.test.mjs",
        "scripts/__tests__/d12-measurement-toolchain.test.mjs",
        "tests/e2e/config/playwright.editor-performance.config.ts",
        "tests/e2e/config/playwright.issue-2348-editor-debugging.config.ts",
        "tests/e2e/editor-debugging-2348.static.test.ts",
        "tests/e2e/editor-performance.spec.ts",
        "tests/e2e/editor-debugging-2348.spec.ts",
        "tests/e2e/fixtures/editor-debugging-2348/dap-socket-adapter.fixture",
        "tests/e2e/fixtures/editor-debugging-2348/package.json",
        "tests/e2e/fixtures/editor-debugging-2348/program.ts",
        "tests/e2e/fixtures/editor-debugging-2348/throws.ts",
        "tests/e2e/fixtures/keiko.e2e.config.json",
        "tests/e2e/support/dapOperatorProvisioning.ts",
        "tests/e2e/support/editorWorkspace.ts",
      ]),
    );
  });

  it("produces an order-independent, path- and byte-sensitive lowercase SHA-256 digest", () => {
    const files = new Map([
      ["scripts/check-perf-evidence.mjs", "checker\n"],
      ["tests/e2e/editor-performance.spec.ts", "spec\n"],
    ]);
    const paths = [...files.keys()];
    const digest = (selectedPaths) =>
      computeD12MeasurementToolchainDigest((path) => files.get(path), selectedPaths);

    expect(digest(paths)).toMatch(/^[0-9a-f]{64}$/u);
    expect(digest([...paths].reverse())).toBe(digest(paths));
    files.set(paths[0], "checker changed\n");
    expect(digest(paths)).not.toBe(
      computeD12MeasurementToolchainDigest(
        (path) => (path === paths[0] ? "checker\n" : files.get(path)),
        paths,
      ),
    );
  });

  it("selects only exact toolchain paths from tracked and untracked Git results", () => {
    expect(
      selectD12MeasurementToolchainPaths([
        "scripts/run-d12-perf-comparison.mjs",
        "packages/keiko-ui/src/unrelated.ts",
        "scripts/check-perf-evidence.mjs",
        "scripts/run-d12-perf-comparison.mjs",
      ]),
    ).toEqual(["scripts/check-perf-evidence.mjs", "scripts/run-d12-perf-comparison.mjs"]);
  });
});
