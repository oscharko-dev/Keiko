import { readFileSync } from "node:fs";
import { join } from "node:path";
import { format } from "prettier";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { validateGovernedToolContract, checkContractExamples } from "./governed-tool-contract.mjs";
import { validateEvidenceExample } from "./governed-tool-examples.mjs";
import { REQUIRED_PHASES, REQUIRED_STATUSES } from "./governed-tool-contract-shape.mjs";

export const TOOL_CATALOG_OPERATIONS_PATH = "docs/observability/tool-catalog-operations.v1.json";
const SOURCE_CONTRACT = "docs/architecture/governed-tool-contract.v1.json";

function terminalFixture(contract, status) {
  const example = contract.resultExamples[status];
  return {
    ...contract.examples.terminal,
    status: example.status,
    reason: example.reason,
    effectStarted: example.effectStarted,
    reservationId: example.effectStarted ? contract.examples.terminal.reservationId : null,
    budgetDisposition: example.effectStarted ? "committed" : "not-reserved",
    ...(status === "failed" ? { errorKind: "TypeError", frames: [], causeChain: [] } : {}),
  };
}
function sourceContract(root) {
  return JSON.parse(readFileSync(join(root, SOURCE_CONTRACT), "utf8"));
}
export function compileToolCatalogOperations(contract) {
  const errors = [...validateGovernedToolContract(contract), ...checkContractExamples(contract)];
  if (errors.length > 0) throw new TypeError("Invalid governed lifecycle source contract");
  const provenance = {
    source: SOURCE_CONTRACT,
    sourceDigest: sha256Hex(canonicalise(contract)),
    digestFormat: "keiko-security-canonical-json-sha256",
    declarationOwnerIssue: 3412,
    runtimeOwnerIssue: 3413,
    readiness: "contract-only",
  };
  const contracts = REQUIRED_PHASES.map((phase) => ({
    schemaVersion: 1,
    phase,
    op: contract.phases[phase].op,
    requiredFields: contract.phases[phase].required,
    provenance,
  }));
  const fixtures = REQUIRED_PHASES.map((phase) => ({
    phase,
    classification: "synthetic-contract-fixture",
    evidence: contract.examples[phase],
  }));
  const terminalFixtures = REQUIRED_STATUSES.map((status) => ({
    phase: "terminal",
    classification: "synthetic-contract-fixture",
    evidence: terminalFixture(contract, status),
  }));
  for (const fixture of [...fixtures, ...terminalFixtures])
    if (validateEvidenceExample(contract, fixture.phase, fixture.evidence).length > 0)
      throw new TypeError("Invalid generated lifecycle fixture");
  return JSON.parse(
    canonicalise({
      schemaVersion: 1,
      generatedBy: "scripts/generate-op-catalog.mjs",
      qualification: "declared-contract-only",
      contracts,
      fixtures,
      terminalFixtures,
      statusReasons: contract.statuses,
      readinessVocabulary: contract.readiness,
      budgetDispositionVocabulary: contract.budgetDispositions,
      evidenceAllowed: contract.evidenceAllowed,
      evidenceForbidden: contract.evidenceForbidden,
    }),
  );
}
export function generateToolCatalogOperations(root = process.cwd()) {
  return compileToolCatalogOperations(sourceContract(root));
}
export async function toolCatalogOperationsBytes(root = process.cwd()) {
  return format(`${JSON.stringify(generateToolCatalogOperations(root), null, 2)}\n`, {
    parser: "json",
    printWidth: 100,
    tabWidth: 2,
  });
}
export function validateToolCatalogOperationFixture(root, phase, evidence) {
  return validateEvidenceExample(sourceContract(root), phase, evidence);
}
