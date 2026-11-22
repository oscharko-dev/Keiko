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

import { pathToFileURL } from "node:url";

import { readJsonArgument } from "./lib/json-argument.mjs";

const NAME = "check-acceptance-evidence";
const SCHEMA_VERSION = 4;

// The signs the acceptance test records (`containerRuntimeFacts`). A sign it stopped recording
// counts as present, so a writer that drops or renames one fails closed instead of shrinking the
// check; a sign it adds counts whenever it is not `false`.
const CONTAINER_RUNTIME_SIGNS = [
  "dockerOnPath",
  "podmanOnPath",
  "otherClientOnPath",
  "dockerHostConfigured",
  "dockerSocketPresent",
  "runtimeStatePresent",
  "applicationPresent",
];

function presentSigns(containerRuntime) {
  if (typeof containerRuntime !== "object" || containerRuntime === null) return ["unrecorded"];
  const recorded = Object.entries(containerRuntime)
    .filter(([, present]) => present !== false)
    .map(([sign]) => sign);
  const unrecorded = CONTAINER_RUNTIME_SIGNS.filter(
    (sign) => !Object.hasOwn(containerRuntime, sign),
  );
  return [...recorded, ...unrecorded.map((sign) => `${sign}-unrecorded`)];
}

function casesOf(evidence) {
  return Array.isArray(evidence?.cases) ? evidence.cases : [];
}

function metCount(evidence) {
  return casesOf(evidence).filter((entry) => entry?.metExpectation === true).length;
}

// Each precondition of the promise, recomputed from the evidence's own facts, in report order.
const PRECONDITIONS = [
  ["schema-version", (evidence) => evidence.schemaVersion !== SCHEMA_VERSION],
  ["platform", (evidence) => evidence.platform !== "darwin"],
  ["administrator", (evidence) => evidence.userClass !== "standard"],
  ["container-runtime-present", (evidence) => presentSigns(evidence.containerRuntime).length > 0],
];

// What the run itself said was unmet; a run that recorded nothing certifies nothing.
function recordedPreconditions(evidence) {
  return Array.isArray(evidence.unmetPreconditions)
    ? evidence.unmetPreconditions.map(String)
    : ["unrecorded"];
}

const CASE_RULES = [
  [
    "case-set-incomplete",
    (evidence) => evidence.caseSetComplete !== true || casesOf(evidence).length === 0,
  ],
  [
    "case-not-met",
    (evidence) =>
      evidence.everyCaseMetExpectation !== true || metCount(evidence) < casesOf(evidence).length,
  ],
];

/** The reasons the evidence does not certify the promise; empty when it does. */
export function acceptanceEvidenceFailures(evidence) {
  if (typeof evidence !== "object" || evidence === null) return ["evidence-unreadable"];
  const failures = PRECONDITIONS.filter(([, unmet]) => unmet(evidence)).map(([name]) => name);
  for (const precondition of recordedPreconditions(evidence)) {
    if (!failures.includes(precondition)) failures.push(precondition);
  }
  failures.push(...CASE_RULES.filter(([, unmet]) => unmet(evidence)).map(([name]) => name));
  if (evidence.certifiesPromise !== true && failures.length === 0) failures.push("not-certified");
  return failures;
}

function fact(evidence, name) {
  return String(evidence?.[name]);
}

/** One body-free line per fact: closed values and counts only. */
export function acceptanceEvidenceSummary(evidence) {
  const signs = presentSigns(evidence?.containerRuntime);
  const cases = casesOf(evidence).length;
  return [
    `platform ${fact(evidence, "platform")} ${fact(evidence, "darwinRelease")} ${fact(evidence, "arch")}`,
    `node ${fact(evidence, "node")}, opencode ${fact(evidence, "opencode")}`,
    `user class ${fact(evidence, "userClass")}`,
    `container runtime signs: ${signs.length === 0 ? "none" : signs.join(", ")}`,
    `cases: ${String(metCount(evidence))} of ${String(cases)} met, set complete ${fact(evidence, "caseSetComplete")}`,
    `certifies the promise: ${fact(evidence, "certifiesPromise")}`,
  ];
}

/** Reads the evidence named by `argv[2]` and returns the process exit code. */
export function runCheck(argv, io = console) {
  const read = readJsonArgument(argv, io, { name: NAME, input: "evidence" });
  if ("exitCode" in read) return read.exitCode;
  const evidence = read.value;
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
