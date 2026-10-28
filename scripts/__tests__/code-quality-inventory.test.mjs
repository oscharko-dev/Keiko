import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectPolicyInventory,
  policyDigest,
  readPreviousPolicies,
  selectPolicyScope,
} from "../lib/code-quality-inventory.mjs";
import * as policyMembership from "../lib/code-quality-inventory.mjs";
import { validatePolicy } from "../lib/code-quality-policy.mjs";
import { fileURLToPath, URL } from "node:url";

import {
  createPolicyFixtureRepository,
  fixtureOwnedPolicy,
  copyNativePolicyFixtureSources,
} from "./support/code-quality-fixture.mjs";

import { responsibilityRecord } from "./support/code-quality-responsibility-fixture.mjs";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
const { execFileSync: actualExecFileSync } = await vi.importActual("node:child_process");

const roots = [];
afterEach(() => {
  vi.mocked(execFileSync).mockReset();
  vi.mocked(execFileSync).mockImplementation(actualExecFileSync);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function trackedRepository() {
  const root = createPolicyFixtureRepository();
  roots.push(root);
  return root;
}

describe("actual tracked/build/workspace inventory (#3915)", () => {
  it("reconciles the actual built workspace public surface with its full source inventory", async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const inventory = await collectPolicyInventory(root);
    expect(inventory.packages).toHaveLength(27);
    expect(inventory.files.some((file) => file.scope === "root-product" && file.production)).toBe(
      true,
    );
    expect(inventory.files.some((file) => file.scope === "tooling" && file.production)).toBe(true);
    const membership = policyMembership.collectPolicyMembership(root);
    expect(
      membership.paths.some(
        (path) =>
          path === "native/opencode-service-host" ||
          path.startsWith("native/opencode-service-host/"),
      ),
    ).toBe(false);
    expect(inventory.files.some((file) => file.scope === "native-host")).toBe(false);
    expect(inventory.files.some((file) => file.scope === "documentary" && !file.production)).toBe(
      true,
    );
    for (const path of [
      "packages/keiko-local-knowledge/src/testing.ts",
      "packages/keiko-workspace/src/testing.ts",
      "packages/keiko-server/src/editor/lsp/testing/fakeLspProcess.ts",
    ]) {
      expect(inventory.files.find((file) => file.path === path)).toMatchObject({
        production: true,
        reason: "production-runtime-reachable",
      });
      expect(inventory.productionReachability.promoted).toContain(path);
    }
    expect(inventory.rootBuild.sources.length).toBeGreaterThan(0);
    expect(inventory.packages.every((owner) => owner.build.sources.length > 0)).toBe(true);
  }, 60_000);

  it("selects real inventoried scopes and rejects empty or partial CI qualification", async () => {
    const { files } = await collectPolicyInventory(trackedRepository());
    const production = selectPolicyScope(files, "production", false);
    expect(production).toMatchObject({ partial: true, files });
    expect(selectPolicyScope(files, "package:alpha", false).files).toEqual(files);
    expect(selectPolicyScope(files, "repository", true)).toMatchObject({ partial: false, files });
    expect(() => selectPolicyScope(files, "unknown", false)).toThrow("unknown-or-empty-scope");
    expect(() => selectPolicyScope(files, "production", true)).toThrow("partial-ci-scope");
    expect(() => selectPolicyScope([], "repository", false)).toThrow("unknown-or-empty-scope");
  });

  it("keeps detached module preparation internal to the collected subject", async () => {
    const root = trackedRepository();
    const subject = await policyMembership.collectPolicySubject(root);
    const receipt = policyMembership.preparedModuleReceipt(subject);
    expect(receipt.failure).toBeNull();
    expect(receipt.rows.map((row) => row.path)).toEqual(["packages/alpha/src/index.ts"]);
    expect(receipt.rows[0].statements).toEqual([{ start: 0, bindings: null }]);
    expect(subject.inventory).not.toHaveProperty("moduleReceipt");
    expect(subject.inventory.productionReachability).toEqual({ promoted: [] });
    expect(await collectPolicyInventory(root)).toEqual(subject.inventory);
    expect(Object.isFrozen(receipt.rows[0].statements[0])).toBe(true);
    delete subject.moduleReceipt;
    expect(() => policyMembership.preparedModuleReceipt(subject)).toThrow(
      "symbol-module-facts-changed",
    );
  });

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

  it("retains fixture-owned responsibility obligations through complete ancestry", () => {
    const root = trackedRepository();
    mkdirSync(join(root, "scripts"));
    const baseline = fixtureOwnedPolicy([responsibilityRecord()]);
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
          "Record responsibility history",
        ],
        { cwd: root, stdio: "ignore" },
      );
    };
    commit(baseline);
    const removed = fixtureOwnedPolicy();
    commit(removed);
    writeFileSync(join(root, "unrelated.txt"), "Unrelated fixture metadata");
    commit(removed);
    const history = readPreviousPolicies(root);
    expect(validatePolicy(removed, history)).toContain("responsibility-shrank");
    const legacy = {
      version: 1,
      upstream: baseline.upstream,
      runner: baseline.runner,
      rules: baseline.rules,
    };
    expect(validatePolicy(legacy, history)).toContain("responsibility-downgrade");
    const rebound = structuredClone(baseline);
    rebound.responsibilities[0].consumer.owner = "beta";
    expect(validatePolicy(rebound, history)).toContain("responsibility-shrank");
    expect(history.some(({ responsibilities }) => responsibilities?.length === 1)).toBe(true);
  });

  it.each([
    ["anti-slop/no-chained-type-assertions", "production"],
    ["anti-slop/no-chained-type-assertions", "package:alpha"],
    ["anti-slop/require-safety-comment-for-type-assertion", "production"],
    ["anti-slop/require-safety-comment-for-type-assertion", "package:alpha"],
  ])("rejects %s %s activation removed two commits earlier", (id, scope) => {
    const root = trackedRepository();
    const policy = fixtureOwnedPolicy();
    mkdirSync(join(root, "scripts"));
    const active = structuredClone(policy);
    active.rules.find((rule) => rule.id === id).activeScopes = [scope];
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
    const policy = fixtureOwnedPolicy();
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

describe("policy digest byte identity (#3918)", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ])("matches the standard SHA-256 vector for %j", (input, expected) => {
    expect(policyDigest(input)).toBe(expected);
    expect(policyDigest(Buffer.from(input))).toBe(expected);
  });

  it.each(["Keiko 😀 漢字", "\ud800", "a".repeat(6 * 1024 * 1024)])(
    "preserves UTF-8 string and ready byte identities",
    (input) => {
      expect(policyDigest(input)).toBe(policyDigest(Buffer.from(input, "utf8")));
    },
  );

  it("keeps invalid UTF-8 bytes distinct from decoded source text", () => {
    const bytes = Buffer.from([128, 255, 0]);
    expect(policyDigest(bytes)).not.toBe(policyDigest(bytes.toString("utf8")));
  });

  it("hashes only each byte view's selected region without mutating it", () => {
    const backing = Uint8Array.from([99, 0, 128, 255, 3, 88]);
    const before = backing.slice();
    const expected = policyDigest(Buffer.from([0, 128, 255, 3]));
    for (const view of [
      Buffer.from(backing.buffer, 1, 4),
      new Uint8Array(backing.buffer, 1, 4),
      new DataView(backing.buffer, 1, 4),
    ]) {
      expect(policyDigest(view)).toBe(expected);
    }
    expect(backing).toEqual(before);
    expect(policyDigest(backing)).not.toBe(expected);
  });

  it.each([undefined, null, 1, {}, [], new ArrayBuffer(1)])(
    "rejects malformed input with the native argument-type failure",
    (input) => {
      expect(() => policyDigest(input)).toThrow(TypeError);
      expect(() => policyDigest(input)).toThrow(
        expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
      );
    },
  );
});

function membershipGit(root, args, input) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", input });
}

function expectMembershipParity(root) {
  const complete = policyMembership.collectPolicyMembership(root);
  expect(policyMembership.collectPolicyPaths(root)).toEqual(complete.paths);
  return complete;
}

describe("fresh paths-only actual Git membership (#3918)", () => {
  it("preserves tracked, forced ignored, unusual and fresh path membership", () => {
    const root = trackedRepository();
    writeFileSync(join(root, ".gitignore"), "ignored-*\n");
    membershipGit(root, ["config", "core.precomposeunicode", "false"]);
    const blob = membershipGit(root, ["hash-object", "-w", "--stdin"], "tracked").trim();
    membershipGit(root, ["update-index", "--index-info"], `100644 ${blob}\té.ts\n`);
    const tracked = ["tracked space.ts", "ignored-tracked.ts"];
    for (const path of tracked) {
      writeFileSync(join(root, path), "tracked");
      membershipGit(root, ["add", "-f", "--", path]);
    }
    const additions = ["fresh space.ts", "日本語.ts", "é.ts"];
    for (const path of additions) writeFileSync(join(root, path), "fresh");
    writeFileSync(join(root, "ignored-untracked.ts"), "ignored");
    membershipGit(root, ["update-index", "--skip-worktree", "--", "ignored-tracked.ts"]);
    unlinkSync(join(root, "ignored-tracked.ts"));
    const complete = expectMembershipParity(root);
    expect("é.ts".localeCompare("é.ts")).toBe(0);
    expect(complete.tracked.has("ignored-tracked.ts")).toBe(true);
    expect(complete.tracked.has("é.ts")).toBe(true);
    expect(complete.paths).toContain("é.ts");
    expect(complete.paths.indexOf("é.ts")).toBeLessThan(complete.paths.indexOf("é.ts"));
    expect(complete.paths).not.toContain("ignored-untracked.ts");
    for (const path of [...tracked, ...additions]) expect(complete.paths).toContain(path);
    unlinkSync(join(root, additions[0]));
    unlinkSync(join(root, tracked[0]));
    const changed = expectMembershipParity(root);
    expect(changed.paths).not.toContain(additions[0]);
    expect(changed.paths).toContain(tracked[0]);
    writeFileSync(join(root, "added-later.ts"), "later");
    expect(expectMembershipParity(root).paths).toContain("added-later.ts");
  });

  it.skipIf(process.platform === "win32")(
    "preserves actual LF names through NUL delimiters",
    () => {
      const root = trackedRepository();
      const tracked = "tracked\nline.ts";
      const addition = "fresh\nline.ts";
      writeFileSync(join(root, tracked), "tracked");
      membershipGit(root, ["add", "--", tracked]);
      writeFileSync(join(root, addition), "fresh");
      const complete = expectMembershipParity(root);
      expect(complete.tracked.has(tracked)).toBe(true);
      expect(complete.paths).toContain(tracked);
      expect(complete.paths).toContain(addition);
    },
  );

  it("deduplicates actual unmerged index stages without losing path order", () => {
    const root = trackedRepository();
    const blob = membershipGit(root, ["hash-object", "-w", "--stdin"], "conflict").trim();
    membershipGit(
      root,
      ["update-index", "--index-info"],
      [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\tconflict.ts\n`).join(""),
    );
    const complete = expectMembershipParity(root);
    expect(complete.tracked.has("conflict.ts")).toBe(true);
    expect(complete.paths.filter((path) => path === "conflict.ts")).toHaveLength(1);
  });

  it("returns an empty set for a real empty index and rejects a nonrepository", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-membership-empty-"));
    roots.push(root);
    membershipGit(root, ["init", "--initial-branch=fixture"]);
    expect(expectMembershipParity(root).paths).toEqual([]);
    rmSync(join(root, ".git"), { recursive: true });
    expect(() => policyMembership.collectPolicyMembership(root)).toThrow();
    expect(() => policyMembership.collectPolicyPaths(root)).toThrow();
  });

  it("rejects an unknown status injected after actual Git output", () => {
    const root = trackedRepository();
    let genuineOutput;
    vi.mocked(execFileSync).mockImplementation((executable, args, options) => {
      genuineOutput = actualExecFileSync(executable, args, options);
      // Fault injection at the subprocess boundary, not a claim about normal Git output.
      return `${genuineOutput}X hostile.ts\0`;
    });
    expect(() => policyMembership.collectPolicyPaths(root)).toThrow("invalid-membership-status");
    expect(genuineOutput).toContain("H package.json\0");
  });

  it("uses one real bounded subprocess rather than the full producer's two", () => {
    const root = trackedRepository();
    vi.mocked(execFileSync).mockClear();
    const complete = policyMembership.collectPolicyMembership(root);
    expect(vi.mocked(execFileSync).mock.calls).toHaveLength(2);
    vi.mocked(execFileSync).mockClear();
    expect(policyMembership.collectPolicyPaths(root)).toEqual(complete.paths);
    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual([
      "ls-files",
      "-z",
      "-t",
      "--cached",
      "--others",
      "--exclude-standard",
    ]);
    expect(calls[0][2]).toMatchObject({
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(vi.mocked(execFileSync).mock.results[0].type).toBe("return");
  });
});

const NATIVE_TEST_INFRASTRUCTURE = [
  "native/portable-launcher/test-app-owner-macos.mjs",
  "native/runtime-supervisor/linux/app-owner-cli-fixture.mjs",
  "native/runtime-supervisor/linux/process_scope_decoder_worker_fixture.mjs",
  "native/runtime-supervisor/linux/process_scope_node_fixture.mjs",
  "native/runtime-supervisor/process_scope_observer_worker_fixture.mjs",
];

function writeNativeInfrastructureFixture(root, path) {
  const source = "export const fixtureValue = 1;\n";
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), source);
  return source;
}

describe("exact native test-infrastructure inventory (#3918)", () => {
  it.each(NATIVE_TEST_INFRASTRUCTURE)(
    "classifies only the exact fixture %s while keeping runtime promotion fail-closed",
    (path) => {
      expect(policyMembership.classifyPolicyPath(path, [])).toEqual({
        scope: "tests",
        production: false,
        reason: "test-or-fixture",
      });
      expect(() => policyMembership.classifyPolicyPath(path, [], true)).toThrow(
        "unclassified-source",
      );
      const nearby = path.replace(/\.mjs$/u, "-unregistered.mjs");
      expect(() => policyMembership.classifyPolicyPath(nearby, [])).toThrow("unclassified-source");
    },
  );

  it("retains every existing inventoried row and hashes all five exact added fixtures", async () => {
    const root = trackedRepository();
    const before = await collectPolicyInventory(root);
    const sources = new Map();
    for (const path of NATIVE_TEST_INFRASTRUCTURE)
      sources.set(path, writeNativeInfrastructureFixture(root, path));
    const after = await collectPolicyInventory(root);
    expect(after.files).toHaveLength(before.files.length + NATIVE_TEST_INFRASTRUCTURE.length);
    for (const retained of before.files)
      expect(after.files.find((file) => file.path === retained.path)).toEqual(retained);
    for (const [path, source] of sources)
      expect(after.files.find((file) => file.path === path)).toEqual({
        path,
        tracked: false,
        sha256: policyDigest(source),
        scope: "tests",
        production: false,
        reason: "test-or-fixture",
      });
    expect(after.productionReachability).toEqual(before.productionReachability);
    expect(after.packages).toEqual(before.packages);
    expect(after.rootBuild).toEqual(before.rootBuild);
  });

  it.each(NATIVE_TEST_INFRASTRUCTURE)(
    "rejects a real production runtime import of exact native fixture %s",
    async (path) => {
      const root = trackedRepository();
      writeNativeInfrastructureFixture(root, path);
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, "scripts/runtime-entry.mjs"), `import "../${path}";\n`);
      await expect(collectPolicyInventory(root)).rejects.toThrow("unclassified-source");
    },
  );

  it.each(NATIVE_TEST_INFRASTRUCTURE)(
    "rejects a real public export of exact native fixture %s",
    async (path) => {
      const root = trackedRepository();
      writeNativeInfrastructureFixture(root, path);
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "fixture",
          workspaces: ["packages/*"],
          exports: `./${path}`,
        }),
      );
      await expect(collectPolicyInventory(root)).rejects.toThrow("unclassified-source");
    },
  );
});

const FOURTH_PACKAGE_FIXTURE =
  "packages/keiko-server/src/tool-catalog/__fixtures__/nativeEffectRuntimeFixture.ts";
const NEARBY_PACKAGE_SOURCE = FOURTH_PACKAGE_FIXTURE.replace(".ts", "-unregistered.ts");

function writeFourthPackageFixture(root) {
  const directory = "packages/keiko-server";
  mkdirSync(join(root, directory, "src/tool-catalog/__fixtures__"), { recursive: true });
  writeFileSync(
    join(root, directory, "package.json"),
    JSON.stringify({ name: "@oscharko-dev/keiko-server", exports: "./src/index.ts" }),
  );
  writeFileSync(
    join(root, directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { rootDir: "src", outDir: "dist" },
      include: ["src/**/*.ts"],
    }),
  );
  const sources = new Map([
    [`${directory}/src/index.ts`, "export const value = 1;\n"],
    [FOURTH_PACKAGE_FIXTURE, "export const fixtureValue = 1;\n"],
    [NEARBY_PACKAGE_SOURCE, "export const nearbyValue = 1;\n"],
  ]);
  for (const [path, source] of sources) writeFileSync(join(root, path), source);
  return sources;
}

function writeFourthFixtureChain(root, sources) {
  const directory = "packages/keiko-server/src/tool-catalog/__fixtures__";
  sources.set(FOURTH_PACKAGE_FIXTURE, 'export * from "./catalogRuntimeFixture.js";\n');
  sources.set(
    `${directory}/catalogRuntimeFixture.ts`,
    'export * from "./catalogToolFixture.js";\n',
  );
  sources.set(
    `${directory}/catalogToolFixture.ts`,
    'export * from "../../../../../tests/support/buffered-server-log.js";\n',
  );
  sources.set("tests/support/buffered-server-log.ts", "export const fixtureValue = 1;\n");
  mkdirSync(join(root, "tests/support"), { recursive: true });
  for (const [path, source] of sources) writeFileSync(join(root, path), source);
}

function exposeFourthPackageFixture(root, linkage) {
  if (linkage === "runtime") {
    writeFileSync(
      join(root, "packages/keiko-server/src/index.ts"),
      'export * from "./tool-catalog/__fixtures__/nativeEffectRuntimeFixture.js";\n',
    );
    return;
  }
  writeFileSync(
    join(root, "packages/keiko-server/package.json"),
    JSON.stringify({
      name: "@oscharko-dev/keiko-server",
      exports: "./src/tool-catalog/__fixtures__/nativeEffectRuntimeFixture.ts",
    }),
  );
}

describe("exact fourth package-fixture membership (#3918)", () => {
  it("keeps the fourth fixture exact and preserves its supported runtime owner", () => {
    const packages = [{ directory: "packages/keiko-server", name: "@oscharko-dev/keiko-server" }];
    expect(policyMembership.classifyPolicyPath(FOURTH_PACKAGE_FIXTURE, packages)).toEqual({
      scope: "tests",
      production: false,
      reason: "test-or-fixture",
    });
    const production = {
      scope: "package:@oscharko-dev/keiko-server",
      production: true,
      reason: "workspace-owner",
    };
    expect(policyMembership.classifyPolicyPath(NEARBY_PACKAGE_SOURCE, packages)).toEqual(
      production,
    );
    expect(policyMembership.classifyPolicyPath(FOURTH_PACKAGE_FIXTURE, packages, true)).toEqual(
      production,
    );
  });

  it("retains the full census and hashes without promoting a dormant fixture chain", async () => {
    const root = trackedRepository();
    const before = await collectPolicyInventory(root);
    const sources = writeFourthPackageFixture(root);
    writeFourthFixtureChain(root, sources);
    const after = await collectPolicyInventory(root);
    expect(after.files).toHaveLength(before.files.length + sources.size);
    for (const retained of before.files)
      expect(after.files.find((file) => file.path === retained.path)).toEqual(retained);
    for (const [path, source] of sources) {
      const row = after.files.find((file) => file.path === path);
      expect(row).toMatchObject({ path, tracked: false, sha256: policyDigest(source) });
      const production = path.endsWith("/src/index.ts") || path === NEARBY_PACKAGE_SOURCE;
      expect(row.production).toBe(production);
      expect(row.scope).toBe(production ? "package:@oscharko-dev/keiko-server" : "tests");
    }
    expect(after.productionReachability.promoted).toEqual([]);
  });

  it.each(["runtime", "public"])(
    "promotes a healthy fourth package fixture reached through a real %s edge",
    async (linkage) => {
      const root = trackedRepository();
      writeFourthPackageFixture(root);
      exposeFourthPackageFixture(root, linkage);
      const inventory = await collectPolicyInventory(root);
      expect(inventory.files.find((file) => file.path === FOURTH_PACKAGE_FIXTURE)).toMatchObject({
        scope: "package:@oscharko-dev/keiko-server",
        production: true,
        reason: "production-runtime-reachable",
      });
      expect(inventory.productionReachability.promoted).toContain(FOURTH_PACKAGE_FIXTURE);
    },
  );

  it.each(["runtime", "public"])(
    "rejects the unsupported transitive root helper reached through a real %s edge",
    async (linkage) => {
      const root = trackedRepository();
      const sources = writeFourthPackageFixture(root);
      writeFourthFixtureChain(root, sources);
      exposeFourthPackageFixture(root, linkage);
      await expect(collectPolicyInventory(root)).rejects.toThrow("unclassified-source");
    },
  );
});

describe("retired owner presence pin relocation (#3918)", () => {
  it("retains production native-host membership on the three byte-pinned historical inputs", async () => {
    const root = trackedRepository();
    copyNativePolicyFixtureSources(root);
    const inventory = await collectPolicyInventory(root);
    const native = inventory.files.filter((file) => file.scope === "native-host");
    expect(native.map(({ path }) => path)).toEqual([
      "native/opencode-service-host/entry.mjs",
      "native/opencode-service-host/guard-seams.mjs",
      "native/opencode-service-host/host.mjs",
    ]);
    expect(native.every((file) => file.production)).toBe(true);
  });
});
