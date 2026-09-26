import { describe, expect, it } from "vitest";

import {
  WORKSPACE_PERFORMANCE_MEASUREMENT_TOOLCHAIN_PATHS,
  computeWorkspacePerformanceMeasurementToolchainDigest,
} from "../workspace-performance-measurement-toolchain.mjs";

const WORKSPACE_SCRIPT = "test:e2e:workspace-perf";

function measurementInputs(command) {
  return new Map([
    ...WORKSPACE_PERFORMANCE_MEASUREMENT_TOOLCHAIN_PATHS.map((path) => [path, `contents:${path}`]),
    ["package.json", JSON.stringify({ name: "keiko", scripts: { [WORKSPACE_SCRIPT]: command } })],
  ]);
}

function digestFor(inputs) {
  return computeWorkspacePerformanceMeasurementToolchainDigest((path) => {
    const contents = inputs.get(path);
    if (contents === undefined) throw new Error(`missing fixture input: ${path}`);
    return contents;
  });
}

describe("workspace performance measurement toolchain", () => {
  it("binds the canonical workspace-performance npm command", () => {
    const original = measurementInputs(
      "playwright test --config tests/e2e/config/playwright.workspace-performance.config.ts --project=chromium",
    );
    const changed = measurementInputs(
      "playwright test --config tests/e2e/config/playwright.workspace-performance.config.ts --project=webkit",
    );

    expect(digestFor(original)).not.toBe(digestFor(changed));
  });

  it("does not make unrelated package metadata part of the measurement ruler", () => {
    const original = measurementInputs(
      "playwright test --config workspace.config.ts --project=chromium",
    );
    const changed = new Map(original);
    changed.set(
      "package.json",
      JSON.stringify({
        name: "renamed-keiko",
        scripts: {
          [WORKSPACE_SCRIPT]: "playwright test --config workspace.config.ts --project=chromium",
        },
      }),
    );

    expect(digestFor(original)).toBe(digestFor(changed));
  });

  it("fails closed when the canonical script is absent", () => {
    const inputs = measurementInputs("playwright test");
    inputs.set("package.json", JSON.stringify({ scripts: {} }));
    expect(() => digestFor(inputs)).toThrow(
      `package.json must define a non-empty ${WORKSPACE_SCRIPT}`,
    );
  });
});
