import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { URL, pathToFileURL } from "node:url";
import { codeQualityPolicyMain, executeCodeQualityPolicy } from "../check-code-quality-policy.mjs";
import { collectPolicySubject } from "../lib/code-quality-inventory.mjs";
import { validatePolicy } from "../lib/code-quality-policy.mjs";
import { assessPolicyResponsibilities } from "../lib/code-quality-responsibilities.mjs";
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
  it.each(["optional-value", "extra-envelope", "mutable-errors"])(
    "keeps unsupported %s envelope incomplete",
    async (variant) => {
      const own = createPublicParserFixture(variant);
      roots.push(own.root);
      const report = assessPolicyResponsibilities(await collectPolicySubject(own.root), own.policy);
      expect(report.assessments[0].structural).toBe("incomplete");
      expect(report.counts.pending).toBe(1);
    },
  );
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

import { qualifyPolicyResponsibilities } from "../lib/code-quality-responsibilities.mjs";

async function directSemanticQualifierFixture(mode) {
  const { symlinkSync } = await import("node:fs");
  const own = createEnforcementFixture();
  roots.push(own.root);
  const tools = new URL("../../", import.meta.url);
  mkdirSync(join(own.root, "node_modules/.bin"));
  for (const name of ["vitest", "typescript"])
    symlinkSync(
      new URL(`node_modules/${name}`, tools),
      join(own.root, "node_modules", name),
      "junction",
    );
  symlinkSync(
    new URL("node_modules/.bin/vitest", tools),
    join(own.root, "node_modules/.bin/vitest"),
  );
  own.put("package-lock.json", readFileSync(new URL("package-lock.json", tools), "utf8"));
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
  const { nativeCompilerExecutable } = await import("../lib/code-quality-provenance.mjs");
  const own = await directSemanticQualifierFixture("healthy");
  const args =
    kind === "healthy"
      ? ["-b", "packages/alpha/tsconfig.json", "--force"]
      : ["-p", "packages/alpha/tsconfig.json"];
  if (kind === "missing-runtime") args.push("--emitDeclarationOnly");
  own.put(
    "scripts/semantic-fixture-build.mjs",
    `import { execFileSync } from "node:child_process";
execFileSync(${JSON.stringify(nativeCompilerExecutable())}, ${JSON.stringify(args)}, {
  cwd: process.cwd(), timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
});`,
  );
  const manifest = JSON.parse(readFileSync(join(own.root, "package.json"), "utf8"));
  manifest.scripts = { "build:packages": "node scripts/semantic-fixture-build.mjs" };
  own.put("package.json", manifest);
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

function embeddedSemanticOptions() {
  return { mode: "enforce", scope: "repository", json: true, qualifyResponsibilities: true };
}

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
