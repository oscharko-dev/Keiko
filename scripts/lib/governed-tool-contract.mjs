import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REQUIRED_AXES,
  REQUIRED_BOUNDS,
  REQUIRED_CONSUMERS,
  REQUIRED_INTERFACE_FIELDS,
  REQUIRED_OWNERS,
  REQUIRED_PHASES,
  REQUIRED_STATUSES,
  REQUIRED_CONSUMER_INTERFACES,
  REQUIRED_STATUS_REASONS,
} from "./governed-tool-contract-shape.mjs";
import { validateEvidenceExample, validateResultExample } from "./governed-tool-examples.mjs";
export { validateEvidenceExample } from "./governed-tool-examples.mjs";

function sameSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    new Set(actual).size === actual.length &&
    actual.length === expected.length &&
    expected.every((key) => actual.includes(key))
  );
}
function requireKeys(value, keys, label, errors) {
  if (!value || !sameSet(Object.keys(value), keys))
    errors.push(`${label}: incomplete or unknown keys`);
}
function checkInterface(name, value, expected, contract, errors) {
  if (!value || !sameSet(value.fields, expected.split(","))) {
    errors.push(`interface ${name}: incomplete or ambiguous fields`);
    return;
  }
  const producer = contract.consumers?.[String(value.ownerIssue)];
  if (!producer?.outputs?.includes(name)) errors.push(`interface ${name}: missing sole producer`);
}
function checkConsumerFields(issue, consumer, errors) {
  const expected = REQUIRED_CONSUMER_INTERFACES[issue] ?? ["", ""];
  for (const [index, side] of ["inputs", "outputs"].entries()) {
    const fields = expected[index] ? expected[index].split(",") : [];
    if (!sameSet(consumer[side], fields)) errors.push(`consumer ${issue}: incomplete ${side}`);
  }
}
function checkConsumer(issue, consumer, interfaces, errors) {
  checkConsumerFields(issue, consumer, errors);
  for (const name of [...(consumer.inputs ?? []), ...(consumer.outputs ?? [])]) {
    if (!interfaces[name]) errors.push(`consumer ${issue}: unknown interface ${name}`);
  }
  for (const name of consumer.outputs ?? []) {
    if (String(interfaces[name]?.ownerIssue) !== issue) {
      errors.push(`consumer ${issue}: conflicting producer ${name}`);
    }
  }
}
function checkInterfaces(contract, errors) {
  const interfaces = contract.interfaces ?? {};
  requireKeys(interfaces, Object.keys(REQUIRED_INTERFACE_FIELDS), "interfaces", errors);
  for (const [name, expected] of Object.entries(REQUIRED_INTERFACE_FIELDS)) {
    checkInterface(name, interfaces[name], expected, contract, errors);
  }
  for (const [issue, consumer] of Object.entries(contract.consumers ?? {})) {
    checkConsumer(issue, consumer, interfaces, errors);
  }
}
function checkStatuses(contract, errors) {
  for (const status of REQUIRED_STATUSES) {
    if (!sameSet(contract.statuses?.[status], REQUIRED_STATUS_REASONS[status].split(","))) {
      errors.push(`status ${status}: incomplete or unknown reasons`);
    }
  }
  const recoveryOwners = Object.entries(contract.statuses ?? {})
    .filter(([, reasons]) => Array.isArray(reasons) && reasons.includes("recovery-required"))
    .map(([status]) => status);
  if (!sameSet(recoveryOwners, ["invalid"]) || contract.recovery?.status !== "invalid") {
    errors.push("recovery-required: must belong only to invalid");
  }
}
function checkPhase(phase, value, contract, errors) {
  const required = value.required ?? [];
  if (!value.op?.startsWith("tool-catalog.") || !required.includes("correlationId")) {
    errors.push(`phase ${phase}: missing operation or correlation`);
  }
  const allowed = contract.evidenceAllowed ?? [];
  if (required.some((key) => !allowed.includes(key)))
    errors.push(`phase ${phase}: unknown evidence field`);
  if (phase === "invocation-started" && required.includes("status")) {
    errors.push("invocation-started: terminal status is forbidden");
  }
}
function checkDigestDomains(digests, errors) {
  const domains = new Set();
  for (const [kind, value] of Object.entries(digests)) {
    if (!value.domain || domains.has(value.domain) || !value.fields?.length) {
      errors.push(`digest ${kind}: missing fields or duplicate domain`);
    }
    domains.add(value.domain);
  }
}
function checkDigests(contract, errors) {
  checkDigestDomains(contract.digests ?? {}, errors);
  const projection = contract.digests?.projection?.fields ?? [];
  for (const field of [
    "catalogRevision",
    "profile",
    "adapterDialect",
    "adapterRuntime",
    "tools.alias",
    "tools.description",
    "tools.inputSchema",
    "tools.resultSchema",
    "tools.effects",
    "tools.actionMapping",
    "tools.policyReferences",
    "tools.handlerRequirement",
  ]) {
    if (!projection.includes(field)) errors.push(`projection digest: missing ${field}`);
  }
}
function checkShape(contract, errors) {
  for (const [field, keys] of Object.entries({
    owners: REQUIRED_OWNERS,
    axes: REQUIRED_AXES,
    bounds: REQUIRED_BOUNDS,
    statuses: REQUIRED_STATUSES,
    phases: REQUIRED_PHASES,
    consumers: REQUIRED_CONSUMERS,
  })) {
    requireKeys(contract[field], keys, field, errors);
  }
  for (const value of Object.values(contract.bounds ?? {})) {
    if (!Number.isSafeInteger(value) || value <= 0)
      errors.push("bounds: must be positive safe integers");
  }
  for (const value of Object.values(contract.owners ?? {})) {
    if (typeof value !== "string" || value.length === 0) errors.push("owners: missing owner");
  }
}
export function validateGovernedToolContract(contract) {
  if (contract?.schemaVersion !== 1 || contract?.implementation !== "architecture-only") {
    return ["invalid architecture contract version or implementation claim"];
  }
  const errors = [];
  checkShape(contract, errors);
  checkInterfaces(contract, errors);
  checkStatuses(contract, errors);
  checkDigests(contract, errors);
  for (const [phase, value] of Object.entries(contract.phases ?? {})) {
    checkPhase(phase, value, contract, errors);
  }
  return errors;
}
function checkProbe(row, root, errors) {
  if (!/^(packages|scripts)\/[a-zA-Z0-9_./-]+$/.test(row.path) || row.path.includes("..")) {
    errors.push(`inventory ${row.id}: invalid repository path`);
    return;
  }
  try {
    if (!readFileSync(join(root, row.path), "utf8").includes(row.probe))
      errors.push(`inventory ${row.id}: source probe missing`);
  } catch {
    errors.push(`inventory ${row.id}: source file missing`);
  }
}
export function checkInventoryProbes(contract, root) {
  const errors = [];
  const seen = new Set();
  const dispositions = new Set([
    "retain owner",
    "derive projection",
    "migrate/delete",
    "external dependency",
  ]);
  for (const row of contract.inventory ?? []) {
    if (seen.has(row.id)) errors.push(`inventory ${row.id}: duplicate identity`);
    seen.add(row.id);
    if (!dispositions.has(row.disposition)) errors.push(`inventory ${row.id}: unknown disposition`);
    if (!contract.consumers[String(row.ownerIssue)])
      errors.push(`inventory ${row.id}: missing owner`);
    checkProbe(row, root, errors);
  }
  if (seen.size < 43) errors.push("inventory: incomplete audited baseline");
  return errors;
}
export function checkContractExamples(contract) {
  const errors = [];
  for (const phase of REQUIRED_PHASES) {
    errors.push(...validateEvidenceExample(contract, phase, contract.examples?.[phase]));
  }
  for (const status of REQUIRED_STATUSES) {
    errors.push(...validateResultExample(contract, contract.resultExamples?.[status]));
  }
  return errors;
}
