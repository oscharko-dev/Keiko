// Real-model, paired baseline/candidate qualification through existing authenticated Chat APIs.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { arch, platform, totalmem, cpus } from "node:os";
import { parseArgs } from "node:util";
import { URL, URLSearchParams } from "node:url";
import {
  startContinuityRuntime,
  privateContinuityOutput,
  snapshotContinuityState,
} from "./chat-continuity-runtime.mjs";
import {
  continuityCorpusManifest,
  continuityDigest,
  continuityPressureNote,
  INITIAL_CONTEXT,
  CORRECTION_CONTEXT,
  RECALL_QUESTION,
  evaluateContinuityAnswer,
} from "./chat-continuity-corpus.mjs";
import { activityLogSnapshot, readActivityLogSince } from "../../lib/activity-log-files.mjs";
import {
  driveContinuityCampaigns,
  writeContinuityJson,
  installContinuityCancellation,
  continuityCaseId,
  continuityTrialResult,
} from "./chat-continuity-campaign.mjs";
import { readContinuityBuildIdentity } from "./chat-continuity-build.mjs";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    config: { type: "string" },
    phase: { type: "string" },
    "duration-ms": { type: "string", default: "7200000" },
    cycles: { type: "string", default: "10" },
    repetitions: { type: "string", default: "5" },
  },
});
if (!values.output || !values.config || !new Set(["baseline", "candidate"]).has(values.phase))
  throw new Error("explicit-output-config-and-phase-required");
const output = privateContinuityOutput(values.output);
mkdirSync(output, { mode: 0o700 });
const requiredDuration = Number(values["duration-ms"]),
  requiredCycles = Number(values.cycles);
const repetitions = Number(values.repetitions);
if (
  ![requiredDuration, requiredCycles, repetitions].every((n) => Number.isSafeInteger(n) && n >= 0)
)
  throw new Error("invalid-qualification-bounds");
const ledger = [],
  physical = [];
const metadata = {
  phase: values.phase,
  ...readContinuityBuildIdentity(),
  harnessDigests: Object.fromEntries(
    ["corpus", "runtime", "run", "campaign", "build"].map((part) => [
      part,
      continuityDigest(readFileSync(new URL(`./chat-continuity-${part}.mjs`, import.meta.url))),
    ]),
  ),
  corpus: continuityCorpusManifest(),
  requiredDuration,
  requiredCycles,
  repetitions,
  qualificationKind:
    requiredDuration >= 7200000 && requiredCycles >= 10 && repetitions >= 5
      ? "longitudinal-fixture"
      : "smoke",
  configurationScope: "configured-chat-providers-only",
  startedAt: new Date().toISOString(),
  hardware: { arch: arch(), platform: platform(), memoryBytes: totalmem(), cpus: cpus().length },
  configurationDigest: continuityDigest(readFileSync(values.config)),
  nodeVersion: process.version,
  policy:
    "Synthetic data only; native configured models; isolated private state; all failures retained.",
};
writeFileSync(join(output, "predeclared.json"), JSON.stringify(metadata, null, 2), { mode: 0o600 });
let runtime, campaign;
let finalStatus = "failed",
  finalQualification;
const cancellation = installContinuityCancellation();
const save = (status, qualification) =>
  writeContinuityJson(join(output, "ledger.json"), {
    ...metadata,
    status,
    qualification,
    updatedAt: new Date().toISOString(),
    campaign,
    ledger,
    physical,
  });
function record(row) {
  ledger.push({ ...row, recordedAt: new Date().toISOString() });
  save("running");
  console.log(
    JSON.stringify({
      id: row.id,
      model: row.model,
      kind: row.kind,
      status: row.status,
      correct: row.score?.correct,
      total: row.score?.total,
      elapsedMs: row.elapsedMs,
      cycles: row.cycles,
      observed: row.observed,
      code: row.code,
    }),
  );
}
async function checked(method, path, body) {
  cancellation.signal.throwIfAborted();
  const result = await runtime.request(method, path, body);
  if (result.status < 200 || result.status >= 300) {
    const error = new Error("qualification-request-refused");
    error.status = result.status;
    error.code = result.json?.error?.code ?? result.json?.code;
    throw error;
  }
  return result;
}
function address(state) {
  return { chatId: state.chat.id, projectPath: runtime.project, modelId: state.model };
}
async function context(state) {
  return (await checked("GET", `/api/chats/context?${new URLSearchParams(address(state))}`)).json;
}
async function newChat(model, kind, repetition) {
  const created = (
    await checked("POST", "/api/chats", {
      projectPath: runtime.project,
      title: `Continuity ${values.phase} ${kind} ${repetition}`,
      selectedModel: model,
    })
  ).json.chat;
  const chat =
    kind === "grounded"
      ? (
          await checked("PATCH", `/api/chats?id=${created.id}`, {
            connectedScopes: [
              {
                kind: "files",
                root: runtime.project,
                relativePaths: ["concept.md"],
                connectedAtMs: Date.now(),
              },
            ],
          })
        ).json.chat
      : created;
  return { model, kind, repetition, chat, cycles: 0, startedAt: Date.now(), failures: 0 };
}
function contextProjection(status) {
  return Object.fromEntries(
    Object.entries(status).filter(([key]) =>
      new Set([
        "contextWindowTokens",
        "inputBudgetTokens",
        "estimatedInputTokens",
        "compaction",
        "pendingCompaction",
        "lastRequest",
        "segments",
        "canCompact",
        "conversationInputBudgetTokens",
        "autoCompactionAtTokens",
      ]).has(key),
    ),
  );
}
async function send(state, content, id, score = false) {
  const startedAt = Date.now(),
    logs = join(runtime.dir, "state", "logs"),
    beforeLog = activityLogSnapshot(logs);
  runtime.setActive(id);
  const result = await checked(
    "POST",
    state.kind === "grounded" ? "/api/chats/messages/grounded" : "/api/desktop/chat",
    sendBody(state, content),
  );
  const answer = responseContent(state, result);
  const events = contextEvents(logs, beforeLog);
  const status = await context(state);
  const row = {
    id,
    model: state.model,
    kind: state.kind,
    repetition: state.repetition,
    status: result.status,
    elapsedMs: Date.now() - startedAt,
    answerDigest: continuityDigest(answer),
    answerChars: answer.length,
    context: contextProjection(status),
    events,
  };
  if (score) {
    row.score = evaluateContinuityAnswer(answer);
    const phase = id.endsWith(":control")
      ? "control"
      : id.endsWith(":restart-recall")
        ? "restart"
        : "cycle";
    (state.probes ??= []).push({ phase, score: row.score });
  }
  record(row);
  return status;
}
function sendBody(state, content) {
  return {
    ...address(state),
    content,
    expectedSkillSelectionRevision: null,
    ...(state.kind === "grounded"
      ? { expectedGroundingScopeIdentity: state.chat.groundingScopeIdentity }
      : { clientTurnId: randomUUID() }),
  };
}
function responseContent(state, result) {
  return (
    (state.kind === "grounded"
      ? result.json.content
      : result.json.messages?.findLast((m) => m.role === "assistant")?.content) ?? ""
  );
}
function contextEvents(logs, beforeLog) {
  return readActivityLogSince(logs, beforeLog)
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    })
    .filter((event) => /^(chat\.(context|continuity)|gateway\.)/u.test(event.op));
}
async function establish(state) {
  await send(state, INITIAL_CONTEXT, continuityCaseId(state, "initial"));
  await send(state, CORRECTION_CONTEXT, continuityCaseId(state, "correction"));
  await probe(state, continuityCaseId(state, "control"));
}
async function probe(state, id) {
  const original = runtime,
    dir = join(output, `probe-${ledger.length}`);
  await original.drain();
  cancellation.signal.throwIfAborted();
  await snapshotContinuityState(original.dir, dir);
  let isolated;
  try {
    isolated = await startContinuityRuntime(dir, original.env.KEIKO_CONFIG_FILE, physical, {
      env: original.env,
      port: original.proxyPort,
      signal: cancellation.signal,
    });
    isolated.project = original.project;
    isolated.setActive = original.setActive;
    runtime = isolated;
    await send(state, RECALL_QUESTION, id, true);
    await isolated.drain();
  } finally {
    runtime = original;
    await isolated?.close();
  }
}
async function pressureCycle(state) {
  const cycle = state.cycles + 1,
    mode = cycle % 2 ? "manual" : "automatic";
  let status = await context(state);
  const original = status.compaction?.messagesCompacted ?? 0;
  status = await fillContext(state, cycle, mode, status, original);
  if (mode === "manual") {
    const compacted = (await checked("POST", "/api/chats/context/compact", address(state))).json;
    record({
      id: continuityCaseId(state, `cycle-${cycle}:manual`),
      model: state.model,
      kind: state.kind,
      repetition: state.repetition,
      context: contextProjection(compacted),
    });
    status = compacted;
  }
  const observed = (status.compaction?.messagesCompacted ?? 0) > original;
  if (observed) state.cycles++;
  record({
    id: continuityCaseId(state, `cycle-${cycle}:observed`),
    model: state.model,
    kind: state.kind,
    repetition: state.repetition,
    mode,
    observed,
    cycles: state.cycles,
  });
  if (!observed) state.failures++;
  await probe(state, continuityCaseId(state, `cycle-${cycle}:recall`));
  return observed;
}
async function fillContext(state, cycle, mode, status, original) {
  const budget =
    state.kind === "grounded" ? status.conversationInputBudgetTokens : status.inputBudgetTokens;
  const characters = Math.max(6000, Math.floor(budget * 0.9));
  const parts = mode === "manual" ? 3 : 5;
  for (let part = 0; part < parts; part++) {
    status = await send(
      state,
      continuityPressureNote(cycle, part, characters),
      continuityCaseId(state, `cycle-${cycle}:pressure-${part}`),
    );
    if (pressureReached(mode, status, original)) break;
  }
  return status;
}
function pressureReached(mode, status, original) {
  return mode === "manual"
    ? status.canCompact
    : (status.compaction?.messagesCompacted ?? 0) > original;
}
async function runGuarded(state, operation) {
  try {
    return await operation();
  } catch (error) {
    if (cancellation.signal.aborted) throw error;
    state.failures++;
    record({
      id: continuityCaseId(state, `failed-${state.failures}`),
      model: state.model,
      kind: state.kind,
      repetition: state.repetition,
      errorClass: error.name,
      status: error.status,
      code: error.code ?? "operation-failed",
    });
    return false;
  }
}
async function runCampaigns() {
  const states = [];
  for (const model of runtime.models)
    for (const kind of ["plain", "grounded"]) {
      const state = await newChat(model, kind, "long");
      states.push(state);
      await runGuarded(state, () => establish(state));
    }
  campaign = states;
  await driveContinuityCampaigns(states, { requiredCycles, requiredDuration }, (state) =>
    runGuarded(state, () => pressureCycle(state)),
  );
  cancellation.signal.throwIfAborted();
  await runtime.restart();
  for (const state of states)
    await runGuarded(state, () => probe(state, continuityCaseId(state, "restart-recall")));
  const results = states.map((state) =>
    continuityTrialResult(state, { requiredCycles, requiredDuration }),
  );
  for (const result of results) record(result);
  const campaignsPassed = results.every((result) => result.status === "passed");
  const repetitionsPassed = await runRepetitions();
  return { campaignsPassed, repetitionsPassed };
}
async function runRepetitions() {
  let passed = true;
  for (let repetition = 0; repetition < repetitions; repetition++)
    for (const model of runtime.models) {
      const state = await newChat(model, "plain", repetition);
      await runGuarded(state, async () => {
        await establish(state);
        await pressureCycle(state);
      });
      const result = continuityTrialResult(state, {
        requiredCycles: 1,
        requiredDuration: 0,
        requireRestart: false,
      });
      record(result);
      if (result.status !== "passed") passed = false;
    }
  return passed;
}
try {
  runtime = await startContinuityRuntime(join(output, "runtime"), values.config, physical, {
    signal: cancellation.signal,
  });
  metadata.models = runtime.models;
  metadata.requestTimeoutByModel = runtime.requestTimeoutByModel;
  record({ id: "runtime-ready", models: runtime.models });
  const qualification = await runCampaigns();
  const passed = qualification.campaignsPassed && qualification.repetitionsPassed;
  finalStatus = passed ? "completed" : "incomplete";
  finalQualification = qualification;
  if (!passed) process.exitCode = 1;
} catch (error) {
  const interrupted = cancellation.signal.aborted;
  record({
    id: interrupted ? "campaign-terminated" : "campaign-failed",
    errorClass: error.name,
    code: interrupted ? "operator-interrupted" : (error.code ?? "operation-failed"),
  });
  metadata.terminationSignal = cancellation.reason;
  finalStatus = interrupted ? "terminated" : "failed";
  process.exitCode = interrupted ? (cancellation.reason === "SIGTERM" ? 143 : 130) : 1;
} finally {
  try {
    await runtime?.close();
  } catch (error) {
    record({
      id: "campaign-cleanup-failed",
      errorClass: error.name,
      code: "runtime-cleanup-failed",
    });
    finalStatus = "failed";
    process.exitCode = 1;
  } finally {
    cancellation.dispose();
  }
  save(finalStatus, finalQualification);
}
