import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { assessPolicyDiagnostics, validatePolicy } from "../lib/code-quality-policy.mjs";
import { classifyPolicyPath, selectPolicyScope } from "../lib/code-quality-inventory.mjs";

import { publicParserRecord } from "./support/code-quality-symbol-fixture.mjs";

const policy = JSON.parse(readFileSync(new URL("../code-quality-policy.json", import.meta.url)));
const files = [
  { path: "src/main.ts", scope: "root-product", production: true },
  { path: "packages/example/src/main.ts", scope: "package:example", production: true },
  { path: "packages/example/src/main.test.ts", scope: "tests", production: false },
];
const diagnostic = (path, rule) => ({ path, rule, line: 1, column: 1 });
const CONTRACTS_SCOPE = "package:@oscharko-dev/keiko-contracts";
const ASSERTION_RULES = [
  "anti-slop/no-chained-type-assertions",
  "anti-slop/require-safety-comment-for-type-assertion",
];

describe("code-quality policy fail-closed contract (#3915)", () => {
  it("activates the qualified Effect rules only for the exact native host owner (#3988)", () => {
    const effects = policy.rules.filter(({ id }) => id.startsWith("anti-slop-effect/"));
    expect(effects).toHaveLength(5);
    const owners = [
      ...files,
      { path: "native/opencode-service-host/entry.mjs", scope: "native-host", production: true },
    ];
    for (const rule of effects) {
      expect(rule.activeScopes).toEqual(["native-host"]);
      const result = assessPolicyDiagnostics(
        owners.map(({ path }) => diagnostic(path, rule.id)),
        owners,
        policy,
      );
      expect(result.violations.map(({ path }) => path)).toEqual([
        "native/opencode-service-host/entry.mjs",
      ]);
      expect(result.census).toHaveLength(owners.length);
    }
  });

  it("keeps all 22 dispositions and the three initial production guards", () => {
    expect(validatePolicy(policy)).toEqual([]);
    expect(policy.rules).toHaveLength(22);
    for (const rule of ["no-widen-then-assert", "no-reflect-apply", "no-reduce-accumulator-copy"]) {
      const broken = structuredClone(policy);
      broken.rules.find((entry) => entry.id.endsWith(`/${rule}`)).activeScopes = [];
      expect(validatePolicy(broken).length).toBeGreaterThan(0);
    }
  });

  it("retains the eight manual ingress obligations and exact ninth observation record", () => {
    expect(policy.version).toBe(2);
    expect(policy.responsibilities.map(({ id }) => id)).toEqual([
      "manual-job-create-route-handler",
      "manual-job-refresh-route-handler",
      "manual-source-refresh-consumer",
      "manual-source-persistence-consumer",
      "manual-summary-update-persistence-consumer",
      "manual-source-scope-composition",
      "manual-summary-projection",
      "manual-limit-diagnostic-public-proof",
      "support-raw-property-observation",
      "git-status-public-parser",
      "git-diff-public-parser",
      "git-history-public-parser",
      "git-summary-public-parser",
      "git-remotes-public-parser",
      "git-sync-preview-public-parser",
      "git-sync-execute-public-parser",
    ]);
    for (const record of policy.responsibilities.slice(0, 8)) {
      expect(record.rules).toEqual(["anti-slop/no-unknown-parameters"]);
      expect(record.owner).toBe("@oscharko-dev/keiko-contracts");
      expect(record.transform).toEqual(record.output);
      const { parameterIndex, ...input } = record.input;
      expect(parameterIndex).toBe(0);
      expect(input).toEqual(record.transform);
    }
    const removed = structuredClone(policy);
    removed.responsibilities.pop();
    expect(validatePolicy(removed, [policy])).toContain("responsibility-shrank");
    const legacy = {
      version: 1,
      upstream: policy.upstream,
      runner: policy.runner,
      rules: policy.rules,
    };
    expect(validatePolicy(legacy)).toEqual([]);
    expect(validatePolicy(legacy, [policy])).toContain("responsibility-downgrade");
  });

  it("pins the ninth observation owner, selectors and public proof shape", () => {
    const record = policy.responsibilities[8];
    expect(record.kind).toBe("raw-property-observation");
    expect(record.owner).toBe("@oscharko-dev/keiko-contracts");
    expect(record.rules).toEqual([
      "anti-slop/no-object-parameters",
      "anti-slop/no-unknown-returns",
      "anti-slop/no-reflect-get",
    ]);
    const selector = {
      consumerPath: "packages/keiko-contracts/src/observability.test.ts",
      specifier: "@oscharko-dev/keiko-contracts/runtime/observability",
      exportName: "validateRegisteredActivityLogEvent",
    };
    expect(record.input).toEqual({ ...selector, parameterIndex: 0 });
    expect(record.transform).toEqual(selector);
    expect(record.output).toEqual(selector);
    expect(record.consumer).toEqual({
      ...selector,
      exportName: "validatePublicObservation",
      kind: "public-api-proof",
      owner: record.owner,
    });
    expect(record.proofs).toEqual([selector.consumerPath]);
    expect(record.proofAssertions).toHaveLength(15);
    expect(record.proofAssertions.every((proof) => proof.path === selector.consumerPath)).toBe(
      true,
    );
    for (const variant of ["removed", "rebound"]) {
      const changed = structuredClone(policy);
      if (variant === "removed") changed.responsibilities.splice(8, 1);
      else changed.responsibilities[8].consumer.exportName = "unreviewedConsumer";
      expect(validatePolicy(changed, [policy])).toContain("responsibility-shrank");
    }
  });

  it.each(["Status", "Diff"])(
    "pins the exact Git %s public parser without broader activation",
    (kind) => {
      const index = kind === "Status" ? 9 : 10;
      const record = policy.responsibilities[index];
      const path = "packages/keiko-contracts/src/git-repository.test.ts";
      const selector = {
        consumerPath: path,
        specifier: "@oscharko-dev/keiko-contracts/runtime/git-repository",
        exportName: `parseGitRepository${kind}Response`,
      };
      expect(record.id).toBe(`git-${kind.toLowerCase()}-public-parser`);
      expect(record.owner).toBe("@oscharko-dev/keiko-contracts");
      expect(record.kind).toBe("public-parser");
      expect(record.rules).toEqual(["anti-slop/no-unknown-parameters"]);
      expect(record.input).toEqual({ ...selector, parameterIndex: 0 });
      expect(record.transform).toEqual(selector);
      expect(record.output).toEqual(selector);
      expect(record.consumer).toEqual({
        ...selector,
        kind: "public-api-proof",
        owner: record.owner,
        exportName: `parsePublicGit${kind}`,
      });
      expect(record.proofs).toEqual([path]);
      expect(record.proofAssertions).toHaveLength(kind === "Status" ? 6 : 3);
      expect(record.proofAssertions.every((proof) => proof.path === path)).toBe(true);
      for (const variant of ["removed", "rebound"]) {
        const changed = structuredClone(policy);
        if (variant === "removed") changed.responsibilities.splice(index, 1);
        else changed.responsibilities[index].consumer.exportName = "unreviewedParser";
        expect(validatePolicy(changed, [policy])).toContain("responsibility-shrank");
      }
    },
  );

  it.each([
    ["history", "git-history", "parseGitHistoryResponse", "parsePublicGitHistory"],
    ["summary", "git-repository-summary", "parseGitRepositorySummary", "parsePublicGitSummary"],
    ["remotes", "git-repository-summary", "parseGitRemotesResponse", "parsePublicGitRemotes"],
    ["sync-preview", "git-sync", "parseGitSyncPreview", "parsePublicGitSyncPreview"],
    ["sync-execute", "git-sync", "parseGitSyncExecuteResponse", "parsePublicGitSyncExecute"],
  ])(
    "pins the additive Git %s parser without changing prior obligations",
    (kind, module, producer, consumer) => {
      const index = policy.responsibilities.findIndex(
        (record) => record.id === `git-${kind}-public-parser`,
      );
      const record = policy.responsibilities[index];
      const path = `packages/keiko-contracts/src/${module}.test.ts`;
      const selector = {
        consumerPath: path,
        specifier: `@oscharko-dev/keiko-contracts/runtime/${module}`,
        exportName: producer,
      };
      expect(record.owner).toBe("@oscharko-dev/keiko-contracts");
      expect(record.kind).toBe("public-parser");
      expect(record.rules).toEqual(["anti-slop/no-unknown-parameters"]);
      expect(record.input).toEqual({ ...selector, parameterIndex: 0 });
      expect(record.transform).toEqual(selector);
      expect(record.output).toEqual(selector);
      expect(record.consumer).toEqual({
        ...selector,
        exportName: consumer,
        kind: "public-api-proof",
        owner: record.owner,
      });
      expect(record.proofs).toEqual([path]);
      expect(record.proofAssertions).toHaveLength(3);
      expect(record.proofAssertions.every((proof) => proof.path === path)).toBe(true);
      for (const mode of ["removed", "rebound"]) {
        const changed = structuredClone(policy);
        if (mode === "removed") changed.responsibilities.splice(index, 1);
        else changed.responsibilities[index].consumer.exportName = "unreviewedParser";
        expect(validatePolicy(changed, [policy])).toContain("responsibility-shrank");
      }
    },
  );

  it.each(ASSERTION_RULES)("enforces %s only on all current and future contracts members", (id) => {
    const packages = [{ directory: "packages/contracts", name: "@oscharko-dev/keiko-contracts" }];
    const owners = [
      ...files,
      ...["src/owner.ts", "src/future.generated.ts", "src/owner.test.ts"].map((suffix) => {
        const path = `packages/contracts/${suffix}`;
        return { path, ...classifyPolicyPath(path, packages) };
      }),
    ];
    expect(policy.rules.find((rule) => rule.id === id).activeScopes).toEqual([CONTRACTS_SCOPE]);
    const result = assessPolicyDiagnostics(
      owners.map(({ path }) => diagnostic(path, id)),
      owners,
      policy,
    );
    expect(result.violations.map(({ path }) => path)).toEqual([
      "packages/contracts/src/owner.ts",
      "packages/contracts/src/future.generated.ts",
    ]);
    expect(result.census).toHaveLength(owners.length);
    const removed = structuredClone(policy);
    removed.rules.find((rule) => rule.id === id).activeScopes = [];
    expect(validatePolicy(removed, [policy])).toContain("activation-shrank");
    const broader = structuredClone(policy);
    broader.rules.find((rule) => rule.id === id).activeScopes.push("production");
    expect(validatePolicy(broader, [policy])).toEqual([]);
    expect(validatePolicy(policy, [broader])).toContain("activation-shrank");
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
    previous.rules
      .find((rule) => rule.id === "anti-slop/no-chained-type-assertions")
      .activeScopes.push("production");
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

describe("closed public parser schema (#3918)", () => {
  it("accepts only the exact first parser obligation", () => {
    const candidate = { ...policy, responsibilities: [publicParserRecord()] };
    expect(validatePolicy(candidate)).toEqual([]);
    candidate.responsibilities[0].rules.push("anti-slop/no-unknown-returns");
    expect(validatePolicy(candidate)).toContain("invalid-responsibilities");
  });
  it.each(["parameter", "consumer", "extra", "removed", "rebound"])(
    "refuses %s parser contract drift",
    (variant) => {
      const candidate = { ...policy, responsibilities: [publicParserRecord()] };
      const baseline = structuredClone(candidate);
      const record = candidate.responsibilities[0];
      if (variant === "parameter") record.input.parameterIndex = 1;
      if (variant === "consumer") delete record.consumer.kind;
      if (variant === "extra") record.authorized = true;
      if (variant === "removed") candidate.responsibilities = [];
      if (variant === "rebound") record.kind = "diagnostic-checker";
      expect(validatePolicy(candidate, [baseline]).length).toBeGreaterThan(0);
    },
  );
});
