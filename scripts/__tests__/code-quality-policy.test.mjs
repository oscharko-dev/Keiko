import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { assessPolicyDiagnostics, validatePolicy } from "../lib/code-quality-policy.mjs";
import { classifyPolicyPath, selectPolicyScope } from "../lib/code-quality-inventory.mjs";

const policy = JSON.parse(readFileSync(new URL("../code-quality-policy.json", import.meta.url)));
const files = [
  { path: "src/main.ts", scope: "root-product", production: true },
  { path: "packages/example/src/main.ts", scope: "package:example", production: true },
  { path: "packages/example/src/main.test.ts", scope: "tests", production: false },
];
const diagnostic = (path, rule) => ({ path, rule, line: 1, column: 1 });

describe("code-quality policy fail-closed contract (#3915)", () => {
  it("keeps all 22 dispositions and the three initial production guards", () => {
    expect(validatePolicy(policy)).toEqual([]);
    expect(policy.rules).toHaveLength(22);
    for (const rule of ["no-widen-then-assert", "no-reflect-apply", "no-reduce-accumulator-copy"]) {
      const broken = structuredClone(policy);
      broken.rules.find((entry) => entry.id.endsWith(`/${rule}`)).activeScopes = [];
      expect(validatePolicy(broken).length).toBeGreaterThan(0);
    }
  });

  it("rejects missing, duplicated, unknown, cosmetic and malformed rule policies", () => {
    const altered = [
      { ...policy, rules: policy.rules.slice(1) },
      { ...policy, rules: [...policy.rules, policy.rules[0]] },
      { ...policy, rules: [...policy.rules, { id: "anti-slop/require-readable-spacing" }] },
      { ...policy, version: 999 },
      { ...policy, extra: "unexpected" },
    ];
    for (const input of altered) expect(validatePolicy(input).length).toBeGreaterThan(0);
  });

  it("does not shrink a previously activated assertion scope", () => {
    const previous = structuredClone(policy);
    previous.rules.find((rule) => rule.id === "anti-slop/no-chained-type-assertions").activeScopes =
      ["production"];
    expect(validatePolicy(policy, [previous])).toContain("activation-shrank");
    expect(validatePolicy(previous, [policy])).toEqual([]);
  });

  it("rejects unknown/empty scopes and marks local subsets partial", () => {
    expect(selectPolicyScope(files, "repository", false).partial).toBe(false);
    expect(selectPolicyScope(files, "package:example", false).files).toHaveLength(1);
    expect(selectPolicyScope(files, "tests", false).partial).toBe(true);
    expect(() => selectPolicyScope(files, "missing", false)).toThrow();
    expect(() => selectPolicyScope(files, "native-host", false)).toThrow();
    expect(() => selectPolicyScope(files, "tests", true)).toThrow();
  });

  it("distinguishes setup, intentional fixture, native host and unclassified source", () => {
    const packages = [{ directory: "packages/example", name: "example" }];
    expect(classifyPolicyPath("packages/example/vitest.setup.ts", packages).production).toBe(false);
    expect(classifyPolicyPath("tests/fixtures/hostile.ts", packages).reason).toBe(
      "test-or-fixture",
    );
    expect(classifyPolicyPath("native/opencode-service-host/entry.mjs", packages).scope).toBe(
      "native-host",
    );
    expect(classifyPolicyPath("packages/example/src/main.ts", packages).production).toBe(true);
    expect(
      classifyPolicyPath(
        "packages/keiko-server/src/tool-catalog/__fixtures__/catalogRuntimeFixture.ts",
        [{ directory: "packages/keiko-server", name: "server" }],
      ).production,
    ).toBe(false);
    expect(() => classifyPolicyPath("new-runtime/main.ts", packages)).toThrow();
    expect(() => classifyPolicyPath("packages/omitted/src/main.ts", packages)).toThrow();
  });

  it("rejects an active bad case in every production owner without rejecting a genuine test input", () => {
    for (const path of ["src/main.ts", "packages/example/src/main.ts"]) {
      const result = assessPolicyDiagnostics(
        [diagnostic(path, "anti-slop/no-widen-then-assert")],
        files,
        policy,
      );
      expect(result.violations).toHaveLength(1);
    }
    const result = assessPolicyDiagnostics(
      [diagnostic("packages/example/src/main.test.ts", "anti-slop/no-widen-then-assert")],
      files,
      policy,
    );
    expect(result.violations).toEqual([]);
    expect(result.census).toHaveLength(1);
  });

  it("never treats unknown diagnostics or omitted files as clean", () => {
    expect(() =>
      assessPolicyDiagnostics([diagnostic("src/main.ts", "parser/error")], files, policy),
    ).toThrow();
    expect(() =>
      assessPolicyDiagnostics(
        [diagnostic("missing.ts", "anti-slop/no-widen-then-assert")],
        files,
        policy,
      ),
    ).toThrow();
  });
});
