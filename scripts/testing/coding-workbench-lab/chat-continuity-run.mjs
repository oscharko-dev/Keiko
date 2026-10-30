// Real-model, paired baseline/candidate qualification through existing authenticated Chat APIs.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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
  sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  productTreeDigest: continuityDigest(execFileSync("git", ["ls-tree", "HEAD", "packages", "src"])),
  harnessDigests: Object.fromEntries(
    ["corpus", "runtime", "run"].map((part) => [
      part,
      continuityDigest(readFileSync(new URL(`./chat-continuity-${part}.mjs`, import.meta.url))),
    ]),
  ),
  corpus: continuityCorpusManifest(),
  requiredDuration,
  requiredCycles,
  repetitions,
  startedAt: new Date().toISOString(),
  hardware: { arch: arch(), platform: platform(), memoryBytes: totalmem(), cpus: cpus().length },
  configurationDigest: continuityDigest(readFileSync(values.config)),
  nodeVersion: process.version,
  policy:
    "Synthetic data only; native configured models; isolated private state; all failures retained.",
};
writeFileSync(join(output, "predeclared.json"), JSON.stringify(metadata, null, 2), { mode: 0o600 });
let runtime, campaign;
const save = (status) =>
  writeFileSync(
    join(output, "ledger.json"),
    JSON.stringify(
      { ...metadata, status, updatedAt: new Date().toISOString(), campaign, ledger, physical },
      null,
      2,
    ),
    { mode: 0o600 },
  );
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
  const result = await runtime.request(method, path, body, { timeoutMs: 360000 });
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
    status: result.status,
    elapsedMs: Date.now() - startedAt,
    answerDigest: continuityDigest(answer),
    answerChars: answer.length,
    context: contextProjection(status),
    events,
  };
  if (score) row.score = evaluateContinuityAnswer(answer);
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
  await send(state, INITIAL_CONTEXT, `${state.model}:${state.kind}:${state.repetition}:initial`);
  await send(
    state,
    CORRECTION_CONTEXT,
    `${state.model}:${state.kind}:${state.repetition}:correction`,
  );
  await probe(state, `${state.model}:${state.kind}:${state.repetition}:control`);
}
async function probe(state, id) {
  const original = runtime,
    dir = join(output, `probe-${ledger.length}`);
  await original.drain();
  await snapshotContinuityState(original.dir, dir);
  let isolated;
  try {
    isolated = await startContinuityRuntime(dir, original.env.KEIKO_CONFIG_FILE, physical, {
      env: original.env,
      port: original.proxyPort,
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
      id: `${state.model}:${state.kind}:cycle-${cycle}:manual`,
      model: state.model,
      kind: state.kind,
      context: contextProjection(compacted),
    });
    status = compacted;
  }
  const observed = (status.compaction?.messagesCompacted ?? 0) > original;
  if (observed) state.cycles++;
  record({
    id: `${state.model}:${state.kind}:cycle-${cycle}:observed`,
    model: state.model,
    kind: state.kind,
    mode,
    observed,
    cycles: state.cycles,
  });
  if (!observed) state.failures++;
  await probe(state, `${state.model}:${state.kind}:cycle-${cycle}:recall`);
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
      `${state.model}:${state.kind}:cycle-${cycle}:pressure-${part}`,
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
    state.failures++;
    record({
      id: `${state.model}:${state.kind}:failed-${state.failures}`,
      model: state.model,
      kind: state.kind,
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
  while (
    states.some(
      (state) => state.cycles < requiredCycles || Date.now() - state.startedAt < requiredDuration,
    )
  ) {
    for (const state of states) {
      if (state.failures >= 3) continue;
      await runGuarded(state, () => pressureCycle(state));
    }
    if (states.every((state) => state.failures >= 3)) break;
  }
  await runtime.restart();
  for (const state of states)
    await runGuarded(state, () => probe(state, `${state.model}:${state.kind}:restart-recall`));
  await runRepetitions();
  for (const state of states)
    record({
      id: `${state.model}:${state.kind}:completed`,
      model: state.model,
      kind: state.kind,
      cycles: state.cycles,
      elapsedMs: Date.now() - state.startedAt,
      failures: state.failures,
    });
}
async function runRepetitions() {
  for (let repetition = 0; repetition < repetitions; repetition++)
    for (const model of runtime.models) {
      const state = await newChat(model, "plain", repetition);
      await runGuarded(state, async () => {
        await establish(state);
        await pressureCycle(state);
      });
    }
}
try {
  runtime = await startContinuityRuntime(join(output, "runtime"), values.config, physical);
  metadata.models = runtime.models;
  record({ id: "runtime-ready", models: runtime.models });
  await runCampaigns();
  save("completed");
} catch (error) {
  record({ id: "campaign-failed", errorClass: error.name, code: error.code ?? "operation-failed" });
  save("failed");
  process.exitCode = 1;
} finally {
  await runtime?.close();
}
