import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPolicyInventory, readPreviousPolicies } from "../lib/code-quality-inventory.mjs";
import { validatePolicy } from "../lib/code-quality-policy.mjs";
import { URL } from "node:url";

import { createPolicyFixtureRepository } from "./support/code-quality-fixture.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function trackedRepository() {
  const root = createPolicyFixtureRepository();
  roots.push(root);
  return root;
}

describe("actual tracked/build/workspace inventory (#3915)", () => {
  it("derives source membership and export targets from real manifests and TypeScript", async () => {
    const inventory = await collectPolicyInventory(trackedRepository());
    expect(inventory.packages).toHaveLength(1);
    expect(inventory.packages[0].build.sources).toEqual(["packages/alpha/src/index.ts"]);
    expect(inventory.packages[0].exports).toEqual([{ target: "./dist/index.js", exists: false }]);
    expect(inventory.files).toMatchObject([
      { path: "packages/alpha/src/index.ts", production: true },
    ]);
  });

  it.each([
    ['export { value } from "./testing/logic.js";', true],
    ['import { value } from "./testing/logic.js"; export { value };', true],
    ['export * from "./testing/logic.js";', true],
    ['export const value = import("./testing/logic.js");', true],
    ['export const value = require("./testing/logic.js");', true],
    ['const path = "./testing/logic.js"; export const value = import(path);', true],
    ['const a = "./testing/logic.js"; const b = a; export const value = import(b);', true],
    ["const load = require; export const value = load(`./testing/logic.js`);", true],
    ['import value = require("./testing/logic.js"); export { value };', true],
    ['import type { Marker } from "./testing/logic.js"; export type { Marker };', false],
    ['export { type Marker } from "./testing/logic.js";', false],
    ['export type * from "./testing/logic.js";', false],
    ['import { type Marker } from "./testing/logic.js"; export type { Marker };', false],
  ])("distinguishes actual value edges from type-only syntax: %s", async (entry, production) => {
    const root = trackedRepository();
    mkdirSync(join(root, "packages/alpha/src/testing"));
    writeFileSync(
      join(root, "packages/alpha/src/testing/logic.ts"),
      "export const value = 1; export interface Marker { value: number }",
    );
    writeFileSync(join(root, "packages/alpha/src/index.ts"), entry);
    const inventory = await collectPolicyInventory(root);
    expect(inventory.files.find((file) => file.path.endsWith("testing/logic.ts"))).toMatchObject({
      production,
      scope: production ? "package:alpha" : "tests",
    });
  });

  it.each([
    ['import { type Marker } from "./testing/logic.js"; export const value = 1;', true],
    ['export { type Marker } from "./testing/logic.js";', true],
    ['import type { Marker } from "./testing/logic.js"; export type { Marker };', false],
    ['export type { Marker } from "./testing/logic.js";', false],
  ])(
    "honors verbatim emission for the actual import/export form: %s",
    async (entry, production) => {
      const root = trackedRepository();
      mkdirSync(join(root, "packages/alpha/src/testing"));
      writeFileSync(
        join(root, "packages/alpha/tsconfig.json"),
        JSON.stringify({
          compilerOptions: { rootDir: "src", outDir: "dist", verbatimModuleSyntax: true },
          include: ["src"],
        }),
      );
      writeFileSync(
        join(root, "packages/alpha/src/testing/logic.ts"),
        "export interface Marker { value: number }",
      );
      writeFileSync(join(root, "packages/alpha/src/index.ts"), entry);
      expect(
        (await collectPolicyInventory(root)).files.find((file) =>
          file.path.endsWith("testing/logic.ts"),
        ),
      ).toMatchObject({ production });
    },
  );

  it("resolves config-owned paths and transitive source cycles", async () => {
    const root = trackedRepository();
    mkdirSync(join(root, "packages/alpha/src/testing"));
    writeFileSync(
      join(root, "packages/alpha/tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          rootDir: "src",
          outDir: "dist",
          paths: { "@helper": ["./src/testing/logic.ts"] },
        },
        include: ["src"],
      }),
    );
    writeFileSync(join(root, "packages/alpha/src/index.ts"), 'export { value } from "@helper";');
    writeFileSync(
      join(root, "packages/alpha/src/testing/logic.ts"),
      'export { value } from "../relay.js";',
    );
    writeFileSync(
      join(root, "packages/alpha/src/relay.ts"),
      'import "./testing/logic.js"; export const value = 1;',
    );
    expect((await collectPolicyInventory(root)).productionReachability.promoted).toEqual([
      "packages/alpha/src/testing/logic.ts",
    ]);
  });

  it("promotes a fixture loaded by repository tooling, not unrelated test helpers", async () => {
    const root = trackedRepository();
    mkdirSync(join(root, "scripts/__tests__"), { recursive: true });
    writeFileSync(join(root, "scripts/runner.mjs"), 'import "./__tests__/helper.mjs";');
    writeFileSync(join(root, "scripts/__tests__/helper.mjs"), "export const value = 1;");
    writeFileSync(join(root, "scripts/__tests__/unrelated.mjs"), "export const value = 1;");
    const inventory = await collectPolicyInventory(root);
    expect(inventory.files.find((file) => file.path.endsWith("/helper.mjs"))).toMatchObject({
      production: true,
      scope: "tooling",
    });
    expect(inventory.files.find((file) => file.path.endsWith("/unrelated.mjs"))).toMatchObject({
      production: false,
      scope: "tests",
    });
  });

  it("fails instead of silently dropping an omitted workspace", async () => {
    const root = trackedRepository();
    unlinkSync(join(root, "packages/alpha/package.json"));
    await expect(collectPolicyInventory(root)).rejects.toThrow("workspace-inventory-mismatch");
  });

  it("includes new untracked source and rejects an unclassified owner", async () => {
    const root = trackedRepository();
    writeFileSync(join(root, "packages/alpha/src/new.ts"), "export const value = 2;");
    expect(
      (await collectPolicyInventory(root)).files.find((file) => file.path.endsWith("/new.ts")),
    ).toMatchObject({ tracked: false, production: true });
    mkdirSync(join(root, "unknown-owner"));
    writeFileSync(join(root, "unknown-owner/new.ts"), "export const value = 3;");
    await expect(collectPolicyInventory(root)).rejects.toThrow("unclassified-source");
  });

  it("fails on invalid build configuration and new unclassified HTML", async () => {
    const root = trackedRepository();
    writeFileSync(join(root, "packages/alpha/tsconfig.json"), "{broken");
    await expect(collectPolicyInventory(root)).rejects.toThrow("invalid-build-config");
    const htmlRoot = trackedRepository();
    writeFileSync(join(htmlRoot, "runtime.html"), "<script>window.runtime = true;</script>");
    await expect(collectPolicyInventory(htmlRoot)).rejects.toThrow("unclassified-html-source");
  });

  it("rejects a regular leaf behind an external parent symlink", async () => {
    const root = trackedRepository();
    const outside = mkdtempSync(join(tmpdir(), "keiko-policy-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "index.ts"), "export const value = 1;");
    rmSync(join(root, "packages/alpha/src"), { recursive: true });
    symlinkSync(outside, join(root, "packages/alpha/src"), "junction");
    await expect(collectPolicyInventory(root)).rejects.toThrow("unsafe-source-file");
  });

  it("binds the actual root build config and fails on its corruption", async () => {
    const root = trackedRepository();
    expect((await collectPolicyInventory(root)).rootBuild.path).toBe("tsconfig.build.json");
    writeFileSync(join(root, "tsconfig.build.json"), "{broken");
    await expect(collectPolicyInventory(root)).rejects.toThrow("invalid-build-config");
  });

  it("rejects an activation removed two commits earlier", () => {
    const root = trackedRepository();
    const policy = JSON.parse(
      readFileSync(new URL("../code-quality-policy.json", import.meta.url), "utf8"),
    );
    mkdirSync(join(root, "scripts"));
    const active = structuredClone(policy);
    active.rules.find((rule) => rule.id === "anti-slop/no-chained-type-assertions").activeScopes = [
      "production",
    ];
    const commit = (value) => {
      writeFileSync(join(root, "scripts/code-quality-policy.json"), JSON.stringify(value));
      execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "Record policy fixture",
        ],
        { cwd: root, stdio: "ignore" },
      );
    };
    commit(active);
    commit(policy);
    writeFileSync(join(root, "unrelated.txt"), "Unrelated fixture metadata");
    commit(policy);
    expect(validatePolicy(policy, readPreviousPolicies(root))).toContain("activation-shrank");
  });

  it("retains an activated merge parent even when the merge tree matches the other parent", () => {
    const root = trackedRepository();
    const policy = JSON.parse(
      readFileSync(new URL("../code-quality-policy.json", import.meta.url), "utf8"),
    );
    mkdirSync(join(root, "scripts"));
    const git = (args) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    const commit = (value) => {
      writeFileSync(join(root, "scripts/code-quality-policy.json"), JSON.stringify(value));
      git(["add", "."]);
      git(["commit", "-m", "Record merge policy fixture"]);
      return git(["rev-parse", "HEAD"]);
    };
    const initial = commit(policy);
    git(["checkout", "-b", "activated"]);
    const active = structuredClone(policy);
    active.rules.find((rule) => rule.id === "anti-slop/no-chained-type-assertions").activeScopes = [
      "production",
    ];
    const accepted = commit(active);
    git(["checkout", "-b", "other", initial]);
    policy.rules[0].reason += " Reviewed fixture metadata.";
    const other = commit(policy);
    const merge = git([
      "commit-tree",
      git(["rev-parse", "HEAD^{tree}"]),
      "-p",
      accepted,
      "-p",
      other,
      "-m",
      "Record merge policy fixture",
    ]);
    git(["update-ref", "refs/heads/other", merge, other]);
    expect(validatePolicy(policy, readPreviousPolicies(root))).toContain("activation-shrank");
  });

  it("rejects shallow history with a complete-history positive control", () => {
    const original = trackedRepository();
    expect(readPreviousPolicies(original)).toEqual([]);
    const shallow = mkdtempSync(join(tmpdir(), "keiko-policy-shallow-"));
    roots.push(shallow);
    execFileSync("git", ["clone", "--no-local", "--depth=1", original, shallow], {
      stdio: "ignore",
    });
    expect(() => readPreviousPolicies(shallow)).toThrow("incomplete-policy-history");
  });
});
