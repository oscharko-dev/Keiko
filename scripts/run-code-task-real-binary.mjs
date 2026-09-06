// Issue #2483 macOS acceptance runner. It drives the real-binary Playwright variant, samples only
// aggregate TCP scope facts for the approved OpenCode process, records the materialized child and
// provider-boundary limits, and proves missing staged payloads fail production discovery closed.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { clearInterval, setInterval } from "node:timers";
import { fileURLToPath } from "node:url";

import { hostDevLaneTarget } from "./stage-dev-coding-runtime.mjs";
import {
  captureToolCatalogQualificationBinding,
  validToolCatalogQualificationOutcome,
  writeToolCatalogQualificationObservation,
} from "./lib/tool-catalog-qualification-observation.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const MAX_DISTINCT_CONNECTIONS = 4_096;
const MAX_ACTIVITY_LOG_BYTES = 32 * 1_024 * 1_024;
const REAL_BINARY_VERSION = "1.17.17";
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

// Absolute, fixed system paths — never a bare name resolved through PATH. This runner samples
// process and socket facts on a developer or CI machine whose PATH may contain writable
// directories, and a shadowed `ps`/`lsof` would silently decide what the egress evidence claims.
// Mirrors the governed-executable pattern in scripts/check-dependency-hygiene.mjs.
const GOVERNED_PS_PATHS = ["/bin/ps", "/usr/bin/ps"];
const GOVERNED_LSOF_PATHS = ["/usr/sbin/lsof", "/usr/bin/lsof", "/opt/homebrew/bin/lsof"];

export function governedExecutable(candidates, label) {
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(`${label} not found at a governed absolute path (${candidates.join(", ")})`);
  }
  return found;
}

function isLoopbackEndpoint(endpoint) {
  return (
    /^127(?:\.\d{1,3}){3}:/u.test(endpoint) ||
    endpoint.startsWith("[::1]:") ||
    endpoint.startsWith("[::ffff:127.") ||
    endpoint.startsWith("localhost:")
  );
}

export function classifyLsofNetworkNames(output) {
  return output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("n") && line.includes("->"))
    .map((line) => line.slice(1))
    .map((connection) => {
      const remote = connection.slice(connection.indexOf("->") + 2);
      return { connection, scope: isLoopbackEndpoint(remote) ? "loopback" : "external" };
    });
}

export function processIdsForExecutable(output, executable) {
  return output.split(/\r?\n/u).flatMap((line) => {
    const matched = /^[ \t]*(?<pid>\d+)[ \t]+(?<command>[^ \t].*)$/u.exec(line);
    if (
      matched?.groups === undefined ||
      (matched.groups.command !== executable &&
        !matched.groups.command.startsWith(`${executable} `))
    ) {
      return [];
    }
    const pid = Number(matched.groups.pid);
    return Number.isSafeInteger(pid) && pid > 0 ? [pid] : [];
  });
}

export function addBounded(set, value, state) {
  if (set.has(value)) return;
  if (set.size >= MAX_DISTINCT_CONNECTIONS) {
    state.truncated = true;
    return;
  }
  set.add(value);
}

export function createNetworkObserver(executable) {
  const processIds = new Set();
  const loopback = new Set();
  const external = new Set();
  const state = { sampleCount: 0, socketObservationCount: 0, truncated: false };
  return {
    sample: () => sampleNetwork(executable, processIds, loopback, external, state),
    report: () => ({
      method: "sampled-established-tcp-sockets",
      sampleCount: state.sampleCount,
      observedProcessCount: processIds.size,
      socketObservationCount: state.socketObservationCount,
      distinctLoopbackConnectionCount: loopback.size,
      distinctExternalConnectionCount: external.size,
      truncated: state.truncated,
      contentFieldsRecorded: false,
      endpointFieldsRecorded: false,
    }),
  };
}

function sampleNetwork(executable, processIds, loopback, external, state) {
  state.sampleCount += 1;
  let psOutput;
  try {
    psOutput = execFileSync(
      governedExecutable(GOVERNED_PS_PATHS, "ps"),
      ["-axo", "pid=,command="],
      {
        encoding: "utf8",
      },
    );
  } catch {
    return;
  }
  for (const pid of processIdsForExecutable(psOutput, executable)) {
    processIds.add(pid);
    sampleProcessSockets(pid, loopback, external, state);
  }
}

function sampleProcessSockets(pid, loopback, external, state) {
  let output;
  try {
    output = execFileSync(
      governedExecutable(GOVERNED_LSOF_PATHS, "lsof"),
      ["-nP", "-a", "-p", String(pid), "-iTCP", "-F", "n"],
      { encoding: "utf8" },
    );
  } catch {
    return;
  }
  for (const observation of classifyLsofNetworkNames(output)) {
    state.socketObservationCount += 1;
    const digest = createHash("sha256").update(observation.connection, "utf8").digest("hex");
    addBounded(observation.scope === "loopback" ? loopback : external, digest, state);
  }
}

function runPlaywright(env, observer, limitObserver) {
  const args = [
    join(repoRoot, "node_modules", "@playwright", "test", "cli.js"),
    "test",
    "--config",
    "tests/e2e/config/playwright.code-task-real-binary.config.ts",
    "--project=chromium",
  ];
  const child = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: "inherit" });
  const sample = () => {
    observer.sample();
    limitObserver.sample();
  };
  const interval = setInterval(sample, 200);
  interval.unref();
  sample();
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      clearInterval(interval);
      sample();
      resolveExit(code ?? 1);
    });
  });
}

export function readGatewayObservation(path) {
  const empty = {
    requestCount: 0,
    outputTokenLimits: [],
    catalogBinding: undefined,
    catalogBindingRequestCount: 0,
  };
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      requestCount: Number(parsed.requestCount ?? 0),
      outputTokenLimits: Array.isArray(parsed.outputTokenLimits)
        ? parsed.outputTokenLimits.filter((value) => Number.isSafeInteger(value))
        : [],
      catalogBinding: captureToolCatalogQualificationBinding(parsed.catalogBinding),
      catalogBindingRequestCount: Number(parsed.catalogBindingRequestCount ?? 0),
    };
  } catch {
    return empty;
  }
}

function materializedConfigPaths(stateDir) {
  const root = join(stateDir, "bff-state", "ui-db", "coding-runtime", "opencode");
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory()) return [];
      const path = join(root, entry.name, "config", "opencode", "opencode.json");
      return existsSync(path) ? [path] : [];
    });
  } catch {
    return [];
  }
}

export function readMaterializedLimits(stateDir) {
  const limits = materializedConfigPaths(stateDir).flatMap((path) => {
    try {
      const config = JSON.parse(readFileSync(path, "utf8"));
      const limit = config.provider?.["keiko-runtime"]?.models?.coding?.limit;
      return Number.isSafeInteger(limit?.context) && Number.isSafeInteger(limit?.output)
        ? [{ context: limit.context, output: limit.output }]
        : [];
    } catch {
      return [];
    }
  });
  return [...new Map(limits.map((limit) => [`${limit.context}:${limit.output}`, limit])).values()];
}

function createMaterializedLimitObserver(stateDir) {
  const observed = new Map();
  return {
    sample: () => {
      for (const limit of readMaterializedLimits(stateDir)) {
        observed.set(`${limit.context}:${limit.output}`, limit);
      }
    },
    report: () => [...observed.values()],
  };
}

function runMissingPayloadProbe(target, stateDir) {
  const runtimeRoot = join(repoRoot, ".portable-sidecar-payloads", target, "opencode-compatible");
  const payload = join(runtimeRoot, "payload");
  const held = join(runtimeRoot, `.payload-missing-probe-${String(process.pid)}`);
  if (!statSync(payload).isDirectory() || existsSync(held)) throw new Error("payload-probe-unsafe");
  renameSync(payload, held);
  try {
    return executeMissingPayloadProbe(stateDir);
  } finally {
    renameSync(held, payload);
  }
}

function executeMissingPayloadProbe(stateDir) {
  const entry = join(
    repoRoot,
    "tests/e2e/servers/dist/tests/e2e/servers/coding-runtime-2483-real-binary-server.mjs",
  );
  const result = spawnSync(process.execPath, [entry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      KEIKO_E2E_STATE_DIR: stateDir,
      KEIKO_2483_EXPECT_UNAVAILABLE_REASON: "payload-missing",
    },
    encoding: "utf8",
  });
  const passed =
    result.status === 0 && result.stdout.includes("KEIKO_2483_UNAVAILABLE payload-missing");
  if (!passed) {
    // The negative probe is the honest half of the readiness proof, so a failure must say WHY.
    // Without this the runner exits nonzero with no signal at all and the next operator has to
    // re-stage the payload by hand to reproduce it.
    console.error(
      `[code-task-real-binary] payload-missing probe failed: exit=${String(result.status)}` +
        ` signal=${String(result.signal)}\n--- probe stdout ---\n${result.stdout}` +
        `\n--- probe stderr ---\n${result.stderr}`,
    );
  }
  return { passed, unavailableReason: passed ? "payload-missing" : "probe-failed" };
}

function writeEvidence(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

export function ensureMacTarget(target = hostDevLaneTarget()) {
  if (target !== "macos-arm64" && target !== "macos-x64") {
    throw new Error("real-binary journey requires macOS arm64 or x64");
  }
  return target;
}

/**
 * The same resolved temp root `tests/e2e/support/e2e-state-dir.ts` uses.
 *
 * It is repeated rather than imported because that helper is TypeScript, loaded by Playwright, and
 * this is a plain Node script — but the VALUE has to agree, because the paths below are forced into
 * `KEIKO_E2E_STATE_DIR`, which the helper returns verbatim. Handing it an unresolved path routes
 * every downstream consumer around the very resolution the helper exists to perform, on the one
 * lane (`code-task-real-binary`, macOS) where the symlinked temp root actually bites.
 * `e2e-state-dir.static.test.ts` pins that this file and the helper stay in step.
 */
function e2eTempRoot() {
  return realpathSync(tmpdir());
}

export function createJourneyContext(target) {
  const runKey = process.env.GITHUB_RUN_ID ?? String(process.pid);
  const stateDir = join(e2eTempRoot(), "keiko-e2e", `code-task-2483-real-binary-${runKey}`);
  return {
    executable: join(
      repoRoot,
      ".portable-sidecar-payloads",
      target,
      "opencode-compatible",
      "payload",
      "bin",
      "opencode",
    ),
    stateDir,
    gatewayObservation: join(stateDir, "gateway-observation.json"),
    probeState: join(e2eTempRoot(), "keiko-e2e", `code-task-2483-missing-${runKey}`),
    evidencePath: resolve(
      repoRoot,
      process.env.KEIKO_CODE_TASK_EVIDENCE_OUT ??
        "test-results/code-task-real-binary-evidence.json",
    ),
  };
}

export function buildJourneyReport(input) {
  return {
    schemaVersion: 1,
    issue: 2483,
    evidenceClass: "functional-not-platform-qualified",
    runtime: { name: "opencode-compatible", version: REAL_BINARY_VERSION, target: input.target },
    journey: { exitCode: input.exitCode, wallClockMs: input.wallClockMs },
    limits: {
      materializedChildLimits: input.limits,
      gatewayRequestCount: input.gateway.requestCount,
      gatewayCatalogBindingRequestCount: input.gateway.catalogBindingRequestCount,
      observedGatewayOutputTokenLimits: input.gateway.outputTokenLimits,
    },
    egress: input.observer.report(),
    missingPayload: input.missingPayload,
    h1Search: input.h1Search,
    managedCatalog: input.managedCatalog,
    activityLog: input.activityLog,
  };
}

export function retainJourneyActivityLog(context) {
  const source = join(context.stateDir, "activity", "logs", "server.log");
  if (!existsSync(source)) return { status: "missing" };
  mkdirSync(dirname(context.evidencePath), { recursive: true });
  copyFileSync(source, `${context.evidencePath}.activity.jsonl`);
  return {
    status: "retained",
    sha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
  };
}

function hasRetainedActivity(report) {
  return (
    report.activityLog?.status === "retained" && /^[a-f0-9]{64}$/u.test(report.activityLog.sha256)
  );
}

function validH1SearchEvidence(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.schemaVersion === 1 &&
    value.toolCallId === "h1-real-binary-search" &&
    value.hitCount === 1 &&
    value.startLine === 1 &&
    value.endLine === 1 &&
    value.readTargetDerivedFromResult === true &&
    /^[a-f0-9]{64}$/u.test(value.pathDigest) &&
    /^[a-f0-9]{64}$/u.test(value.snippetDigest)
  );
}

export function readH1SearchEvidence(stateDir) {
  const path = join(stateDir, "h1-result-consumption.json");
  if (!existsSync(path) || statSync(path).size > 4_096) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!validH1SearchEvidence(value)) return undefined;
  return {
    schemaVersion: value.schemaVersion,
    toolCallId: value.toolCallId,
    hitCount: value.hitCount,
    pathDigest: value.pathDigest,
    snippetDigest: value.snippetDigest,
    startLine: value.startLine,
    endLine: value.endLine,
    readTargetDerivedFromResult: true,
  };
}

function readActivityRecords(stateDir) {
  const path = join(stateDir, "activity", "logs", "server.log");
  if (!existsSync(path) || statSync(path).size > MAX_ACTIVITY_LOG_BYTES) return undefined;
  const records = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        const value = JSON.parse(line);
        return value !== null && typeof value === "object" ? value : undefined;
      } catch {
        return undefined;
      }
    });
  return records.includes(undefined) ? undefined : records;
}

function catalogSettlement(value, expectedBinding) {
  const toolRef = value.toolRef;
  const valid = [
    value.op === "tool-catalog.invocation-settled",
    typeof value.correlationId === "string" && EVIDENCE_ID.test(value.correlationId),
    toolRef !== null && typeof toolRef === "object",
    typeof toolRef?.canonicalId === "string" && EVIDENCE_ID.test(toolRef.canonicalId),
    typeof value.status === "string",
    typeof value.invocationId === "string" && EVIDENCE_ID.test(value.invocationId),
  ].every(Boolean);
  if (!valid) {
    return undefined;
  }
  const binding = captureToolCatalogQualificationBinding({
    catalogRevision: value.catalogRevision,
    profile: value.profile,
    projectionDigest: value.projectionDigest,
    handlerSetDigest: expectedBinding.handlerSetDigest,
  });
  if (binding === undefined) return undefined;
  return {
    correlationId: value.correlationId,
    invocationId: value.invocationId,
    status: value.status,
    canonicalId: value.toolRef.canonicalId,
    catalogRevision: binding.catalogRevision,
    profile: binding.profile,
    projectionDigest: binding.projectionDigest,
  };
}

function removeJourneyState(context) {
  rmSync(context.stateDir, { recursive: true, force: true });
  rmSync(context.probeState, { recursive: true, force: true });
}

function settlementUsesBinding(settlement, binding) {
  return (
    settlement.catalogRevision === binding.catalogRevision &&
    settlement.profile.id === binding.profile.id &&
    settlement.profile.version === binding.profile.version &&
    settlement.projectionDigest === binding.projectionDigest
  );
}

function completedToolIndex(settlements, canonicalId, after = -1) {
  return settlements.findIndex(
    (settlement, index) =>
      index > after && settlement.status === "completed" && settlement.canonicalId === canonicalId,
  );
}

export function readManagedCatalogEvidence(stateDir, gateway, h1Search) {
  const binding = captureToolCatalogQualificationBinding(gateway.catalogBinding);
  if (
    binding === undefined ||
    gateway.requestCount <= 0 ||
    gateway.catalogBindingRequestCount !== gateway.requestCount ||
    !validH1SearchEvidence(h1Search)
  ) {
    return undefined;
  }
  const activity = readActivityRecords(stateDir);
  if (activity === undefined) return undefined;
  const terminalRecords = activity.filter(
    (value) => value.op === "tool-catalog.invocation-settled",
  );
  const settlements = terminalRecords.flatMap((value) => {
    const captured = catalogSettlement(value, binding);
    return captured === undefined ? [] : [captured];
  });
  if (settlements.length !== terminalRecords.length) return undefined;
  const correlations = [...new Set(settlements.map(({ correlationId }) => correlationId))];
  const candidates = correlations.flatMap((correlationId) => {
    const scoped = settlements.filter((item) => item.correlationId === correlationId);
    if (
      !scoped.every((item) => settlementUsesBinding(item, binding)) ||
      new Set(scoped.map(({ invocationId }) => invocationId)).size !== scoped.length
    ) {
      return [];
    }
    const search = completedToolIndex(scoped, "keiko.repo.search");
    const read = completedToolIndex(scoped, "keiko.workspace.read", search);
    if (search < 0 || read < 0) return [];
    return [{ correlationId, settlementCount: scoped.length }];
  });
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0];
  return {
    binding,
    correlationId: candidate.correlationId,
    settlementCount: candidate.settlementCount,
    proof: {
      kind: "managed-search-read",
      searchSettled: true,
      boundedReadSettled: true,
      causalHandoff: true,
    },
  };
}

function validManagedCatalogEvidence(value) {
  return (
    value !== undefined &&
    captureToolCatalogQualificationBinding(value.binding) !== undefined &&
    typeof value.correlationId === "string" &&
    EVIDENCE_ID.test(value.correlationId) &&
    validToolCatalogQualificationOutcome(
      "managed-opencode",
      "completed",
      value.settlementCount,
      value.proof,
    )
  );
}

function hasStableGatewayCatalogBinding(limits) {
  return (
    limits.gatewayRequestCount > 0 &&
    limits.gatewayCatalogBindingRequestCount === limits.gatewayRequestCount
  );
}

/**
 * Names every observation the evidence predicate requires but the report does not carry. Empty means
 * the report is complete; the list is the operator-facing explanation of a failed run.
 */
export function missingRealBinaryEvidence(report) {
  const limits = report.limits;
  const gaps = [];
  if (report.journey.exitCode !== 0)
    gaps.push(`journey exit code ${String(report.journey.exitCode)}`);
  if (!limits.materializedChildLimits.some((l) => l.context === 32_768 && l.output === 4_096)) {
    gaps.push("no materialized child limits of context 32768 / output 4096");
  }
  if (limits.gatewayRequestCount <= 0) gaps.push("no gateway request was observed");
  if (!hasStableGatewayCatalogBinding(limits)) {
    gaps.push("not every gateway request carried the stable productive catalog binding");
  }
  if (!limits.observedGatewayOutputTokenLimits.includes(4_096)) {
    gaps.push("no gateway request carried the effective output limit 4096");
  }
  gaps.push(...missingPayloadEvidence(report.missingPayload));
  if (!validH1SearchEvidence(report.h1Search))
    gaps.push("no useful H1 search-to-read result evidence");
  if (!validManagedCatalogEvidence(report.managedCatalog)) {
    gaps.push("no stable managed catalog binding with completed search and bounded read");
  }
  if (!hasRetainedActivity(report)) gaps.push("no retained canonical activity log");
  return gaps;
}

function missingPayloadEvidence(probe) {
  if (probe?.passed !== true) {
    return [`payload-missing probe did not pass (reason ${String(probe?.unavailableReason)})`];
  }
  return probe.unavailableReason === "payload-missing"
    ? []
    : [`payload-missing probe reported ${probe.unavailableReason}`];
}

export function realBinaryEvidenceComplete(report) {
  const limits = report.limits;
  return (
    report.journey.exitCode === 0 &&
    limits.materializedChildLimits.some(
      (limit) => limit.context === 32_768 && limit.output === 4_096,
    ) &&
    hasStableGatewayCatalogBinding(limits) &&
    limits.observedGatewayOutputTokenLimits.includes(4_096) &&
    report.missingPayload?.passed === true &&
    report.missingPayload.unavailableReason === "payload-missing" &&
    validH1SearchEvidence(report.h1Search) &&
    validManagedCatalogEvidence(report.managedCatalog) &&
    hasRetainedActivity(report)
  );
}

export function writeManagedCatalogObservation(report) {
  if (!realBinaryEvidenceComplete(report)) return false;
  writeToolCatalogQualificationObservation({
    consumer: "managed-opencode",
    component: "managed-opencode",
    binding: report.managedCatalog.binding,
    terminalStatus: "completed",
    settlementCount: report.managedCatalog.settlementCount,
    proof: report.managedCatalog.proof,
  });
  return true;
}

function reportMissingEvidence(report) {
  if (realBinaryEvidenceComplete(report)) return;
  for (const gap of missingRealBinaryEvidence(report)) {
    console.error(`[code-task-real-binary] incomplete evidence: ${gap}`);
  }
  process.exitCode = 1;
}

export async function runRealBinaryJourney() {
  const target = ensureMacTarget();
  const context = createJourneyContext(target);
  if (!existsSync(context.executable)) {
    throw new Error("staged approved OpenCode payload is missing");
  }
  execFileSync(governedExecutable(GOVERNED_LSOF_PATHS, "lsof"), ["-v"], { stdio: "ignore" });
  const observer = createNetworkObserver(context.executable);
  const limitObserver = createMaterializedLimitObserver(context.stateDir);
  const startedAt = Date.now();
  const exitCode = await runPlaywright(
    {
      ...process.env,
      KEIKO_E2E_STATE_DIR: context.stateDir,
      KEIKO_STATE_DIR: join(context.stateDir, "activity"),
      KEIKO_E2E_REAL_BINARY: "1",
      KEIKO_2483_GATEWAY_OBSERVATION_PATH: context.gatewayObservation,
    },
    observer,
    limitObserver,
  );
  const missingPayload =
    exitCode === 0 ? runMissingPayloadProbe(target, context.probeState) : undefined;
  const gateway = readGatewayObservation(context.gatewayObservation);
  const h1Search = readH1SearchEvidence(context.stateDir);
  const managedCatalog = readManagedCatalogEvidence(context.stateDir, gateway, h1Search);
  const activityLog = retainJourneyActivityLog(context);
  const report = buildJourneyReport({
    context,
    exitCode,
    gateway,
    limits: limitObserver.report(),
    missingPayload,
    h1Search,
    managedCatalog,
    activityLog,
    observer,
    target,
    wallClockMs: Date.now() - startedAt,
  });
  writeEvidence(context.evidencePath, report);
  writeManagedCatalogObservation(report);
  removeJourneyState(context);
  // A bare nonzero exit forces the next reader to diff the evidence file against the predicate.
  reportMissingEvidence(report);
  return report;
}

function isDirectInvocation() {
  const argv1 = process.argv[1];
  return argv1 !== undefined && resolve(argv1) === fileURLToPath(import.meta.url);
}

if (isDirectInvocation()) {
  try {
    await runRealBinaryJourney();
  } catch (error) {
    console.error(`[code-task-real-binary] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
