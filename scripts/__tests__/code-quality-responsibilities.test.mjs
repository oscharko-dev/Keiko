import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { URL } from "node:url";
import { codeQualityPolicyMain, executeCodeQualityPolicy } from "../check-code-quality-policy.mjs";
import { collectPolicySubject } from "../lib/code-quality-inventory.mjs";
import { validatePolicy } from "../lib/code-quality-policy.mjs";
import { assessPolicyResponsibilities } from "../lib/code-quality-responsibilities.mjs";
import { emitSymbolFixture } from "./support/code-quality-symbol-fixture.mjs";
import { createSymbolResolver } from "../lib/code-quality-symbols.mjs";
import { deepRedactStrings, createAuditRedactor } from "@oscharko-dev/keiko-security/redaction";
import { validateRelationship } from "@oscharko-dev/keiko-contracts/runtime/relationships-validation";
import {
  responsibilityPolicy,
  responsibilityRecord,
  createResponsibilityFixture,
  executeResponsibilityFixture,
  createEnforcementFixture,
  createCrossOwnerEnforcementFixture,
  replaceEnforcementOwner,
  replaceConsumerCallFixture,
  createRawHelperEnforcementFixture,
} from "./support/code-quality-responsibility-fixture.mjs";

function executeCensusChild(root, ci) {
  const entry = new URL("../check-code-quality-policy.mjs", import.meta.url).href;
  const source = `import { codeQualityPolicyMain } from ${JSON.stringify(entry)};
    process.exitCode = await codeQualityPolicyMain(["--mode", "census"], ${JSON.stringify(root)});`;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    env: { ...process.env, CI: ci },
    encoding: "utf8",
    timeout: 45_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
}

const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("v2 static enforcement keeps combined semantic qualification pending (#3918)", () => {
  it("adapts exact raw helper and informative predicate recheck sites without semantic trust", async () => {
    const own = createRawHelperEnforcementFixture();
    roots.push(own.root);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exit = await codeQualityPolicyMain(["--json"], own.root);
    const report = JSON.parse(log.mock.calls[0][0]);
    for (const rule of [
      "anti-slop/no-unknown-parameters",
      "anti-slop/no-runtime-typeof",
      "anti-slop/no-known-value-widening",
    ]) {
      const findings = report.census.filter((finding) => finding.rule === rule);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((finding) => finding.path === "packages/alpha/src/owner.ts")).toBe(
        true,
      );
    }
    expect(
      report.enforcementOutcome,
      JSON.stringify({
        scope: report.scope,
        counts: report.counts,
        census: report.census,
        adaptations: report.adaptations,
        violations: report.violations,
      }),
    ).toBe("passed");
    expect(report.violations).toEqual([]);
    expect(report.adaptations.map(({ finding }) => finding)).toEqual(report.census);
    expect(report.outcome).toBe("failed");
    expect(report.responsibilities.counts.qualified).toBe(0);
    expect(report.responsibilities.counts.pending).toBe(1);
    expect(report.responsibilities.assessments[0].proofs[0].executed).toBe(false);
    expect(exit).toBe(0);
  }, 60_000);

  it.each(["wrapper", "unicode-wrapper", "aliases", "property", "nonzero", "unicode"])(
    "adapts the complete native raw checking census for %s without runtime qualification",
    async (variant) => {
      const own = createRawHelperEnforcementFixture(variant);
      roots.push(own.root);
      const report = await executeCodeQualityPolicy(
        { scope: "repository", mode: "enforce" },
        own.root,
      );
      expect(
        report.enforcementOutcome,
        JSON.stringify({
          census: report.census,
          adaptations: report.adaptations,
          violations: report.violations,
          assessments: report.responsibilities.assessments,
        }),
      ).toBe("passed");
      expect(report.violations).toEqual([]);
      expect(report.adaptations.map(({ finding }) => finding)).toEqual(report.census);
      expect(report.responsibilities.counts.qualified).toBe(0);
      expect(report.responsibilities.counts.pending).toBe(1);
      expect(report.outcome).toBe("failed");
      if (["wrapper", "unicode-wrapper"].includes(variant)) {
        expect(
          report.census.filter(({ rule }) => rule === "anti-slop/no-unknown-parameters"),
        ).toHaveLength(2);
        expect(
          report.adaptations.some(({ slot }) => slot.kind === "parameter" && slot.line === 3),
        ).toBe(true);
      }
    },
    60_000,
  );

  it.each([
    "export",
    "export-alias",
    "trusted",
    "exported-trusted",
    "returned",
    "callback",
    "mutable-callee",
    "destructured-callee",
    "computed-callee",
    "nested-unused",
    "deferred-class",
    "asserted-origin",
    "nonnull-origin",
    "satisfies-origin",
    "erased-origin",
    "parameter-write",
    "helper-write",
    "mutable-origin",
    "reassigned-origin",
    "destructured-origin",
    "self-cycle",
    "mutual-cycle",
  ])(
    "keeps real helper diagnostics enforced for unsupported %s provenance",
    async (variant) => {
      const own = createRawHelperEnforcementFixture(variant);
      roots.push(own.root);
      const report = await executeCodeQualityPolicy(
        { scope: "repository", mode: "enforce" },
        own.root,
      );
      const nativeTypeof = report.census.filter(
        ({ rule }) => rule === "anti-slop/no-runtime-typeof",
      );
      expect(nativeTypeof).toHaveLength(1);
      expect(report.violations).toEqual(expect.arrayContaining(nativeTypeof));
      expect(report.enforcementOutcome).toBe("failed");
      expect(report.responsibilities.counts.qualified).toBe(0);
      expect(report.adaptations.some(({ finding }) => nativeTypeof.includes(finding))).toBe(false);
      if (variant.endsWith("cycle")) {
        expect(report.adaptations).toEqual([]);
        expect(report.responsibilities.assessments[0].structural).toBe("incomplete");
      }
    },
    60_000,
  );

  it.each(["extra-slot", "other-api", "literal-erasure", "unrelated-typeof", "partially-narrowed"])(
    "does not borrow checking slots for %s native diagnostics",
    async (variant) => {
      const own = createRawHelperEnforcementFixture(variant);
      roots.push(own.root);
      const report = await executeCodeQualityPolicy(
        { scope: "repository", mode: "enforce" },
        own.root,
      );
      expect(report.census.length).toBeGreaterThan(3);
      expect(report.enforcementOutcome).toBe("failed");
      expect(report.violations.length).toBeGreaterThan(0);
      expect(report.responsibilities.counts.qualified).toBe(0);
      expect(report.responsibilities.counts.ready).toBe(1);
      expect(report.adaptations).toHaveLength(3);
      expect(
        report.violations.every(
          (finding) => !report.adaptations.some((adapted) => adapted.finding === finding),
        ),
      ).toBe(true);
    },
    60_000,
  );

  it("does not let a Unicode byte-column collision borrow the selected raw parameter's slot", async () => {
    const own = createRawHelperEnforcementFixture("unicode-extra-slot");
    roots.push(own.root);
    const report = await executeCodeQualityPolicy(
      { scope: "repository", mode: "enforce" },
      own.root,
    );
    const unknowns = report.census.filter(({ rule }) => rule === "anti-slop/no-unknown-parameters");
    expect(unknowns).toHaveLength(2);
    const source = readFileSync(join(own.root, "packages/alpha/src/owner.ts"), "utf8");
    const line = source.split("\n").find((value) => value.startsWith("export function validate"));
    const selectedUtf16Column = line.indexOf("input: unknown") + "input: ".length + 1;
    expect(unknowns[0].column).toBe(selectedUtf16Column);
    expect(unknowns[1].column).toBeGreaterThan(selectedUtf16Column);
    expect(report.adaptations.map(({ finding }) => finding)).toContainEqual(unknowns[1]);
    expect(report.violations).toEqual([unknowns[0]]);
    expect(report.enforcementOutcome).toBe("failed");
    expect(report.responsibilities.counts.qualified).toBe(0);
  }, 60_000);

  it("matches the native Unicode truthful structural-redactor return annotation without altering compiler offsets", async () => {
    const own = createEnforcementFixture("structural-redactor");
    roots.push(own.root);
    own.put(
      "packages/alpha/src/owner.ts",
      [
        "export function validate(είσοδος: unknown): unknown { return είσοδος; }",
        'export function consume(input: number): number { const result = validate(input); if (typeof result !== "number") throw new TypeError("invalid"); return result; }',
        "",
      ].join("\n"),
    );
    emitSymbolFixture(own.root);
    const report = await executeCodeQualityPolicy(
      { scope: "repository", mode: "enforce" },
      own.root,
    );
    const nativeReturn = report.census.filter(
      ({ rule }) => rule === "anti-slop/no-unknown-returns",
    );
    expect(nativeReturn).toHaveLength(1);
    const adaptation = report.adaptations.find(
      ({ finding }) => finding.rule === nativeReturn[0].rule,
    );
    expect(adaptation.finding).toEqual(nativeReturn[0]);
    const source = readFileSync(join(own.root, "packages/alpha/src/owner.ts"), "utf8");
    expect(source.slice(adaptation.slot.start, adaptation.slot.end)).toBe("unknown");
    expect(report.enforcementOutcome).toBe("passed");
    expect(report.violations).toEqual([]);
    expect(report.adaptations).toHaveLength(2);
    expect(report.responsibilities.counts.qualified).toBe(0);
    expect(report.responsibilities.assessments[0].proofs[0].executed).toBe(false);
  }, 60_000);

  it.each(["validator", "structural-redactor"])(
    "adapts only the canonical raw slots of a healthy %s and discloses both verdicts",
    async (kind) => {
      const own = createEnforcementFixture(kind);
      roots.push(own.root);
      const report = await executeCodeQualityPolicy(
        { scope: "repository", mode: "enforce" },
        own.root,
      );
      expect(report.outcome).toBe("failed");
      expect(report.enforcementOutcome).toBe("passed");
      expect(report.responsibilities.counts.qualified).toBe(0);
      expect(report.responsibilities.counts.pending).toBe(1);
      expect(report.responsibilities.assessments[0].proofs[0].executed).toBe(false);
      expect(report.responsibilities.counts.ready).toBe(1);
      expect(report.violations).toEqual([]);
      expect(report.census.some((finding) => own.record.rules.includes(finding.rule))).toBe(true);
      expect(report.adaptations).toHaveLength(kind === "validator" ? 1 : 2);
      expect(report.adaptations[0]).toMatchObject({
        responsibilityId: own.record.id,
        slot: { kind: "parameter", index: 0 },
      });
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(await codeQualityPolicyMain([], own.root)).toBe(0);
      expect(log.mock.calls[0][0]).toContain("enforcement=PASSED; combined=FAILED");
    },
    60_000,
  );

  it.each(["unchecked", "foreign", "missing-consumer", "missing-proof", "unassigned"])(
    "fails enforcement for %s obligations without borrowing a raw-slot adaptation",
    async (variant) => {
      const own = createEnforcementFixture("validator", variant);
      roots.push(own.root);
      if (variant === "foreign") own.record.owner = "beta";
      if (variant === "missing-consumer") own.record.consumer.exportName = "missing";
      if (variant === "missing-proof") own.record.proofs = ["packages/alpha/src/absent.test.ts"];
      if (variant === "unassigned") own.policy.responsibilities = [];
      own.put("scripts/code-quality-policy.json", own.policy);
      const report = await executeCodeQualityPolicy(
        { scope: "repository", mode: "enforce" },
        own.root,
      );
      expect(report.enforcementOutcome).toBe("failed");
      expect(report.adaptations).toEqual([]);
      expect(report.violations.length).toBeGreaterThan(0);
      if (variant !== "unassigned") {
        expect(report.responsibilities.counts.ready).toBe(0);
        expect(report.responsibilities.assessments[0].reasons.length).toBeGreaterThan(0);
      }
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(await codeQualityPolicyMain([], own.root)).toBe(1);
    },
    60_000,
  );

  it("rejects an open dictionary union through the actual CLI without borrowing a raw slot", async () => {
    const own = createEnforcementFixture();
    roots.push(own.root);
    replaceEnforcementOwner(own, "union-dictionary");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await codeQualityPolicyMain([], own.root)).toBe(1);
    expect(log.mock.calls[0][0]).toContain("enforcement=FAILED; combined=FAILED");
    const report = await executeCodeQualityPolicy(
      { scope: "repository", mode: "enforce" },
      own.root,
    );
    expect(report.responsibilities.counts.qualified).toBe(0);
    expect(report.responsibilities.counts.pending).toBe(0);
    expect(report.responsibilities.assessments[0].semantic).toBe("rejected");
    expect(report.responsibilities.counts.ready).toBe(0);
    expect(report.responsibilities.assessments[0].reasons).toContain(
      "unchecked-validator-dictionary",
    );
    expect(report.adaptations).toEqual([]);
    expect(report.violations.length).toBeGreaterThan(0);
  }, 60_000);

  it("accepts a genuinely imported built cross-owner consumer without qualifying semantics", async () => {
    const own = createCrossOwnerEnforcementFixture();
    roots.push(own.root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exit = await codeQualityPolicyMain([], own.root);
    const report = await executeCodeQualityPolicy(
      { scope: "repository", mode: "enforce" },
      own.root,
    );
    expect(report.responsibilities.assessments[0].reasons).toEqual([]);
    expect(exit).toBe(0);
    expect(report.enforcementOutcome).toBe("passed");
    expect(report.outcome).toBe("failed");
    expect(report.responsibilities.counts.ready).toBe(1);
    expect(report.responsibilities.counts.pending).toBe(1);
    expect(report.responsibilities.counts.qualified).toBe(0);
    expect(report.responsibilities.assessments[0].roles.consumer.identities[0].owner).toBe("beta");
    expect(report.responsibilities.assessments[0].proofs[0].executed).toBe(false);
  }, 60_000);

  it("rejects a declared consumer that never calls the producer, despite a real decoy call", async () => {
    const own = createCrossOwnerEnforcementFixture();
    roots.push(own.root);
    own.put(
      "packages/beta/src/owner.ts",
      'import { validate } from "alpha/runtime"; export function decoy(input: number): number { const result = validate(input); if (!result.ok) throw new TypeError("invalid"); return result.value; } export function consume(input: number): number { return input; }',
    );
    emitSymbolFixture(own.root, "packages/beta");
    const report = await executeCodeQualityPolicy(
      { scope: "repository", mode: "enforce" },
      own.root,
    );
    expect(report.enforcementOutcome).toBe("failed");
    expect(report.responsibilities.assessments[0].reasons).toContain(
      "unbound-responsibility-consumer",
    );
    expect(report.adaptations).toEqual([]);
    expect(report.violations.length).toBeGreaterThan(0);
    expect(report.responsibilities.counts.qualified).toBe(0);
  }, 60_000);

  it.each(["alias", "callback", "namespace", "reexport", "arrow", "expression"])(
    "binds the actual %s consumer implementation without semantic trust",
    async (variant) => {
      const own = createCrossOwnerEnforcementFixture();
      roots.push(own.root);
      replaceConsumerCallFixture(own, variant);
      const report = await executeCodeQualityPolicy(
        { scope: "repository", mode: "enforce" },
        own.root,
      );
      const assessment = report.responsibilities.assessments[0];
      expect(report.enforcementOutcome).toBe("passed");
      expect(assessment.consumerBinding.bound).toBe(true);
      expect(assessment.consumerBinding.calls).toHaveLength(1);
      expect(assessment.consumerBinding.implementation.owner).toBe("beta");
      expect(assessment.consumerBinding.implementation.producer.kind).toBe(
        ["arrow", "expression"].includes(variant) ? "VariableDeclaration" : "FunctionDeclaration",
      );
      expect(assessment.proofs[0].executed).toBe(false);
      expect(report.responsibilities.counts.qualified).toBe(0);
      expect(report.responsibilities.counts.pending).toBe(1);
      expect(report.outcome).toBe("failed");
      if (variant !== "reexport")
        expect(assessment.roles.consumer.identities[0].producer.kind).toBe("VariableDeclaration");
    },
    60_000,
  );

  it.each(["fake", "mutable", "destructured", "computed", "unused", "nested", "dispatch", "class"])(
    "keeps %s consumer indirection unbound and the raw slot enforced",
    async (variant) => {
      const own = createCrossOwnerEnforcementFixture();
      roots.push(own.root);
      replaceConsumerCallFixture(own, variant);
      const report = await executeCodeQualityPolicy(
        { scope: "repository", mode: "enforce" },
        own.root,
      );
      expect(report.enforcementOutcome).toBe("failed");
      expect(report.responsibilities.assessments[0].reasons).toContain(
        "unbound-responsibility-consumer",
      );
      expect(report.adaptations).toEqual([]);
      expect(report.violations.length).toBeGreaterThan(0);
      expect(report.responsibilities.counts.qualified).toBe(0);
    },
    60_000,
  );

  it.each(["foreign", "mutable-consumer"])(
    "refuses an unsupported %s consumer implementation",
    async (variant) => {
      const own = createCrossOwnerEnforcementFixture();
      roots.push(own.root);
      replaceConsumerCallFixture(own, variant);
      const report = await executeCodeQualityPolicy(
        { scope: "repository", mode: "enforce" },
        own.root,
      );
      expect(report.enforcementOutcome).toBe("failed");
      expect(report.responsibilities.assessments[0].structural).toBe("incomplete");
      expect(report.adaptations).toEqual([]);
      expect(report.responsibilities.counts.qualified).toBe(0);
    },
    60_000,
  );

  it.each([
    ["wrong-producer", "foreign-responsibility-owner"],
    ["wrong-consumer", "foreign-responsibility-owner"],
    ["alias-producer", "foreign-responsibility-owner"],
    ["missing", "unresolved-responsibility-facts"],
    ["noncallable", "noncallable-responsibility-consumer"],
  ])(
    "rejects exact cross-owner %s binding without an owner waiver",
    async (variant, reason) => {
      const own = createCrossOwnerEnforcementFixture(variant);
      roots.push(own.root);
      if (variant === "wrong-producer") own.record.owner = "beta";
      if (variant === "wrong-consumer") own.record.consumer.owner = "alpha";
      if (variant === "missing") own.record.consumer.exportName = "missing";
      own.put("scripts/code-quality-policy.json", own.policy);
      const report = await executeCodeQualityPolicy(
        { scope: "repository", mode: "enforce" },
        own.root,
      );
      expect(report.enforcementOutcome).toBe("failed");
      expect(report.responsibilities.assessments[0].reasons).toContain(reason);
      expect(report.responsibilities.counts.qualified).toBe(0);
      expect(report.adaptations).toEqual([]);
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(await codeQualityPolicyMain([], own.root)).toBe(1);
    },
    60_000,
  );

  it.each(["missing-producer", "missing-consumer", "malformed-consumer", "extra-authorization"])(
    "rejects %s ownership at the real CLI policy boundary",
    async (variant) => {
      const own = createCrossOwnerEnforcementFixture();
      roots.push(own.root);
      if (variant === "missing-producer") delete own.record.owner;
      if (variant === "missing-consumer") delete own.record.consumer.owner;
      if (variant === "malformed-consumer") own.record.consumer.owner = null;
      if (variant === "extra-authorization") own.record.consumer.exempt = true;
      own.put("scripts/code-quality-policy.json", own.policy);
      await expect(
        executeCodeQualityPolicy({ scope: "repository", mode: "enforce" }, own.root),
      ).rejects.toThrow("invalid-responsibilities");
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect(await codeQualityPolicyMain([], own.root)).toBe(1);
      expect(error.mock.calls[0][0]).toContain("invalid-responsibilities");
    },
    60_000,
  );

  it.each([undefined, "", null, 7, {}, ["alpha"], "x".repeat(257)])(
    "rejects missing or malformed exact consumer owner %j",
    (owner) => {
      const policy = responsibilityPolicy([responsibilityRecord()]);
      policy.responsibilities[0].consumer.owner = owner;
      expect(validatePolicy(policy)).toEqual(["invalid-responsibilities"]);
    },
  );
  it.each(["inherited-owner", "array-selector"])(
    "rejects malformed closed consumer shape %s",
    (variant) => {
      const policy = responsibilityPolicy([responsibilityRecord()]);
      const selector = policy.responsibilities[0].consumer;
      if (variant === "inherited-owner") {
        delete selector.owner;
        Object.setPrototypeOf(selector, { owner: "alpha" });
      } else policy.responsibilities[0].consumer = Object.assign([], selector);
      expect(validatePolicy(policy)).toEqual(["invalid-responsibilities"]);
    },
  );

  it("binds historical consumer ownership and rejects extra authorization fields", () => {
    const baseline = responsibilityPolicy([responsibilityRecord()]);
    const current = structuredClone(baseline);
    current.responsibilities[0].consumer.owner = "beta";
    expect(validatePolicy(current, [baseline])).toEqual(["responsibility-shrank"]);
    current.responsibilities[0].consumer.owner = "alpha";
    current.responsibilities[0].consumer.exempt = true;
    expect(validatePolicy(current)).toEqual(["invalid-responsibilities"]);
    delete current.responsibilities[0].consumer.exempt;
    for (const role of ["input", "transform", "output"]) {
      current.responsibilities[0][role].owner = "alpha";
      expect(validatePolicy(current)).toEqual(["invalid-responsibilities"]);
      delete current.responsibilities[0][role].owner;
    }
  });

  it("pins exact parameter index in validation and historical identity", () => {
    const previous = responsibilityPolicy([responsibilityRecord()]);
    const current = structuredClone(previous);
    current.responsibilities[0].input.parameterIndex = 1;
    expect(validatePolicy(current, [previous])).toEqual(["responsibility-shrank"]);
    current.responsibilities[0].input.parameterIndex = -1;
    expect(validatePolicy(current)).toEqual(["invalid-responsibilities"]);
    delete current.responsibilities[0].input.parameterIndex;
    expect(validatePolicy(current)).toEqual(["invalid-responsibilities"]);
  });

  it("discloses failed static and semantic obligations in census without treating its exit as enforcement", async () => {
    const own = createEnforcementFixture();
    roots.push(own.root);
    own.record.consumer.exportName = "missing";
    own.put("scripts/code-quality-policy.json", own.policy);
    const report = await executeCodeQualityPolicy(
      { scope: "repository", mode: "census" },
      own.root,
    );
    expect(report.outcome).toBe("failed");
    expect(report.enforcementOutcome).toBe("failed");
    expect(report.responsibilities.counts.incomplete).toBe(1);
    const census = executeCensusChild(own.root, "false");
    expect(census.error).toBeUndefined();
    expect(census.status).toBe(0);
    expect(census.stdout).toContain("enforcement=FAILED; combined=FAILED");
    const ci = executeCensusChild(own.root, "true");
    expect(ci.error).toBeUndefined();
    expect(ci.status).toBe(1);
    expect(ci.stderr).toContain("partial-ci-verdict");
  }, 60_000);

  it.each(["extra-slot", "unknown-consumer", "open-dictionary", "missing-slot"])(
    "keeps %s unsafe contracts active instead of adapting a body or consumer",
    async (variant) => {
      const own = createEnforcementFixture();
      roots.push(own.root);
      if (variant === "missing-slot") own.record.input.parameterIndex = 1;
      else replaceEnforcementOwner(own, variant);
      own.put("scripts/code-quality-policy.json", own.policy);
      const report = await executeCodeQualityPolicy(
        { scope: "repository", mode: "enforce" },
        own.root,
      );
      expect(report.enforcementOutcome).toBe("failed");
      expect(report.violations.length).toBeGreaterThan(0);
      expect(report.adaptations).toHaveLength(variant === "extra-slot" ? 1 : 0);
      if (variant === "extra-slot") {
        expect(report.violations.some((finding) => finding.rule === own.record.rules[0])).toBe(
          true,
        );
      } else {
        expect(report.responsibilities.counts.ready).toBe(0);
        expect(report.responsibilities.assessments[0].reasons.length).toBeGreaterThan(0);
      }
    },
    60_000,
  );
});

function assertConsumerSafety(api) {
  expect(api.consume(3)).toBe(3);
  for (const input of ["unchecked", null, {}, []]) expect(() => api.consume(input)).toThrow();
}

describe("one ordinary runtime consumer contract rejects unchanged-signature mutants", () => {
  it("accepts the actual healthy emitted producer and consumer", async () => {
    const own = createEnforcementFixture();
    roots.push(own.root);
    assertConsumerSafety(await executeResponsibilityFixture(own));
  });
  it.each(["unchecked", "lying-predicate", "open-dictionary", "generic-assertion"])(
    "rejects the %s mutant through the same consumer assertion contract",
    async (variant) => {
      const own = createEnforcementFixture("validator", variant);
      roots.push(own.root);
      if (variant !== "unchecked") replaceEnforcementOwner(own, variant);
      const api = await executeResponsibilityFixture(own);
      expect(() => assertConsumerSafety(api)).toThrow();
    },
  );
});
async function fixture(variant) {
  const own = createResponsibilityFixture(variant);
  roots.push(own.root);
  own.subject = await collectPolicySubject(own.root);
  return own;
}
describe("closed responsibility policy schema/history (#3918)", () => {
  it("accepts exact v1 unchanged and additive v2 without authorizing semantic qualification", () => {
    const v2 = responsibilityPolicy([responsibilityRecord()]);
    const { responsibilities: ignored, ...v1 } = v2;
    expect(ignored).toHaveLength(1);
    v1.version = 1;
    expect(validatePolicy(v1)).toEqual([]);
    expect(validatePolicy(v2, [v1])).toEqual([]);
  });
  it("rejects downgrade and removal of existing recorded obligations", () => {
    const baseline = responsibilityPolicy([responsibilityRecord()]);
    const current = responsibilityPolicy();
    expect(validatePolicy(current, [baseline])).toEqual(["responsibility-shrank"]);
    const { responsibilities: ignored, ...v1 } = current;
    expect(ignored).toEqual([]);
    v1.version = 1;
    expect(validatePolicy(v1, [baseline])).toEqual(["responsibility-downgrade"]);
  });
  it.each(["owner", "kind", "input", "transform", "output", "consumer", "rules", "proofs"])(
    "rejects removal/rebinding of the %s obligation",
    (key) => {
      const baseline = responsibilityPolicy([responsibilityRecord()]);
      const current = structuredClone(baseline);
      if (key === "owner") current.responsibilities[0][key] = "beta";
      else if (key === "kind") current.responsibilities[0][key] = "structural-redactor";
      else if (["rules", "proofs"].includes(key))
        current.responsibilities[0][key] =
          key === "rules" ? ["anti-slop/no-reflect-get"] : ["packages/alpha/src/other.test.ts"];
      else current.responsibilities[0][key].exportName = "counterfeit";
      expect(validatePolicy(current, [baseline])).toEqual(["responsibility-shrank"]);
    },
  );
  it.each([
    (record) => {
      record.exempt = true;
    },
    (record) => {
      record.proofs = ["../escape.test.ts"];
    },
    (record) => {
      record.input.exportName = "";
    },
    (record) => {
      record.rules = ["invented"];
    },
    (record) => {
      record.proofs = [];
    },
    (record) => {
      record.kind = "domain-waiver";
    },
  ])("rejects malformed or claimed authorization records", (mutate) => {
    const policy = responsibilityPolicy([responsibilityRecord()]);
    mutate(policy.responsibilities[0]);
    expect(validatePolicy(policy)).toEqual(["invalid-responsibilities"]);
  });
  it("rejects duplicate identities and unknown policy keys", () => {
    const record = responsibilityRecord();
    expect(validatePolicy(responsibilityPolicy([record, record]))).toEqual([
      "invalid-responsibilities",
    ]);
    expect(validatePolicy({ ...responsibilityPolicy(), qualified: true })).toEqual([
      "invalid-policy",
    ]);
  });
});

describe("current-subject responsibility facts are descriptive, not waivers", () => {
  it("resolves emitted actual producer facts but an existing proof path never qualifies semantics", async () => {
    const own = await fixture();
    const report = assessPolicyResponsibilities(
      own.subject,
      responsibilityPolicy([responsibilityRecord()]),
    );
    expect(report.counts).toEqual({
      ready: 1,
      incomplete: 0,
      invalid: 0,
      qualified: 0,
      pending: 1,
      rejected: 0,
    });
    expect(report.assessments[0].proofs[0].executed).toBe(false);
    expect(report.assessments[0].obligations).toContain("consumer-proof-not-evaluated");
    const api = await executeResponsibilityFixture(own);
    expect(api.consume(3)).toBe(3);
    expect(() => api.consume("unchecked")).toThrow("invalid");
    expect(report.counts.qualified).toBe(0);
  }, 15_000);
  it.each(["unchecked", "domain-unknown"])(
    "rejects actual %s outputs instead of trusting boundary names",
    async (variant) => {
      const own = await fixture(variant);
      const report = assessPolicyResponsibilities(
        own.subject,
        responsibilityPolicy([responsibilityRecord()]),
      );
      expect(report.counts.rejected).toBe(1);
      expect(report.assessments[0].reasons).toContain(
        variant === "unchecked" ? "unchecked-validator-output" : "unknown-domain-output",
      );
      const api = await executeResponsibilityFixture(own);
      expect(variant === "unchecked" ? api.validate("unchecked") : api.consume("unchecked")).toBe(
        "unchecked",
      );
    },
    15_000,
  );
  it("never qualifies a same-shaped always-true predicate from signatures or a present proof", async () => {
    const own = await fixture("lying-predicate");
    const report = assessPolicyResponsibilities(
      own.subject,
      responsibilityPolicy([responsibilityRecord()]),
    );
    expect(report.counts.ready).toBe(1);
    expect(report.counts.pending).toBe(1);
    expect(report.counts.qualified).toBe(0);
    const api = await executeResponsibilityFixture(own);
    expect(api.consume("unchecked")).toBe("unchecked");
  }, 15_000);

  it("does not call a noncallable or overloaded consumer structurally ready", async () => {
    const own = createResponsibilityFixture();
    roots.push(own.root);
    const path = "packages/alpha/src/owner.ts";
    own.put(
      path,
      readFileSync(join(own.root, path), "utf8") +
        "\nexport const unrelated = 42;\nexport function overloaded(input: number): number;\nexport function overloaded(input: string): number;\nexport function overloaded(input: number | string): number { return Number(input); }\n",
    );
    emitSymbolFixture(own.root);
    const subject = await collectPolicySubject(own.root);
    for (const [exportName, reason] of [
      ["unrelated", "noncallable-responsibility-consumer"],
      ["overloaded", "ambiguous-responsibility-consumer"],
    ]) {
      const record = responsibilityRecord();
      record.consumer.exportName = exportName;
      const report = assessPolicyResponsibilities(subject, responsibilityPolicy([record]));
      expect(report.counts.ready).toBe(0);
      expect(report.counts.incomplete).toBe(1);
      expect(report.counts.pending).toBe(1);
      expect(report.counts.qualified).toBe(0);
      expect(report.assessments[0].reasons).toContain(reason);
    }
    const absent = responsibilityRecord();
    absent.consumer.exportName = "missing";
    expect(
      assessPolicyResponsibilities(subject, responsibilityPolicy([absent])).counts.incomplete,
    ).toBe(1);
  }, 15_000);

  it("rejects foreign canonical ownership despite identical selectors/signatures", async () => {
    const own = await fixture();
    const record = responsibilityRecord();
    record.owner = "beta";
    expect(
      assessPolicyResponsibilities(own.subject, responsibilityPolicy([record])).assessments[0]
        .reasons,
    ).toContain("foreign-responsibility-owner");
  }, 15_000);
  it("reports partial, unresolved and missing-proof facts incomplete rather than qualified", async () => {
    const own = await fixture();
    const record = responsibilityRecord();
    expect(
      assessPolicyResponsibilities(own.subject, responsibilityPolicy([record]), []).counts
        .incomplete,
    ).toBe(1);
    record.output.exportName = "missing";
    expect(
      assessPolicyResponsibilities(own.subject, responsibilityPolicy([record])).counts.incomplete,
    ).toBe(1);
    record.output.exportName = "validate";
    record.proofs = ["packages/alpha/src/missing.test.ts"];
    expect(
      assessPolicyResponsibilities(own.subject, responsibilityPolicy([record])).counts.incomplete,
    ).toBe(1);
  }, 15_000);
  it("binds proof bytes to the observed source instead of accepting a stale digest", async () => {
    const own = await fixture();
    const resolver = createSymbolResolver(own.subject);
    try {
      const original = resolver.sourceIdentity("packages/alpha/src/proof.test.ts");
      expect(original.sha256).toMatch(/^[a-f0-9]{64}$/u);
      own.put(original.path, "export const proof = false;\n");
      expect(() => resolver.assertCurrent()).toThrow("symbol-subject-changed");
    } finally {
      resolver.close();
    }
  });
  it("keeps legacy/no-record assessment empty without assigning semantic trust", async () => {
    const own = await fixture();
    expect(assessPolicyResponsibilities(own.subject, { version: 1 }).assessments).toEqual([]);
  });
});

describe("actual policy entry reports responsibility incompleteness", () => {
  it("keeps v1 report shape and fails v2 enforcement despite existing proof paths and passing runtime controls", async () => {
    const own = await fixture();
    mkdirSync(join(own.root, "scripts"));
    const v2 = responsibilityPolicy([responsibilityRecord()]);
    const { responsibilities: ignored, ...v1 } = v2;
    expect(ignored).toHaveLength(1);
    v1.version = 1;
    const path = join(own.root, "scripts/code-quality-policy.json");
    writeFileSync(path, JSON.stringify(v1));
    const legacy = await executeCodeQualityPolicy(
      { scope: "repository", mode: "enforce" },
      own.root,
    );
    expect(legacy.schemaVersion).toBe(1);
    expect(legacy.outcome).toBe("passed");
    expect(Object.hasOwn(legacy, "responsibilities")).toBe(false);
    expect(Object.hasOwn(legacy, "enforcementOutcome")).toBe(false);
    expect(Object.hasOwn(legacy, "adaptations")).toBe(false);
    writeFileSync(path, JSON.stringify(v2));
    const report = await executeCodeQualityPolicy(
      { scope: "repository", mode: "enforce" },
      own.root,
    );
    expect(report.schemaVersion).toBe(2);
    expect(report.outcome).toBe("failed");
    expect(report.counts.visited).toBe(report.counts.expected);
    expect(report.counts.violations).toBe(0);
    expect(report.responsibilities.counts.qualified).toBe(0);
    expect(report.responsibilities.counts.pending).toBe(1);
  }, 60_000);
});

describe("real public reference boundaries retain structural behavior", () => {
  it("preserves relationship input/endpoints/metadata identity and exact null error omission", () => {
    const source = { kind: "workflow-run", id: "fixture-run", workspaceId: "fixture-workspace" };
    const target = { kind: "memory", id: "fixture-memory", workspaceId: "fixture-workspace" };
    const metadata = { reason: "fixture" };
    const input = {
      id: "fixture",
      schemaVersion: "1",
      workspaceId: "fixture-workspace",
      source,
      target,
      type: "reads-context",
      lifecycleState: "active",
      etag: 0,
      createdAt: "fixture",
      updatedAt: "fixture",
      metadata,
    };
    const before = JSON.stringify(input);
    const result = validateRelationship(input);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(input);
    expect(result.value.source).toBe(source);
    expect(result.value.target).toBe(target);
    expect(result.value.metadata).toBe(metadata);
    expect(JSON.stringify(result.value)).toBe(before);
    expect(validateRelationship(null)).toEqual({
      ok: false,
      errors: [{ code: "denied/invalid-structure", message: "relationship must be an object" }],
    });
  });
  it("redacts structure without certifying unknown input as a validated domain value", () => {
    const input = JSON.parse(
      '{"nested":["fixture-sensitive-value",7,null],"__proto__":{"marker":"fixture-sensitive-value"}}',
    );
    const before = JSON.stringify(input);
    const redact = createAuditRedactor({ additionalSecrets: ["fixture-sensitive-value"] }, {});
    const output = deepRedactStrings(input, redact);
    expect(output.nested).toEqual([redact("fixture-sensitive-value"), 7, null]);
    expect(Object.hasOwn(output, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(output)).toBeNull();
    expect(output.marker).toBeUndefined();
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(deepRedactStrings(output, redact))).toBe(JSON.stringify(output));
  });
});
