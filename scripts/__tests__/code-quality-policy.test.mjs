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

describe("public parser optional raw admission rules (#3918)", () => {
  it.each([
    { rules: ["anti-slop/no-runtime-typeof"] },
    { rules: ["anti-slop/no-unsafe-dictionary-type"] },
    { rules: ["anti-slop/no-runtime-typeof", "anti-slop/no-unsafe-dictionary-type"] },
  ])("admits only explicit additional raw rules $rules with exact proof selectors", ({ rules }) => {
    const record = publicParserRecord();
    expect(validatePolicy({ ...policy, responsibilities: [record] })).toEqual([]);
    record.rules.push(...rules);
    record.proofAssertions = [{ path: record.proofs[0], testName: "actual public refusal" }];
    expect(record.rules).toEqual(["anti-slop/no-unknown-parameters", ...rules]);
    const candidate = { ...policy, responsibilities: [record] };
    expect(validatePolicy(candidate)).toEqual([]);
  });

  it.each([
    "missing-proof",
    "empty-proof",
    "foreign-proof",
    "duplicate-proof",
    "wrong-index",
    "missing-unknown",
    "return",
    "widening",
  ])("refuses incomplete or unrelated public parser rules: %s", (variant) => {
    const record = publicParserRecord();
    record.rules.push("anti-slop/no-runtime-typeof");
    record.proofAssertions = [{ path: record.proofs[0], testName: "actual public refusal" }];
    if (variant === "missing-proof") delete record.proofAssertions;
    if (variant === "empty-proof") record.proofAssertions = [];
    if (variant === "foreign-proof") record.proofAssertions[0].path = "unregistered.test.ts";
    if (variant === "duplicate-proof")
      record.proofAssertions.push({ ...record.proofAssertions[0] });
    if (variant === "wrong-index") record.input.parameterIndex = 1;
    if (variant === "missing-unknown") record.rules.shift();
    if (variant === "return") record.rules.push("anti-slop/no-unknown-returns");
    if (variant === "widening") record.rules.push("anti-slop/no-known-value-widening");
    expect(validatePolicy({ ...policy, responsibilities: [record] })).toContain(
      "invalid-responsibilities",
    );
  });

  it("retains additive rules and proof selectors in complete policy history", () => {
    const record = publicParserRecord();
    const original = { ...policy, responsibilities: [structuredClone(record)] };
    record.rules.push("anti-slop/no-runtime-typeof");
    record.proofAssertions = [{ path: record.proofs[0], testName: "actual public refusal" }];
    const extended = { ...policy, responsibilities: [record] };
    expect(validatePolicy(extended, [original])).toEqual([]);
    expect(validatePolicy(original, [extended])).toContain("responsibility-shrank");
    const rebound = structuredClone(extended);
    rebound.responsibilities[0].proofAssertions[0].testName = "unrelated proof";
    expect(validatePolicy(rebound, [extended])).toContain("responsibility-shrank");
  });
});

describe("canonical policy report diagnostic order", () => {
  it("retains activation for each occurrence of the same diagnostic object", () => {
    let reads = 0;
    const repeated = {
      path: files[0].path,
      line: 1,
      column: 1,
      get rule() {
        reads += 1;
        return reads === 1 ? "anti-slop/no-reflect-apply" : "anti-slop/no-known-value-widening";
      },
    };
    const result = assessPolicyDiagnostics([repeated, repeated], files, policy);
    expect(result.census).toHaveLength(2);
    expect(result.census.every((entry) => entry === repeated)).toBe(true);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toBe(repeated);
  });

  it("retains inventory order and every active/inactive duplicate across input permutations", () => {
    const owners = [files[0], files[2], files[1]];
    const activeRule = "anti-slop/no-reflect-apply";
    const otherRule = "anti-slop/no-widen-then-assert";
    const inactiveRule = "anti-slop/no-known-value-widening";
    const first = Object.freeze(diagnostic(owners[0].path, activeRule));
    const duplicate = Object.freeze({ ...first });
    const other = Object.freeze(diagnostic(owners[0].path, otherRule));
    const column = Object.freeze({ ...first, column: 3 });
    const line = Object.freeze({ ...first, line: 2 });
    const laterLine = Object.freeze({ ...first, line: 10 });
    const inactive = Object.freeze(diagnostic(owners[0].path, inactiveRule));
    const testOnly = Object.freeze(diagnostic(owners[1].path, activeRule));
    const packageOnly = Object.freeze(diagnostic(owners[2].path, activeRule));
    const expected = [
      inactive,
      first,
      duplicate,
      other,
      column,
      line,
      laterLine,
      testOnly,
      packageOnly,
    ];
    const permutations = [
      [packageOnly, laterLine, other, testOnly, line, inactive, column, first, duplicate],
      [testOnly, column, duplicate, inactive, packageOnly, first, other, laterLine, line],
    ];
    for (const permutation of permutations) {
      const input = Object.freeze(permutation);
      const before = [...input];
      const result = assessPolicyDiagnostics(input, owners, policy);
      expect(result.census).toEqual(expected);
      expect(result.violations).toEqual([
        first,
        duplicate,
        other,
        column,
        line,
        laterLine,
        packageOnly,
      ]);
      expect(result.census).toHaveLength(input.length);
      expect(result.census.filter((entry) => entry === first)).toHaveLength(1);
      expect(result.census.filter((entry) => entry === duplicate)).toHaveLength(1);
      expect(result.census).toContain(inactive);
      expect(result.census).toContain(testOnly);
      expect(result.violations).not.toContain(inactive);
      expect(result.violations).not.toContain(testOnly);
      expect(input).toEqual(before);
      expect(owners).toEqual([files[0], files[2], files[1]]);
    }
  });
});

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
      "knowledge-catalog-capsules-public-parser",
      "knowledge-catalog-capsule-sets-public-parser",
      "memory-record-public-parser",
      "memory-scope-public-parser",
      "memory-payload-public-parser",
      "atlassian-sync-change-summary-public-parser",
      "atlassian-sync-job-state-public-parser",
      "atlassian-connector-pod-source-public-parser",
      "atlassian-connector-descriptor-public-parser",
      "atlassian-sync-bounds-public-parser",
      "atlassian-sync-scope-public-parser",
      "atlassian-connector-activity-public-parser",
      "atlassian-connector-pending-approval-public-parser",
      "atlassian-connector-action-execution-public-parser",
      "jira-live-search-request-public-parser",
      "jira-live-search-result-public-parser",
      "memory-proposal-public-parser",
      "memory-acceptance-public-parser",
      "memory-rejection-public-parser",
      "memory-update-public-parser",
      "memory-supersession-public-parser",
      "memory-pin-public-parser",
      "memory-unpin-public-parser",
      "memory-archive-public-parser",
      "memory-forget-public-parser",
      "memory-audit-record-public-parser",
      "memory-retrieval-request-public-parser",
      "documentation-navigation-request-public-parser",
      "documentation-manual-proposal-request-public-parser",
      "coding-runtime-question-answer-public-parser",
      "coding-runtime-questions-response-public-parser",
      "coding-runtime-questions-channel-public-parser",
      "coding-runtime-research-channel-public-parser",
      "governed-action-v1-public-parser",
      "code-task-execution-v1-public-parser",
      "run-control-snapshot-public-parser",
      "runtime-governance-request-public-parser",
      "runtime-governance-outcome-public-parser",
      "code-task-acceptance-contribution-public-parser",
      "code-task-qualification-flow-public-parser",
      "code-task-qualification-manifest-public-parser",
      "auxiliary-capability-request-public-parser",
      "auxiliary-capability-outcome-public-parser",
      "task-workspace-transition-from-typed-recheck",
      "task-workspace-transition-to-typed-recheck",
      "task-workspace-next-from-typed-recheck",
      "task-workspace-cleanup-value-typed-recheck",
      "actual-code-task-acceptance-raw-reader-return",
      "support-canonical-json-decoder-return",
      "editor-document-version-public-parser",
      "git-editor-diff-request-public-parser",
      "git-editor-diff-response-public-parser",
      "git-editor-blame-request-public-parser",
      "git-editor-blame-response-public-parser",
      "command-request-public-parser",
      "command-catalog-public-parser",
      "command-result-public-parser",
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

  it.each([
    ["capsules", "parseLocalKnowledgeCapsulesResponse", "parsePublicCapsulesCatalog"],
    ["capsule-sets", "parseLocalKnowledgeCapsuleSetsResponse", "parsePublicCapsuleSetsCatalog"],
  ])(
    "pins the additive Knowledge catalog %s public parser and rejects removal/rebinding",
    (kind, producer, consumer) => {
      const index = policy.responsibilities.findIndex(
        (record) => record.id === `knowledge-catalog-${kind}-public-parser`,
      );
      const record = policy.responsibilities[index];
      const path = "packages/keiko-contracts/src/local-knowledge-pods.test.ts";
      const selector = {
        consumerPath: path,
        specifier: "@oscharko-dev/keiko-contracts/runtime/local-knowledge-pods",
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
      for (const mode of ["removed", "rebound"]) {
        const changed = structuredClone(policy);
        if (mode === "removed") changed.responsibilities.splice(index, 1);
        else changed.responsibilities[index].consumer.exportName = "unreviewedCatalogParser";
        expect(validatePolicy(changed, [policy])).toContain("responsibility-shrank");
      }
    },
  );

  it.each([
    ["record", "validateMemoryRecord", "parsePublicMemoryRecord"],
    ["scope", "validateMemoryScope", "parsePublicMemoryScope"],
    ["payload", "validateMemoryStructuredPayload", "parsePublicMemoryPayload"],
  ])(
    "pins the additive Memory %s parser and retains all preceding obligations",
    (kind, producer, consumer) => {
      const index = policy.responsibilities.findIndex(
        (record) => record.id === `memory-${kind}-public-parser`,
      );
      const record = policy.responsibilities[index];
      const path = "packages/keiko-contracts/src/memory.test.ts";
      const selector = {
        consumerPath: path,
        specifier: "@oscharko-dev/keiko-contracts/runtime/memory",
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
      for (const mode of ["removed", "rebound"]) {
        const changed = structuredClone(policy);
        if (mode === "removed") changed.responsibilities.splice(index, 1);
        else changed.responsibilities[index].consumer.exportName = "unreviewedMemoryParser";
        expect(validatePolicy(changed, [policy])).toContain("responsibility-shrank");
      }
    },
  );

  it.each([
    [
      "sync-change-summary",
      "validateAtlassianSyncChangeSummary",
      "parsePublicAtlassianSyncChangeSummary",
    ],
    ["sync-job-state", "validateAtlassianSyncJobState", "parsePublicAtlassianSyncJobState"],
    [
      "connector-pod-source",
      "validateAtlassianConnectorPodSource",
      "parsePublicAtlassianConnectorPodSource",
    ],
  ])(
    "pins the additive Atlassian %s parser and retains prior obligations",
    (kind, producer, consumer) => {
      const index = policy.responsibilities.findIndex(
        (record) => record.id === `atlassian-${kind}-public-parser`,
      );
      const record = policy.responsibilities[index];
      const path = "packages/keiko-contracts/src/atlassian-connectors-validation.test.ts";
      const selector = {
        consumerPath: path,
        specifier: "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors-validation",
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
        else changed.responsibilities[index].consumer.exportName = "unreviewedAtlassianParser";
        expect(validatePolicy(changed, [policy])).toContain("responsibility-shrank");
      }
    },
  );

  it.each([
    [
      "connector-descriptor",
      "validateAtlassianConnectorDescriptor",
      "parsePublicAtlassianConnectorDescriptor",
    ],
    ["sync-bounds", "validateAtlassianSyncBounds", "parsePublicAtlassianSyncBounds"],
    ["sync-scope", "validateAtlassianSyncScope", "parsePublicAtlassianSyncScope"],
  ])(
    "pins the additive Atlassian approved-scope %s parser and retains prior obligations",
    (kind, producer, consumer) => {
      const index = policy.responsibilities.findIndex(
        (record) => record.id === `atlassian-${kind}-public-parser`,
      );
      const record = policy.responsibilities[index];
      const path = "packages/keiko-contracts/src/atlassian-connectors-validation.test.ts";
      const selector = {
        consumerPath: path,
        specifier: "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors-validation",
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
        else changed.responsibilities[index].consumer.exportName = "unreviewedApprovedScopeParser";
        expect(validatePolicy(changed, [policy])).toContain("responsibility-shrank");
      }
    },
  );

  it.each([...ASSERTION_RULES, "anti-slop/no-reflect-get", "anti-slop/no-unknown-returns"])(
    "enforces %s only on all current and future contracts members",
    (id) => {
      const packages = [{ directory: "packages/contracts", name: "@oscharko-dev/keiko-contracts" }];
      const owners = [
        ...files,
        ...["src/owner.ts", "src/future.generated.ts", "vitest.config.ts", "src/owner.test.ts"].map(
          (suffix) => {
            const path = `packages/contracts/${suffix}`;
            return { path, ...classifyPolicyPath(path, packages) };
          },
        ),
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
        "packages/contracts/vitest.config.ts",
      ]);
      expect(result.census).toHaveLength(owners.length);
      const removed = structuredClone(policy);
      removed.rules.find((rule) => rule.id === id).activeScopes = [];
      expect(validatePolicy(removed, [policy])).toContain("activation-shrank");
      const broader = structuredClone(policy);
      broader.rules.find((rule) => rule.id === id).activeScopes.push("production");
      expect(validatePolicy(broader, [policy])).toEqual([]);
      expect(validatePolicy(policy, [broader])).toContain("activation-shrank");
    },
  );

  it.each([
    [
      "connector-activity",
      "validateAtlassianConnectorActivityRecord",
      "parsePublicAtlassianConnectorActivityRecord",
    ],
    [
      "connector-pending-approval",
      "validateAtlassianConnectorPendingApproval",
      "parsePublicAtlassianConnectorPendingApproval",
    ],
    [
      "connector-action-execution",
      "validateAtlassianConnectorActionExecutionResult",
      "parsePublicAtlassianConnectorActionExecutionResult",
    ],
  ])(
    "pins the additive Atlassian governed-action %s parser and retains prior obligations",
    (kind, producer, consumer) => {
      const index = policy.responsibilities.findIndex(
        (record) => record.id === `atlassian-${kind}-public-parser`,
      );
      const record = policy.responsibilities[index];
      const path = "packages/keiko-contracts/src/atlassian-connectors-validation.test.ts";
      const selector = {
        consumerPath: path,
        specifier: "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors-validation",
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
        else changed.responsibilities[index].consumer.exportName = "unreviewedGovernedActionParser";
        expect(validatePolicy(changed, [policy])).toContain("responsibility-shrank");
      }
    },
  );

  it.each([
    ["request", "validateJiraLiveSearchRequest", "parsePublicJiraLiveSearchRequest"],
    ["result", "validateJiraLiveSearchResult", "parsePublicJiraLiveSearchResult"],
  ])(
    "pins the additive Atlassian live-search %s parser and retains prior obligations",
    (kind, producer, consumer) => {
      const index = policy.responsibilities.findIndex(
        (record) => record.id === `jira-live-search-${kind}-public-parser`,
      );
      const record = policy.responsibilities[index];
      const path = "packages/keiko-contracts/src/atlassian-connectors-validation.test.ts";
      const selector = {
        consumerPath: path,
        specifier: "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors-validation",
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
        else changed.responsibilities[index].consumer.exportName = "unreviewedLiveParser";
        expect(validatePolicy(changed, [policy])).toContain("responsibility-shrank");
      }
    },
  );

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

describe("remaining Memory public parser obligations (#3918)", () => {
  it("pins all eleven public roots and exact proof selectors without activating scopes", () => {
    const records = policy.responsibilities.slice(32, 43);
    const unknownOnly = new Set(["memory-pin-public-parser", "memory-unpin-public-parser"]);
    expect(records).toHaveLength(11);
    for (const record of records) {
      expect(record.owner).toBe("@oscharko-dev/keiko-contracts");
      expect(record.kind).toBe("public-parser");
      expect(record.input.parameterIndex).toBe(0);
      expect(record.rules).toEqual(
        unknownOnly.has(record.id)
          ? ["anti-slop/no-unknown-parameters"]
          : ["anti-slop/no-unknown-parameters", "anti-slop/no-unsafe-dictionary-type"],
      );
      expect(record.consumer.kind).toBe("public-api-proof");
      expect(record.proofs).toEqual(["packages/keiko-contracts/src/memory.test.ts"]);
      expect(record.proofAssertions.slice(0, 3).map(({ testName }) => testName)).toEqual([
        "Memory remaining public parsers (#3918) preserves operation audit and retrieval identities and optional presence",
        "Memory remaining public parsers (#3918) refuses malformed Memory envelopes with exact owning diagnostics",
        "Memory remaining public parsers (#3918) retains branded domain result types acknowledgement and array admission",
      ]);
      const removed = structuredClone(policy);
      removed.responsibilities = removed.responsibilities.filter(({ id }) => id !== record.id);
      expect(validatePolicy(removed, [policy])).toContain("responsibility-shrank");
    }
  });
});

describe("documentation request public parser obligations (#3918)", () => {
  it("pins two exact unknown-parameter roots without optional rule grants", () => {
    const records = policy.responsibilities.slice(43, 45);
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.kind).toBe("public-parser");
      expect(record.owner).toBe("@oscharko-dev/keiko-contracts");
      expect(record.rules).toEqual(["anti-slop/no-unknown-parameters"]);
      expect(record.input.parameterIndex).toBe(0);
      expect(record.consumer.kind).toBe("public-api-proof");
      expect(record.proofs).toEqual([record.input.consumerPath]);
      const removed = structuredClone(policy);
      removed.responsibilities = removed.responsibilities.filter(({ id }) => id !== record.id);
      expect(validatePolicy(removed, [policy])).toContain("responsibility-shrank");
    }
  });
});

describe("governance public parser obligations (#3918)", () => {
  it("pins two exact public parameter-zero roots without optional grants", () => {
    const records = policy.responsibilities.slice(49, 51);
    expect(records).toHaveLength(2);
    expect(records.map(({ id }) => id)).toEqual([
      "governed-action-v1-public-parser",
      "code-task-execution-v1-public-parser",
    ]);
    expect(records.map(({ input }) => input.exportName)).toEqual([
      "validateGovernedActionV1",
      "validateCodeTaskExecutionV1",
    ]);
    for (const record of records) {
      expect(record.kind).toBe("public-parser");
      expect(record.owner).toBe("@oscharko-dev/keiko-contracts");
      expect(record.rules).toEqual(["anti-slop/no-unknown-parameters"]);
      expect(record.input.parameterIndex).toBe(0);
      expect(record.consumer.kind).toBe("public-api-proof");
      const removed = structuredClone(policy);
      removed.responsibilities = removed.responsibilities.filter(({ id }) => id !== record.id);
      expect(validatePolicy(removed, [policy])).toContain("responsibility-shrank");
    }
  });
});

describe("run control public parser obligations (#3918)", () => {
  it("pins three exact public parameter-zero roots without optional grants", () => {
    const records = policy.responsibilities.slice(51, 54);
    expect(records).toHaveLength(3);
    expect(records.map(({ id }) => id)).toEqual([
      "run-control-snapshot-public-parser",
      "runtime-governance-request-public-parser",
      "runtime-governance-outcome-public-parser",
    ]);
    expect(records.map(({ input }) => input.exportName)).toEqual([
      "validateRunControlSnapshotV1",
      "validateRuntimeGovernanceRequestV1",
      "validateRuntimeGovernanceOutcomeV1",
    ]);
    for (const record of records) {
      expect(record.kind).toBe("public-parser");
      expect(record.owner).toBe("@oscharko-dev/keiko-contracts");
      expect(record.rules).toEqual(["anti-slop/no-unknown-parameters"]);
      expect(record.input.parameterIndex).toBe(0);
      expect(record.consumer.kind).toBe("public-api-proof");
      expect(record.proofs).toEqual([record.input.consumerPath]);
      const removed = structuredClone(policy);
      removed.responsibilities = removed.responsibilities.filter(({ id }) => id !== record.id);
      expect(validatePolicy(removed, [policy])).toContain("responsibility-shrank");
    }
  });
});

describe("acceptance and auxiliary public parser obligations (#3918)", () => {
  it("pins five exact public parameter-zero roots without optional grants", () => {
    const records = policy.responsibilities.slice(54, 59);
    expect(records).toHaveLength(5);
    expect(records.map(({ input }) => input.exportName)).toEqual([
      "validateCodeTaskAcceptanceContribution",
      "validateCodeTaskQualificationFlowArtifact",
      "validateCodeTaskQualificationManifest",
      "validateAuxiliaryCapabilityRequestV1",
      "validateAuxiliaryCapabilityOutcomeV1",
    ]);
    for (const record of records) {
      expect(record.kind).toBe("public-parser");
      expect(record.owner).toBe("@oscharko-dev/keiko-contracts");
      expect(record.rules).toEqual(["anti-slop/no-unknown-parameters"]);
      expect(record.input.parameterIndex).toBe(0);
      expect(record.consumer.kind).toBe("public-api-proof");
      expect(record.proofs).toEqual([record.input.consumerPath]);
      const removed = structuredClone(policy);
      removed.responsibilities = removed.responsibilities.filter(({ id }) => id !== record.id);
      expect(validatePolicy(removed, [policy])).toContain("responsibility-shrank");
    }
  });
});

describe("typed task public recheck obligations (#3918)", () => {
  it("pins four selected parameters without changing activation or granting unrelated raw rules", () => {
    const records = policy.responsibilities.slice(59, 63);
    expect(records).toHaveLength(4);
    expect(records.map(({ input }) => [input.exportName, input.parameterIndex])).toEqual([
      ["isLegalTaskWorkspaceTransition", 0],
      ["isLegalTaskWorkspaceTransition", 1],
      ["nextLegalTaskWorkspaceStates", 0],
      ["isCleanupEligibleLifecycleState", 0],
    ]);
    for (const record of records) {
      expect(record.kind).toBe("typed-parameter-recheck");
      expect(record.rules).toEqual(["anti-slop/no-known-value-widening"]);
      expect(record.input).toEqual({
        ...record.transform,
        parameterIndex: record.input.parameterIndex,
      });
      expect(record.output).toEqual(record.transform);
      expect(record.consumer.kind).toBe("public-api-proof");
      const removed = structuredClone(policy);
      removed.responsibilities = removed.responsibilities.filter(({ id }) => id !== record.id);
      expect(validatePolicy(removed, [policy])).toContain("responsibility-shrank");
      for (const rules of [
        [],
        ["anti-slop/no-unknown-parameters"],
        [...record.rules, "anti-slop/no-runtime-typeof"],
      ]) {
        const changed = structuredClone(policy);
        changed.responsibilities.find(({ id }) => id === record.id).rules = rules;
        expect(validatePolicy(changed)).toContain("invalid-responsibilities");
      }
    }
  });
});

describe("canonical JSON decoder closed responsibility schema (#3918)", () => {
  it("retains the exact sole return rule and bounded real proof owners", () => {
    const record = policy.responsibilities.find(
      ({ id }) => id === "support-canonical-json-decoder-return",
    );
    expect(record.id).toBe("support-canonical-json-decoder-return");
    expect(record.kind).toBe("raw-canonical-json-decoder");
    expect(record.rules).toEqual(["anti-slop/no-unknown-returns"]);
    expect(record.input.parameterIndex).toBe(0);
    expect(record.transform.exportName).toBe("parseCanonicalSupportJson");
    expect(record.output.exportName).toBe("canonicalSupportJson");
    expect(record.proofs).toEqual([
      "packages/keiko-contracts/src/support-report-json.test.ts",
      "packages/keiko-activity-log/src/reader/support-report.test.ts",
      "packages/keiko-activity-log/src/reader/support-report-browser.test.ts",
    ]);
    expect(record.proofAssertions).toHaveLength(16);
    expect(validatePolicy(policy)).toEqual([]);
  });

  it.each(["wrong-rule", "extra-rule", "wrong-index", "no-proof", "proof-overflow"])(
    "refuses %s without widening an existing responsibility kind",
    (variant) => {
      const changed = structuredClone(policy);
      const record = changed.responsibilities.find(
        ({ id }) => id === "support-canonical-json-decoder-return",
      );
      if (variant === "wrong-rule") record.rules = ["anti-slop/no-unknown-parameters"];
      if (variant === "extra-rule") record.rules.push("anti-slop/no-runtime-typeof");
      if (variant === "wrong-index") record.input.parameterIndex = 1;
      if (variant === "no-proof") delete record.proofAssertions;
      if (variant === "proof-overflow")
        record.proofAssertions.push({
          path: record.proofs[0],
          testName: "extra canonical assertion",
        });
      expect(validatePolicy(changed)).toContain("invalid-responsibilities");
    },
  );
});

describe("manual document version public parser obligation (#3918)", () => {
  it("retains one existing parser boundary without optional rule grants", () => {
    const record = policy.responsibilities.find(
      ({ id }) => id === "editor-document-version-public-parser",
    );
    expect(record.kind).toBe("public-parser");
    expect(record.rules).toEqual(["anti-slop/no-unknown-parameters"]);
    expect(record.input).toEqual({
      consumerPath: "packages/keiko-contracts/src/editor-session.test.ts",
      specifier: "@oscharko-dev/keiko-contracts/runtime/editor-session",
      exportName: "parseEditorDocumentVersion",
      parameterIndex: 0,
    });
    expect(record.transform).toEqual(record.output);
    expect(record.consumer.exportName).toBe("parsePublicEditorDocumentVersion");
    expect(record.proofs).toEqual(["packages/keiko-contracts/src/editor-session.test.ts"]);
    expect(record.proofAssertions).toHaveLength(12);
    expect(validatePolicy(policy)).toEqual([]);
  });
});

describe("Git read public parser obligations (#3918)", () => {
  it.each([
    {
      id: "git-editor-diff-request-public-parser",
      producer: "parseGitEditorDiffRequest",
      witness: "parsePublicGitEditorDiffRequest",
      assertions: 6,
    },
    {
      id: "git-editor-diff-response-public-parser",
      producer: "parseGitEditorDiffResponse",
      witness: "parsePublicGitEditorDiffResponse",
      assertions: 16,
    },
    {
      id: "git-editor-blame-request-public-parser",
      producer: "parseGitEditorBlameRequest",
      witness: "parsePublicGitEditorBlameRequest",
      assertions: 6,
    },
    {
      id: "git-editor-blame-response-public-parser",
      producer: "parseGitEditorBlameResponse",
      witness: "parsePublicGitEditorBlameResponse",
      assertions: 8,
    },
  ])(
    "retains only the required unknown input of $producer",
    ({ id, producer, witness, assertions }) => {
      const record = policy.responsibilities.find((entry) => entry.id === id);
      expect(record.kind).toBe("public-parser");
      expect(record.rules).toEqual(["anti-slop/no-unknown-parameters"]);
      expect(record.input).toEqual({
        consumerPath: "packages/keiko-contracts/src/git-editor.test.ts",
        specifier: "@oscharko-dev/keiko-contracts/runtime/git-editor",
        exportName: producer,
        parameterIndex: 0,
      });
      expect(record.transform).toEqual(record.output);
      expect(record.consumer.exportName).toBe(witness);
      expect(record.proofs).toEqual(["packages/keiko-contracts/src/git-editor.test.ts"]);
      expect(record.proofAssertions).toHaveLength(assertions);
      expect(validatePolicy(policy)).toEqual([]);
    },
  );
});

describe("Command parser unknown input obligations (#3918)", () => {
  it.each([
    {
      id: "command-request-public-parser",
      producer: "parseCommandTaskRunRequest",
      witness: "parsePublicCommandRequest",
      assertions: 5,
    },
    {
      id: "command-catalog-public-parser",
      producer: "validateCommandTaskCatalog",
      witness: "parsePublicCommandCatalog",
      assertions: 6,
    },
    {
      id: "command-result-public-parser",
      producer: "validateCommandTaskRunResult",
      witness: "parsePublicCommandResult",
      assertions: 4,
    },
  ])(
    "retains declared raw input responsibility of $producer",
    ({ id, producer, witness, assertions }) => {
      const record = policy.responsibilities.find((entry) => entry.id === id);
      expect(record).toMatchObject({
        owner: "@oscharko-dev/keiko-contracts",
        kind: "public-parser",
        rules: ["anti-slop/no-unknown-parameters"],
        input: { exportName: producer, parameterIndex: 0 },
        consumer: { exportName: witness, kind: "public-api-proof" },
      });
      expect(record.proofs).toEqual(["packages/keiko-contracts/src/command-runner.test.ts"]);
      expect(record.proofAssertions).toHaveLength(assertions);
      expect(record.proofAssertions.every((proof) => proof.path === record.proofs[0])).toBe(true);
      expect(record.transform.exportName).toBe(producer);
      expect(record.output.exportName).toBe(producer);
    },
  );
});
