// Drives one scenario through one isolated instance for one arm (#4207). The three arms share every
// step a person would take and differ only in what the product is allowed to know: `off` never
// enables memory (the floor), `product` learns from the turns (the measurement), `oracle` receives
// the truth facts as a curated store and only answers (the ceiling of retrieval and answering).
import { randomUUID } from "node:crypto";
import { awaitLearning, captureTotal, listMemories, readCaptures } from "./instance.mjs";
import { retainBodiesFor } from "./isolation.mjs";
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
    const before = await captureTotal(instance);
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
      suppliedCount: sent.supplied.length,
      learnerUnused: context.fixture === undefined ? 0 : context.fixture.pendingLearner(),
    });
    context.fixture?.clearLearner();
  }
  return rows;
}

function sameBody(memory, fact) {
  return (memory?.body ?? "").trim() === fact.seed.trim();
}

// The memory a single-memory route returned; a response without one is a broken contract.
function memoryOf(json, what) {
  if (json?.memory === undefined || json.memory === null)
    throw new Error(`${what} returned no memory`);
  return json.memory;
}

async function acceptIfProposed(instance, memoryId, status) {
  if (status !== "proposed") return;
  expectOk(
    await instance.request("POST", `/api/memory/proposals/${memoryId}/accept`, {}),
    "oracle acceptance",
  );
}

// The memories a capture response says it stored, by the id the route returns for each. The route
// persists every candidate and puts the stored memory's id where the proposal's id was; a rejected
// or unrelated outcome carries none. The newest-first listing is never searched for the seed: it
// cannot say which of its rows this seeding produced.
function storedCandidates(captured) {
  const outcomes = Array.isArray(captured.outcomes) ? captured.outcomes : [];
  return outcomes
    .filter(
      (outcome) =>
        outcome?.kind === "candidate" && typeof outcome.proposal?.proposalId === "string",
    )
    .map((outcome) => ({ id: outcome.proposal.proposalId, status: outcome.status }));
}

function describeOutcomes(captured) {
  const outcomes = Array.isArray(captured.outcomes) ? captured.outcomes : [];
  return outcomes.map((outcome) => `${outcome?.kind ?? "unknown"}:${outcome?.reason ?? "-"}`);
}

// Stores one truth fact through the explicit route, accepts it when it was parked, makes its body
// exact, and returns what was stored and in which scope. A seeding the route did not turn into
// exactly one memory is reported as not seeded and touches nothing: the lab never guesses which
// stored memory it meant.
async function seedFact(instance, chatId, fact) {
  const captured = expectOk(
    await instance.request("POST", "/api/memory/capture-from-conversation", {
      text: `${SEED_PREFIX}${fact.seed}`,
      context: { projectPath: instance.project, chatId },
    }),
    "oracle seeding",
  );
  const outcomes = describeOutcomes(captured);
  const stored = storedCandidates(captured);
  if (stored.length !== 1) return { key: fact.key, seeded: false, outcomes };
  const [{ id, status }] = stored;
  await acceptIfProposed(instance, id, status);
  const current = memoryOf(
    expectOk(await instance.request("GET", `/api/memory/${id}`), "oracle read"),
    "oracle read",
  );
  const exact = sameBody(current, fact)
    ? current
    : memoryOf(
        expectOk(
          await instance.request("PATCH", `/api/memory/${id}`, { body: fact.seed }),
          "oracle body edit",
        ),
        "oracle body edit",
      );
  return {
    key: fact.key,
    seeded: true,
    outcomes,
    memoryId: id,
    scope: exact?.scope?.kind ?? "unknown",
  };
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

// The oracle arm asserts its own precondition: every truth fact was stored by its own seeding and
// reads back accepted and exact exactly once, and nothing else is accepted. The scope each seed
// landed in is reported (`scopes`, a count per scope kind): the explicit route stores in project
// scope today, which the report states instead of leaving to be rediscovered.
async function seedOracle(scenario, instance) {
  const chatId = await createChat(instance, `oracle ${scenario.id}`);
  const seeded = [];
  for (const fact of scenario.truth) seeded.push(await seedFact(instance, chatId, fact));
  const accepted = (await listMemories(instance)).filter((memory) => memory.status === "accepted");
  const seedIds = new Set(seeded.map((seed) => seed.memoryId).filter((id) => id !== undefined));
  const mismatches = scenario.truth
    .filter((fact) => accepted.filter((memory) => sameBody(memory, fact)).length !== 1)
    .map((fact) => fact.key);
  const extras = accepted.filter((memory) => !seedIds.has(memory.id)).length;
  return {
    seeded,
    mismatches,
    extras,
    scopes: countBy(seeded.filter((seed) => seed.seeded).map((seed) => seed.scope)),
    preconditionMet: mismatches.length === 0 && extras === 0 && seeded.every((seed) => seed.seeded),
  };
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

// The scripted model's request journal, without the memory bodies unless bodies may be retained.
function journalOf(context) {
  if (context.fixture === undefined) return [];
  return context.fixture
    .requests()
    .map(({ memoryBodies, ...entry }) =>
      context.retainBodies && memoryBodies !== undefined ? { ...entry, memoryBodies } : entry,
    );
}

/**
 * Runs one scenario for one arm on a fresh instance and returns the scored evidence. `requested`
 * carries arm, memoryMode, budgetTokens, confirmForget, retainBodies, turnTimeoutMs, learning
 * (quietMs, maxMs, pendingLearner) and, offline, the scripted model fixture. Bodies are retained
 * only when the scenario is not anchor text, whatever the run asked for (the labelling pass,
 * `labelPass`, excepted): real conversations leave counts and verdicts, never text.
 */
export async function runScenario(scenario, instance, requested) {
  const context = {
    ...requested,
    retainBodies: retainBodiesFor(scenario, requested.retainBodies, requested.labelPass),
  };
  if (!ARMS.includes(context.arm)) throw new RangeError(`unknown arm ${context.arm}`);
  await ensureProject(instance);
  context.fixture?.setPhase("run");
  const startedAt = Date.now();
  const turns = context.arm === "oracle" ? [] : await runTurns(scenario, instance, context);
  const oracle = context.arm === "oracle" ? await seedOracle(scenario, instance) : undefined;
  const learnedAt = Date.now();
  const memories = await listMemories(instance);
  const probes = await runProbes(scenario, instance, context);
  // Probes run with memory on, so the product may still be learning from the last question; settle
  // before the store and the ledger are read, otherwise probeCaptures would depend on timing.
  if (context.arm !== "off")
    await awaitLearning(instance, { ...context.learning, phase: "after the probes" });
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
    requests: journalOf(context),
  };
}
