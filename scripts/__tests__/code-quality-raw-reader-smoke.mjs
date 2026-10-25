import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { URL } from "node:url";
import { collectPolicySubject } from "../lib/code-quality-inventory.mjs";
import { validatePolicy } from "../lib/code-quality-policy.mjs";
import { assessPolicyResponsibilities } from "../lib/code-quality-responsibilities.mjs";

const ACTUAL_RAW_READER_PROOF = "packages/keiko-contracts/src/code-task-acceptance.test.ts";
const ACTUAL_RAW_READER_SOURCE = "packages/keiko-contracts/src/code-task-acceptance.ts";
const ACTUAL_RAW_READER_RULE = "anti-slop/no-unknown-returns";

function actualRawReaderAssertions() {
  const reader = "raw own-property reader public contract (#3918)";
  const inherited =
    "ownField makes an inherited field unreadable regardless of descriptor shape (Codex P1 3789773829)";
  const collected =
    "factErrors collects every violation instead of stopping at the first (KfQ 3789542365)";
  const members = "C1A concrete acceptance member admission";
  const names = [
    `${reader} preserves unknown without any at the actual built public reader`,
    `${reader} reads own values and refuses inherited and absent values`,
    `${reader} propagates an own getter failure and never invokes an inherited getter`,
    `${reader} checks the complete actual owning validator on healthy and malformed facts`,
    "keeps the source reader aligned with the actual public raw observations (#3918)",
    `${inherited} rejects a fact's inherited non-enumerable value on the known branch`,
    `${inherited} rejects a fact's inherited non-enumerable outcome discriminator on an empty object`,
    `${inherited} rejects an inherited non-enumerable top-level header field`,
    `${inherited} still accepts a legitimate contribution once Object.prototype is restored`,
    `${collected} reports both the disallowed value and the unrelated extra key on a non-known outcome`,
    `${collected} reports both the invalid value and the unrelated extra key on a known outcome`,
    `${members} refuses skipped contribution members case 1 through source`,
    `${members} refuses skipped contribution members case 1 through public`,
    `${members} refuses skipped contribution members case 2 through source`,
    `${members} refuses skipped contribution members case 2 through public`,
  ];
  return names.map((testName) => ({ path: ACTUAL_RAW_READER_PROOF, testName }));
}

function assertActualRawReaderPublicSelection(record) {
  const specifier = "@oscharko-dev/keiko-contracts/runtime/code-task-acceptance";
  for (const [role, exportName] of [
    ["input", "ownField"],
    ["transform", "ownField"],
    ["output", "validateCodeTaskAcceptanceContribution"],
    ["consumer", "rawReaderAcceptanceWitness"],
  ]) {
    assert.equal(record[role].consumerPath, ACTUAL_RAW_READER_PROOF);
    assert.equal(record[role].specifier, specifier);
    assert.equal(record[role].exportName, exportName);
  }
  assert.equal(record.input.parameterIndex, 0);
  assert.equal(record.consumer.kind, "public-api-proof");
  assert.equal(record.consumer.owner, "@oscharko-dev/keiko-contracts");
}

async function actualRawReaderSubject() {
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const current = JSON.parse(readFileSync(join(root, "scripts/code-quality-policy.json"), "utf8"));
  const matches = current.responsibilities.filter(
    (entry) => entry.id === "actual-code-task-acceptance-raw-reader-return",
  );
  assert.equal(matches.length, 1);
  const [record] = matches;
  assert.equal(record.kind, "raw-own-property-reader");
  assertActualRawReaderPublicSelection(record);
  assert.deepEqual(record.rules, [ACTUAL_RAW_READER_RULE]);
  assert.deepEqual(record.proofAssertions, actualRawReaderAssertions());
  const policy = current;
  assert.deepEqual(validatePolicy(policy, [current]), []);
  assert.deepEqual(policy.responsibilities, current.responsibilities);
  assert.deepEqual(policy.rules, current.rules);
  assert.equal(
    policy.responsibilities
      .flatMap((entry) => entry.proofs)
      .includes("scripts/__tests__/code-quality-responsibilities.test.mjs"),
    false,
  );
  const subject = await collectPolicySubject(root);
  const file = subject.inventory.files.find((entry) => entry.path === ACTUAL_RAW_READER_SOURCE);
  assert.equal(file?.production, true);
  return { root, current, policy, record, subject, file };
}

function actualRawReaderCanonicalSlot(own, pending) {
  const reader = pending.assessments.find((entry) => entry.id === own.record.id);
  assert.equal(reader?.structural, "ready");
  assert.equal(reader.semantic, "pending");
  assert.equal(reader.consumerBinding.readerWitness.bound, true);
  assert.equal(reader.roles.input.identities.length, 1);
  assert.deepEqual(reader.roles.input.identities, reader.roles.transform.identities);
  const [identity] = reader.roles.input.identities;
  assert.equal(identity.owner, "@oscharko-dev/keiko-contracts");
  assert.deepEqual(identity.entry, {
    specifier: own.record.input.specifier,
    exportName: "ownField",
  });
  assert.equal(identity.producer.path, ACTUAL_RAW_READER_SOURCE);
  assert.equal(identity.producer.kind, "FunctionDeclaration");
  assert.equal(reader.roles.input.signatures.length, 1);
  assert.equal(reader.roles.input.signatures[0].parameters.length, 2);
  assert.equal(reader.roles.input.signatures[0].result.kind, "unknown");
  assert.equal(reader.slots.length, 1);
  const [slot] = reader.slots;
  assert.equal(slot.path, ACTUAL_RAW_READER_SOURCE);
  assert.equal(slot.rule, ACTUAL_RAW_READER_RULE);
  assert.equal(slot.kind, "return");
  assert.equal(slot.type.kind, "unknown");
  assert.ok(slot.start >= identity.producer.start && slot.end <= identity.producer.end);
  return slot;
}

async function actualRawReaderCensus(own, pending) {
  const { runNativePolicy } = await import("../lib/code-quality-runner.mjs");
  const slot = actualRawReaderCanonicalSlot(own, pending);
  assert.equal(own.file.path, slot.path);
  const scan = runNativePolicy(own.root, [own.file]);
  assert.equal(scan.visited, 1);
  const returns = scan.diagnostics.filter((finding) => finding.rule === ACTUAL_RAW_READER_RULE);
  assert.equal(returns.length, 1);
  assert.deepEqual(returns[0], {
    path: ACTUAL_RAW_READER_SOURCE,
    rule: ACTUAL_RAW_READER_RULE,
    line: slot.line,
    column: slot.column,
  });
  return scan;
}

function assertActualRawReaderPending(own, scan, pending, adapt) {
  const reader = pending.assessments.find((entry) => entry.id === own.record.id);
  assert.equal(reader.structural, "ready");
  assert.equal(reader.semantic, "pending");
  assert.equal(reader.consumerBinding.readerWitness.bound, true);
  assert.equal(reader.slots.length, 1);
  assert.equal(
    reader.proofs.every((proof) => !proof.executed),
    true,
  );
  const native = { census: scan.diagnostics, violations: scan.diagnostics };
  const result = adapt(native, pending);
  assert.deepEqual(result.census, scan.diagnostics);
  assert.deepEqual(result.violations, scan.diagnostics);
  assert.deepEqual(result.adaptations, []);
}

async function assertActualRawReaderQualified(own, scan, qualified, adapt) {
  const reader = qualified.assessments.find((entry) => entry.id === own.record.id);
  assert.equal(qualified.execution.status, "passed");
  assert.equal(qualified.counts.qualified, 1);
  assert.deepEqual(
    qualified.assessments.map((entry) => entry.id),
    [own.record.id],
  );
  assert.equal(reader.semantic, "qualified");
  assert.deepEqual(
    reader.proofAssertions,
    actualRawReaderAssertions().map((selector) => ({ ...selector, status: "passed" })),
  );
  const result = adapt({ census: scan.diagnostics, violations: scan.diagnostics }, qualified);
  assert.deepEqual(result.census, scan.diagnostics);
  assert.equal(result.adaptations.length, 1);
  assert.equal(result.adaptations[0].responsibilityId, own.record.id);
  assert.deepEqual(
    result.adaptations[0].finding,
    scan.diagnostics.find((finding) => finding.rule === ACTUAL_RAW_READER_RULE),
  );
  assert.deepEqual(
    result.violations,
    scan.diagnostics.filter((finding) => finding.rule !== ACTUAL_RAW_READER_RULE),
  );
  const fresh = { ...own, subject: await collectPolicySubject(own.root) };
  const again = assessPolicyResponsibilities(fresh.subject, rawReaderStaticPolicy(own));
  const after = await actualRawReaderCensus(fresh, again);
  assert.equal(after.configSha256, scan.configSha256);
  assert.deepEqual(after.diagnostics, scan.diagnostics);
  assert.deepEqual(fresh.subject.inventory, own.subject.inventory);
  const reread = JSON.parse(
    readFileSync(join(own.root, "scripts/code-quality-policy.json"), "utf8"),
  );
  assert.deepEqual(reread, own.current);
  assertActualRawReaderPending(fresh, after, again, adapt);
}

// Qualify the registered reader independently of the complete production cohort.
function rawReaderStaticPolicy(own) {
  assert.deepEqual(own.policy.responsibilities, own.current.responsibilities);
  assert.deepEqual(own.policy.rules, own.current.rules);
  return { ...own.policy, responsibilities: [own.record] };
}

test(
  "actual canonical reader fresh qualification (#3918) retains native RETURN while pending and adapts exactly it after actual selected proofs",
  { timeout: 195_000 },
  async () => {
    const { adaptResponsibilityDiagnostics, qualifyPolicyResponsibilities } =
      await import("../lib/code-quality-responsibilities.mjs");
    const own = await actualRawReaderSubject();
    const pending = assessPolicyResponsibilities(own.subject, rawReaderStaticPolicy(own));
    const scan = await actualRawReaderCensus(own, pending);
    assertActualRawReaderPending(own, scan, pending, adaptResponsibilityDiagnostics);
    const qualified = await qualifyPolicyResponsibilities(own.subject, rawReaderStaticPolicy(own));
    await assertActualRawReaderQualified(own, scan, qualified, adaptResponsibilityDiagnostics);
  },
);
