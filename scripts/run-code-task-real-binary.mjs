// Issue #2483 macOS acceptance runner. It drives the real-binary Playwright variant, samples only
// aggregate TCP scope facts for the approved OpenCode process, records the materialized child and
// provider-boundary limits, and proves missing staged payloads fail production discovery closed.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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

const repoRoot = resolve(import.meta.dirname, "..");
const MAX_DISTINCT_CONNECTIONS = 4_096;
const REAL_BINARY_VERSION = "1.17.17";

function isLoopbackEndpoint(endpoint) {
  return (
    /^127(?:\.[0-9]{1,3}){3}:/u.test(endpoint) ||
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
    const matched = /^\s*(?<pid>[0-9]+)\s+(?<command>.+)$/u.exec(line);
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

function addBounded(set, value, state) {
  if (set.has(value)) return;
  if (set.size >= MAX_DISTINCT_CONNECTIONS) {
    state.truncated = true;
    return;
  }
  set.add(value);
}

function createNetworkObserver(executable) {
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
    psOutput = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
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
    output = execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-F", "n"], {
      encoding: "utf8",
    });
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

function readGatewayObservation(path) {
  if (!existsSync(path)) return { requestCount: 0, outputTokenLimits: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return {
    requestCount: Number(parsed.requestCount ?? 0),
    outputTokenLimits: Array.isArray(parsed.outputTokenLimits)
      ? parsed.outputTokenLimits.filter((value) => Number.isSafeInteger(value))
      : [],
  };
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
  return { passed, unavailableReason: passed ? "payload-missing" : "probe-failed" };
}

function writeEvidence(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

function ensureMacTarget() {
  const target = hostDevLaneTarget();
  if (target === undefined) throw new Error("real-binary journey requires macOS arm64 or x64");
  return target;
}

function createJourneyContext(target) {
  const runKey = process.env.GITHUB_RUN_ID ?? String(process.pid);
  const stateDir = join(tmpdir(), "keiko-e2e", `code-task-2483-real-binary-${runKey}`);
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
    probeState: join(tmpdir(), "keiko-e2e", `code-task-2483-missing-${runKey}`),
    evidencePath: resolve(
      repoRoot,
      process.env.KEIKO_CODE_TASK_EVIDENCE_OUT ??
        "test-results/code-task-real-binary-evidence.json",
    ),
  };
}

function buildJourneyReport(input) {
  return {
    schemaVersion: 1,
    issue: 2483,
    evidenceClass: "functional-not-platform-qualified",
    runtime: { name: "opencode-compatible", version: REAL_BINARY_VERSION, target: input.target },
    journey: { exitCode: input.exitCode, wallClockMs: input.wallClockMs },
    limits: {
      materializedChildLimits: input.limits,
      gatewayRequestCount: input.gateway.requestCount,
      observedGatewayOutputTokenLimits: input.gateway.outputTokenLimits,
    },
    egress: input.observer.report(),
    missingPayload: input.missingPayload,
  };
}

export function realBinaryEvidenceComplete(report) {
  const limits = report.limits;
  return (
    report.journey.exitCode === 0 &&
    limits.materializedChildLimits.some(
      (limit) => limit.context === 32_768 && limit.output === 4_096,
    ) &&
    limits.gatewayRequestCount > 0 &&
    limits.observedGatewayOutputTokenLimits.includes(4_096) &&
    report.missingPayload?.passed === true &&
    report.missingPayload.unavailableReason === "payload-missing"
  );
}

export async function runRealBinaryJourney() {
  const target = ensureMacTarget();
  const context = createJourneyContext(target);
  if (!existsSync(context.executable)) {
    throw new Error("staged approved OpenCode payload is missing");
  }
  execFileSync("lsof", ["-v"], { stdio: "ignore" });
  const observer = createNetworkObserver(context.executable);
  const limitObserver = createMaterializedLimitObserver(context.stateDir);
  const startedAt = Date.now();
  const exitCode = await runPlaywright(
    {
      ...process.env,
      KEIKO_E2E_STATE_DIR: context.stateDir,
      KEIKO_E2E_REAL_BINARY: "1",
      KEIKO_2483_GATEWAY_OBSERVATION_PATH: context.gatewayObservation,
    },
    observer,
    limitObserver,
  );
  const missingPayload =
    exitCode === 0 ? runMissingPayloadProbe(target, context.probeState) : undefined;
  const report = buildJourneyReport({
    context,
    exitCode,
    gateway: readGatewayObservation(context.gatewayObservation),
    limits: limitObserver.report(),
    missingPayload,
    observer,
    target,
    wallClockMs: Date.now() - startedAt,
  });
  writeEvidence(context.evidencePath, report);
  rmSync(context.stateDir, { recursive: true, force: true });
  rmSync(context.probeState, { recursive: true, force: true });
  if (!realBinaryEvidenceComplete(report)) process.exitCode = 1;
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
