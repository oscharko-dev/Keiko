import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { policyDigest } from "../lib/code-quality-inventory.mjs";
import { NATIVE_EFFECT_RULES } from "../lib/code-quality-policy.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import {
  assertEnforcedRepositoryReport,
  executePolicyWithDiagnostics,
} from "./code-quality-wiring-smoke.mjs";

function assertQualifiedRecord(assessment, record) {
  assert.deepEqual(
    { id: assessment.id, owner: assessment.owner, kind: assessment.kind, rules: assessment.rules },
    { id: record.id, owner: record.owner, kind: record.kind, rules: record.rules },
  );
  assert.equal(assessment.structural, "ready");
  assert.equal(assessment.semantic, "qualified");
  assert.deepEqual(assessment.reasons, []);
  assert.deepEqual(assessment.obligations, []);
  assert.deepEqual(
    assessment.proofs.map(({ path }) => path),
    record.proofs,
  );
  assert.ok(assessment.proofs.every(({ executed }) => executed === true));
  assert.deepEqual(
    assessment.proofAssertions,
    record.proofAssertions.map((selector) => ({ ...selector, status: "passed" })),
  );
}

function assertRepositoryScope(report, policyBytes) {
  assertEnforcedRepositoryReport(report, { outcome: "passed", packages: 27 });
  assert.equal(report.subject, report.inventory.subject);
  assert.match(report.subject, /^[a-f0-9]{40}$/u);
  assert.equal(report.policySha256, policyDigest(policyBytes));
  assert.deepEqual(report.violations, []);
}

function assertScopeRetirementReport(report, policy) {
  const ruleScopes = ({ id, activeScopes, retiredScopes }) => ({ id, activeScopes, retiredScopes });
  assert.deepEqual(report.rules.map(ruleScopes), policy.rules.map(ruleScopes));
  const retired = policy.rules.filter((rule) => Object.hasOwn(rule, "retiredScopes"));
  assert.ok(Array.isArray(report.scopeRetirements));
  if (retired.length === 0) {
    assert.deepEqual(report.scopeRetirements, []);
    return;
  }
  assert.deepEqual(
    retired.map(({ id }) => id),
    NATIVE_EFFECT_RULES,
  );
  for (const rule of retired) {
    assert.deepEqual(rule.activeScopes, []);
    assert.deepEqual(rule.retiredScopes, ["native-host"]);
    assert.equal(rule.disposition, "Effect-host-only");
  }
  assert.equal(report.scopeRetirements.length, 1);
  const witness = report.scopeRetirements[0];
  assert.deepEqual(Object.keys(witness).sort(), [
    "obligationCount",
    "ownerMemberCount",
    "pathCount",
    "pathsSha256",
    "scope",
    "state",
  ]);
  assert.equal(witness.scope, "native-host");
  assert.equal(witness.state, "owner-absent");
  assert.equal(witness.ownerMemberCount, 0);
  assert.equal(witness.obligationCount, 5);
  assert.ok(Number.isSafeInteger(witness.pathCount));
  assert.ok(witness.pathCount >= 0);
  assert.match(witness.pathsSha256, /^[a-f0-9]{64}$/u);
}

export function assertRepositoryQualification(report, policy, policyBytes) {
  assertRepositoryScope(report, policyBytes);
  assertScopeRetirementReport(report, policy);
  assert.ok(policy.responsibilities.length > 0);
  const responsibilities = report.responsibilities;
  assert.deepEqual(responsibilities.counts, {
    ready: policy.responsibilities.length,
    incomplete: 0,
    invalid: 0,
    qualified: policy.responsibilities.length,
    pending: 0,
    rejected: 0,
  });
  assert.deepEqual(
    responsibilities.assessments.map(({ id }) => id),
    policy.responsibilities.map(({ id }) => id),
  );
  responsibilities.assessments.forEach((assessment, index) =>
    assertQualifiedRecord(assessment, policy.responsibilities[index]),
  );
  assert.equal(responsibilities.execution.status, "passed");
  assert.equal(responsibilities.execution.invocationCount, 1);
  assert.equal(responsibilities.execution.process.directChildClosed, true);
  assert.equal(responsibilities.execution.process.groupAbsent, true);
}

export async function qualifyRepository() {
  const policyPath = new URL("../code-quality-policy.json", import.meta.url);
  const policyBytes = readFileSync(policyPath, "utf8");
  const entry = new URL("../check-code-quality-policy.mjs", import.meta.url);
  // The existing required job bounds the complete operation. Operation-owned limits stay intact.
  const { stdout } = await executePolicyWithDiagnostics(
    [fileURLToPath(entry), "--qualify-responsibilities", "--json", "--progress"],
    { cwd: new URL("../../", import.meta.url), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    true,
  );
  assert.equal(readFileSync(policyPath, "utf8"), policyBytes);
  const report = JSON.parse(stdout);
  assertRepositoryQualification(report, JSON.parse(policyBytes), policyBytes);
  return report;
}

if (isMainModule(import.meta.url)) {
  await qualifyRepository();
  console.log(
    "code-quality repository qualification: PASS — complete current-subject semantic proofs closed and drained.",
  );
}
