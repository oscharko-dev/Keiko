import { describe, expect, it } from "vitest";

import {
  COMPILER_PROBE_OPTIONS,
  evaluateTypeScriptToolchain,
} from "../check-typescript-toolchain.mjs";

const VALID_MANIFEST = {
  dependencies: { typescript: "~6.0.3" },
  devDependencies: { "@typescript/native": "npm:typescript@~7.0.2" },
};

function evaluate(overrides = {}) {
  return evaluateTypeScriptToolchain({
    manifest: VALID_MANIFEST,
    compilerResult: { status: 0, stdout: "Version 7.0.2\n", stderr: "" },
    nativePackageVersion: "7.0.2",
    apiVersion: "6.0.3",
    ...overrides,
  });
}

describe("evaluateTypeScriptToolchain", () => {
  it("accepts the governed TypeScript 7 compiler and TypeScript 6 API split", () => {
    expect(evaluate()).toEqual({ compilerVersion: "7.0.2", apiVersion: "6.0.3", failures: [] });
  });

  it.each([
    [{ dependencies: { typescript: "~7.0.2" }, devDependencies: VALID_MANIFEST.devDependencies }],
    [{ dependencies: { typescript: "^6.0.3" }, devDependencies: VALID_MANIFEST.devDependencies }],
    [{ dependencies: VALID_MANIFEST.dependencies, devDependencies: {} }],
    [
      {
        dependencies: VALID_MANIFEST.dependencies,
        optionalDependencies: { "@typescript/native": "npm:typescript@~7.0.2" },
      },
    ],
    [
      {
        dependencies: VALID_MANIFEST.dependencies,
        devDependencies: VALID_MANIFEST.devDependencies,
        peerDependencies: { typescript: "~6.0.3" },
      },
    ],
    [
      {
        dependencies: VALID_MANIFEST.dependencies,
        devDependencies: VALID_MANIFEST.devDependencies,
        bundleDependencies: ["@typescript/native"],
      },
    ],
    [
      {
        dependencies: VALID_MANIFEST.dependencies,
        devDependencies: VALID_MANIFEST.devDependencies,
        bundledDependencies: ["typescript"],
      },
    ],
  ])("rejects manifest role drift", (manifest) => {
    expect(evaluate({ manifest }).failures).not.toEqual([]);
  });

  it.each([
    [{ status: 0, stdout: "Version 6.0.3\n", stderr: "" }],
    [{ status: 1, stdout: "", stderr: "missing native binary" }],
    [{ status: null, stdout: null, stderr: null, error: { code: "ENOENT" } }],
    [{ status: null, stdout: "", stderr: "", error: { code: "ETIMEDOUT" } }],
    [{ status: null, stdout: "", stderr: "", error: { code: "ENOBUFS" } }],
    [{ status: null, stdout: "", stderr: "", signal: "SIGTERM" }],
    [{ status: 0, stdout: "Version 7.0.2\n", stderr: "secret diagnostic" }],
    [{ status: 0, stdout: "unexpected", stderr: "" }],
    [{ status: 0, stdout: "Version 7.1.0\n", stderr: "" }],
  ])("rejects an invalid native compiler result", (compilerResult) => {
    expect(evaluate({ compilerResult }).failures).not.toEqual([]);
  });

  it.each(["6.0.3", "7.1.0", "7.1.0-dev.20260710.1", "unknown"])(
    "rejects invalid native package version %s",
    (nativePackageVersion) => {
      expect(evaluate({ nativePackageVersion }).failures).not.toEqual([]);
    },
  );

  it.each(["5.7.3", "6.1.0", "7.0.2", "unknown"])(
    "rejects unsupported API version %s",
    (apiVersion) => {
      expect(evaluate({ apiVersion }).failures).not.toEqual([]);
    },
  );

  it("keeps compiler diagnostics out of failure output", () => {
    const failures = evaluate({
      compilerResult: { status: 1, stdout: "", stderr: "customer-secret" },
    }).failures;
    expect(failures.join(" ")).not.toContain("customer-secret");
  });

  it("bounds the native compiler probe", () => {
    expect(COMPILER_PROBE_OPTIONS).toEqual({ timeout: 10_000, maxBuffer: 1_024 });
  });
});
