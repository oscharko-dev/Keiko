import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { URL, pathToFileURL } from "node:url";
import { codeQualityPolicyMain, executeCodeQualityPolicy } from "../check-code-quality-policy.mjs";
import { collectPolicySubject } from "../lib/code-quality-inventory.mjs";
import { validatePolicy } from "../lib/code-quality-policy.mjs";
import {
  assessPolicyResponsibilities,
  resolveRoles,
  qualifyPolicyResponsibilities,
} from "../lib/code-quality-responsibilities.mjs";
import {
  createPublicParserFixture,
  emitSymbolFixture,
} from "./support/code-quality-symbol-fixture.mjs";
import { createSymbolResolver } from "../lib/code-quality-symbols.mjs";
import { deepRedactStrings, createAuditRedactor } from "@oscharko-dev/keiko-security/redaction";
import { validateRelationship } from "@oscharko-dev/keiko-contracts/runtime/relationships-validation";
import {
  createConsumerSeamFixture,
  createDiagnosticFixture,
  createDictionaryEnforcementFixture,
  createForeignDiagnosticFixture,
  responsibilityPolicy,
  responsibilityRecord,
  createResponsibilityFixture,
  executeResponsibilityFixture,
  createEnforcementFixture,
  createCrossOwnerEnforcementFixture,
  replaceEnforcementOwner,
  replaceConsumerCallFixture,
  createRawHelperEnforcementFixture,
  createCollectiveParserFixture,
  createPrivateModuleParserFixture,
  createTypedRecheckFixture,
  createCanonicalDecoderFixture,
  installResponsibilityFixtureTools,
  installSemanticFixtureBuild,
  embeddedSemanticOptions,
  createCollectiveSemanticFixture,
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

function executeScopedPolicyChild(root, scope, json) {
  const entry = new URL("../check-code-quality-policy.mjs", import.meta.url).href;
  const args = ["--scope", scope, ...(json ? ["--json"] : [])];
  const source = `import { codeQualityPolicyMain } from ${JSON.stringify(entry)};
    process.exitCode = await codeQualityPolicyMain(${JSON.stringify(args)}, ${JSON.stringify(root)});`;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    env: { ...process.env, CI: "false" },
    encoding: "utf8",
    timeout: 45_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
}

function prepareInvalidScopedConsumer(own, variant) {
  if (variant === "missing") own.record.consumer.exportName = "missing";
  if (variant === "foreign") own.record.consumer.owner = "alpha";
  if (variant === "unbound") {
    own.put(
      "packages/beta/src/owner.ts",
      "export function consume(input: number): number { return input; }",
    );
    emitSymbolFixture(own.root, "packages/beta");
  }
  for (const rule of own.policy.rules) {
    if (own.record.rules.includes(rule.id))
      rule.activeScopes = rule.activeScopes.filter(
        (scope) => !["package:alpha", "package:beta"].includes(scope),
      );
  }
  own.put("scripts/code-quality-policy.json", own.policy);
}

const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("collective public parser structural roots (#3918)", () => {
  it.each(["direct", "one-root"])(
    "joins only the private helper component for %s with pending semantics",
    async (variant) => {
      const own = createPrivateModuleParserFixture(variant, [
        "anti-slop/no-runtime-typeof",
        "anti-slop/no-unsafe-dictionary-type",
      ]);
      roots.push(own.root);
      const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
      expect(report.counts).toMatchObject({
        ready: own.records.length,
        qualified: 0,
        pending: own.records.length,
      });
      const helper = report.assessments
        .flatMap((record) => record.slots)
        .filter((slot) => slot.path === "packages/alpha/src/helper.ts");
      expect(helper.filter((slot) => slot.rule === "anti-slop/no-runtime-typeof")).toHaveLength(2);
      expect(
        helper.filter((slot) => slot.rule === "anti-slop/no-unsafe-dictionary-type"),
      ).toHaveLength(3);
      expect(
        helper.every(
          (slot) =>
            JSON.stringify(slot.contributingResponsibilityIds) ===
            JSON.stringify(own.records.map((record) => record.id)),
        ),
      ).toBe(true);
      expect(
        report.assessments.every((record) => record.proofs.every((proof) => !proof.executed)),
      ).toBe(true);
    },
    30_000,
  );

  it.each(["missing-record", "missing-rule", "missing-selector", "incomplete-root"])(
    "withholds imported helper ownership when a contributing root is %s",
    async (variant) => {
      const rule = "anti-slop/no-runtime-typeof";
      const own = createPrivateModuleParserFixture("direct", [rule]);
      roots.push(own.root);
      if (variant === "missing-record") own.policy.responsibilities.pop();
      if (variant === "missing-rule") own.records[1].rules = ["anti-slop/no-unknown-parameters"];
      if (variant === "missing-selector") delete own.records[1].proofAssertions;
      if (variant === "incomplete-root") own.records[1].consumer.exportName = "absent";
      const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
      expect(report.assessments[0].structural).toBe("ready");
      expect(
        report.assessments
          .flatMap((record) => record.slots ?? [])
          .filter((slot) => slot.path === "packages/alpha/src/helper.ts" && slot.rule === rule),
      ).toEqual([]);
    },
    30_000,
  );

  it("joins the complete registered incoming roots without qualifying their pending proofs", async () => {
    const own = createCollectiveParserFixture();
    roots.push(own.root);
    const subject = await collectPolicySubject(own.root);
    const report = assessPolicyResponsibilities(subject, own.policy);
    expect(report.counts).toMatchObject({ ready: 2, qualified: 0, pending: 2 });
    const source = readFileSync(join(own.root, "packages/alpha/src/owner.ts"), "utf8");
    const start = source.indexOf("input: unknown", source.indexOf("function isRecord")) + 7;
    const slots = report.assessments.flatMap((record) => record.slots);
    expect(slots).toContainEqual(
      expect.objectContaining({
        start,
        rule: "anti-slop/no-unknown-parameters",
        contributingResponsibilityIds: ["fixture-first", "fixture-second"],
      }),
    );
    expect(
      report.assessments.every((record) => record.proofs.every((proof) => !proof.executed)),
    ).toBe(true);
  }, 30_000);

  it.each([
    "third-caller",
    "typed-caller",
    "export-helper",
    "reexport-helper",
    "callback",
    "return-escape",
    "mutable-alias",
    "deferred",
    "helper-write",
    "root-write",
  ])(
    "withholds the shared helper for %s without invalidating its public roots",
    async (variant) => {
      const own = createCollectiveParserFixture(variant);
      roots.push(own.root);
      const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
      expect(report.counts.ready).toBe(2);
      const source = readFileSync(join(own.root, "packages/alpha/src/owner.ts"), "utf8");
      const start = source.indexOf("input: unknown", source.indexOf("function isRecord")) + 7;
      expect(
        report.assessments.flatMap((record) => record.slots).some((slot) => slot.start === start),
      ).toBe(false);
    },
    30_000,
  );

  it.each([
    "missing-record",
    "missing-rule",
    "incomplete-root",
    "invalid-root",
    "missing-selector",
  ])(
    "retains shared diagnostics when a contributing root is %s",
    async (variant) => {
      const rule = "anti-slop/no-runtime-typeof";
      const own = createCollectiveParserFixture("direct", [rule]);
      roots.push(own.root);
      if (variant === "missing-record") own.policy.responsibilities.pop();
      if (variant === "missing-rule") own.records[1].rules = ["anti-slop/no-unknown-parameters"];
      if (variant === "incomplete-root") own.records[1].consumer.exportName = "absent";
      if (variant === "invalid-root") own.records[1].consumer.owner = "beta";
      if (variant === "missing-selector") delete own.records[1].proofAssertions;
      const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
      const source = readFileSync(join(own.root, "packages/alpha/src/owner.ts"), "utf8");
      const start = source.indexOf("typeof input");
      expect(
        report.assessments
          .flatMap((record) => record.slots ?? [])
          .some((slot) => slot.start === start && slot.rule === rule),
      ).toBe(false);
      expect(report.assessments[0].structural).toBe("ready");
    },
    30_000,
  );

  it("makes native structural adaptations deterministic while leaving semantic execution pending", async () => {
    const own = createCollectiveParserFixture("direct", [
      "anti-slop/no-runtime-typeof",
      "anti-slop/no-unsafe-dictionary-type",
    ]);
    roots.push(own.root);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await codeQualityPolicyMain(["--json"], own.root)).toBe(0);
    const report = JSON.parse(log.mock.calls[0][0]);
    expect(report.enforcementOutcome).toBe("passed");
    expect(report.outcome).toBe("failed");
    expect(report.counts.visited).toBe(report.counts.expected);
    expect(report.responsibilities.counts).toMatchObject({ ready: 2, pending: 2, qualified: 0 });
    const shared = report.adaptations.filter(
      ({ slot }) => slot.contributingResponsibilityIds?.length === 2,
    );
    expect(new Set(shared.map(({ finding }) => finding.rule))).toEqual(
      new Set([
        "anti-slop/no-unknown-parameters",
        "anti-slop/no-runtime-typeof",
        "anti-slop/no-unsafe-dictionary-type",
      ]),
    );
    expect(shared.every(({ responsibilityId }) => responsibilityId === "fixture-first")).toBe(true);
    own.policy.responsibilities.reverse();
    own.put("scripts/code-quality-policy.json", own.policy);
    log.mockClear();
    expect(await codeQualityPolicyMain(["--json"], own.root)).toBe(0);
    const reversed = JSON.parse(log.mock.calls[0][0]);
    expect(reversed.adaptations).toEqual(report.adaptations);
  }, 60_000);

  it.each(["anti-slop/no-runtime-typeof", "anti-slop/no-unsafe-dictionary-type"])(
    "retains the real native domain diagnostic for %s alongside raw adaptations",
    async (rule) => {
      const own = createCollectiveParserFixture("domain", [rule]);
      roots.push(own.root);
      const report = await executeCodeQualityPolicy(
        { mode: "enforce", scope: "repository", json: true },
        own.root,
      );
      const domainLine =
        readFileSync(join(own.root, "packages/alpha/src/owner.ts"), "utf8")
          .split("\n")
          .findIndex((line) => line.includes("function domain")) + 1;
      expect(report.violations).toContainEqual(expect.objectContaining({ rule, line: domainLine }));
      expect(
        report.adaptations.some(
          ({ finding }) => finding.rule === rule && finding.line !== domainLine,
        ),
      ).toBe(true);
      expect(report.enforcementOutcome).toBe("failed");
    },
    30_000,
  );

  it("withholds a join when the actual producer source is outside the selected scope", async () => {
    const own = createCollectiveParserFixture();
    roots.push(own.root);
    const subject = await collectPolicySubject(own.root);
    const files = subject.inventory.files.filter(
      (file) => file.path !== "packages/alpha/src/owner.ts",
    );
    const report = assessPolicyResponsibilities(subject, own.policy, files);
    expect(report.counts).toMatchObject({ ready: 0, incomplete: 2, qualified: 0, pending: 2 });
    expect(
      report.assessments.every((record) => record.reasons.includes("partial-responsibility-scope")),
    ).toBe(true);
  }, 30_000);

  it("makes canonical producer metadata independent of supported public alias record order", async () => {
    const own = createCollectiveParserFixture("public-alias", ["anti-slop/no-runtime-typeof"]);
    roots.push(own.root);
    const options = { mode: "enforce", scope: "repository", json: true };
    const report = await executeCodeQualityPolicy(options, own.root);
    expect(report.responsibilities.counts).toMatchObject({ ready: 3, qualified: 0, pending: 3 });
    const producer = report.responsibilities.assessments[0].roles.input.identities[0].producer;
    expect(producer.kind).toBe("FunctionDeclaration");
    const rootSlot = report.adaptations.find(
      ({ slot }) =>
        slot.contributingResponsibilityIds?.join(",") === "fixture-first,fixture-firstAlias",
    );
    expect(rootSlot.slot.producerIdentity.producer).toEqual(producer);
    const shared = report.adaptations.filter(
      ({ slot }) => slot.contributingResponsibilityIds?.length === 3,
    );
    expect(shared.length).toBeGreaterThan(0);
    expect(
      shared.every(
        ({ slot }) =>
          slot.contributingResponsibilityIds.join(",") ===
          "fixture-first,fixture-firstAlias,fixture-second",
      ),
    ).toBe(true);
    own.policy.responsibilities.reverse();
    own.put("scripts/code-quality-policy.json", own.policy);
    const reversed = await executeCodeQualityPolicy(options, own.root);
    expect(reversed.responsibilities.counts).toMatchObject({ ready: 3, qualified: 0, pending: 3 });
    expect(reversed.adaptations).toEqual(report.adaptations);
  }, 60_000);

  it("retains the existing const producer public-proof refusal", async () => {
    const own = createCollectiveParserFixture("public-const-alias");
    roots.push(own.root);
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(report.counts).toMatchObject({ ready: 1, incomplete: 2, qualified: 0, pending: 3 });
    expect(report.assessments[0].reasons).toContain("unresolved-responsibility-facts");
    expect(report.assessments[2].reasons).toContain("unresolved-responsibility-facts");
  }, 30_000);
});

function responsibilityOwnerCensus(report) {
  const native = report.census.filter(({ path }) => path.startsWith("native/"));
  expect(native.filter(({ rule }) => rule === "anti-slop/no-runtime-typeof")).toHaveLength(9);
  expect(
    native.filter(({ rule }) => rule === "anti-slop/no-conditional-empty-object-spread"),
  ).toHaveLength(2);
  expect(native).toHaveLength(11);
  expect(report.adaptations.some(({ finding }) => finding.path.startsWith("native/"))).toBe(false);
  const owner = report.census.filter(({ path }) => path === "packages/alpha/src/owner.ts");
  expect(report.census).toHaveLength(native.length + owner.length);
  return owner;
}

describe("registered graph remains global for scoped CLI diagnostics (#3918)", () => {
  it.each([
    ["package:alpha", true],
    ["package:alpha", false],
    ["native-host", true],
    ["native-host", false],
  ])(
    "assesses the complete cross-owner graph for scope %s (JSON %s)",
    (scope, json) => {
      const own = createCrossOwnerEnforcementFixture();
      roots.push(own.root);
      const child = executeScopedPolicyChild(own.root, scope, json);
      expect(child.error).toBeUndefined();
      expect(child.stderr).toBe("");
      if (!json) {
        expect(child.stdout).toContain("enforcement=PASSED; combined=FAILED");
        expect(child.stdout).toContain("semantic-qualified=0; semantic-pending=1");
        expect(child.stdout).toContain("partial");
      } else {
        const report = JSON.parse(child.stdout);
        expect(report.scope).toEqual({ id: scope, partial: true });
        expect(report.counts.expected).toBe(
          report.inventory.files.filter((file) => file.scope === scope).length,
        );
        expect(report.counts.visited).toBe(report.counts.expected);
        expect(report.responsibilities.assessments[0].reasons).toEqual([]);
        expect(report.responsibilities.assessments[0].consumerBinding.bound).toBe(true);
        expect(report.responsibilities.counts).toMatchObject({
          ready: 1,
          pending: 1,
          qualified: 0,
        });
        expect(report.responsibilities.assessments[0].proofs[0].executed).toBe(false);
        expect(report.enforcementOutcome).toBe("passed");
        expect(report.outcome).toBe("failed");
        expect(
          report.census.every(({ path }) =>
            scope === "native-host"
              ? path.startsWith("native/")
              : path.startsWith("packages/alpha/"),
          ),
        ).toBe(true);
        expect(
          report.adaptations.every(({ finding }) => finding.path === "packages/alpha/src/owner.ts"),
        ).toBe(true);
        if (scope === "native-host") {
          expect(report.census).toHaveLength(11);
          expect(report.adaptations).toEqual([]);
        } else expect(report.adaptations).toHaveLength(1);
      }
      expect(child.status).toBe(0);
    },
    60_000,
  );

  it.each([
    ["missing", "unresolved-responsibility-facts", true],
    ["missing", "unresolved-responsibility-facts", false],
    ["foreign", "foreign-responsibility-owner", true],
    ["foreign", "foreign-responsibility-owner", false],
    ["unbound", "unbound-responsibility-consumer", true],
    ["unbound", "unbound-responsibility-consumer", false],
  ])(
    "refuses inactive global %s consumer (%s) outside Native scope (JSON %s)",
    (variant, reason, json) => {
      const own = createCrossOwnerEnforcementFixture();
      roots.push(own.root);
      prepareInvalidScopedConsumer(own, variant);
      const child = executeScopedPolicyChild(own.root, "native-host", json);
      expect(child.error).toBeUndefined();
      expect(child.stderr).toBe("");
      if (!json) expect(child.stdout).toContain("enforcement=FAILED; combined=FAILED");
      else {
        const report = JSON.parse(child.stdout);
        expect(report.responsibilities.assessments[0].reasons).toContain(reason);
        expect(report.responsibilities.assessments[0].reasons).not.toContain(
          "partial-responsibility-scope",
        );
        expect(report.responsibilities.assessments[0].structural).not.toBe("ready");
        expect(report.responsibilities.counts.qualified).toBe(0);
        expect(report.enforcementOutcome).toBe("failed");
        expect(report.outcome).toBe("failed");
        expect(report.violations).toEqual([]);
        expect(report.adaptations).toEqual([]);
        expect(report.census).toHaveLength(11);
      }
      expect(child.status).toBe(1);
    },
    60_000,
  );
});

describe("v2 static enforcement keeps combined semantic qualification pending (#3918)", () => {
  it.each([
    "direct",
    "alias",
    "callback",
    "one",
    "two",
    "overload",
    "siblingAlias",
    "overloadAlias",
  ])(
    "binds actual public consumer seam %s without runtime semantic promotion",
    async (variant) => {
      const own = createConsumerSeamFixture(variant);
      roots.push(own.root);
      const runtime = await import(
        pathToFileURL(join(own.root, "src/public-consumer.test.mjs")).href
      );
      expect(runtime.consume(1)).toBe(1);
      expect(() => runtime.consume("malformed")).toThrow(TypeError);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const exit = await codeQualityPolicyMain(["--json"], own.root);
      const report = JSON.parse(log.mock.calls[0][0]);
      const owner = responsibilityOwnerCensus(report);
      expect(owner.some(({ rule }) => rule === "anti-slop/no-unknown-parameters")).toBe(true);
      expect(report.counts.visited).toBe(report.counts.expected);
      expect(report.responsibilities.counts.qualified).toBe(0);
      expect(report.responsibilities.assessments[0].proofs?.[0]?.executed ?? false).toBe(false);
      expect(report.outcome).toBe("failed");
      expect(
        {
          exit,
          enforcement: report.enforcementOutcome,
          assessment: report.responsibilities.assessments[0],
        },
        JSON.stringify({ counts: report.counts, owner, violations: report.violations }),
      ).toMatchObject({
        exit: 0,
        enforcement: "passed",
        assessment: { structural: "ready", consumerBinding: { bound: true } },
      });
    },
    60_000,
  );

  it.each([
    "exported",
    "exportAlias",
    "escaped",
    "mutableSibling",
    "destructuredSibling",
    "computedSibling",
    "unusedSibling",
    "nestedSibling",
    "classSibling",
    "mixedOverload",
    "overloadSelf",
    "mixedAlias",
    "mixedCycle",
    "cycle",
    "mutual",
    "ambiguous",
  ])(
    "refuses unsupported private consumer seam %s without borrowing raw slots",
    async (variant) => {
      const own = createConsumerSeamFixture(variant);
      roots.push(own.root);
      const runtime = await import(
        pathToFileURL(join(own.root, "src/public-consumer.test.mjs")).href
      );
      expect(runtime.consume(1)).toBe(1);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const exit = await codeQualityPolicyMain(["--json"], own.root);
      const report = JSON.parse(log.mock.calls[0][0]);
      responsibilityOwnerCensus(report);
      expect(
        exit,
        JSON.stringify({
          counts: report.counts,
          assessment: report.responsibilities.assessments[0],
          adaptations: report.adaptations.length,
          violations: report.violations.length,
        }),
      ).toBe(1);
      expect(report.enforcementOutcome).toBe("failed");
      expect(report.responsibilities.assessments[0].structural).not.toBe("ready");
      expect(report.adaptations).toEqual([]);
      expect(report.violations.some(({ rule }) => rule === "anti-slop/no-unknown-parameters")).toBe(
        true,
      );
      expect(report.responsibilities.counts.qualified).toBe(0);
      expect(report.outcome).toBe("failed");
    },
    60_000,
  );

  it.each(["boundary-free", "inactive-raw"])(
    "does not certify empty v2 semantic qualification for %s JSON/text reporting",
    async (variant) => {
      const own = createEnforcementFixture();
      roots.push(own.root);
      own.policy.responsibilities = [];
      if (variant === "boundary-free") {
        own.put(
          "packages/alpha/src/owner.ts",
          "export function validate(input: number): number { return input; }\nexport function consume(input: number): number { return validate(input); }\n",
        );
        emitSymbolFixture(own.root);
      } else {
        for (const rule of own.policy.rules)
          rule.activeScopes = rule.activeScopes.filter((scope) => scope !== "package:alpha");
      }
      own.put("scripts/code-quality-policy.json", own.policy);
      expect(validatePolicy(own.policy)).toEqual([]);
      const runtime = await executeResponsibilityFixture(own);
      expect(runtime.consume(1)).toBe(1);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const jsonExit = await codeQualityPolicyMain(["--json"], own.root);
      const report = JSON.parse(log.mock.calls[0][0]);
      log.mockClear();
      const textExit = await codeQualityPolicyMain([], own.root);
      const text = log.mock.calls[0][0];
      expect({ jsonExit, textExit }).toEqual({ jsonExit: 0, textExit: 0 });
      expect(report.schemaVersion).toBe(2);
      expect(report.counts.visited).toBe(report.counts.expected);
      expect(report.enforcementOutcome).toBe("passed");
      expect(report.violations).toEqual([]);
      expect(report.adaptations).toEqual([]);
      expect(report.responsibilities.assessments).toEqual([]);
      expect(report.responsibilities.counts.qualified).toBe(0);
      expect(report.responsibilities.counts.pending).toBe(0);
      const owner = responsibilityOwnerCensus(report);
      if (variant === "boundary-free") expect(owner).toEqual([]);
      else expect(owner.length).toBeGreaterThan(0);
      expect(
        { outcome: report.outcome, text },
        JSON.stringify({
          counts: report.counts,
          owner,
          responsibilityCounts: report.responsibilities.counts,
        }),
      ).toEqual({
        outcome: "failed",
        text: `code-quality-policy: enforcement=PASSED; combined=FAILED; semantic-qualified=0; semantic-pending=0 - ${report.counts.visited} files; 0 active findings; repository`,
      });
    },
    60_000,
  );

  it("adapts exact raw helper and informative predicate recheck sites without semantic trust", async () => {
    const own = createRawHelperEnforcementFixture();
    roots.push(own.root);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exit = await codeQualityPolicyMain(["--json"], own.root);
    const report = JSON.parse(log.mock.calls[0][0]);
    const ownerCensus = responsibilityOwnerCensus(report);
    for (const rule of [
      "anti-slop/no-unknown-parameters",
      "anti-slop/no-runtime-typeof",
      "anti-slop/no-known-value-widening",
    ]) {
      const findings = ownerCensus.filter((finding) => finding.rule === rule);
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
    expect(report.adaptations.map(({ finding }) => finding)).toEqual(ownerCensus);
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
      expect(report.adaptations.map(({ finding }) => finding)).toEqual(
        responsibilityOwnerCensus(report),
      );
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
      const nativeTypeof = responsibilityOwnerCensus(report).filter(
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
    const unknowns = responsibilityOwnerCensus(report).filter(
      ({ rule }) => rule === "anti-slop/no-unknown-parameters",
    );
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

  it.each([
    "fake",
    "mutable",
    "destructured",
    "computed",
    "computed-alias",
    "unused",
    "nested",
    "dispatch",
    "class",
  ])(
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

describe("closed public diagnostic proof (#3918)", () => {
  it("accepts the exact closed diagnostic record", () => {
    const own = createDiagnosticFixture();
    roots.push(own.root);
    expect(validatePolicy(own.policy)).toEqual([]);
  });
  it("makes the excluded owning proof structurally ready without semantic qualification", async () => {
    const own = createDiagnosticFixture();
    roots.push(own.root);
    const subject = await collectPolicySubject(own.root);
    const report = assessPolicyResponsibilities(subject, own.policy);
    expect(report.assessments[0].structural).toBe("ready");
    expect(report.counts.qualified).toBe(0);
  });
});

describe("public diagnostic proof controls (#3918)", () => {
  it.each([
    "constant",
    "discarded",
    "receiver",
    "input",
    "mutable",
    "asserted",
    "nonnull",
    "satisfies",
    "nested",
    "extra",
    "counterfeit",
    "wrapper",
    "destructured",
    "dynamic",
    "overload",
  ])("refuses %s diagnostic result binding", async (variant) => {
    const own = createDiagnosticFixture(variant);
    roots.push(own.root);
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(report.assessments[0].structural).not.toBe("ready");
    expect(report.counts.qualified).toBe(0);
  });
  it("compiles the foreign owning proof before refusing diagnostic ownership", async () => {
    const own = createForeignDiagnosticFixture();
    roots.push(own.root);
    const subject = await collectPolicySubject(own.root);
    const resolver = createSymbolResolver(subject, {}, [
      { owner: "packages/beta", paths: own.record.proofs },
    ]);
    try {
      expect(resolver.resolveProofConsumer(own.record.consumer).identities[0].owner).toBe("beta");
      expect(resolver.resolveProofExport(own.record.input).identities[0].owner).toBe("alpha");
    } finally {
      resolver.close();
    }
    const report = assessPolicyResponsibilities(subject, own.policy);
    expect(report.assessments[0].reasons).toContain("foreign-responsibility-owner");
    expect(report.counts.qualified).toBe(0);
  });
  it.each([
    "extra",
    "legacy",
    "proof",
    "owner",
    "kind",
    "input",
    "transform",
    "output",
    "consumer",
    "rules",
  ])("rejects %s closed diagnostic record drift", (variant) => {
    const own = createDiagnosticFixture();
    roots.push(own.root);
    const baseline = structuredClone(own.policy);
    const record = own.policy.responsibilities[0];
    if (variant === "extra") record.consumer.authorized = true;
    else if (variant === "legacy") record.kind = "validator";
    else if (variant === "proof") record.proofs = ["packages/alpha/src/other.test.ts"];
    else if (variant === "rules") record.rules = [record.rules[0]];
    else if (["owner", "kind"].includes(variant))
      record[variant] = variant === "owner" ? "beta" : "structural-redactor";
    else record[variant].exportName = "rebound";
    expect(validatePolicy(own.policy, [baseline]).length).toBeGreaterThan(0);
  });
  it("keeps partial producer scope incomplete and runtime proof pending", async () => {
    const own = createDiagnosticFixture();
    roots.push(own.root);
    const subject = await collectPolicySubject(own.root);
    const report = assessPolicyResponsibilities(
      subject,
      own.policy,
      subject.inventory.files.filter((file) => file.path !== "packages/alpha/src/owner.ts"),
    );
    expect(report.assessments[0].reasons).toContain("partial-responsibility-scope");
    const full = assessPolicyResponsibilities(subject, own.policy);
    expect(full.assessments[0].proofs[0].executed).toBe(false);
    expect(full.counts.pending).toBe(1);
  });
});

describe("diagnostic raw slot exact Native positions (#3918)", () => {
  it("adapts only the selected multibyte raw parameter beside another unknown subject", async () => {
    const own = createDiagnosticFixture();
    roots.push(own.root);
    own.put(
      "packages/alpha/src/owner.ts",
      'export function validate(είσοδος: unknown, unrelated: unknown = 1): readonly string[] { return typeof είσοδος === "number" ? [] : ["invalid"]; }\n',
    );
    emitSymbolFixture(own.root);
    for (const rule of own.policy.rules)
      if (own.record.rules.includes(rule.id))
        rule.activeScopes = [...new Set([...rule.activeScopes, "package:alpha"])];
    own.put("scripts/code-quality-policy.json", own.policy);
    const report = await executeCodeQualityPolicy(
      { scope: "repository", mode: "enforce" },
      own.root,
    );
    const native = report.census.filter(
      (entry) =>
        entry.path === "packages/alpha/src/owner.ts" &&
        entry.rule === "anti-slop/no-unknown-parameters",
    );
    expect(native).toHaveLength(2);
    expect(report.adaptations.map(({ finding }) => finding)).toContainEqual(native[0]);
    expect(report.adaptations.map(({ finding }) => finding)).not.toContainEqual(native[1]);
    expect(report.responsibilities.counts.qualified).toBe(0);
    expect(report.outcome).toBe("failed");
  }, 60_000);
});

describe("dictionary Native exact-member before controls (#3918)", () => {
  it.each(["direct", "unicode"])(
    "adapts only exact %s Native dictionary coordinates",
    async (variant) => {
      const own = createDictionaryEnforcementFixture(variant);
      roots.push(own.root);
      const runtime = await executeResponsibilityFixture(own);
      expect(runtime.consume(7)).toBe(7);
      expect(runtime.validate(null).ok).toBe(false);
      expect(runtime.validate({ value: Number.NaN }).ok).toBe(false);
      const report = await executeCodeQualityPolicy(
        { scope: "repository", mode: "enforce" },
        own.root,
      );
      const raw = responsibilityOwnerCensus(report).filter(
        ({ rule }) => rule === "anti-slop/no-unsafe-dictionary-type",
      );
      expect(raw).toHaveLength(5);
      expect(report.responsibilities.counts.ready).toBe(1);
      expect(report.responsibilities.counts.qualified).toBe(0);
      expect(report.responsibilities.assessments[0].proofs[0].executed).toBe(false);
      const adapted = report.adaptations.filter(
        ({ finding }) => finding.rule === "anti-slop/no-unsafe-dictionary-type",
      );
      expect(adapted).toHaveLength(3);
      expect(
        adapted.every(
          ({ finding, slot }) =>
            raw.some((item) => item.line === finding.line && item.column === finding.column) &&
            slot.line === finding.line &&
            slot.column === finding.column,
        ),
      ).toBe(true);
      expect(
        report.violations.filter(({ rule }) => rule === "anti-slop/no-unsafe-dictionary-type"),
      ).toHaveLength(2);
    },
    60_000,
  );

  it("rejects the actual open intersection output for its index facts", async () => {
    const own = createDictionaryEnforcementFixture("intersection");
    roots.push(own.root);
    const report = await executeCodeQualityPolicy(
      { scope: "repository", mode: "enforce" },
      own.root,
    );
    expect(
      responsibilityOwnerCensus(report).some(
        ({ rule }) => rule === "anti-slop/no-unsafe-dictionary-type",
      ),
    ).toBe(true);
    expect(report.responsibilities.counts.qualified).toBe(0);
    expect(report.responsibilities.assessments[0].reasons).toContain(
      "unchecked-validator-dictionary",
    );
  }, 60_000);
});

describe("dictionary actual Native refusal controls (#3918)", () => {
  it.each([
    ["typed-index", 0],
    ["any-index", 0],
    ["counterfeit", 0],
    ["alias-member", 0],
    ["unused", 1],
    ["parameter-intersection", 2],
    ["other-predicate-parameter", 2],
  ])(
    "retains the actual unadapted Native partition for %s",
    async (variant, count) => {
      const own = createDictionaryEnforcementFixture(variant);
      roots.push(own.root);
      const report = await executeCodeQualityPolicy(
        { scope: "repository", mode: "enforce" },
        own.root,
      );
      const raw = responsibilityOwnerCensus(report).filter(
        ({ rule }) => rule === "anti-slop/no-unsafe-dictionary-type",
      );
      expect(report.census.length).toBeGreaterThan(0);
      if (!["typed-index", "any-index"].includes(variant)) expect(raw.length).toBeGreaterThan(0);
      const adapted = report.adaptations.filter(
        ({ finding }) => finding.rule === "anti-slop/no-unsafe-dictionary-type",
      );
      expect(adapted).toHaveLength(count);
      expect(
        report.violations.filter(({ rule }) => rule === "anti-slop/no-unsafe-dictionary-type"),
      ).toHaveLength(raw.length - count);
      expect(report.responsibilities.counts.qualified).toBe(0);
      expect(report.responsibilities.assessments[0].proofs[0].executed).toBe(false);
    },
    60_000,
  );
});

describe("closed public parser responsibility (#3918)", () => {
  it.each([
    "direct",
    "typed-index",
    "recursive",
    "nested-unknown",
    "instantiated-result",
    "reasons",
    "instantiated-reasons",
    "result-alias",
  ])("keeps %s shallow facts structural-ready and semantics pending", async (variant) => {
    const own = createPublicParserFixture(variant);
    roots.push(own.root);
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(report.assessments[0].structural).toBe("ready");
    expect(report.assessments[0].proofs[0].executed).toBe(false);
    expect(report.counts).toMatchObject({ qualified: 0, pending: 1 });
  });
  it.each(["unknown", "any", "unknown-index", "any-index"])(
    "rejects immediate %s output",
    async (variant) => {
      const own = createPublicParserFixture(variant);
      roots.push(own.root);
      const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
      expect(report.assessments[0].structural).toBe("invalid");
      expect(report.assessments[0].reasons).toContain("unchecked-public-parser-output");
      expect(report.counts.rejected).toBe(1);
    },
  );
  it.each([
    "optional-value",
    "extra-envelope",
    "mutable-errors",
    "mutable-reasons",
    "unknown-reasons",
    "any-reasons",
    "optional-reasons",
    "extra-reasons",
    "both-failure-fields",
    "string-reasons",
    "array-like-reasons",
  ])("keeps unsupported %s envelope incomplete", async (variant) => {
    const own = createPublicParserFixture(variant);
    roots.push(own.root);
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(report.assessments[0].structural).toBe("incomplete");
    expect(report.counts.pending).toBe(1);
  });
  it.each([
    "constant",
    "discarded",
    "input",
    "mutable",
    "asserted",
    "nonnull",
    "satisfies",
    "nested",
    "extra",
    "destructured",
    "alias",
    "counterfeit",
    "asserted-result",
    "asserted-return",
    "annotated-local",
    "counterfeit-type",
  ])("never adapts %s forwarding", async (variant) => {
    const own = createPublicParserFixture(variant);
    roots.push(own.root);
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(report.assessments[0].structural).not.toBe("ready");
    expect(report.assessments[0].slots ?? []).toEqual([]);
    expect(report.counts.qualified).toBe(0);
  });
  it("requires same owner, declared proof, actual selector and complete producer scope", async () => {
    const own = createPublicParserFixture();
    roots.push(own.root);
    const subject = await collectPolicySubject(own.root);
    const partial = assessPolicyResponsibilities(
      subject,
      own.policy,
      subject.inventory.files.filter((file) => file.path !== "packages/alpha/src/owner.ts"),
    );
    expect(partial.assessments[0].reasons).toContain("partial-responsibility-scope");
    own.record.consumer.specifier = "alpha";
    expect(assessPolicyResponsibilities(subject, own.policy).assessments[0].structural).not.toBe(
      "ready",
    );
    own.record.consumer.specifier = "alpha/runtime";
    own.record.proofs = ["packages/alpha/src/absent.test.ts"];
    expect(assessPolicyResponsibilities(subject, own.policy).assessments[0].structural).toBe(
      "incomplete",
    );
  });
});

describe("public parser owner and export refusal (#3918)", () => {
  it("compiles the genuine foreign proof before refusing its owner", async () => {
    const own = createPublicParserFixture("foreign-proof");
    roots.push(own.root);
    const subject = await collectPolicySubject(own.root);
    const resolver = createSymbolResolver(subject, {}, [
      { owner: "packages/beta", paths: own.record.proofs },
    ]);
    try {
      expect(resolver.resolveProofConsumer(own.record.consumer).identities[0].owner).toBe("beta");
      expect(resolver.resolveProofExport(own.record.input).identities[0].owner).toBe("alpha");
    } finally {
      resolver.close();
    }
    expect(assessPolicyResponsibilities(subject, own.policy).assessments[0].reasons).toContain(
      "foreign-responsibility-owner",
    );
  });
  it("refuses a type-only public entry with a type-correct proof", async () => {
    const own = createPublicParserFixture("type-only");
    roots.push(own.root);
    const subject = await collectPolicySubject(own.root);
    const resolver = createSymbolResolver(subject, {}, [
      { owner: "packages/alpha", paths: own.record.proofs },
    ]);
    try {
      expect(resolver.resolveProofConsumer(own.record.consumer).signatures).toHaveLength(1);
    } finally {
      resolver.close();
    }
    expect(assessPolicyResponsibilities(subject, own.policy).assessments[0].structural).toBe(
      "incomplete",
    );
  });
});

describe("public parser canonical producer premises (#3918)", () => {
  it.each(["generic", "explicit-this"])(
    "keeps %s producer unsupported without raw slots",
    async (variant) => {
      const own = createPublicParserFixture(variant);
      roots.push(own.root);
      const subject = await collectPolicySubject(own.root);
      const resolver = createSymbolResolver(subject, {}, [
        { owner: "packages/alpha", paths: own.record.proofs },
      ]);
      try {
        expect(resolver.resolveProofConsumer(own.record.consumer).signatures).toHaveLength(1);
        expect(resolver.resolveProofExport(own.record.input).signatures).toHaveLength(1);
      } finally {
        resolver.close();
      }
      const report = assessPolicyResponsibilities(subject, own.policy);
      expect(report.assessments[0].structural).toBe("incomplete");
      expect(report.assessments[0].slots).toEqual([]);
      expect(report.counts.qualified).toBe(0);
    },
  );
});

describe("closed monotonic semantic proof selectors", () => {
  it("admits declared exact assertions without changing default assessment", () => {
    const policy = responsibilityPolicy([responsibilityRecord()]);
    const record = policy.responsibilities[0];
    record.proofAssertions = [
      { path: record.proofs[0], testName: "actual producer healthy and refusal" },
    ];
    expect(validatePolicy(policy)).toEqual([]);
  });

  it.each(["foreign-path", "duplicate", "empty", "command"])("refuses %s selectors", (kind) => {
    const policy = responsibilityPolicy([responsibilityRecord()]);
    const record = policy.responsibilities[0];
    const assertion = { path: record.proofs[0], testName: "actual producer healthy and refusal" };
    record.proofAssertions = kind === "empty" ? [] : [assertion];
    if (kind === "foreign-path") assertion.path = "scripts/__tests__/unregistered.test.mjs";
    if (kind === "duplicate") record.proofAssertions.push({ ...assertion });
    if (kind === "command") assertion.command = "arbitrary";
    expect(validatePolicy(policy)).toContain("invalid-responsibilities");
  });

  it("refuses selector history removal or rebinding", () => {
    const policy = responsibilityPolicy([responsibilityRecord()]);
    const record = policy.responsibilities[0];
    record.proofAssertions = [
      { path: record.proofs[0], testName: "actual producer healthy and refusal" },
    ];
    const previous = structuredClone(policy);
    record.proofAssertions[0].testName = "unrelated case";
    expect(validatePolicy(policy, [previous])).toContain("responsibility-shrank");
    delete record.proofAssertions;
    expect(validatePolicy(policy, [previous])).toContain("responsibility-shrank");
  });
});

// Genuine installed Vitest/public-parser controls for the new result admission seam.
// These helper fixtures do not qualify any production responsibility or import saved green facts.
async function semanticProofFixture(mode) {
  const { mkdtempSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "keiko-semantic-proof-"));
  roots.push(root);
  const tools = new URL("../../", import.meta.url);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "owned-semantic-proof", type: "module" }),
  );
  writeFileSync(join(root, "package-lock.json"), readFileSync(new URL("package-lock.json", tools)));
  symlinkSync(new URL("node_modules", tools), join(root, "node_modules"), "junction");
  const title = "actual public healthy and malformed diagnostic";
  const assertion = `() => { expect(check(defaults)).toHaveLength(0); expect(check(null)).toContain("limits must be an object"); }`;
  const call =
    mode === "todo"
      ? `it.todo(${JSON.stringify(title)});`
      : `it${mode === "skip" ? ".skip" : ""}(${JSON.stringify(title)}, ${assertion});`;
  const source = `import { it, expect } from "vitest";\nimport { validateHtmlManualScopeLimits as check } from "@oscharko-dev/keiko-contracts/runtime/html-manual-source";\nimport { DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS as defaults } from "@oscharko-dev/keiko-contracts/runtime/documentation-manual-proposal";\n${call}\n${mode === "duplicate" ? call : ""}`;
  const path = "selected-proof.test.mjs";
  writeFileSync(join(root, path), source);
  return {
    root,
    records: [
      {
        id: "owned-helper-proof",
        proofs: [path],
        proofAssertions: [{ path, testName: mode === "missing" ? "absent assertion" : title }],
      },
    ],
  };
}

describe("fresh semantic assertion observations", () => {
  it.skipIf(process.platform === "win32")(
    "admits a genuinely reached actual public proof",
    async () => {
      const { executeResponsibilityProofs } =
        await import("../lib/code-quality-responsibility-proofs.mjs");
      const own = await semanticProofFixture("healthy");
      const observations = await executeResponsibilityProofs(own.root, own.records);
      expect(observations.records).toStrictEqual([
        {
          id: "owned-helper-proof",
          assertions: [
            {
              path: "selected-proof.test.mjs",
              testName: "actual public healthy and malformed diagnostic",
              status: "passed",
            },
          ],
          executedPaths: ["selected-proof.test.mjs"],
        },
      ]);
      expect(observations.process.directChildClosed).toBe(true);
      expect(observations.process.groupAbsent).toBe(true);
      expect(observations.process.reportBytes).toBeGreaterThan(0);
    },
    195_000,
  );

  it.skipIf(process.platform === "win32").each(["missing", "skip", "todo", "duplicate"])(
    "never qualifies %s assertions from a genuine child result",
    async (mode) => {
      const { executeResponsibilityProofs } =
        await import("../lib/code-quality-responsibility-proofs.mjs");
      const own = await semanticProofFixture(mode);
      await expect(executeResponsibilityProofs(own.root, own.records)).rejects.toThrow(
        "semantic-proof-assertion-missing",
      );
    },
    195_000,
  );
});

async function inheritedPipeSurvivorFixture() {
  const own = await semanticProofFixture("healthy");
  const owner = "owned-semantic-inherited-pipe";
  const pidFile = join(own.root, "owned-survivor.json");
  own.records[0].proofAssertions[0].testName = "owned inherited-pipe output-overflow fixture";
  const idle =
    'process.send("ready", () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));';
  const source = `import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
it("owned inherited-pipe output-overflow fixture", async () => {
  const survivor = spawn(process.execPath, ["-e", ${JSON.stringify(idle)}], {
    detached: true, stdio: ["ignore", process.stdout, process.stderr, "ipc"],
  });
  writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ owner: ${JSON.stringify(owner)}, pid: survivor.pid }));
  await new Promise((resolve, reject) => {
    survivor.once("message", resolve);
    survivor.once("error", reject);
  });
  survivor.disconnect();
  survivor.unref();
  // The actual unchanged 32MiB production output bound triggers group termination.
  process.stdout.write(Buffer.alloc(32 * 1024 * 1024 + 1, 97));
  await new Promise(() => {});
});`;
  writeFileSync(join(own.root, "selected-proof.test.mjs"), source);
  return { ...own, owner, pidFile };
}

async function cleanupInheritedPipeSurvivor(own, existsSync) {
  if (!existsSync(own.pidFile)) return;
  const survivor = JSON.parse(readFileSync(own.pidFile, "utf8"));
  if (survivor.owner !== own.owner || !Number.isSafeInteger(survivor.pid) || survivor.pid <= 0)
    throw new TypeError("owned-survivor-fixture-identity-invalid");
  process.kill(-survivor.pid, "SIGKILL");
  await vi.waitFor(
    () => {
      expect(() => process.kill(-survivor.pid, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    },
    { timeout: 5_000 },
  );
}

// A real escaped fixture child deliberately retains the actual npm-owned pipe descriptors.
// This verifies failed direct-close settlement, never escaped-descendant containment.
it.skipIf(process.platform === "win32")(
  "fails output overflow and closes inherited readers without certifying the escaped survivor",
  async () => {
    const { executeResponsibilityProofs } =
      await import("../lib/code-quality-responsibility-proofs.mjs");
    const { existsSync } = await import("node:fs");
    const own = await inheritedPipeSurvivorFixture();
    try {
      await expect(executeResponsibilityProofs(own.root, own.records)).rejects.toThrow(
        "semantic-proof-output-limit",
      );
      const survivor = JSON.parse(readFileSync(own.pidFile, "utf8"));
      expect(survivor.owner).toBe(own.owner);
      expect(Number.isSafeInteger(survivor.pid) && survivor.pid > 0).toBe(true);
      expect(() => process.kill(-survivor.pid, 0)).not.toThrow();
    } finally {
      await cleanupInheritedPipeSurvivor(own, existsSync);
    }
  },
  30_000,
);

async function installSemanticFixtureTools(own) {
  roots.push(own.root);
  await installResponsibilityFixtureTools(own);
}

async function directSemanticQualifierFixture(mode) {
  const own = createEnforcementFixture();
  await installSemanticFixtureTools(own);
  const config = JSON.parse(readFileSync(join(own.root, "packages/alpha/tsconfig.json"), "utf8"));
  config.exclude = ["**/*.test.ts"];
  own.put("packages/alpha/tsconfig.json", config);
  emitSymbolFixture(own.root);
  const proofPath = own.record.proofs[0];
  const titles = [
    "actual public healthy producer and consumer",
    "actual public malformed producer refusal",
  ];
  const target = join(
    own.root,
    mode === "source" ? "packages/alpha/src/owner.ts" : "packages/alpha/dist/owner.js",
  );
  const mutation =
    mode === "healthy"
      ? ""
      : `writeFileSync(${JSON.stringify(target)}, ${JSON.stringify(readFileSync(target, "utf8") + "\n")});`;
  own.put(
    proofPath,
    `import { it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { validate, consume } from "alpha/runtime";
it(${JSON.stringify(titles[0])}, () => {
  expect(validate(1)).toEqual({ ok: true, value: 1 });
  expect(consume(1)).toBe(1);
});
it(${JSON.stringify(titles[1])}, () => {
  expect(validate(null)).toEqual({ ok: false });
  ${mutation}
});`,
  );
  own.record.proofAssertions = titles.map((testName) => ({ path: proofPath, testName }));
  own.put("scripts/code-quality-policy.json", own.policy);
  own.subject = await collectPolicySubject(own.root);
  return { ...own, proofPath, target };
}

describe("direct semantic responsibility qualification", () => {
  it.skipIf(process.platform === "win32")(
    "qualifies one responsibility only after actual public healthy and malformed assertions pass",
    async () => {
      const own = await directSemanticQualifierFixture("healthy");
      const report = await qualifyPolicyResponsibilities(own.subject, own.policy);
      expect(report.counts).toMatchObject({ ready: 1, qualified: 1, pending: 0 });
      expect(report.execution).toMatchObject({ status: "passed", invocationCount: 1 });
      expect(report.execution.process).toMatchObject({
        directChildClosed: true,
        groupAbsent: true,
      });
      expect(report.assessments[0]).toMatchObject({ semantic: "qualified", obligations: [] });
      expect(report.assessments[0].proofs).toEqual([
        expect.objectContaining({ path: own.proofPath, executed: true }),
      ]);
      expect(report.assessments[0].proofAssertions).toEqual(
        own.record.proofAssertions.map((assertion) => ({ ...assertion, status: "passed" })),
      );
    },
    195_000,
  );

  it.skipIf(process.platform === "win32").each(["source", "runtime"])(
    "refuses %s mutation performed by the actual reached child proof",
    async (mode) => {
      const own = await directSemanticQualifierFixture(mode);
      const before = readFileSync(own.target, "utf8");
      await expect(qualifyPolicyResponsibilities(own.subject, own.policy)).rejects.toThrow(
        "symbol-subject-changed",
      );
      expect(readFileSync(own.target, "utf8")).toBe(before + "\n");
    },
    195_000,
  );
});

async function embeddedSemanticCliFixture(kind) {
  const { unlinkSync } = await import("node:fs");
  const own = await directSemanticQualifierFixture("healthy");
  const args =
    kind === "healthy"
      ? ["-b", "packages/alpha/tsconfig.json", "--force"]
      : ["-p", "packages/alpha/tsconfig.json"];
  if (kind === "missing-runtime") args.push("--emitDeclarationOnly");
  await installSemanticFixtureBuild(own, args);
  if (kind === "legacy") {
    delete own.policy.responsibilities;
    own.policy.version = 1;
  }
  if (kind === "empty") own.policy.responsibilities = [];
  if (kind === "missing-selector") delete own.record.proofAssertions;
  if (kind === "foreign-selector") own.record.proofAssertions[0].path = "unregistered.test.ts";
  own.put("scripts/code-quality-policy.json", own.policy);
  const runtime = join(own.root, "packages/alpha/dist/owner.js");
  const emittedRuntime = readFileSync(runtime, "utf8");
  if (kind === "healthy") own.put("packages/alpha/dist/owner.js", "export const stale = true;\n");
  else unlinkSync(runtime);
  return { ...own, emittedRuntime };
}

async function collectiveSemanticFixture(variant) {
  return createCollectiveSemanticFixture(variant, roots);
}

describe("collective public parser actual CLI qualification (#3918)", () => {
  it
    .skipIf(process.platform === "win32")
    .each(["private-module-unsafe", "private-module-missing-assertion"])(
    "preserves structural applicability and fails whole semantic qualification for %s",
    async (variant) => {
      const own = await collectiveSemanticFixture(variant);
      const staticReport = await executeCodeQualityPolicy(
        { mode: "enforce", scope: "repository", json: true },
        own.root,
      );
      expect(staticReport.violations).toEqual([]);
      expect(staticReport.enforcementOutcome).toBe("passed");
      expect(staticReport.responsibilities.counts).toMatchObject({
        ready: 2,
        qualified: 0,
        pending: 2,
      });
      const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        expect(
          await codeQualityPolicyMain(["--json", "--qualify-responsibilities"], own.root),
        ).toBe(1);
        expect(stderr.mock.calls.join(" ")).toContain(
          variant.endsWith("unsafe")
            ? "semantic-proof-execution-failed"
            : "semantic-proof-assertion-missing",
        );
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
      }
    },
    195_000,
  );

  it.skipIf(process.platform === "win32")(
    "qualifies imported helper slots only through the unchanged whole public proof runner",
    async () => {
      const own = await collectiveSemanticFixture("private-module");
      const report = await executeCodeQualityPolicy(embeddedSemanticOptions(), own.root);
      expect(report.violations).toEqual([]);
      expect(report.outcome).toBe("passed");
      expect(report.responsibilities.counts).toMatchObject({ ready: 2, qualified: 2, pending: 0 });
      expect(report.responsibilities.execution).toMatchObject({
        status: "passed",
        invocationCount: 1,
        process: { directChildClosed: true, groupAbsent: true },
      });
    },
    195_000,
  );

  it.skipIf(process.platform === "win32")(
    "executes both bound public roots once before granting semantics",
    async () => {
      const own = await collectiveSemanticFixture("direct");
      const report = await executeCodeQualityPolicy(embeddedSemanticOptions(), own.root);
      expect(report.responsibilities.assessments.map((record) => record.reasons)).toEqual([[], []]);
      expect(report.violations).toEqual([]);
      expect(report.outcome).toBe("passed");
      expect(report.responsibilities.counts).toMatchObject({ ready: 2, qualified: 2, pending: 0 });
      expect(report.responsibilities.execution).toMatchObject({
        status: "passed",
        invocationCount: 1,
        process: { directChildClosed: true, groupAbsent: true },
      });
      expect(
        report.responsibilities.assessments.every((record) =>
          record.proofAssertions.every((proof) => proof.status === "passed"),
        ),
      ).toBe(true);
    },
    195_000,
  );

  it.skipIf(process.platform === "win32").each(["unsafe", "missing-assertion"])(
    "returns a real nonzero CLI verdict for %s despite complete structural applicability",
    async (variant) => {
      const own = await collectiveSemanticFixture(variant);
      const staticReport = await executeCodeQualityPolicy(
        { mode: "enforce", scope: "repository", json: true },
        own.root,
      );
      expect(staticReport.responsibilities.assessments.map((record) => record.reasons)).toEqual([
        [],
        [],
      ]);
      expect(staticReport.violations).toEqual([]);
      expect(staticReport.enforcementOutcome).toBe("passed");
      expect(staticReport.responsibilities.counts).toMatchObject({
        ready: 2,
        qualified: 0,
        pending: 2,
      });
      const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const code = await codeQualityPolicyMain(
          ["--json", "--qualify-responsibilities"],
          own.root,
        );
        expect(code).toBe(1);
        expect(stdout.mock.calls.join(" ")).not.toContain('"outcome":"passed"');
        expect(stderr.mock.calls.join(" ")).toContain(
          variant === "unsafe"
            ? "semantic-proof-execution-failed"
            : "semantic-proof-assertion-missing",
        );
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
      }
    },
    195_000,
  );
});

describe("explicit semantic CLI build and admission", () => {
  it.skipIf(process.platform === "win32")(
    "rebuilds stale actual runtime before evaluating and qualifying its public assertions",
    async () => {
      const own = await embeddedSemanticCliFixture("healthy");
      const runtime = join(own.root, "packages/alpha/dist/owner.js");
      expect(readFileSync(runtime, "utf8")).toBe("export const stale = true;\n");
      const report = await executeCodeQualityPolicy(embeddedSemanticOptions(), own.root);
      expect(readFileSync(runtime, "utf8")).toBe(own.emittedRuntime);
      expect(report).toMatchObject({
        mode: "enforce",
        outcome: "passed",
        enforcementOutcome: "passed",
      });
      expect(report.responsibilities.counts).toMatchObject({ qualified: 1, pending: 0 });
      expect(report.responsibilities.execution).toMatchObject({
        status: "passed",
        invocationCount: 1,
      });
      expect(report.counts.visited).toBe(report.counts.expected);
    },
    195_000,
  );

  it.skipIf(process.platform === "win32").each([
    ["legacy", "semantic-proof-assertion-missing"],
    ["empty", "semantic-proof-assertion-missing"],
    ["missing-selector", "semantic-proof-assertion-missing"],
    ["foreign-selector", "invalid-responsibilities"],
  ])(
    "refuses %s before the actual build",
    async (kind, reason) => {
      const { existsSync } = await import("node:fs");
      const own = await embeddedSemanticCliFixture(kind);
      await expect(executeCodeQualityPolicy(embeddedSemanticOptions(), own.root)).rejects.toThrow(
        reason,
      );
      expect(existsSync(join(own.root, "packages/alpha/dist/owner.js"))).toBe(false);
    },
    195_000,
  );

  it.skipIf(process.platform === "win32")(
    "refuses an actual declaration-only build that leaves the public runtime absent",
    async () => {
      const { existsSync } = await import("node:fs");
      const own = await embeddedSemanticCliFixture("missing-runtime");
      await expect(executeCodeQualityPolicy(embeddedSemanticOptions(), own.root)).rejects.toThrow(
        "unpacked-export-target",
      );
      expect(existsSync(join(own.root, "packages/alpha/dist/owner.js"))).toBe(false);
      expect(existsSync(join(own.root, "packages/alpha/dist/owner.d.ts"))).toBe(true);
    },
    195_000,
  );
});

describe("direct semantic prerequisite refusals", () => {
  it("reports empty obligations as incomplete without assigning qualification", async () => {
    const own = await directSemanticQualifierFixture("healthy");
    own.policy.responsibilities = [];
    own.put("scripts/code-quality-policy.json", own.policy);
    own.subject = await collectPolicySubject(own.root);
    const report = await qualifyPolicyResponsibilities(own.subject, own.policy);
    expect(report.assessments).toEqual([]);
    expect(report.counts).toMatchObject({ qualified: 0, pending: 0 });
    expect(report.execution).toEqual({
      status: "failed",
      reason: "semantic-proof-structural-incomplete",
    });
  }, 195_000);

  it.skipIf(process.platform === "win32")(
    "refuses an unmapped declaration-only public runtime at subject collection",
    async () => {
      const { unlinkSync } = await import("node:fs");
      const own = await directSemanticQualifierFixture("healthy");
      const config = JSON.parse(
        readFileSync(join(own.root, "packages/alpha/tsconfig.json"), "utf8"),
      );
      config.compilerOptions.emitDeclarationOnly = true;
      own.put("packages/alpha/tsconfig.json", config);
      emitSymbolFixture(own.root);
      unlinkSync(join(own.root, "packages/alpha/dist/owner.js"));
      await expect(collectPolicySubject(own.root)).rejects.toThrow("unmapped-production-export");
    },
    195_000,
  );
});

describe("explicit semantic CLI build and admission", () => {
  it.skipIf(process.platform === "win32")(
    "refuses an actual failed build before qualifying or replacing stale runtime",
    async () => {
      const own = await embeddedSemanticCliFixture("healthy");
      own.put("scripts/semantic-fixture-build.mjs", "process.exit(7);\n");
      await expect(executeCodeQualityPolicy(embeddedSemanticOptions(), own.root)).rejects.toThrow(
        "semantic-proof-build-failed",
      );
      expect(readFileSync(join(own.root, "packages/alpha/dist/owner.js"), "utf8")).toBe(
        "export const stale = true;\n",
      );
    },
    195_000,
  );
});

describe("captured unknown argument semantic admission (#3918)", () => {
  it("requires qualified semantics only for the supplemental captured argument", async () => {
    const { adaptResponsibilityDiagnostics } =
      await import("../lib/code-quality-responsibilities.mjs");
    const legacy = {
      path: "owner.ts",
      rule: "anti-slop/no-known-value-widening",
      line: 1,
      column: 1,
    };
    const captured = { ...legacy, line: 2 };
    const report = { census: [legacy, captured], violations: [legacy, captured] };
    const assessment = {
      id: "validator",
      kind: "validator",
      structural: "ready",
      slots: [legacy, { ...captured, capturedUnknownPredicate: true }],
    };
    const pending = adaptResponsibilityDiagnostics(report, {
      assessments: [{ ...assessment, semantic: "pending" }],
    });
    expect(pending.violations).toEqual([captured]);
    const qualified = adaptResponsibilityDiagnostics(report, {
      assessments: [{ ...assessment, semantic: "qualified" }],
    });
    expect(qualified.violations).toEqual([]);
    expect(qualified.census).toEqual(report.census);
  });
});

describe("raw own-property reader RETURN only (#3918)", () => {
  it.each(["pending", "rejected", undefined])("keeps %s semantics unadapted", async (semantic) => {
    const { adaptResponsibilityDiagnostics } =
      await import("../lib/code-quality-responsibilities.mjs");
    const finding = { path: "owner.ts", rule: "anti-slop/no-unknown-returns", line: 1, column: 1 };
    const assessments = [
      {
        id: "reader",
        kind: "raw-own-property-reader",
        structural: "ready",
        semantic,
        slots: [finding],
      },
    ];
    expect(
      adaptResponsibilityDiagnostics({ census: [finding], violations: [finding] }, { assessments })
        .violations,
    ).toEqual([finding]);
  });

  it("adapts the qualified reader coordinate while retaining every caller coordinate", async () => {
    const { adaptResponsibilityDiagnostics } =
      await import("../lib/code-quality-responsibilities.mjs");
    const reader = { path: "owner.ts", rule: "anti-slop/no-unknown-returns", line: 1, column: 1 };
    const caller = { ...reader, line: 2 };
    const parameter = { ...reader, rule: "anti-slop/no-unknown-parameters" };
    const census = [reader, caller, parameter];
    const assessments = [
      {
        id: "reader",
        kind: "raw-own-property-reader",
        structural: "ready",
        semantic: "qualified",
        slots: [reader],
      },
    ];
    const result = adaptResponsibilityDiagnostics({ census, violations: census }, { assessments });
    expect(result.census).toEqual(census);
    expect(result.violations).toEqual([caller, parameter]);
    expect(result.adaptations).toHaveLength(1);
  });
});

function minimalRawReaderFixture(
  body = "return Object.hasOwn(record, key) ? record[key] : undefined;",
  prefix = "",
  result = "unknown",
) {
  const own = createPublicParserFixture();
  roots.push(own.root);
  const path = own.record.consumer.consumerPath;
  own.put(
    "packages/alpha/src/owner.ts",
    `${prefix}
export function ownField(record: Record<string, unknown>, key: string): ${result} { ${body} }
export type ParseResult = { ok: true; value: number } | { ok: false; errors: readonly string[] };
export function validate(input: unknown): ParseResult {
  if (typeof input !== "object" || input === null) return { ok: false, errors: ["invalid"] };
  const value = ownField(input as Record<string, unknown>, "value");
  return typeof value === "number" ? { ok: true, value } : { ok: false, errors: ["invalid"] };
}
`,
  );
  const proof = readFileSync(join(own.root, path), "utf8");
  const publicImport = 'import { validate as parse, type ParseResult } from "alpha/runtime";';
  expect(proof).toContain(publicImport);
  own.put(
    path,
    proof.replace(
      publicImport,
      'import { ownField, validate as parse, type ParseResult } from "alpha/runtime";',
    ),
  );
  const selector = { consumerPath: path, specifier: "alpha/runtime", exportName: "ownField" };
  Object.assign(own.record, {
    kind: "raw-own-property-reader",
    input: { ...selector, parameterIndex: 0 },
    transform: selector,
    rules: ["anti-slop/no-unknown-returns"],
    proofAssertions: [{ path, testName: "reader control" }],
  });
  own.put("scripts/code-quality-policy.json", own.policy);
  emitSymbolFixture(own.root);
  return own;
}

describe("exact canonical raw reader body controls (#3918)", () => {
  it("binds an actual public reader and complete owning parser witness without qualification", async () => {
    const own = minimalRawReaderFixture();
    expect(validatePolicy(own.policy)).toEqual([]);
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(report.assessments[0].structural).toBe("ready");
    expect(report.assessments[0].consumerBinding.readerWitness.bound).toBe(true);
    expect(report.assessments[0].slots).toHaveLength(1);
    expect(report.assessments[0].slots[0].kind).toBe("return");
    expect(report.counts.qualified).toBe(0);
  });

  it.each([
    ["inherited", "return record[key];", "", "unknown"],
    [
      "different key",
      "return Object.hasOwn(record, key) ? record['other'] : undefined;",
      "",
      "unknown",
    ],
    [
      "asserted",
      "return (Object.hasOwn(record, key) ? record[key] : undefined) as unknown;",
      "",
      "unknown",
    ],
    [
      "mutated body",
      "key = 'other'; return Object.hasOwn(record, key) ? record[key] : undefined;",
      "",
      "unknown",
    ],
    [
      "fake Object",
      "return Object.hasOwn(record, key) ? record[key] : undefined;",
      "const Object = { hasOwn: (_record: object, _key: string): boolean => true };",
      "unknown",
    ],
    [
      "domain declaration",
      "return Object.hasOwn(record, key) ? String(record[key]) : '';",
      "",
      "string",
    ],
  ])("refuses %s reader", async (_name, body, prefix, result) => {
    const own = minimalRawReaderFixture(body, prefix, result);
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(report.assessments[0].structural).not.toBe("ready");
    expect(report.assessments[0].slots ?? []).toEqual([]);
    expect(report.counts.qualified).toBe(0);
  });
});

describe("unsupported raw reader public proof flow (#3918)", () => {
  it("remains incomplete without qualification or RETURN adaptation", async () => {
    const own = minimalRawReaderFixture();
    const path = own.record.consumer.consumerPath;
    const proof = readFileSync(join(own.root, path), "utf8");
    expect(proof).toContain("return result;");
    own.put(path, proof.replace("return result;", "return parse(input);"));
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(report.assessments[0].consumerBinding.readerWitness.bound).toBe(true);
    expect(report.assessments[0].structural).toBe("incomplete");
    expect(report.assessments[0].reasons).toEqual(["unsupported-raw-reader-public-proof-binding"]);
    expect(report.assessments[0].slots).toEqual([]);
    expect(report.counts.qualified).toBe(0);
    const { adaptResponsibilityDiagnostics } =
      await import("../lib/code-quality-responsibilities.mjs");
    const reader = {
      path: "packages/alpha/src/owner.ts",
      rule: "anti-slop/no-unknown-returns",
      line: 2,
      column: 1,
    };
    const result = adaptResponsibilityDiagnostics(
      { census: [reader], violations: [reader] },
      report,
    );
    expect(result.violations).toEqual([reader]);
    expect(result.adaptations).toEqual([]);
  });
});

function rewriteMinimalRawReader(own, before, after) {
  const path = "packages/alpha/src/owner.ts";
  const source = readFileSync(join(own.root, path), "utf8");
  expect(source).toContain(before);
  own.put(path, source.replace(before, after));
  emitSymbolFixture(own.root);
}

describe("bounded raw reader signature and witness controls (#3918)", () => {
  it.each([
    ["Record shadow", "", "type Record<K extends string, V> = { [P in K]: V };\n"],
    ["any dictionary", "record: Record<string, unknown>", "record: Record<string, any>"],
    ["optional key", "key: string", "key: string = 'value'"],
    ["different receiver", "Object.hasOwn(record, key)", "Object.hasOwn({}, key)"],
    [
      "callback body",
      "return Object.hasOwn(record, key) ? record[key] : undefined;",
      "return (() => Object.hasOwn(record, key) ? record[key] : undefined)();",
    ],
    [
      "receiver alias",
      "return Object.hasOwn(record, key) ? record[key] : undefined;",
      "const receiver = record; return Object.hasOwn(receiver, key) ? receiver[key] : undefined;",
    ],
  ])("refuses %s without qualification", async (_name, before, after) => {
    const own = minimalRawReaderFixture();
    rewriteMinimalRawReader(own, before, after);
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(report.assessments[0].structural).not.toBe("ready");
    expect(report.assessments[0].slots ?? []).toEqual([]);
    expect(report.counts.qualified).toBe(0);
  });

  it("keeps a missing actual validator witness incomplete", async () => {
    const own = minimalRawReaderFixture();
    rewriteMinimalRawReader(
      own,
      'ownField(input as Record<string, unknown>, "value")',
      '(input as Record<string, unknown>)["value"]',
    );
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(report.assessments[0].structural).toBe("incomplete");
    expect(report.assessments[0].reasons).toEqual(["unsupported-raw-reader-validator-witness"]);
    expect(report.assessments[0].consumerBinding.bound).toBe(false);
    expect(report.assessments[0].slots).toEqual([]);
    expect(report.counts.qualified).toBe(0);
  });

  it("rejects an explicit unsafe owning-parser envelope", async () => {
    const own = minimalRawReaderFixture();
    rewriteMinimalRawReader(own, "value: number", "value: unknown");
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(report.assessments[0].structural).toBe("invalid");
    expect(report.assessments[0].reasons).toContain("unchecked-raw-reader-validator-output");
    expect(report.assessments[0].slots).toEqual([]);
    expect(report.counts.qualified).toBe(0);
  });
});

describe("within-call role resolution deduplication", () => {
  it("resolves repeated export selectors once through the actual compiler resolver", async () => {
    const own = createResponsibilityFixture();
    roots.push(own.root);
    const subject = await collectPolicySubject(own.root);
    const resolver = createSymbolResolver(subject);
    try {
      const resolve = vi.spyOn(resolver, "resolveExport");
      const roles = resolveRoles(resolver, responsibilityRecord());
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(roles.input).toEqual(roles.transform);
      expect(roles.input).toEqual(roles.output);
      expect(roles.input).not.toBe(roles.transform);
      roles.input.identities[0].owner = "modified";
      expect(roles.transform.identities[0].owner).toBe("alpha");
      expect(roles.output.identities[0].owner).toBe("alpha");
      resolveRoles(resolver, responsibilityRecord());
      expect(resolve).toHaveBeenCalledTimes(4);
      const sameConsumer = responsibilityRecord();
      sameConsumer.consumer = { ...sameConsumer.transform, owner: "alpha" };
      const independent = resolveRoles(resolver, sameConsumer);
      expect(resolve).toHaveBeenCalledTimes(6);
      expect(independent.consumer).toEqual(independent.transform);
      expect(independent.consumer).not.toBe(independent.transform);
    } finally {
      resolver.close();
    }
  });
  it.each(["proxy", "accessor", "inherited"])(
    "keeps %s selectors on the actual cold path",
    async (kind) => {
      const own = createResponsibilityFixture();
      roots.push(own.root);
      const subject = await collectPolicySubject(own.root);
      const record = responsibilityRecord();
      const original = record.transform;
      let selector;
      if (kind === "proxy") selector = new Proxy(original, {});
      if (kind === "accessor") {
        selector = { ...original };
        Object.defineProperty(selector, "exportName", { get: () => original.exportName });
      }
      if (kind === "inherited") selector = Object.create(original);
      record.input = selector;
      record.transform = selector;
      record.output = selector;
      const resolver = createSymbolResolver(subject);
      try {
        const resolve = vi.spyOn(resolver, "resolveExport");
        const roles = resolveRoles(resolver, record);
        expect(resolve).toHaveBeenCalledTimes(4);
        expect(roles.input).toEqual(roles.transform);
        expect(roles.transform).toEqual(roles.output);
      } finally {
        resolver.close();
      }
    },
  );
  it("keeps proof consumers separate and normal-mode selectors cold across calls", async () => {
    const own = createDiagnosticFixture();
    roots.push(own.root);
    const subject = await collectPolicySubject(own.root);
    const resolver = createSymbolResolver(subject, {}, [
      { owner: "packages/alpha", paths: own.record.proofs },
    ]);
    try {
      const proof = vi.spyOn(resolver, "resolveProofExport");
      const consumer = vi.spyOn(resolver, "resolveProofConsumer");
      const normal = vi.spyOn(resolver, "resolveExport");
      const roles = resolveRoles(resolver, own.record);
      expect(proof).toHaveBeenCalledTimes(1);
      expect(consumer).toHaveBeenCalledTimes(1);
      expect(normal).not.toHaveBeenCalled();
      expect(roles.input).toEqual(roles.output);
      expect(() => resolveRoles(resolver, { ...own.record, kind: "validator" })).toThrow();
      expect(normal).toHaveBeenCalledTimes(1);
      expect(proof).toHaveBeenCalledTimes(1);
    } finally {
      resolver.close();
    }
  });
  it("refuses changed source and missing exports after a successful role resolution", async () => {
    const own = createResponsibilityFixture();
    roots.push(own.root);
    const subject = await collectPolicySubject(own.root);
    const resolver = createSymbolResolver(subject);
    try {
      const record = responsibilityRecord();
      resolveRoles(resolver, record);
      const missing = { ...record, output: { ...record.output, exportName: "missing" } };
      expect(() => resolveRoles(resolver, missing)).toThrow("unresolved-owner-symbol");
      const path = "packages/alpha/src/owner.ts";
      own.put(
        path,
        readFileSync(join(own.root, path), "utf8") + "\nexport const changed = true;\n",
      );
      expect(() => resolveRoles(resolver, record)).toThrow("symbol-subject-changed");
    } finally {
      resolver.close();
    }
  });
});

function reflectionObservationFixture(
  body = "const property: unknown = Reflect.get(value, key); return property;",
  prefix = "",
) {
  const own = createResponsibilityFixture();
  roots.push(own.root);
  own.put(
    "packages/alpha/src/owner.ts",
    `${prefix}
function runtimeProperty(value: object, key: PropertyKey): unknown { ${body} }
export interface Observation { readonly admitted: boolean; }
export function validate(event: object): Observation { return { admitted: runtimeProperty(event, "value") === 1 }; }
`,
  );
  own.put(
    "src/consumer.ts",
    'import { validate } from "alpha/runtime"; export const result = validate({value:1});',
  );
  const path = "packages/alpha/src/proof.test.ts";
  own.put(
    path,
    `import { validate, type Observation } from "alpha/runtime";
export function observe(event: object): Observation { const result = validate(event); return result; }
`,
  );
  const selector = { consumerPath: path, specifier: "alpha/runtime", exportName: "validate" };
  own.record = {
    ...responsibilityRecord(),
    kind: "raw-property-observation",
    input: { ...selector, parameterIndex: 0 },
    transform: selector,
    output: selector,
    consumer: { kind: "public-api-proof", owner: "alpha", ...selector, exportName: "observe" },
    rules: [
      "anti-slop/no-object-parameters",
      "anti-slop/no-unknown-returns",
      "anti-slop/no-reflect-get",
    ],
    proofs: [path],
    proofAssertions: [{ path, testName: "observation preservation" }],
  };
  own.policy = responsibilityPolicy([own.record]);
  own.put("scripts/code-quality-policy.json", own.policy);
  emitSymbolFixture(own.root);
  return own;
}

function mutateObservationSource(own, variant) {
  const sourcePath = "packages/alpha/src/owner.ts";
  const source = readFileSync(join(own.root, sourcePath), "utf8");
  const exposure = {
    "export-list": "export { runtimeProperty };",
    "alias-export-list": "export { runtimeProperty as exposedProperty };",
    "container-escape": "export const exposedProperty = [runtimeProperty];",
  }[variant];
  if (exposure) own.put(sourcePath, source + "\n" + exposure);

  if (variant === "unused-nested")
    own.put(
      sourcePath,
      source.replace(
        'return { admitted: runtimeProperty(event, "value") === 1 };',
        'const unused = (): unknown => runtimeProperty(event, "value"); return { admitted: true };',
      ),
    );
  if (variant === "absent-key-annotation")
    own.put(sourcePath, source.replace("key: PropertyKey", 'key = "value"'));
  if (variant === "typed-return")
    own.put(
      sourcePath,
      source
        .replace("key: PropertyKey): unknown", "key: PropertyKey): number")
        .replace("const property: unknown", "const property: number"),
    );
  if (variant === "unreached")
    own.put(sourcePath, source.replace('runtimeProperty(event, "value") === 1', "true"));
  if (variant === "ambiguous")
    own.put(
      sourcePath,
      source +
        source.split("export interface")[0].replaceAll("runtimeProperty", "otherProperty") +
        "export const unrelated = 1;",
    );
  if (variant === "ambiguous")
    own.put(
      sourcePath,
      readFileSync(join(own.root, sourcePath), "utf8").replace(
        'runtimeProperty(event, "value") === 1',
        'runtimeProperty(event, "value") === otherProperty(event, "value")',
      ),
    );
}

function mutateObservationConsumer(own, variant) {
  if (variant === "asserted-consumer")
    own.put(
      own.record.proofs[0],
      readFileSync(join(own.root, own.record.proofs[0]), "utf8").replace(
        "return result;",
        "return result as Observation;",
      ),
    );
  if (variant === "foreign-result")
    own.put(
      own.record.proofs[0],
      readFileSync(join(own.root, own.record.proofs[0]), "utf8").replace(
        "event: object): Observation",
        "event: object): {readonly admitted: boolean}",
      ),
    );
}

describe("private raw property observation witness", () => {
  it("binds exact private reflection through the public owning validator without domain clearance", async () => {
    const own = reflectionObservationFixture();
    expect(validatePolicy(own.policy)).toEqual([]);
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(report.assessments[0].structural).toBe("ready");
    expect(report.assessments[0].slots.map(({ rule }) => rule).sort()).toEqual(
      own.record.rules.toSorted(),
    );
    expect(report.assessments[0].consumerBinding.bound).toBe(true);
    expect(report.counts.qualified).toBe(0);
  });
  it.each([
    [
      "third receiver",
      "const property: unknown = Reflect.get(value, key, value); return property;",
      "",
    ],
    ["literal key", 'const property: unknown = Reflect.get(value, "other"); return property;', ""],
    ["other receiver", "const property: unknown = Reflect.get({}, key); return property;", ""],
    [
      "aliased receiver",
      "const receiver = value; const property: unknown = Reflect.get(receiver, key); return property;",
      "",
    ],
    [
      "asserted result",
      "const property: unknown = Reflect.get(value, key) as unknown; return property;",
      "",
    ],
    ["changed return", "const property: unknown = Reflect.get(value, key); return 42;", ""],
    ["mutable local", "let property: unknown = Reflect.get(value, key); return property;", ""],
    [
      "extra statement",
      "const property: unknown = Reflect.get(value, key); void value; return property;",
      "",
    ],
    [
      "shadowed Reflect",
      "const property: unknown = Reflect.get(value, key); return property;",
      "const Reflect = {get: (_value: object, _key: PropertyKey): unknown => 1};",
    ],
    [
      "shadowed PropertyKey",
      "const property: unknown = Reflect.get(value, key); return property;",
      "type PropertyKey = string;",
    ],
  ])("refuses %s without adapting helper or caller findings", async (_name, body, prefix) => {
    const own = reflectionObservationFixture(body, prefix);
    const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
    expect(report.assessments[0].structural).not.toBe("ready");
    expect(report.assessments[0].slots ?? []).toEqual([]);
    expect(report.counts.qualified).toBe(0);
  });
  it.each([
    "unreached",
    "export-list",
    "alias-export-list",
    "container-escape",
    "unused-nested",
    "absent-key-annotation",
    "typed-return",
    "ambiguous",
    "asserted-consumer",
    "foreign-result",
    "broadened-rules",
    "missing-assertion",
  ])("refuses %s observation participation", async (variant) => {
    const own = reflectionObservationFixture();
    mutateObservationSource(own, variant);
    mutateObservationConsumer(own, variant);
    if (variant === "broadened-rules") own.record.rules.push("anti-slop/no-runtime-typeof");
    if (variant === "missing-assertion") own.record.proofAssertions = [];
    emitSymbolFixture(own.root);
    if (["broadened-rules", "missing-assertion"].includes(variant))
      expect(validatePolicy(own.policy)).toContain("invalid-responsibilities");
    else {
      const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
      expect(report.assessments[0].structural).not.toBe("ready");
      expect(report.assessments[0].slots ?? []).toEqual([]);
    }
  });
  it("keeps pending slots and unrelated coordinates in enforcement", async () => {
    const own = reflectionObservationFixture();
    const report = await executeCodeQualityPolicy(
      { mode: "enforce", scope: "repository" },
      own.root,
    );
    const { adaptResponsibilityDiagnostics } =
      await import("../lib/code-quality-responsibilities.mjs");
    const assessment = report.responsibilities.assessments[0];
    expect(assessment.structural).toBe("ready");
    for (const slot of assessment.slots)
      expect(report.census).toContainEqual(
        expect.objectContaining({
          path: slot.path,
          rule: slot.rule,
          line: slot.line,
          column: slot.column,
        }),
      );
    const census = report.census.filter((finding) => own.record.rules.includes(finding.rule));
    const pending = adaptResponsibilityDiagnostics(
      { census, violations: census },
      { assessments: [assessment] },
    );
    expect(pending.adaptations).toEqual([]);
    const qualified = adaptResponsibilityDiagnostics(
      { census, violations: census },
      { assessments: [{ ...assessment, semantic: "qualified" }] },
    );
    expect(qualified.adaptations).toHaveLength(3);
    expect(
      qualified.violations.some((finding) => finding.rule === "anti-slop/no-object-parameters"),
    ).toBe(true);
  });
});

function legacyTypedFixturePolicy(own) {
  const old = structuredClone(own.policy);
  const record = old.responsibilities[0];
  record.kind = "validator";
  delete record.consumer.kind;
  for (const role of ["input", "transform", "output", "consumer"]) {
    record[role].consumerPath = "src/consumer.ts";
  }
  record.transform.exportName = "isState";
  record.output.exportName = "isState";
  record.consumer.exportName = "transition";
  return old;
}

// Original-engine counterfactual: the original closed schema must reject this new kind;
// it cannot pass this assertion through a missing named resolver import or setup failure.
describe("typed finite entry responsibilities (#3918)", () => {
  it("recognizes the explicit new kind while old raw-root ownership remains ineligible", async () => {
    const own = createTypedRecheckFixture();
    roots.push(own.root);
    expect(validatePolicy(own.policy)).toEqual([]);
    const subject = await collectPolicySubject(own.root);
    const report = assessPolicyResponsibilities(subject, own.policy);
    expect(report.counts).toMatchObject({ ready: 4, pending: 4, qualified: 0 });
    expect(report.assessments.flatMap((record) => record.slots)).toHaveLength(4);
    const old = legacyTypedFixturePolicy(own);
    const legacyResolver = createSymbolResolver(subject);
    try {
      const roles = resolveRoles(legacyResolver, old.responsibilities[0]);
      for (const role of ["input", "transform", "output", "consumer"]) {
        expect(roles[role].identities).toHaveLength(1);
        expect(roles[role].identities[0].owner).toBe("alpha");
        expect(roles[role].identities[0].producer.path).toBe("packages/alpha/src/owner.ts");
      }
      expect(
        legacyResolver.callableSlots(roles.input.identities[0]).parameters[0].type,
      ).toMatchObject({ kind: "union", members: 2, containsUnknown: false });
      const binding = legacyResolver.consumerCalls(
        roles.consumer.identities[0],
        roles.transform.identities[0],
        "alpha",
      );
      expect(binding.bound).toBe(true);
      expect(binding.calls).toHaveLength(2);
    } finally {
      legacyResolver.close();
    }

    const legacy = assessPolicyResponsibilities(subject, old);
    expect(legacy.assessments[0].structural).toBe("incomplete");
    expect(legacy.assessments[0].slots ?? []).toEqual([]);
    own.put("scripts/code-quality-policy.json", old);
    const nativeLegacy = await executeCodeQualityPolicy(
      { mode: "enforce", scope: "repository" },
      own.root,
    );
    const slot = report.assessments[0].slots[0];
    expect(nativeLegacy.violations).toContainEqual(
      expect.objectContaining({
        path: slot.path,
        rule: slot.rule,
        line: slot.line,
        column: slot.column,
      }),
    );
    expect(
      nativeLegacy.violations.filter(
        (finding) => finding.rule === "anti-slop/no-known-value-widening",
      ),
    ).toHaveLength(4);
    expect(nativeLegacy.adaptations).toEqual([]);
    expect(nativeLegacy.enforcementOutcome).toBe("failed");
  }, 30_000);

  it.each(["removed", "inert", "proof-swapped", "proof-result"])(
    "keeps %s obligations incomplete rather than granting a declaration-shaped waiver",
    async (variant) => {
      const own = createTypedRecheckFixture(variant);
      roots.push(own.root);
      const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
      expect(report.assessments[0].structural).toBe("incomplete");
      expect(report.assessments[0].slots ?? []).toEqual([]);
    },
    30_000,
  );

  it("requires the sole exact rule and real named proof selectors", () => {
    const own = createTypedRecheckFixture();
    roots.push(own.root);
    for (const rules of [
      [],
      ["anti-slop/no-runtime-typeof"],
      [...own.records[0].rules, "anti-slop/no-unknown-parameters"],
    ]) {
      const policy = structuredClone(own.policy);
      policy.responsibilities[0].rules = rules;
      expect(validatePolicy(policy)).toContain("invalid-responsibilities");
    }
    const policy = structuredClone(own.policy);
    delete policy.responsibilities[0].proofAssertions;
    expect(validatePolicy(policy)).toContain("invalid-responsibilities");
  }, 30_000);
});

async function installTypedFixtureNodeTypes(own) {
  const { symlinkSync: linkTypes } = await import("node:fs");
  const tools = new URL("../../", import.meta.url);
  mkdirSync(join(own.root, "node_modules/@types"));
  linkTypes(
    new URL("node_modules/@types/node", tools),
    join(own.root, "node_modules/@types/node"),
    "junction",
  );
}

async function typedSemanticFixture(mode = "healthy") {
  const own = createTypedRecheckFixture(mode === "lying" ? "lying" : "direct");
  await installSemanticFixtureTools(own);
  await installTypedFixtureNodeTypes(own);
  const config = JSON.parse(readFileSync(join(own.root, "packages/alpha/tsconfig.json"), "utf8"));
  config.compilerOptions.lib.push("DOM");
  config.compilerOptions.types = ["node"];
  own.put("packages/alpha/tsconfig.json", config);
  const path = own.records[0].proofs[0];
  const wrappers = readFileSync(join(own.root, path), "utf8");
  const target = join(own.root, "packages/alpha/src/owner.ts");
  const stale =
    mode === "stale"
      ? `writeFileSync(${JSON.stringify(target)}, ${JSON.stringify(readFileSync(target, "utf8") + "\n")});`
      : "";
  own.put(
    path,
    wrappers +
      `
import { it, expect } from "vitest";
import { writeFileSync } from "node:fs";
it${mode === "skip" ? ".skip" : ""}("typed public finite admission", () => {
  expect(publictransition("ready", "done")).toBe(${mode === "failed" ? "false" : "true"});
  expect(publictransition("done", "ready")).toBe(false);
  expect(publicnext("ready")).toBe(next("ready"));
  expect(publiceligible("done")).toBe(true);
  expect(publiceligible("ready")).toBe(false);
  for (const hostile of [null, 1, "__proto__", "constructor"]) {
    const box: { value: State } = { value: "ready" };
    Object.defineProperty(box, "value", { value: hostile });
    expect(publictransition(box.value, "done")).toBe(false);
    expect(publictransition("ready", box.value)).toBe(false);
    expect(publicnext(box.value)).toEqual([]);
    expect(publiceligible(box.value)).toBe(false);
  }
  ${stale}
});
`,
  );
  if (mode === "missing") own.records[0].proofAssertions[0].testName = "absent typed assertion";
  own.put("scripts/code-quality-policy.json", own.policy);
  await installSemanticFixtureBuild(own, ["-b", "packages/alpha/tsconfig.json", "--force"]);
  return own;
}

describe("typed public recheck fresh semantic qualification (#3918)", () => {
  it.skipIf(process.platform === "win32")(
    "retains pending native arguments then qualifies all four exact coordinates through real public proofs",
    async () => {
      const own = await typedSemanticFixture();
      const pending = await executeCodeQualityPolicy(
        { mode: "enforce", scope: "repository" },
        own.root,
      );
      expect(pending.responsibilities.counts).toMatchObject({ ready: 4, pending: 4, qualified: 0 });
      const selected = pending.responsibilities.assessments.flatMap((entry) => entry.slots);
      expect(selected).toHaveLength(4);
      for (const slot of selected) {
        expect(pending.violations).toContainEqual(
          expect.objectContaining({
            path: slot.path,
            rule: slot.rule,
            line: slot.line,
            column: slot.column,
          }),
        );
      }
      const qualified = await executeCodeQualityPolicy(embeddedSemanticOptions(), own.root);
      expect(qualified.responsibilities.counts).toMatchObject({
        ready: 4,
        qualified: 4,
        pending: 0,
      });
      expect(qualified.responsibilities.execution).toMatchObject({
        status: "passed",
        invocationCount: 1,
        process: { directChildClosed: true, groupAbsent: true },
      });
      expect(qualified.adaptations).toHaveLength(4);
      expect(
        qualified.adaptations.every(
          ({ finding }) => finding.rule === "anti-slop/no-known-value-widening",
        ),
      ).toBe(true);
      expect(qualified.violations).toEqual([]);
    },
    195_000,
  );

  it.skipIf(process.platform === "win32").each([
    ["lying", "semantic-proof-execution-failed"],
    ["failed", "semantic-proof-execution-failed"],
    ["missing", "semantic-proof-assertion-missing"],
    ["skip", "semantic-proof-assertion-missing"],
    ["stale", "symbol-subject-changed"],
  ])(
    "refuses %s actual proofs without granting typed adaptation",
    async (mode, reason) => {
      const own = await typedSemanticFixture(mode);
      const subject = await collectPolicySubject(own.root);
      await expect(qualifyPolicyResponsibilities(subject, own.policy)).rejects.toThrow(reason);
    },
    195_000,
  );
});

// Original-current39b engine counterfactual reaches the closed-kind assertion after the SAME real native
// fixture assembly; missing named exports/imports cannot manufacture the intended failure.
describe("raw canonical JSON decoder responsibilities (#3918)", () => {
  it("recognizes the closed decoder kind while preserving its pending native unknown return", async () => {
    const own = createCanonicalDecoderFixture();
    roots.push(own.root);
    expect(validatePolicy(own.policy)).toEqual([]);
    const subject = await collectPolicySubject(own.root);
    const assessment = assessPolicyResponsibilities(subject, own.policy);
    expect(assessment.counts).toMatchObject({ ready: 1, pending: 1, qualified: 0 });
    expect(assessment.assessments[0].slots).toHaveLength(1);
    const slot = assessment.assessments[0].slots[0];
    expect(slot).toMatchObject({ rule: "anti-slop/no-unknown-returns", kind: "return" });
    const report = await executeCodeQualityPolicy(
      { mode: "enforce", scope: "repository" },
      own.root,
    );
    expect(report.violations).toContainEqual(
      expect.objectContaining({
        path: slot.path,
        rule: slot.rule,
        line: slot.line,
        column: slot.column,
      }),
    );
    expect(report.adaptations).toEqual([]);
    expect(report.enforcementOutcome).toBe("failed");
  }, 30_000);

  it.each(["transform", "output", "consumer"])(
    "withholds a rebound %s role",
    async (role) => {
      const own = createCanonicalDecoderFixture();
      roots.push(own.root);
      const record = own.records[0];
      if (role === "consumer") record.consumer.owner = "foreign";
      else
        record[role].exportName =
          role === "output" ? "parseCanonicalSupportJson" : "canonicalSupportJson";
      const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
      expect(report.counts.ready).toBe(0);
      expect(report.assessments[0].slots ?? []).toEqual([]);
    },
    30_000,
  );
});

async function canonicalDecoderSemanticFixture(mode = "healthy") {
  const own = createCanonicalDecoderFixture(mode === "lying" ? "lying-canonicalizer" : "direct");
  await installSemanticFixtureTools(own);
  await installTypedFixtureNodeTypes(own);
  const config = JSON.parse(readFileSync(join(own.root, "packages/alpha/tsconfig.json"), "utf8"));
  config.compilerOptions.types = ["node"];
  own.put("packages/alpha/tsconfig.json", config);
  const path = own.records[0].proofs[0];
  const target = join(own.root, "packages/alpha/src/owner.ts");
  const stale =
    mode === "stale"
      ? `writeFileSync(${JSON.stringify(target)}, ${JSON.stringify(readFileSync(target, "utf8") + "\n")});`
      : "";
  own.put(
    path,
    readFileSync(join(own.root, path), "utf8") +
      `
import { it, expect } from "vitest";
import { writeFileSync } from "node:fs";
it${mode === "skip" ? ".skip" : ""}("actual public canonical decoder admission", () => {
  expect(publicCanonicalDecoderWitness('{"a":[null,true,1]}', 64)).toBe(${mode === "failed" ? "'null'" : "'{\"a\":[null,true,1]}'"});
  expect(publicDecode("true", 4)).toBe(true);
  expect(publicDecode("null", 4)).toBeNull();
  expect(() => publicDecode(" null", 64)).toThrow(expect.objectContaining({reason:"corrupt-report"}));
  expect(() => publicDecode('"é"', 3)).toThrow(expect.objectContaining({reason:"report-budget-exceeded"}));
  ${stale}
});
`,
  );
  if (mode === "missing")
    own.records[0].proofAssertions[0].testName = "absent canonical decoder assertion";
  own.put("scripts/code-quality-policy.json", own.policy);
  await installSemanticFixtureBuild(own, ["-b", "packages/alpha/tsconfig.json", "--force"]);
  return own;
}

describe("raw canonical JSON decoder fresh semantic qualification (#3918)", () => {
  it.skipIf(process.platform === "win32")(
    "grants only the exact return after fresh public admission proofs pass",
    async () => {
      const own = await canonicalDecoderSemanticFixture();
      const pending = await executeCodeQualityPolicy(
        { mode: "enforce", scope: "repository" },
        own.root,
      );
      expect(pending.responsibilities.counts).toMatchObject({ ready: 1, pending: 1, qualified: 0 });
      expect(pending.adaptations).toEqual([]);
      const report = await executeCodeQualityPolicy(embeddedSemanticOptions(), own.root);
      expect(report.responsibilities.counts).toMatchObject({ ready: 1, pending: 0, qualified: 1 });
      expect(report.responsibilities.execution).toMatchObject({
        status: "passed",
        invocationCount: 1,
        process: { directChildClosed: true, groupAbsent: true },
      });
      expect(report.adaptations).toHaveLength(1);
      expect(report.adaptations[0].finding.rule).toBe("anti-slop/no-unknown-returns");
      expect(report.violations).toEqual([]);
    },
    195_000,
  );

  it.skipIf(process.platform === "win32").each([
    ["lying", "semantic-proof-execution-failed"],
    ["failed", "semantic-proof-execution-failed"],
    ["missing", "semantic-proof-assertion-missing"],
    ["skip", "semantic-proof-assertion-missing"],
    ["stale", "symbol-subject-changed"],
  ])(
    "refuses %s proof without adapting a raw return",
    async (mode, reason) => {
      const own = await canonicalDecoderSemanticFixture(mode);
      await expect(
        qualifyPolicyResponsibilities(await collectPolicySubject(own.root), own.policy),
      ).rejects.toThrow(reason);
    },
    195_000,
  );
});
