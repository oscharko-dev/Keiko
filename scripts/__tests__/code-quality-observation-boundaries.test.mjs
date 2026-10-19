import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectPolicySubject } from "../lib/code-quality-inventory.mjs";
import { validatePolicy } from "../lib/code-quality-policy.mjs";
import {
  assessPolicyResponsibilities,
  adaptResponsibilityDiagnostics,
  qualifyPolicyResponsibilities,
} from "../lib/code-quality-responsibilities.mjs";
import { emitSymbolFixture } from "./support/code-quality-symbol-fixture.mjs";
import {
  createObservationOptionsFixture,
  createObjectValidatorFixture,
  objectValidatorRecord,
  createDirectObservationCheckerFixture,
  responsibilityPolicy,
  createRawHelperEnforcementFixture,
  installResponsibilityFixtureTools,
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

describe("optional own-key and raw-root observation capability", () => {
  it.each([
    ["default", {}, 3],
    ["own-key", { additionalObservationForms: ["own-key-identity"] }, 5],
    ["raw-root", { rawObjectInput: true }, 4],
    ["combined", { rawObjectInput: true, additionalObservationForms: ["own-key-identity"] }, 6],
  ])(
    "declares exact %s slots without granting unqualified findings",
    async (_name, options, count) => {
      const own = createObservationOptionsFixture(options);
      roots.push(own.root);
      expect(validatePolicy(own.policy)).toEqual([]);
      const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
      const assessment = report.assessments[0];
      expect(assessment.structural).toBe("ready");
      expect(assessment.slots).toHaveLength(count);
      expect(
        assessment.slots.filter((slot) => slot.rule === "anti-slop/no-object-parameters"),
      ).toHaveLength(count - 2);
      const findings = assessment.slots.map(({ path, rule, line, column }) => ({
        path,
        rule,
        line,
        column,
      }));
      expect(adaptResponsibilityDiagnostics({ violations: findings }, report).adaptations).toEqual(
        [],
      );
      const qualified = { assessments: [{ ...assessment, semantic: "qualified" }] };
      expect(
        adaptResponsibilityDiagnostics({ violations: findings }, qualified).adaptations,
      ).toHaveLength(count);
    },
  );

  it.each([
    [
      "wrong first receiver",
      (source) => source.replace("Reflect.ownKeys(left)", "Reflect.ownKeys(right)"),
    ],
    ["wrong membership", (source) => source.replace("leftKeys.every", "leftKeys.some")],
    ["loose equality", (source) => source.replace("leftKeys.length ===", "leftKeys.length ==")],
    ["mutable binding", (source) => source.replace("const leftKeys", "let leftKeys")],
    ["extra statement", (source) => source.replace("const leftKeys", "void left; const leftKeys")],
    [
      "counterfeit Set",
      (source) =>
        source +
        "\nclass Set { readonly size = 1; constructor(_keys: PropertyKey[]) {} has(_key: PropertyKey): boolean { return true; } }",
    ],
    [
      "counterfeit Reflect",
      (source) =>
        source +
        "\nconst Reflect = { get(_value: object, _key: PropertyKey): unknown { return 1; }, ownKeys(_value: object): PropertyKey[] { return []; } };",
    ],
    [
      "second reachable helper",
      (source) =>
        source
          .replace("function exactKeys", "function otherKeys")
          .replace(
            "&& exactKeys(event, {value: 1})",
            "&& otherKeys(event, {value: 1}) && exactKeys(event, {value: 1})",
          ) +
        "\nfunction exactKeys(left: object, right: object): boolean { const leftKeys = Reflect.ownKeys(left); const rightKeys = new Set(Reflect.ownKeys(right)); return leftKeys.length === rightKeys.size && leftKeys.every((key) => rightKeys.has(key)); }",
    ],
    [
      "escaped alias",
      (source) => source + "\nconst alias = exactKeys; export const escaped = [alias];",
    ],
    [
      "exported helper",
      (source) => source.replace("function exactKeys", "export function exactKeys"),
    ],
    ["unreached helper", (source) => source.replace("&& exactKeys(event, {value: 1})", "")],
  ])("withholds the entire combined declaration for %s", async (_name, mutate) => {
    const own = createObservationOptionsFixture({
      rawObjectInput: true,
      additionalObservationForms: ["own-key-identity"],
    });
    roots.push(own.root);
    const path = "packages/alpha/src/owner.ts";
    own.put(path, mutate(readFileSync(join(own.root, path), "utf8")));
    emitSymbolFixture(own.root);
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(report.assessments[0].structural).not.toBe("ready");
    expect(report.assessments[0].slots ?? []).toEqual([]);
  });
});

describe("direct whole-receiver observation qualification", () => {
  it.each([
    ["trusted consumer", "function persist(_event: object): void {}", "persist(event);"],
    [
      "callback capture",
      "",
      'const callback = (): unknown => runtimeProperty(event, "value"); void callback;',
    ],
    ["container escape", "", "const saved = { event }; void saved;"],
    ["typed alias", "", "const alias: object = event; void alias;"],
    [
      "mutation call alias",
      "",
      'const alias = event; Object.defineProperty(alias, "changed", {value: true});',
    ],
    ["written alias", "", "const alias = event; (alias as {changed: boolean}).changed = true;"],
  ])("withholds the receiver escaping through %s", async (_name, prefix, extra) => {
    const own = createDirectObservationCheckerFixture();
    roots.push(own.root);
    const path = "packages/alpha/src/owner.ts";
    const original = readFileSync(join(own.root, path), "utf8");
    own.put(
      path,
      prefix +
        original.replace(
          'return { duration: runtimeProperty(event, "duration") };',
          extra + ' return { duration: runtimeProperty(event, "duration") };',
        ),
    );
    emitSymbolFixture(own.root);
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(report.assessments[0].structural).toBe("ready");
    expect(report.assessments[0].slots).toHaveLength(9);
  });
  it("withholds a checker whose omitted default parameter escapes the receiver", async () => {
    const own = createDirectObservationCheckerFixture();
    roots.push(own.root);
    const path = "packages/alpha/src/owner.ts";
    const original = readFileSync(join(own.root, path), "utf8");
    const changed =
      "function persist(_event: object): void {}\n" +
      original.replace(
        "function readEnvelope(event: object):",
        "function readEnvelope(event: object, unused = persist(event)):",
      );
    expect(changed).toContain("readEnvelope(original)");
    own.put(path, changed);
    emitSymbolFixture(own.root);
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(report.assessments[0].structural).toBe("ready");
    expect(report.assessments[0].slots).toHaveLength(9);
  });
  it("requires every current contributor and its completed proofs for the four new slots", async () => {
    const own = createDirectObservationCheckerFixture();
    roots.push(own.root);
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    const record = report.assessments[0];
    expect(record.slots).toHaveLength(10);
    const findings = record.slots.map(({ path, rule, line, column }) => ({
      path,
      rule,
      line,
      column,
    }));
    const ready = {
      ...record,
      semantic: "qualified",
      proofs: record.proofs.map((proof) => ({ ...proof, executed: true })),
      proofAssertions: own.record.proofAssertions.map((proof) => ({ ...proof, status: "passed" })),
    };
    expect(
      adaptResponsibilityDiagnostics({ violations: findings }, { assessments: [ready] })
        .adaptations,
    ).toHaveLength(10);
    const incomplete = { ...ready, proofAssertions: [] };
    expect(
      adaptResponsibilityDiagnostics({ violations: findings }, { assessments: [incomplete] })
        .adaptations,
    ).toHaveLength(6);
    const other = { ...ready, id: "other-contributor", slots: [], semantic: "pending" };
    const joined = {
      ...ready,
      slots: ready.slots.map((slot) =>
        slot.observationRoots
          ? {
              ...slot,
              observationRoots: [
                ...slot.observationRoots,
                { ...slot.observationRoots[0], recordId: other.id },
              ],
            }
          : slot,
      ),
    };
    expect(
      adaptResponsibilityDiagnostics({ violations: findings }, { assessments: [joined, other] })
        .adaptations,
    ).toHaveLength(6);
  });
});

// Browser declarations belong to the actual Vitest proof context, not structural admission.
async function objectValidatorSemanticFixture(variant = "valid") {
  const own = createObjectValidatorFixture(variant);
  await installSemanticFixtureTools(own);
  const path = "packages/alpha/tsconfig.json";
  const config = JSON.parse(readFileSync(join(own.root, path), "utf8"));
  config.compilerOptions.lib.push("DOM");
  own.put(path, config);
  return own;
}

describe("optional object validator responsibility (#3918)", () => {
  it("closes the opt-in without changing legacy observation options", () => {
    const record = objectValidatorRecord();
    expect(validatePolicy(responsibilityPolicy([record]))).toEqual([]);
    for (const mutate of [
      (entry) => {
        entry.rawObjectInput = false;
      },
      (entry) => {
        entry.rawObjectInput = null;
      },
      (entry) => {
        entry.kind = "public-parser";
      },
      (entry) => {
        entry.rules.push("anti-slop/no-unknown-parameters");
      },
      (entry) => {
        entry.input.parameterIndex = 1;
      },
      (entry) => {
        delete entry.proofAssertions;
      },
      (entry) => {
        entry.directRawCheckerInputs = true;
      },
    ]) {
      const invalid = structuredClone(record);
      mutate(invalid);
      expect(validatePolicy(responsibilityPolicy([invalid]))).not.toEqual([]);
    }
  });

  it("requires the new declaration and identical actual producer roles", async () => {
    const own = createObjectValidatorFixture();
    roots.push(own.root);
    const subject = await collectPolicySubject(own.root);
    const ready = assessPolicyResponsibilities(subject, own.policy);
    expect(ready.counts).toMatchObject({ ready: 1, pending: 1 });
    expect(ready.assessments[0].slots).toHaveLength(1);
    expect(ready.assessments[0].slots[0].rawObjectValidatorInput).toBe(true);
    const absent = structuredClone(own.policy);
    delete absent.responsibilities[0].rawObjectInput;
    expect(assessPolicyResponsibilities(subject, absent).counts.ready).toBe(0);
    const wrong = structuredClone(own.policy);
    wrong.responsibilities[0].output.exportName = "consume";
    const refused = assessPolicyResponsibilities(subject, wrong).assessments[0];
    expect(refused.reasons).toContain("mismatched-object-validator-producer");
    expect(refused.slots).toEqual([]);
  });

  it("does not adapt a pending tagged fact through either dispatch path", () => {
    // Constructed dispatch reports only; these do not establish actual fact eligibility.
    for (const kind of ["validator", "public-parser"]) {
      const finding = {
        path: "owner.ts",
        rule: "anti-slop/no-known-value-widening",
        line: 1,
        column: 1,
      };
      const slot = { ...finding, rawObjectValidatorInput: true };
      const assessment = {
        id: "object",
        kind,
        structural: "ready",
        semantic: "pending",
        slots: [slot],
      };
      if (kind === "public-parser") slot.contributingResponsibilityIds = [assessment.id];
      expect(
        adaptResponsibilityDiagnostics({ violations: [finding] }, { assessments: [assessment] })
          .violations,
      ).toEqual([finding]);
      assessment.semantic = "qualified";
      expect(
        adaptResponsibilityDiagnostics({ violations: [finding] }, { assessments: [assessment] })
          .violations,
      ).toEqual([]);
    }
  });

  it.skipIf(process.platform === "win32")(
    "refuses genuine semantic qualification for an unchecked raw view reaching its consumer",
    async () => {
      const own = await objectValidatorSemanticFixture("unchecked");
      const subject = await collectPolicySubject(own.root);
      const pending = assessPolicyResponsibilities(subject, own.policy);
      expect(pending.counts).toMatchObject({ ready: 1, pending: 1 });
      await expect(qualifyPolicyResponsibilities(subject, own.policy)).rejects.toThrow(
        "semantic-proof-execution-failed",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "retains the root tag through genuine public proof completion",
    async () => {
      const own = await objectValidatorSemanticFixture();
      const subject = await collectPolicySubject(own.root);
      const pending = assessPolicyResponsibilities(subject, own.policy);
      const slot = pending.assessments[0].slots[0];
      const finding = { path: slot.path, rule: slot.rule, line: slot.line, column: slot.column };
      expect(adaptResponsibilityDiagnostics({ violations: [finding] }, pending).violations).toEqual(
        [finding],
      );
      const qualified = await qualifyPolicyResponsibilities(subject, own.policy);
      expect(qualified.counts).toMatchObject({ ready: 1, qualified: 1, pending: 0 });
      expect(qualified.assessments[0].slots).toEqual(pending.assessments[0].slots);
      expect(
        qualified.assessments[0].proofAssertions.every((proof) => proof.status === "passed"),
      ).toBe(true);
      expect(
        adaptResponsibilityDiagnostics({ violations: [finding] }, qualified).violations,
      ).toEqual([]);
    },
  );
});

describe("optional raw typeof responsibility slots (#3918)", () => {
  it("retains original roles and requires only the same declared raw boundary", async () => {
    const own = createRawHelperEnforcementFixture("optional-typeof");
    roots.push(own.root);
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    const assessment = report.assessments[0];
    expect(assessment.structural).toBe("ready");
    expect(assessment.semantic).toBe("pending");
    expect(assessment.consumerBinding.bound).toBe(true);
    expect(assessment.roles.input.signatures[0].parameters[0].type.kind).toBe("unknown");
    const source = readFileSync(join(own.root, "packages/alpha/src/owner.ts"), "utf8");
    const start = source.indexOf("function fields(");
    const end = source.indexOf("export function validate(");
    const slots = assessment.slots.filter(
      (slot) => slot.rule === "anti-slop/no-runtime-typeof" && slot.start > start && slot.end < end,
    );
    expect(slots.map((slot) => slot.start)).toEqual(
      ["direct", "optional", "nullish", "not-null", "alias", "primitive-guard"].map((marker) =>
        source.indexOf("typeof", source.indexOf(`/* ${marker} */`)),
      ),
    );
  });
});
