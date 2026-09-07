import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectH1OwnedSourcePaths } from "../lib/h1-source-closure.mjs";
import { GOVERNED_TOOL_CONTRACT_PINS } from "../lib/governed-tool-contract-pins.mjs";

let root;
const entry = GOVERNED_TOOL_CONTRACT_PINS.pendingH1.ownedImplementation[0];
function write(path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-h1-runtime-closure-"));
  for (const path of GOVERNED_TOOL_CONTRACT_PINS.pendingH1.ownedImplementation) write(path, "");
  write("package-lock.json", "{}");
  for (const path of GOVERNED_TOOL_CONTRACT_PINS.pendingH1.ownedImplementation) {
    write(`packages/${path.split("/")[1]}/package.json`, "{}");
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("H1 runtime source ownership", () => {
  it("automatically includes new transitive value exports and terminates import cycles", () => {
    write(entry, 'import "./new-helper.js"; import type { Shape } from "./type-only.js";');
    write("packages/keiko-contracts/src/new-helper.ts", 'export * from "./new-guard.js";');
    write("packages/keiko-contracts/src/new-guard.ts", 'import "./new-helper.js";');
    const paths = collectH1OwnedSourcePaths(root);
    expect(paths).toEqual(
      expect.arrayContaining([
        "packages/keiko-contracts/src/new-helper.ts",
        "packages/keiko-contracts/src/new-guard.ts",
        "packages/keiko-contracts/package.json",
        "package-lock.json",
      ]),
    );
    expect(paths).not.toContain("packages/keiko-contracts/src/type-only.ts");
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("fails closed on an unreadable runtime import", () => {
    write(entry, 'import "./missing.js";');
    expect(() => collectH1OwnedSourcePaths(root)).toThrow();
  });

  it("fails closed on an import outside the first-party tree", () => {
    write(entry, 'import "../../../outside.js";');
    expect(() => collectH1OwnedSourcePaths(root)).toThrow(TypeError);
  });

  it("fails closed when an owned source file is a symlink", () => {
    const outside = join(dirname(root), `keiko-h1-outside-${process.pid}.ts`);
    writeFileSync(outside, "// mutable host source\n");
    rmSync(join(root, entry));
    symlinkSync(outside, join(root, entry));
    expect(() => collectH1OwnedSourcePaths(root)).toThrow(TypeError);
    rmSync(outside, { force: true });
  });

  it("fails closed when a source parent is a symlink", () => {
    const packageRoot = join(root, "packages", "keiko-contracts");
    const outside = mkdtempSync(join(tmpdir(), "keiko-h1-parent-"));
    rmSync(packageRoot, { recursive: true });
    symlinkSync(outside, packageRoot, "dir");
    writeFileSync(join(outside, "package.json"), "{}");
    mkdirSync(join(outside, "src"));
    writeFileSync(join(outside, "src", "coding-repository-search.ts"), "");
    expect(() => collectH1OwnedSourcePaths(root)).toThrow(TypeError);
    rmSync(outside, { recursive: true, force: true });
  });
});
