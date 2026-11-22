// Certifies the macOS promise of epic #4491 from the coding acceptance task's evidence file (#4519).
//
// The acceptance test writes body-free evidence when `KEIKO_ACCEPTANCE_EVIDENCE_FILE` is set
// (docs/qa/coding-acceptance-task.md). This prints the facts a reviewer needs to trust the run (the
// platform, the user class, every sign of a container runtime, the case set) and passes only when
// the evidence certifies the promise: a standard user, no container runtime, every case recorded and
// every case as expected. It recomputes each condition instead of trusting `certifiesPromise` alone,
// and it names every precondition that failed.
//
//   node scripts/check-acceptance-evidence.mjs <evidence.json>

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const NAME = "check-acceptance-evidence";
const SCHEMA_VERSION = 4;

function presentSigns(containerRuntime) {
  if (typeof containerRuntime !== "object" || containerRuntime === null) return ["unrecorded"];
  return Object.entries(containerRuntime)
    .filter(([, present]) => present !== false)
    .map(([sign]) => sign);
}

/** The reasons the evidence does not certify the promise; empty when it does. */
export function acceptanceEvidenceFailures(evidence) {
  if (typeof evidence !== "object" || evidence === null) return ["evidence-unreadable"];
  const failures = [];
  if (evidence.schemaVersion !== SCHEMA_VERSION) failures.push("schema-version");
  if (evidence.platform !== "darwin") failures.push("platform");
  if (evidence.userClass !== "standard") failures.push("administrator");
  if (presentSigns(evidence.containerRuntime).length > 0)
    failures.push("container-runtime-present");
  for (const precondition of Array.isArray(evidence.unmetPreconditions)
    ? evidence.unmetPreconditions
    : ["unrecorded"]) {
    if (!failures.includes(precondition)) failures.push(String(precondition));
  }
  const cases = Array.isArray(evidence.cases) ? evidence.cases : [];
  if (evidence.caseSetComplete !== true || cases.length === 0) failures.push("case-set-incomplete");
  const unmet = cases.filter((entry) => entry?.metExpectation !== true).length;
  if (evidence.everyCaseMetExpectation !== true || unmet > 0) failures.push("case-not-met");
  if (evidence.certifiesPromise !== true && failures.length === 0) failures.push("not-certified");
  return failures;
}

/** One body-free line per fact: closed values and counts only. */
export function acceptanceEvidenceSummary(evidence) {
  const cases = Array.isArray(evidence?.cases) ? evidence.cases : [];
  const met = cases.filter((entry) => entry?.metExpectation === true).length;
  const signs = presentSigns(evidence?.containerRuntime);
  return [
    `platform ${String(evidence?.platform)} ${String(evidence?.darwinRelease)} ${String(evidence?.arch)}`,
    `node ${String(evidence?.node)}, opencode ${String(evidence?.opencode)}`,
    `user class ${String(evidence?.userClass)}`,
    `container runtime signs: ${signs.length === 0 ? "none" : signs.join(", ")}`,
    `cases: ${String(met)} of ${String(cases.length)} met, set complete ${String(evidence?.caseSetComplete)}`,
    `certifies the promise: ${String(evidence?.certifiesPromise)}`,
  ];
}

/** Reads the evidence named by `argv[2]` and returns the process exit code. */
export function runCheck(argv, io = console) {
  const file = argv[2];
  if (file === undefined || file === "") {
    io.error(`${NAME}: FAIL usage: node scripts/${NAME}.mjs <evidence.json>`);
    return 2;
  }
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    io.error(`${NAME}: FAIL the evidence could not be read (${detail})`);
    return 1;
  }
  for (const line of acceptanceEvidenceSummary(evidence)) io.log(`${NAME}: ${line}`);
  const failures = acceptanceEvidenceFailures(evidence);
  if (failures.length > 0) {
    io.error(`${NAME}: FAIL does not certify the promise: ${failures.join(", ")}`);
    return 1;
  }
  io.log(`${NAME}: PASS a standard user without a container runtime, every case as expected`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = runCheck(process.argv);
}
