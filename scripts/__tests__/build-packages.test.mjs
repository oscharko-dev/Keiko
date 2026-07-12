import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildPackages, findEmptyPackageBuildOutputs } from "../build-packages.mjs";

const roots = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "keiko-build-packages-"));
  const output = join(root, "packages", "fixture", "dist", "index.js");
  mkdirSync(join(root, "packages", "fixture", "dist"), { recursive: true });
  roots.push(root);
  return { root, output };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native TypeScript package build", () => {
  it("reports zero-byte outputs with repository-relative paths", () => {
    const { root, output } = fixture();
    writeFileSync(output, "");

    expect(findEmptyPackageBuildOutputs(root)).toEqual(["packages/fixture/dist/index.js"]);
  });

  it("accepts an explicitly governed legitimately empty output", () => {
    const { root, output } = fixture();
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(output, "");
    writeFileSync(
      join(root, "scripts", "empty-build-output-allowlist.json"),
      '["packages/fixture/dist/index.js"]\n',
    );

    expect(findEmptyPackageBuildOutputs(root)).toEqual([]);
  });

  it("rejects allowlist entries outside package build outputs", () => {
    const { root } = fixture();
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "empty-build-output-allowlist.json"), '["../secret"]\n');

    expect(() => findEmptyPackageBuildOutputs(root)).toThrow("Invalid empty build-output");
  });

  it("rejects malformed empty-output allowlist entries fail-closed", () => {
    const { root } = fixture();
    mkdirSync(join(root, "scripts"), { recursive: true });
    const allowlist = [
      "packages/fixture/dist/../index.js",
      "packages/fixture/dist/index.js",
      "packages/fixture/dist/index.js",
      "packages/fixture/dist//index.js",
      "packages\\fixture\\dist\\index.js",
      42,
    ];
    writeFileSync(
      join(root, "scripts", "empty-build-output-allowlist.json"),
      `${JSON.stringify(allowlist)}\n`,
    );

    expect(() => findEmptyPackageBuildOutputs(root)).toThrow("Invalid empty build-output");
  });

  it("orders empty output reports by deterministic code-unit order", () => {
    const { root, output } = fixture();
    const upper = join(root, "packages", "fixture", "dist", "B.js");
    const lower = join(root, "packages", "fixture", "dist", "a.js");
    writeFileSync(output, "");
    writeFileSync(lower, "");
    writeFileSync(upper, "");

    expect(findEmptyPackageBuildOutputs(root)).toEqual([
      "packages/fixture/dist/B.js",
      "packages/fixture/dist/a.js",
      "packages/fixture/dist/index.js",
    ]);
  });

  it("retries a successful compiler process that emits an empty file", () => {
    const { root, output } = fixture();
    let attempts = 0;

    buildPackages({
      root,
      runCompiler: () => {
        attempts += 1;
        writeFileSync(output, attempts === 1 ? "" : "export {};\n");
        return { status: 0 };
      },
    });

    expect(attempts).toBe(2);
  });

  it("fails closed after repeated empty output", () => {
    const { root, output } = fixture();

    expect(() =>
      buildPackages({
        root,
        runCompiler: () => {
          writeFileSync(output, "");
          return { status: 0 };
        },
      }),
    ).toThrow("packages/fixture/dist/index.js");
  });
});
