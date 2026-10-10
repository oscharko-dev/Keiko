import { afterEach, describe, expect, it } from "vitest";
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { executeCodeQualityPolicy } from "../check-code-quality-policy.mjs";
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
} from "./support/code-quality-responsibility-fixture.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
