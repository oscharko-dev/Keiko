import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { executeCodeQualityPolicy } from "../check-code-quality-policy.mjs";
import { collectPolicySubject } from "../lib/code-quality-inventory.mjs";
import {
  assessPolicyResponsibilities,
  adaptResponsibilityDiagnostics,
} from "../lib/code-quality-responsibilities.mjs";
import { createSymbolResolver } from "../lib/code-quality-symbols.mjs";
import {
  createContextDiagnosticFixture,
  createCollectiveContextDiagnosticFixture,
  createCollectiveParserFixture,
  installResponsibilityFixtureTools,
  installSemanticFixtureBuild,
  embeddedSemanticOptions,
  createCollectiveSemanticFixture,
} from "./support/code-quality-responsibility-fixture.mjs";

const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function installSemanticFixtureTools(own) {
  roots.push(own.root);
  await installResponsibilityFixtureTools(own);
}

async function collectiveSemanticFixture(variant) {
  return createCollectiveSemanticFixture(variant, roots);
}

async function collectiveCapacityFixture() {
  const own = createCollectiveParserFixture("cardinality", ["anti-slop/no-runtime-typeof"]);
  roots.push(own.root);
  const subject = await collectPolicySubject(own.root);
  const resolver = createSymbolResolver(subject, {}, [
    { owner: "packages/alpha", paths: [own.records[0].consumer.consumerPath] },
  ]);
  try {
    const legacy = own.records.map((record) => {
      const identity = resolver.resolveProofExport(record.input).identities[0];
      return resolver
        .rawCheckingSlots(identity, 0)
        .filter((slot) => record.rules.includes(slot.rule));
    });
    return { own, subject, legacy };
  } finally {
    resolver.close();
  }
}

function expectWithheldCapacity(assessment) {
  expect(assessment.helperClosures).toEqual(
    ["anti-slop/no-runtime-typeof", "anti-slop/no-unknown-parameters"].map((rule) => ({
      status: "withheld",
      reason: "collective-helper-budget-exhausted",
      owner: "alpha",
      sourcePath: "packages/alpha/src/owner.ts",
      rule,
      rootCount: 2,
      limit: 64,
      observedCount: 65,
    })),
  );
}

async function interceptCollectiveAttempt(intercept, operation = "collectiveRawCheckingSlots") {
  const symbols = await import("../lib/code-quality-symbols.mjs");
  const original = symbols.createSymbolResolver;
  vi.spyOn(symbols, "createSymbolResolver").mockImplementation((...args) => {
    const resolver = original(...args);
    const collect = resolver[operation];
    resolver[operation] = (...call) => intercept(collect, call);
    return resolver;
  });
}

describe("collective capacity partial applicability (#3918)", () => {
  it("retains independent roots and every legacy slot when the finite group exceeds 64", async () => {
    const { own, subject, legacy } = await collectiveCapacityFixture();
    expect(legacy.every((slots) => slots.length > 32)).toBe(true);
    const report = assessPolicyResponsibilities(subject, own.policy);
    expect(report.counts).toMatchObject({ ready: 2, pending: 2, qualified: 0 });
    expect(report.assessments.map((record) => record.slots)).toEqual(legacy);
    for (const assessment of report.assessments) {
      expect(assessment.reasons).toEqual([]);
      expect(assessment.obligations).toEqual([
        "runtime-proof-not-evaluated",
        "consumer-proof-not-evaluated",
      ]);
      expectWithheldCapacity(assessment);
      expect(
        assessment.slots.every((slot) => !Object.hasOwn(slot, "contributingResponsibilityIds")),
      ).toBe(true);
    }
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  }, 60_000);

  it("keeps real helper and downstream native violations active with deterministic omissions", async () => {
    const { own } = await collectiveCapacityFixture();
    const report = await executeCodeQualityPolicy(
      { mode: "enforce", scope: "repository", json: true },
      own.root,
    );
    const source = readFileSync(join(own.root, "packages/alpha/src/owner.ts"), "utf8");
    const downstream =
      source.split("\n").findIndex((line) => line.includes("function downstream")) + 1;
    expect(report.violations).toContainEqual(
      expect.objectContaining({ rule: "anti-slop/no-unknown-parameters", line: downstream }),
    );
    expect(report.violations).toContainEqual(
      expect.objectContaining({ rule: "anti-slop/no-runtime-typeof", line: downstream }),
    );
    expect(report.enforcementOutcome).toBe("failed");
    for (const assessment of report.responsibilities.assessments)
      expectWithheldCapacity(assessment);
    own.policy.responsibilities.reverse();
    own.put("scripts/code-quality-policy.json", own.policy);
    const reversed = await executeCodeQualityPolicy(
      { mode: "enforce", scope: "repository", json: true },
      own.root,
    );
    expect(reversed.violations).toEqual(report.violations);
    expect(reversed.adaptations).toEqual(report.adaptations);
    const byId = (records) =>
      Object.fromEntries(records.map((record) => [record.id, record.helperClosures]));
    expect(byId(reversed.responsibilities.assessments)).toEqual(
      byId(report.responsibilities.assessments),
    );
  }, 90_000);

  it.each([new TypeError("symbol-alias-budget"), new Error("unexpected collector failure")])(
    "propagates an untagged collective exception rather than matching its message",
    async (error) => {
      const own = createCollectiveParserFixture();
      roots.push(own.root);
      const subject = await collectPolicySubject(own.root);
      await interceptCollectiveAttempt(() => {
        throw error;
      });
      expect(() => assessPolicyResponsibilities(subject, own.policy)).toThrow(error);
    },
    30_000,
  );

  it("rechecks actual source currentness after an owned capacity refusal", async () => {
    const { own, subject } = await collectiveCapacityFixture();
    await interceptCollectiveAttempt((collect, args) => {
      try {
        return collect(...args);
      } catch (error) {
        const path = join(own.root, "packages/alpha/src/owner.ts");
        writeFileSync(path, readFileSync(path, "utf8") + "\n");
        throw error;
      }
    });
    expect(() => assessPolicyResponsibilities(subject, own.policy)).toThrow(
      "symbol-subject-changed",
    );
  }, 60_000);

  it("does not add optional omission metadata to unaffected existing records", async () => {
    const own = createCollectiveParserFixture();
    roots.push(own.root);
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(report.counts.ready).toBe(2);
    expect(report.assessments.every((record) => !Object.hasOwn(record, "helperClosures"))).toBe(
      true,
    );
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "preserves omission diagnostics through actual semantic completion without clearing violations",
    async () => {
      const own = await collectiveSemanticFixture("cardinality");
      roots.push(own.root);
      const report = await executeCodeQualityPolicy(embeddedSemanticOptions(), own.root);
      expect(report.responsibilities.counts).toMatchObject({ ready: 2, qualified: 2, pending: 0 });
      for (const assessment of report.responsibilities.assessments) {
        expect(assessment.reasons).toEqual([]);
        expect(assessment.obligations).toEqual([]);
        expect(assessment.proofs.every((proof) => proof.executed)).toBe(true);
        expect(assessment.helperClosures).toHaveLength(3);
        expect(
          assessment.helperClosures.every(
            (closure) =>
              closure.reason === "collective-helper-budget-exhausted" && closure.limit === 64,
          ),
        ).toBe(true);
      }
      expect(report.enforcementOutcome).toBe("failed");
      expect(report.violations.length).toBeGreaterThan(0);
      const roundTrip = JSON.parse(JSON.stringify(report));
      expect(roundTrip.responsibilities).toEqual(report.responsibilities);
    },
    195_000,
  );
});

describe("closed context diagnostic responsibility capability (#3918)", () => {
  it("keeps envelope root semantics pending without changing the existing diagnostic kind", async () => {
    const own = createContextDiagnosticFixture();
    roots.push(own.root);
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(report.counts).toMatchObject({ ready: 1, pending: 1, qualified: 0 });
    const [record] = report.assessments;
    expect(record.kind).toBe("diagnostic-checker");
    expect(record.reasons).toEqual([]);
    expect(record.proofs.every((proof) => !proof.executed)).toBe(true);
    expect(record.slots).toContainEqual(
      expect.objectContaining({
        rule: "anti-slop/no-unknown-parameters",
        index: 0,
      }),
    );
    expect(Object.hasOwn(record, "helperClosures")).toBe(false);
  }, 30_000);

  it("collectively owns only direct private string-array diagnostic collectors", async () => {
    const own = createCollectiveContextDiagnosticFixture();
    roots.push(own.root);
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(report.counts).toMatchObject({ ready: 2, pending: 2, qualified: 0 });
    const source = readFileSync(join(own.root, "packages/alpha/src/owner.ts"), "utf8");
    const start = source.indexOf("input: unknown", source.indexOf("function diagnosticIssues")) + 7;
    expect(report.assessments.flatMap((record) => record.slots)).toContainEqual(
      expect.objectContaining({
        start,
        contributingResponsibilityIds: ["fixture-first", "fixture-second"],
      }),
    );
    expect(report.assessments.every((record) => !Object.hasOwn(record, "helperClosures"))).toBe(
      true,
    );
  }, 30_000);

  it("preserves the published whole-group budget withholding for diagnostic envelopes", async () => {
    const own = createCollectiveContextDiagnosticFixture("cardinality");
    roots.push(own.root);
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(report.counts).toMatchObject({ ready: 2, pending: 2, qualified: 0 });
    for (const record of report.assessments) {
      expectWithheldCapacity(record);
      expect(record.reasons).toEqual([]);
      expect(
        record.slots.every((slot) => !Object.hasOwn(slot, "contributingResponsibilityIds")),
      ).toBe(true);
    }
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  }, 60_000);
});

async function contextEnvelopeSemanticFixture(variant = "direct") {
  const own = createContextDiagnosticFixture(variant);
  await installSemanticFixtureTools(own);
  const config = JSON.parse(readFileSync(join(own.root, "packages/alpha/tsconfig.json"), "utf8"));
  config.compilerOptions.lib.push("DOM");
  own.put("packages/alpha/tsconfig.json", config);
  const path = own.record.proofs[0];
  own.put(
    path,
    readFileSync(join(own.root, path), "utf8") +
      `
import { it, expect } from "vitest";
it("context diagnostics healthy", () => { expect(countDiagnostics(3)).toBe(0); });
it("context diagnostics malformed", () => { expect(countDiagnostics("wrong")).toBe(1); });
`,
  );
  await installSemanticFixtureBuild(own, ["-b", "packages/alpha/tsconfig.json", "--force"]);
  return own;
}

describe("closed context diagnostic actual proof capability (#3918)", () => {
  it.skipIf(process.platform === "win32")(
    "executes the actual public diagnostic count before root qualification",
    async () => {
      const own = await contextEnvelopeSemanticFixture();
      roots.push(own.root);
      const report = await executeCodeQualityPolicy(embeddedSemanticOptions(), own.root);
      expect(report.responsibilities.counts).toMatchObject({ ready: 1, qualified: 1, pending: 0 });
      const [record] = report.responsibilities.assessments;
      expect(record.kind).toBe("diagnostic-checker");
      expect(record.reasons).toEqual([]);
      expect(record.obligations).toEqual([]);
      expect(record.proofAssertions.every((assertion) => assertion.status === "passed")).toBe(true);
      expect(record.proofs.every((proof) => proof.executed)).toBe(true);
    },
    195_000,
  );
});

it.skipIf(process.platform === "win32")(
  "rejects a same-type public diagnostic body through its actual malformed count proof (#3918)",
  async () => {
    const own = await contextEnvelopeSemanticFixture("unsafe-body");
    roots.push(own.root);
    const before = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(before.counts).toMatchObject({ ready: 1, qualified: 0 });
    await expect(executeCodeQualityPolicy(embeddedSemanticOptions(), own.root)).rejects.toThrow(
      "semantic-proof-execution-failed",
    );
  },
  195_000,
);

// Constructed reports exercise refusal/dispatch only, never actual semantic qualification.
function numericObjectComponentReport() {
  const ids = ["first", "second", "third"];
  const componentRoots = ids.map((recordId, index) => ({
    recordId,
    origin: index < 2 ? "container" : "answers",
    index: 0,
    identity: {
      owner: "alpha",
      producer: {
        path: "owner.ts",
        start: 100 + index,
        end: 200 + index,
        kind: "FunctionDeclaration",
      },
    },
    proofAssertions: [{ path: "proof.test.ts", testName: "reached " + recordId }],
  }));
  const slot = {
    path: "owner.ts",
    rule: "anti-slop/no-object-parameters",
    line: 2,
    column: 1,
    index: 1,
    objectForm: "json-utf8-byte-measurement",
    contributingResponsibilityIds: ["first", "second"],
    componentRoots,
    producerIdentity: {
      owner: "alpha",
      producer: { path: "owner.ts", start: 10, end: 20, kind: "FunctionDeclaration" },
    },
  };
  const assessments = componentRoots.map((root, index) => ({
    id: root.recordId,
    owner: "alpha",
    kind: "public-parser",
    rules: [slot.rule],
    structural: "ready",
    semantic: "qualified",
    roles: { input: { identities: [root.identity] } },
    consumerBinding: { bound: true, status: "ready" },
    proofs: [{ path: "proof.test.ts", executed: true }],
    proofAssertions: root.proofAssertions.map((entry) => ({ ...entry, status: "passed" })),
    slots: index === 0 ? [slot] : [],
  }));
  return { slot, assessments };
}

function incompleteNumericObjectComponent(variant, slot, assessments) {
  if (variant === "missing-root") assessments.pop();
  if (variant === "duplicate-root") assessments.push(structuredClone(assessments[2]));
  if (variant === "foreign-identity") slot.componentRoots[2].identity.owner = "foreign";
  if (variant === "same-canonical-root")
    slot.componentRoots[2].identity = assessments[2].roles.input.identities[0] =
      slot.componentRoots[0].identity;
  if (variant === "empty-component") slot.componentRoots = [];
  if (variant === "empty-contributors") slot.contributingResponsibilityIds = [];
  if (variant === "duplicate-contributors") slot.contributingResponsibilityIds = ["first", "first"];
  if (variant === "foreign-contributor") slot.contributingResponsibilityIds = ["first", "foreign"];
}

function incompleteNumericObjectProof(variant, slot, assessments) {
  if (variant === "empty-proof-path") {
    slot.componentRoots[2].proofAssertions[0].path = "";
    assessments[2].proofAssertions[0].path = "";
    assessments[2].proofs[0].path = "";
  }
  if (variant === "pending" || variant === "rejected") assessments[2].semantic = variant;
  if (variant === "missing-proof") assessments[2].proofAssertions = [];
  if (variant === "failed-proof") assessments[2].proofAssertions[0].status = "failed";
  if (variant === "unexecuted-path") assessments[2].proofs[0].executed = false;
  if (variant === "untagged") delete slot.objectForm;
  if (variant === "foreign-kind") assessments[0].kind = "validator";
  if (variant === "noncontributor-attribution") {
    assessments[0].slots = [];
    assessments[2].slots = [slot];
  }
}

describe("numeric object component semantic seam (#3918)", () => {
  it.each([
    "missing-root",
    "pending",
    "rejected",
    "duplicate-root",
    "foreign-identity",
    "same-canonical-root",
    "empty-component",
    "empty-contributors",
    "duplicate-contributors",
    "foreign-contributor",
    "missing-proof",
    "empty-proof-path",
    "failed-proof",
    "unexecuted-path",
    "untagged",
    "foreign-kind",
    "noncontributor-attribution",
  ])("refuses %s in collective dispatch and its generic fallback", async (variant) => {
    const { adaptResponsibilityDiagnostics } =
      await import("../lib/code-quality-responsibilities.mjs");
    const { slot, assessments } = numericObjectComponentReport();
    incompleteNumericObjectComponent(variant, slot, assessments);
    incompleteNumericObjectProof(variant, slot, assessments);
    const finding = { path: slot.path, rule: slot.rule, line: slot.line, column: slot.column };
    expect(
      adaptResponsibilityDiagnostics({ violations: [finding] }, { assessments }).violations,
    ).toEqual([finding]);
  });

  it("adapts exactly the complete qualified component and preserves old observation semantics", async () => {
    const { adaptResponsibilityDiagnostics } =
      await import("../lib/code-quality-responsibilities.mjs");
    const { slot, assessments } = numericObjectComponentReport();
    const finding = { path: slot.path, rule: slot.rule, line: slot.line, column: slot.column };
    expect(
      adaptResponsibilityDiagnostics({ violations: [finding] }, { assessments }).adaptations,
    ).toHaveLength(1);
    const observation = {
      id: "observation",
      kind: "raw-property-observation",
      structural: "ready",
      semantic: "qualified",
      slots: [finding],
    };
    expect(
      adaptResponsibilityDiagnostics({ violations: [finding] }, { assessments: [observation] })
        .adaptations,
    ).toHaveLength(1);
    observation.semantic = "pending";
    expect(
      adaptResponsibilityDiagnostics({ violations: [finding] }, { assessments: [observation] })
        .violations,
    ).toEqual([finding]);
  });
});

describe("numeric object unsupported form reporting (#3918)", () => {
  it("retains old slots and reports deterministic closed omissions separately from capacity", async () => {
    const own = createCollectiveParserFixture();
    roots.push(own.root);
    const subject = await collectPolicySubject(own.root);
    const before = assessPolicyResponsibilities(subject, own.policy);
    for (const record of own.records) record.rules.push("anti-slop/no-object-parameters");
    const report = assessPolicyResponsibilities(subject, own.policy);
    expect(report.assessments.map((record) => record.slots)).toEqual(
      before.assessments.map((record) => record.slots),
    );
    // A constructed object coordinate remains active after the real unsupported assessment.
    const finding = {
      path: report.assessments[0].roles.input.identities[0].producer.path,
      rule: "anti-slop/no-object-parameters",
      line: 1,
      column: 1,
    };
    expect(adaptResponsibilityDiagnostics({ violations: [finding] }, report)).toMatchObject({
      adaptations: [],
      violations: [finding],
    });
    for (const record of report.assessments) {
      expect(record.objectForms).toEqual([
        {
          form: "json-utf8-byte-measurement",
          status: "withheld",
          reason: "unsupported-json-byte-form",
          owner: "alpha",
          sourcePath: "packages/alpha/src/owner.ts",
          rule: "anti-slop/no-object-parameters",
          requestedResponsibilityIds: ["fixture-first", "fixture-second"],
        },
      ]);
      expect(record.reasons).toEqual([]);
      expect(record.obligations).toEqual(before.assessments[0].obligations);
      expect(Object.hasOwn(record, "helperClosures")).toBe(false);
    }
    own.policy.responsibilities.reverse();
    const reversed = assessPolicyResponsibilities(subject, own.policy);
    expect(reversed.assessments.map((record) => record.objectForms)).toEqual(
      report.assessments.map((record) => record.objectForms),
    );
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(before.assessments.every((record) => !Object.hasOwn(record, "objectForms"))).toBe(true);
  }, 30_000);

  it("withholds a single opted-in root and propagates currentness and unexpected failures", async () => {
    const own = createCollectiveParserFixture();
    roots.push(own.root);
    own.policy.responsibilities = [own.records[0]];
    own.records[0].rules.push("anti-slop/no-object-parameters");
    const subject = await collectPolicySubject(own.root);
    const report = assessPolicyResponsibilities(subject, own.policy);
    expect(report.assessments[0].objectForms[0].requestedResponsibilityIds).toEqual([
      "fixture-first",
    ]);
    await interceptCollectiveAttempt((_collect, [numericRoots]) => {
      expect(numericRoots).toHaveLength(1);
      expect(numericRoots[0].recordId).toBe("fixture-first");
      throw new TypeError("unexpected-numeric-form-failure");
    }, "collectiveJsonByteMeasurement");
    expect(() => assessPolicyResponsibilities(subject, own.policy)).toThrow(
      "unexpected-numeric-form-failure",
    );
    vi.restoreAllMocks();
    await interceptCollectiveAttempt((collect, args) => {
      const result = collect(...args);
      const path = join(own.root, "packages/alpha/src/owner.ts");
      writeFileSync(path, readFileSync(path, "utf8") + "\n");
      return result;
    }, "collectiveJsonByteMeasurement");
    expect(() => assessPolicyResponsibilities(subject, own.policy)).toThrow(
      "symbol-subject-changed",
    );
  }, 30_000);
});
