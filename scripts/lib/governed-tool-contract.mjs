import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { GOVERNED_TOOL_CONTRACT_PINS as PINS } from "./governed-tool-contract-pins.mjs";
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
  if (!consumer || !Array.isArray(consumer.inputs) || !Array.isArray(consumer.outputs)) {
    errors.push(`consumer ${issue}: invalid interface lists`);
    return;
  }
  checkConsumerFields(issue, consumer, errors);
  for (const name of [...consumer.inputs, ...consumer.outputs]) {
    if (!interfaces[name]) errors.push(`consumer ${issue}: unknown interface ${name}`);
  }
  for (const name of consumer.outputs) {
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
function checkPhase(phase, value, errors) {
  const expected = PINS.phases[phase];
  if (value?.op !== expected?.op || !sameSet(value?.required, expected?.required ?? []))
    errors.push(`phase ${phase}: operation or required fields differ`);
}
function checkDigests(contract, errors) {
  requireKeys(contract.digests, Object.keys(PINS.digests), "digests", errors);
  for (const [kind, expected] of Object.entries(PINS.digests)) {
    const value = contract.digests?.[kind];
    if (value?.domain !== expected.domain || !sameSet(value?.fields, expected.fields))
      errors.push(`digest ${kind}: domain or input set differs`);
  }
}
function checkPinnedValues(contract, errors) {
  for (const section of ["owners", "bounds"]) {
    for (const [key, expected] of Object.entries(PINS[section])) {
      if (contract[section]?.[key] !== expected) errors.push(`${section}: changed ${key}`);
    }
  }
  for (const section of ["evidenceAllowed", "evidenceForbidden"]) {
    if (!sameSet(contract[section], PINS[section])) errors.push(`${section}: vocabulary differs`);
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
  if (errors.length > 0) return errors;
  checkPinnedValues(contract, errors);
  checkInterfaces(contract, errors);
  checkStatuses(contract, errors);
  checkDigests(contract, errors);
  for (const [phase, value] of Object.entries(contract.phases ?? {})) {
    checkPhase(phase, value, errors);
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
function checkInventoryRow(row, contract, root, errors) {
  const dispositions = new Set([
    "retain owner",
    "derive projection",
    "migrate/delete",
    "external dependency",
  ]);
  const expected = PINS.inventory.find((entry) => entry.id === row.id);
  if (!expected || Object.keys(expected).some((key) => expected[key] !== row[key])) {
    errors.push(`inventory ${row.id}: audited source mapping differs`);
    return;
  }
  if (!dispositions.has(row.disposition)) errors.push(`inventory ${row.id}: unknown disposition`);
  if (!contract.consumers[String(row.ownerIssue)])
    errors.push(`inventory ${row.id}: missing owner`);
  checkActiveInventoryProbe(row, root, errors);
}
function checkActiveInventoryProbe(row, root, errors) {
  const migration = PINS.inventoryMigrations[row.id];
  if (!migration) {
    checkProbe(row, root, errors);
    return;
  }
  if (existsSync(join(root, row.path))) errors.push(`inventory ${row.id}: retired source restored`);
  for (const source of migration.replacements) {
    checkProbe({ ...source, id: `${row.id} (${source.path})` }, root, errors);
  }
}
export function checkInventoryProbes(contract, root) {
  const errors = [];
  const seen = new Set();
  if (!isDeepStrictEqual(contract.inventoryMigrations, PINS.inventoryMigrations))
    errors.push("inventory: migration mapping differs");
  if (!Array.isArray(contract.inventory)) return ["inventory: invalid audited baseline"];
  for (const row of contract.inventory) {
    if (!row || typeof row.path !== "string" || typeof row.probe !== "string") {
      errors.push("inventory: invalid source row");
      continue;
    }
    if (seen.has(row.id)) errors.push(`inventory ${row.id}: duplicate identity`);
    seen.add(row.id);
    checkInventoryRow(row, contract, root, errors);
  }
  if (
    !sameSet(
      [...seen],
      PINS.inventory.map((row) => row.id),
    )
  )
    errors.push("inventory: incomplete audited baseline");
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
