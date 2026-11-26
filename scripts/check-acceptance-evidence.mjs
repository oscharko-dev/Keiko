// Certifies the macOS and Windows promise of epic #4491 from the coding acceptance task's evidence
// file (#4519).
//
// The acceptance test writes body-free evidence when `KEIKO_ACCEPTANCE_EVIDENCE_FILE` is set
// (docs/qa/coding-acceptance-task.md). This prints the facts a reviewer needs to trust the run (the
// platform, the user class, every sign of a container runtime, on Windows every sign of an installed
// Keiko service, the case set) and passes only when the evidence certifies the promise: a standard
// user, no container runtime, on Windows also no installed Keiko service, every case recorded and
// every case as expected. It recomputes each condition instead of trusting `certifiesPromise`
// alone, and it names every precondition that failed.
//
// With `--preconditions-only` it checks the preconditions alone, for a machine on which no case was
// run (the Windows preconditions run, #4492 AC3); it then certifies the machine, never a result.
//
//   node scripts/check-acceptance-evidence.mjs <evidence.json> [--preconditions-only]

import { pathToFileURL } from "node:url";

import { containsCredentialShape } from "@oscharko-dev/keiko-security";

import { readJsonArgument } from "./lib/json-argument.mjs";

const NAME = "check-acceptance-evidence";
const SCHEMA_VERSION = 5;

// The signs each platform's producer records: `containerRuntimeFacts` in the macOS acceptance test
// and `windowsContainerRuntimeFacts` in windowsAcceptancePreconditions.ts. A sign a writer stopped
// recording counts as present, so a writer that drops or renames one fails closed instead of
// shrinking the check; a sign it adds counts whenever it is not `false`, and is printed as `<sign>`
// unless its key is printable. They are signs of an installed or configured runtime, never proof
// that an engine is reachable.
const CONTAINER_RUNTIME_SIGNS = {
  darwin: [
    "dockerOnPath",
    "podmanOnPath",
    "otherClientOnPath",
    "dockerHostConfigured",
    "dockerSocketPresent",
    "runtimeStatePresent",
    "applicationPresent",
  ],
  win32: [
    "dockerOnPath",
    "podmanOnPath",
    "otherClientOnPath",
    "dockerHostConfigured",
    "containerServiceInstalled",
    "runtimePipePresent",
    "applicationPresent",
  ],
};

// The Windows promise also needs no installed Keiko service: the gateway service of Keiko 1.5.x or
// any service named with the Keiko prefix. A fact it stopped recording counts as present.
function recordedServices(services) {
  return typeof services === "object" && services !== null;
}

// A services block that is not recorded at all is a probe that could not run (or a writer that
// dropped it): it is reported once, as `service-probe-failed`, not also as an installed service.
function presentServiceSigns(services) {
  if (!recordedServices(services)) return ["unrecorded"];
  const signs = [];
  if (services.keikoGatewayServiceInstalled !== false) signs.push("gatewayServiceInstalled");
  if (services.keikoServiceCount !== 0) signs.push("keikoServiceCount");
  return signs;
}

function presentSigns(containerRuntime, platform = "darwin") {
  if (typeof containerRuntime !== "object" || containerRuntime === null) return ["unrecorded"];
  const recorded = Object.entries(containerRuntime)
    .filter(([, present]) => present !== false)
    .map(([sign]) => (printableKey(sign) ? sign : "<sign>"));
  const unrecorded = (CONTAINER_RUNTIME_SIGNS[platform] ?? CONTAINER_RUNTIME_SIGNS.darwin).filter(
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

// Body-free scan (#4492 AC6). The producer (productionOpenCodeBackend.acceptance.test.ts) writes
// closed values only: enum tokens, versions, counts, booleans and `a:b:c` lines. So every string
// must be one closed token, which rules out a path (`/`, `\\`, `~`), a task text or a model answer
// (whitespace) and anything long. The one legitimate multi-token value is a governed verification
// line, `state step...`, which is a space-separated list of such tokens. A key that names content
// fails whatever its value is; `dockerOnPath` and its siblings are the producer's own presence
// signs (booleans), so `OnPath` is the one suffix that is not a path. A closed token can still be
// shaped like a credential (`sk-…`, a JWT), so every string also passes the credential detector.
const CLOSED_TOKEN = /^[A-Za-z0-9._:+=-]{1,128}$/u;
const KEY_TOKEN = /^[A-Za-z0-9._:+=-]{1,64}$/u;

/** A key is printed only as one closed token that is not shaped like a credential (`sk-…`). */
function printableKey(key) {
  return KEY_TOKEN.test(key) && !containsCredentialShape(key);
}
const TOKEN_LIST_POINTER = /^\/cases\/\d+\/observed\/governedVerifications\/\d+$/u;
const MAX_TOKEN_LIST = 8;
const CONTENT_WORDS = [
  "text",
  "prompt",
  "answer",
  "output",
  "path",
  "message",
  "body",
  "content",
  "task",
  "response",
  "reply",
  "stdout",
  "stderr",
];
const MAX_BODY_FREE_FAILURES = 20;

function closedValue(value, pointer) {
  if (typeof value !== "string") return true;
  if (containsCredentialShape(value)) return false;
  if (CLOSED_TOKEN.test(value)) return true;
  if (!TOKEN_LIST_POINTER.test(pointer)) return false;
  const tokens = value.split(" ");
  return tokens.length <= MAX_TOKEN_LIST && tokens.every((token) => CLOSED_TOKEN.test(token));
}

/** A key that is a content word, or ends in one (`taskText`), except the producer's `…OnPath`. */
function contentKey(key) {
  if (CONTENT_WORDS.includes(key.toLowerCase())) return true;
  if (key.endsWith("OnPath")) return false;
  return CONTENT_WORDS.some((word) => key.endsWith(`${word[0].toUpperCase()}${word.slice(1)}`));
}

function* entriesOf(node) {
  if (Array.isArray(node)) {
    for (const [index, value] of node.entries()) yield [String(index), value, false];
    return;
  }
  if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      const printable = printableKey(key);
      yield [printable ? key : "<key>", value, !printable || contentKey(key)];
    }
  }
}

/** The JSON pointers of every value or key that could carry content, never the content itself. */
function bodyFreeViolations(node, pointer = "", found = []) {
  for (const [segment, value, badKey] of entriesOf(node)) {
    const child = `${pointer}/${segment}`;
    if (badKey || !closedValue(value, child)) found.push(child);
    else bodyFreeViolations(value, child, found);
    if (found.length > MAX_BODY_FREE_FAILURES) return found;
  }
  return found;
}

// Each precondition of the promise, recomputed from the evidence's own facts, in report order.
// A user class that is neither `standard` nor `unknown` (the probe could not run) is refused as an
// administrator, so an unrecognized value fails closed.
const PRECONDITIONS = [
  ["schema-version", (evidence) => evidence.schemaVersion !== SCHEMA_VERSION],
  ["platform", (evidence) => !Object.hasOwn(CONTAINER_RUNTIME_SIGNS, evidence.platform)],
  [
    "administrator",
    (evidence) => evidence.userClass !== "standard" && evidence.userClass !== "unknown",
  ],
  ["administrator-probe-failed", (evidence) => evidence.userClass === "unknown"],
  [
    "container-runtime-present",
    (evidence) => presentSigns(evidence.containerRuntime, evidence.platform).length > 0,
  ],
  [
    "service-installed",
    (evidence) =>
      evidence.platform === "win32" &&
      recordedServices(evidence.services) &&
      presentServiceSigns(evidence.services).length > 0,
  ],
  [
    "service-probe-failed",
    (evidence) => evidence.platform === "win32" && !recordedServices(evidence.services),
  ],
];

// The names a run may record in `unmetPreconditions`: the ones recomputed above and the container
// probe failure (windowsAcceptancePreconditions.ts). A failed container probe leaves its signs
// unrecorded, which the recomputed rule above refuses as present; the recorded code then says that
// the probe could not run. A failed service probe leaves the services block unrecorded, which the
// recomputed `service-probe-failed` rule reports once.
const PRECONDITION_NAMES = new Set([
  ...PRECONDITIONS.map(([name]) => name),
  "container-runtime-probe-failed",
]);

// What the run itself said was unmet; a run that recorded nothing certifies nothing. Only a known
// name is reported as itself: any other value may carry a body, so it becomes one fixed code (the
// body-free scan names its pointer).
function recordedPreconditions(evidence) {
  if (!Array.isArray(evidence.unmetPreconditions)) return ["unrecorded"];
  return evidence.unmetPreconditions.map((value) =>
    PRECONDITION_NAMES.has(value) ? value : "precondition-unrecognized",
  );
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

// The case rules (skipped for a machine on which no case was run) and the body-free scan.
function resultFailures(evidence, preconditionsOnly) {
  // A machine-only check never passes over a file that carries cases: that is a full-suite file.
  const noCases =
    evidence.cases === undefined || (Array.isArray(evidence.cases) && evidence.cases.length === 0);
  const withCases = preconditionsOnly && !noCases;
  const caseRules = preconditionsOnly ? [] : CASE_RULES;
  const bodyFree = bodyFreeViolations(evidence).slice(0, MAX_BODY_FREE_FAILURES);
  return [
    ...(withCases ? ["preconditions-only-with-cases"] : []),
    ...caseRules.filter(([, unmet]) => unmet(evidence)).map(([name]) => name),
    ...bodyFree.map((pointer) => `body-free:${pointer}`),
  ];
}

/** The reasons the evidence does not certify the promise; empty when it does. */
export function acceptanceEvidenceFailures(evidence, { preconditionsOnly = false } = {}) {
  if (typeof evidence !== "object" || evidence === null) return ["evidence-unreadable"];
  const failures = PRECONDITIONS.filter(([, unmet]) => unmet(evidence)).map(([name]) => name);
  for (const precondition of recordedPreconditions(evidence)) {
    if (!failures.includes(precondition)) failures.push(precondition);
  }
  failures.push(...resultFailures(evidence, preconditionsOnly));
  if (!preconditionsOnly && evidence.certifiesPromise !== true && failures.length === 0) {
    failures.push("not-certified");
  }
  return failures;
}

const NOT_CLOSED = "<not-closed>";

// A summary fact is printed only when it is one closed token; anything else may carry a body.
function fact(evidence, name) {
  const value = evidence?.[name];
  const text = String(value);
  const closed = typeof value !== "object" && CLOSED_TOKEN.test(text);
  return closed && !containsCredentialShape(text) ? text : NOT_CLOSED;
}

/** One body-free line per fact: closed values and counts only. */
export function acceptanceEvidenceSummary(evidence) {
  const signs = presentSigns(evidence?.containerRuntime, evidence?.platform);
  const serviceSigns =
    evidence?.platform === "win32" ? presentServiceSigns(evidence.services) : undefined;
  const cases = casesOf(evidence).length;
  return [
    `platform ${fact(evidence, "platform")} ${fact(evidence, "osRelease")} ${fact(evidence, "arch")}`,
    `node ${fact(evidence, "node")}, opencode ${fact(evidence, "opencode")}`,
    `user class ${fact(evidence, "userClass")}`,
    `container runtime signs: ${signs.length === 0 ? "none" : signs.join(", ")}`,
    ...(serviceSigns === undefined
      ? []
      : [`keiko service signs: ${serviceSigns.length === 0 ? "none" : serviceSigns.join(", ")}`]),
    `cases: ${String(metCount(evidence))} of ${String(cases)} met, set complete ${fact(evidence, "caseSetComplete")}`,
    `certifies the promise: ${fact(evidence, "certifiesPromise")}`,
  ];
}

const PRECONDITIONS_ONLY_FLAG = "--preconditions-only";

function passLine(evidence, preconditionsOnly) {
  const environment = `a standard user without a container runtime${evidence.platform === "win32" ? " or Keiko service" : ""}`;
  return preconditionsOnly
    ? `PASS preconditions met: ${environment}; no case was run, so no result is certified`
    : `PASS ${environment}, every case as expected`;
}

/** Reads the evidence named by `argv[2]` and returns the process exit code. */
export function runCheck(argv, io = console) {
  const read = readJsonArgument(argv, io, { name: NAME, input: "evidence" });
  if ("exitCode" in read) return read.exitCode;
  const evidence = read.value;
  const preconditionsOnly = argv.slice(3).includes(PRECONDITIONS_ONLY_FLAG);
  for (const line of acceptanceEvidenceSummary(evidence)) io.log(`${NAME}: ${line}`);
  const failures = acceptanceEvidenceFailures(evidence, { preconditionsOnly });
  if (failures.length > 0) {
    io.error(`${NAME}: FAIL does not certify the promise: ${failures.join(", ")}`);
    return 1;
  }
  io.log(`${NAME}: ${passLine(evidence, preconditionsOnly)}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = runCheck(process.argv);
}
