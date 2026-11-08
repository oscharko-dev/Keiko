// AC7 publication consumes one complete model-free run; it never pools partial or cross-head runs.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { format, resolveConfig } from "prettier";
import { readPrivateFile } from "./lab-client.mjs";
import { privateText } from "./private-json.mjs";
import {
  applyQualificationReport,
  classifyQualification,
  qualificationDigest,
  qualificationSummary,
} from "./api-qualification-evidence.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const HEX = /^[a-f0-9]{64}$/u;
function requireEvidence(condition) {
  if (!condition) throw new TypeError("Incomplete or contradictory Jira qualification evidence");
}
function validateRun(ledger, report, sourceRevision, reportPath) {
  requireEvidence(ledger.operations.length === 439 && /^[a-f0-9]{40}$/u.test(sourceRevision));
  requireEvidence(
    report.phase === "complete" && report.modelCalls === 0 && UUID.test(report.runId),
  );
  requireEvidence(
    /^\d{2}\.\d{1,2}\.\d{1,3}$/u.test(report.release) && HEX.test(report.imageDigest),
  );
  requireEvidence(
    report.sourceRevision === sourceRevision &&
      report.file === `qualification-${report.release}-${report.runId}.json`,
  );
  requireEvidence(
    basename(reportPath) === report.file &&
      basename(dirname(reportPath)) === `api-qualification-${report.runId}`,
  );
  requireEvidence(
    !existsSync(join(dirname(dirname(reportPath)), "api-qualification.pending.json")),
  );
  requireEvidence(!readdirSync(dirname(reportPath)).some((name) => name.endsWith(".pending.json")));
}
function validateCaseBinding(ledger, report, operation, row) {
  requireEvidence(
    row !== undefined && row.id === qualificationDigest(operation.identity).slice(0, 24),
  );
  for (const field of ["runId", "sourceRevision", "release", "imageDigest"])
    requireEvidence(row[field] === report[field]);
  requireEvidence(operation.currentCapabilityIds.includes(row.tool));
  const capability = ledger.currentCapabilities[row.tool];
  requireEvidence(
    capability?.identity === operation.identity && row.mutation === (capability.effect === "write"),
  );
  requireEvidence(HEX.test(row.binding?.contractDigest) && HEX.test(row.resultDigest));
}
function validateCase(ledger, report, operation, row) {
  validateCaseBinding(ledger, report, operation, row);
  if (row.mutation)
    requireEvidence(
      row.journal?.phase === "settled" &&
        new Set(["not-dispatched", "rejected", "succeeded", "succeeded-unconfirmed"]).has(
          row.journal.outcome,
        ),
    );
  requireEvidence(row.failure === undefined && Array.isArray(row.verificationReferences));
  requireEvidence(
    row.verificationReferences.length === 1 &&
      row.verificationReferences[0] === `${report.file}#${row.id}`,
  );
  const actual = classifyQualification({ ...row, journal: row.journal ?? undefined });
  requireEvidence(actual !== "unknown" && actual === row.runtimeAvailability);
}
function archivedReadback(readback) {
  return {
    matched: readback?.matched === true,
    assertionCount: Number.isSafeInteger(readback?.assertionCount) ? readback.assertionCount : 0,
    permissionDenied: readback?.permissionDenied === true,
    capabilityAbsent: readback?.capabilityAbsent === true,
    digest: qualificationDigest(readback),
  };
}
function archivedCase(row) {
  return {
    id: row.id,
    identity: row.identity,
    tool: row.tool,
    mutation: row.mutation,
    runtimeAvailability: row.runtimeAvailability,
    contractDigest: row.binding.contractDigest,
    resultDigest: row.resultDigest,
    readback: archivedReadback(row.readback),
    receipt: {
      status: row.dispatch.receipt.status,
      effectStarted: row.dispatch.receipt.effectStarted,
      budgetDisposition: row.dispatch.receipt.budgetDisposition,
    },
    journal:
      row.journal === null ? null : { phase: row.journal.phase, outcome: row.journal.outcome },
    native: {
      blocked: row.witness.blocked,
      responses: row.witness.responses.map((response) => ({
        status: response.status,
        truncated: response.truncated,
      })),
    },
  };
}
function publication(ledger, report, sourceRevision) {
  const rows = new Map(report.operations.map((row) => [row.identity, row]));
  // The existing all-identity accounting check rejects duplicates, unknowns and owner-policy proposals.
  applyQualificationReport(ledger, report, sourceRevision);
  for (const operation of ledger.operations)
    validateCase(ledger, report, operation, rows.get(operation.identity));
  const evidenceFile = `evidence/${report.file}`;
  const qualified = {
    ...report,
    operations: report.operations.map((row) => ({
      ...row,
      verificationReferences: [`${evidenceFile}#${row.id}`],
    })),
  };
  const archive = {
    schemaVersion: 1,
    runId: report.runId,
    sourceRevision,
    release: report.release,
    imageDigest: report.imageDigest,
    inventoryDigest: report.inventoryDigest,
    modelCalls: 0,
    phase: "complete",
    counts: qualificationSummary(report.operations),
    operations: report.operations.map(archivedCase),
  };
  return {
    evidenceFile,
    archive,
    ledger: applyQualificationReport(ledger, qualified, sourceRevision),
  };
}
async function formatted(path, value) {
  return format(JSON.stringify(value), { ...(await resolveConfig(path)), parser: "json" });
}
/** Publish only after the entire run, provenance, receipts, native results and readbacks agree. */
export async function writeQualificationLedger({
  ledgerPath,
  reportPath,
  sourceRevision,
  assertSource = () => undefined,
}) {
  const previous = readFileSync(ledgerPath, "utf8");
  const ledger = JSON.parse(previous);
  const report = JSON.parse(readPrivateFile(reportPath));
  validateRun(ledger, report, sourceRevision, reportPath);
  const result = publication(ledger, report, sourceRevision);
  const evidencePath = join(dirname(ledgerPath), result.evidenceFile);
  const [archiveText, ledgerText] = await Promise.all([
    formatted(evidencePath, result.archive),
    formatted(ledgerPath, result.ledger),
  ]);
  // Format before publication; an interrupted archive write cannot replace the existing ledger.
  assertSource();
  requireEvidence(readFileSync(ledgerPath, "utf8") === previous);
  if (existsSync(evidencePath)) requireEvidence(readFileSync(evidencePath, "utf8") === archiveText);
  else {
    mkdirSync(dirname(evidencePath), { recursive: true });
    privateText(evidencePath, archiveText, true);
  }
  privateText(ledgerPath, ledgerText);
  return { evidenceFile: result.evidenceFile, sourceRevision, counts: result.archive.counts };
}
function cleanRevision(repository) {
  const options = { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
  requireEvidence(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], options) === "",
  );
  return execFileSync("git", ["rev-parse", "HEAD"], options).trim();
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    requireEvidence(process.argv.length === 3);
    const repository = resolve(import.meta.dirname, "..", "..", "..");
    const sourceRevision = cleanRevision(repository);
    const ledgerPath = join(repository, "docs/local-knowledge/jira-api-coverage/operations.json");
    const result = await writeQualificationLedger({
      ledgerPath,
      reportPath: resolve(process.argv[2]),
      sourceRevision,
      assertSource: () => requireEvidence(cleanRevision(repository) === sourceRevision),
    });
    console.log(JSON.stringify({ operation: "jira-api-ledger-written", ...result }));
  } catch {
    console.log(JSON.stringify({ operation: "jira-api-ledger-written", status: "refused" }));
    process.exitCode = 1;
  }
}
