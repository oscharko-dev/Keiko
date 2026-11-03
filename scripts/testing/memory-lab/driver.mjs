// Drives one scenario through one isolated instance for one arm (#4207). The three arms share every
// step a person would take and differ only in what the product is allowed to know: `off` never
// enables memory (the floor), `product` learns from the turns (the measurement), `oracle` receives
// the truth facts as a curated store and only answers (the ceiling of retrieval and answering).
import { randomUUID } from "node:crypto";
import { awaitLearning, listMemories, readCaptures } from "./instance.mjs";
import { scoreProbe, scoreStore } from "./score.mjs";

export const ARMS = Object.freeze(["off", "product", "oracle"]);
// The explicit path recognizes "Merke dir <fact>"; a colon after "dir" is not an intent today.
const SEED_PREFIX = "Merke dir ";

function expectOk(result, what) {
  if (result.status < 200 || result.status >= 300)
    throw new Error(
      `${what} failed with HTTP ${String(result.status)}: ${JSON.stringify(result.json)}`,
    );
  return result.json;
}

async function ensureProject(instance) {
  const result = await instance.request("POST", "/api/projects", {
    path: instance.project,
    name: "memory-lab",
  });
  if (result.status !== 409) expectOk(result, "project registration");
}

async function createChat(instance, title) {
  const json = expectOk(
    await instance.request("POST", "/api/chats", {
      projectPath: instance.project,
      title,
      selectedModel: instance.answerModelId,
    }),
    "chat creation",
  );
  return json.chat.id;
}

function memoryBody(context, enabled) {
  if (!enabled) return {};
  return {
    memory: {
      enabled: true,
      budgetTokens: context.budgetTokens,
      mode: context.memoryMode,
      context: {},
    },
  };
}

async function sendTurn(instance, chatId, content, context, enabled) {
  const startedAt = Date.now();
  const json = expectOk(
    await instance.request(
      "POST",
      "/api/desktop/chat",
      {
        chatId,
        projectPath: instance.project,
        content,
        modelId: instance.answerModelId,
        clientTurnId: randomUUID(),
        expectedSkillSelectionRevision: null,
        ...memoryBody(context, enabled),
      },
      { timeoutMs: context.turnTimeoutMs },
    ),
    "chat turn",
  );
  const answer = json.messages?.findLast((message) => message.role === "assistant")?.content ?? "";
  return {
    answer,
    actions: json.memory?.actions ?? [],
    supplied: json.memory?.context?.memories ?? [],
    elapsedMs: Date.now() - startedAt,
  };
}

function idOf(entry) {
  if (typeof entry === "string") return entry;
  return entry?.memoryId ?? entry?.id;
}

function memoryIdsOf(action) {
  const listed = [action.memoryIds, action.targets, action.candidates]
    .filter((list) => Array.isArray(list))
    .flat();
  const ids = [action.memoryId, ...listed].map(idOf);
  return [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
}

// A person confirms the forget the product asked to confirm. The lab records that it had to.
async function confirmForgets(instance, actions, context) {
  const confirmed = [];
  let unresolved = 0;
  for (const action of actions) {
    if (action?.kind !== "forget") continue;
    const ids = memoryIdsOf(action);
    if (ids.length === 0) {
      unresolved += 1;
      continue;
    }
    if (!context.confirmForget) continue;
    for (const id of ids) {
      const result = await instance.request("POST", `/api/memory/${id}/forget`, {
        acknowledged: true,
      });
      confirmed.push({ id, status: result.status });
    }
  }
  return { confirmed, unresolved };
}

async function runTurns(scenario, instance, context) {
  const chatId = await createChat(instance, `lab ${scenario.id}`);
  const rows = [];
  for (const [index, turn] of scenario.turns.entries()) {
    const enabled = context.arm === "product" && turn.memory !== false;
    if (enabled && context.fixture !== undefined)
      context.fixture.queueLearner(
        context.learnerItems === undefined ? (turn.learner ?? []) : context.learnerItems(turn),
      );
    const before = (await readCaptures(instance)).length;
    const sent = await sendTurn(instance, chatId, turn.user, context, enabled);
    const settled = enabled
      ? await awaitLearning(instance, context.learning)
      : { captures: before };
    const forgets = await confirmForgets(instance, sent.actions, context);
    rows.push({
      index,
      memory: enabled,
      elapsedMs: sent.elapsedMs,
      actions: sent.actions.map((action) => action?.kind ?? "unknown"),
      forgets,
      captures: settled.captures - before,
      learnerUnused: context.fixture === undefined ? 0 : context.fixture.pendingLearner(),
    });
    context.fixture?.clearLearner();
  }
  return rows;
}

function sameBody(memory, fact) {
  return (memory.body ?? "").trim() === fact.seed.trim();
}

async function acceptIfProposed(instance, memory) {
  if (memory.status !== "proposed") return memory;
  const json = expectOk(
    await instance.request("POST", `/api/memory/proposals/${memory.id}/accept`, {}),
    "oracle acceptance",
  );
  return json.memory ?? { ...memory, status: "accepted" };
}

async function seedFact(instance, chatId, fact) {
  const captured = expectOk(
    await instance.request("POST", "/api/memory/capture-from-conversation", {
      text: `${SEED_PREFIX}${fact.seed}`,
      context: { projectPath: instance.project, chatId },
    }),
    "oracle seeding",
  );
  const outcomes = (Array.isArray(captured.outcomes) ? captured.outcomes : []).map(
    (outcome) => `${outcome?.kind ?? "unknown"}:${outcome?.reason ?? "-"}`,
  );
  const memories = await listMemories(instance);
  const candidate = memories.find((memory) => sameBody(memory, fact)) ?? memories.at(-1);
  if (candidate === undefined) return { key: fact.key, seeded: false, outcomes };
  const accepted = await acceptIfProposed(instance, candidate);
  if (!sameBody(accepted, fact))
    expectOk(
      await instance.request("PATCH", `/api/memory/${accepted.id}`, { body: fact.seed }),
      "oracle body edit",
    );
  return { key: fact.key, seeded: true, outcomes };
}

// The oracle arm asserts its own precondition: every truth fact is stored, accepted and exact.
async function seedOracle(scenario, instance) {
  const chatId = await createChat(instance, `oracle ${scenario.id}`);
  const seeded = [];
  for (const fact of scenario.truth) seeded.push(await seedFact(instance, chatId, fact));
  const memories = await listMemories(instance);
  const mismatches = scenario.truth
    .filter(
      (fact) => !memories.some((memory) => memory.status === "accepted" && sameBody(memory, fact)),
    )
    .map((fact) => fact.key);
  return { seeded, mismatches, preconditionMet: mismatches.length === 0 };
}

async function runProbes(scenario, instance, context) {
  context.fixture?.setAnswerMode("echo");
  const rows = [];
  for (const probe of scenario.probes) {
    const chatId = await createChat(instance, `probe ${scenario.id} ${probe.id}`);
    const sent = await sendTurn(instance, chatId, probe.question, context, context.arm !== "off");
    const score = scoreProbe(scenario, probe, sent.answer, sent.supplied);
    rows.push({
      ...score,
      elapsedMs: sent.elapsedMs,
      suppliedIds: sent.supplied.map((entry) => entry.memoryId),
      ...(context.retainBodies ? { answer: sent.answer } : {}),
    });
  }
  context.fixture?.setAnswerMode("ok");
  return rows;
}

function storeView(memories, retainBodies) {
  return memories.map((memory) => ({
    id: memory.id,
    status: memory.status,
    type: memory.type,
    scope: memory.scope?.kind,
    sensitivity: memory.provenance?.sensitivity,
    confidence: memory.provenance?.confidence,
    ...(retainBodies ? { body: memory.body } : {}),
  }));
}

/**
 * Runs one scenario for one arm on a fresh instance and returns the scored evidence. `context`
 * carries arm, memoryMode, budgetTokens, confirmForget, retainBodies, turnTimeoutMs, learning
 * (quietMs, maxMs, pendingLearner) and, offline, the scripted model fixture.
 */
export async function runScenario(scenario, instance, context) {
  if (!ARMS.includes(context.arm)) throw new RangeError(`unknown arm ${context.arm}`);
  await ensureProject(instance);
  context.fixture?.setPhase("run");
  const startedAt = Date.now();
  const turns = context.arm === "oracle" ? [] : await runTurns(scenario, instance, context);
  const oracle = context.arm === "oracle" ? await seedOracle(scenario, instance) : undefined;
  const learnedAt = Date.now();
  const memories = await listMemories(instance);
  const probes = await runProbes(scenario, instance, context);
  // Learning runs on probe questions too (memory is one switch for recall and learning), so a
  // question the product turns into a memory is counted here instead of passing as recall.
  const afterProbes = await listMemories(instance);
  const known = new Set(memories.map((memory) => memory.id));
  const probeCaptures = afterProbes.filter((memory) => !known.has(memory.id)).length;
  const captures = await readCaptures(instance);
  return {
    scenario: scenario.id,
    language: scenario.language,
    class: scenario.class,
    difficulty: scenario.difficulty,
    arm: context.arm,
    turns,
    ...(oracle === undefined ? {} : { oracle }),
    store: {
      ...scoreStore(memories, scenario),
      memories: storeView(memories, context.retainBodies),
    },
    captures: captures.map((capture) => ({
      outcome: capture.outcome,
      reason: capture.reason ?? null,
      status: capture.currentStatus ?? null,
    })),
    probes,
    probeCaptures,
    timing: { learnMs: learnedAt - startedAt, probeMs: Date.now() - learnedAt },
    requests: context.fixture === undefined ? [] : context.fixture.requests(),
  };
}
