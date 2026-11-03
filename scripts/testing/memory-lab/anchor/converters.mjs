// Row-level converters of the anchor tooling (#4208): one fetched row, thread or benchmark instance
// in, one scenario v1 object out, or the named reason it was skipped. The mapping is documented in
// the header of convert.mjs. Nothing here touches the file system, and no text outside a scenario's
// turns, probes and truth ever leaves a converter.
import { createHash } from "node:crypto";
import { compareStrings } from "../../../lib/compare-strings.mjs";
import { addRedactionCounts, emptyRedactionCounts, redactText } from "./redact.mjs";
import { sourceOf } from "./sets.mjs";

/** The limits that decide which real conversations the lab can drive. */
export const CONVERSION_LIMITS = Object.freeze({
  minUserTurns: 2,
  maxUserTurns: 40,
  maxTurnChars: 4000,
  defaultMaxTurns: 200,
});

const UNRELATED_QUESTION = Object.freeze({
  de: "Was ist Apache Kafka?",
  en: "What is Apache Kafka?",
});
const LANGUAGE_NAME = Object.freeze({ de: "German", en: "English" });
// Mirrors the id rule of scenario.mjs so a bad benchmark id is a counted skip; validateScenario
// stays the authority and refuses anything this pre-check lets through.
const SCENARIO_ID = /^[a-z0-9][a-z0-9-]{2,63}$/u;

function digest12(identity) {
  return createHash("sha256").update(identity).digest("hex").slice(0, 12);
}

// Trims, drops blank turns, applies the skip rules, then redacts. A skip names its reason only.
function prepareUserTurns(rawTexts) {
  const texts = rawTexts.map((text) => text.trim()).filter((text) => text.length > 0);
  if (texts.length < CONVERSION_LIMITS.minUserTurns) return { skip: "fewUserTurns" };
  if (texts.length > CONVERSION_LIMITS.maxUserTurns) return { skip: "tooManyUserTurns" };
  if (texts.some((text) => text.length > CONVERSION_LIMITS.maxTurnChars))
    return { skip: "turnTooLong" };
  const redactions = emptyRedactionCounts();
  const turns = texts.map((text) => {
    const redacted = redactText(text);
    addRedactionCounts(redactions, redacted.counts);
    return { user: redacted.text };
  });
  return { turns, redactions };
}

// The scenario of a real conversation: no truth list, one unrelated probe that measures whether the
// product volunteers memory where none applies (over-application).
function realScenario(set, hash, turns) {
  return {
    schemaVersion: 1,
    id: `${set.family}-${set.language}-${hash}`,
    language: set.language,
    class: "anchor-real",
    difficulty: "noisy",
    description: `Real ${sourceOf(set).title} conversation (${LANGUAGE_NAME[set.language]}) with ${String(turns.length)} user turns; a redacted copy for local measurement only.`,
    truth: [],
    turns,
    probes: [
      {
        id: "unrelated",
        question: UNRELATED_QUESTION[set.language],
        expect: { kind: "no-memory" },
      },
    ],
  };
}

function realOutcome(set, identity, prepared) {
  return {
    scenario: realScenario(set, digest12(identity), prepared.turns),
    redactions: prepared.redactions,
  };
}

function isUserMessage(message) {
  return message?.role === "user" && typeof message.content === "string";
}

function conversationIdentity(row, turns) {
  const hash = row.conversation_hash;
  return typeof hash === "string" && hash.length > 0 ? hash : turns.map((t) => t.user).join("\n");
}

/** Converts one WildChat entry (`{row_idx, row, truncated_cells}`); assistant text is never kept. */
export function convertWildChat(entry, set) {
  const conversation = entry?.row?.conversation;
  if (Array.isArray(entry?.truncated_cells) && entry.truncated_cells.includes("conversation"))
    return { skip: "truncated" };
  if (!Array.isArray(conversation)) return { skip: "malformed" };
  const prepared = prepareUserTurns(
    conversation.filter((message) => isUserMessage(message)).map((message) => message.content),
  );
  if (prepared.skip !== undefined) return { skip: prepared.skip };
  return realOutcome(set, conversationIdentity(entry.row, prepared.turns), prepared);
}

function usableMessage(message) {
  return (
    typeof message?.message_id === "string" &&
    message.deleted !== true &&
    message.review_result !== false
  );
}

// The better-ranked sibling comes first (rank 0 is best, no rank is last); ties fall back to the
// creation time and then the id, so the chosen thread never depends on row order.
function compareSiblings(left, right) {
  const leftRank = typeof left.rank === "number" ? left.rank : Number.POSITIVE_INFINITY;
  const rightRank = typeof right.rank === "number" ? right.rank : Number.POSITIVE_INFINITY;
  if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
  const byDate = compareStrings(String(left.created_date ?? ""), String(right.created_date ?? ""));
  return byDate === 0 ? compareStrings(left.message_id, right.message_id) : byDate;
}

function childrenByParent(messages) {
  const children = new Map();
  for (const message of messages.toSorted((left, right) => compareSiblings(left, right))) {
    const parent = message.parent_id ?? null;
    children.set(parent, [...(children.get(parent) ?? []), message]);
  }
  return children;
}

// Follows the first child of every level from the root; the seen-set stops a malformed cycle.
function firstChildThread(messages) {
  const children = childrenByParent(messages.filter((message) => usableMessage(message)));
  const thread = [];
  const seen = new Set();
  let node = children.get(null)?.[0];
  while (node !== undefined && !seen.has(node.message_id)) {
    seen.add(node.message_id);
    thread.push(node);
    node = children.get(node.message_id)?.[0];
  }
  return thread;
}

/** Groups OASST2 entries by `message_tree_id` in first-appearance order; counts malformed rows. */
export function groupOasstMessages(entries) {
  const trees = new Map();
  let malformed = 0;
  for (const entry of entries) {
    const row = entry?.row;
    if (typeof row?.message_tree_id !== "string" || typeof row.message_id !== "string") {
      malformed += 1;
      continue;
    }
    trees.set(row.message_tree_id, [...(trees.get(row.message_tree_id) ?? []), row]);
  }
  return { trees, malformed };
}

/** Converts the messages of one OASST2 tree into the scenario of its first-child thread. */
export function convertOasstTree(treeId, messages, set) {
  const thread = firstChildThread(messages);
  if (thread.length === 0) return { skip: "noRoot" };
  const prepared = prepareUserTurns(
    thread
      .filter((message) => message.role === "prompter" && typeof message.text === "string")
      .map((message) => message.text),
  );
  if (prepared.skip !== undefined) return { skip: prepared.skip };
  return realOutcome(set, treeId, prepared);
}

// LongMemEval marks an abstention question by the "_abs" suffix of its id; a question_type of
// "abstention" is accepted as well.
function isAbstention(instance) {
  const id = instance.question_id;
  return instance.question_type === "abstention" || (typeof id === "string" && id.endsWith("_abs"));
}

function answerText(answer) {
  if (typeof answer === "number" && Number.isFinite(answer)) return String(answer);
  return typeof answer === "string" && answer.trim().length > 0 ? answer.trim() : undefined;
}

// The scenario id of a question, or undefined when its id leaves no usable slug.
function scenarioIdOf(questionId) {
  const slug = String(questionId)
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((part) => part.length > 0)
    .join("-");
  const id = `longmemeval-${slug}`;
  return slug.length > 0 && SCENARIO_ID.test(id) ? id : undefined;
}

// One entry per session: its non-blank user turns, and whether it holds the evidence of the question.
function sessionPlan(instance) {
  const ids = Array.isArray(instance.haystack_session_ids) ? instance.haystack_session_ids : [];
  const evidenceIds = new Set(
    Array.isArray(instance.answer_session_ids) ? instance.answer_session_ids : [],
  );
  return instance.haystack_sessions.map((session, index) => {
    const turns = Array.isArray(session) ? session : [];
    return {
      users: turns
        .filter((turn) => isUserMessage(turn) && turn.content.trim().length > 0)
        .map((turn) => turn.content.trim()),
      evidence: evidenceIds.has(ids[index]) || turns.some((turn) => turn?.has_answer === true),
    };
  });
}

// Evidence sessions are always kept whole; filler sessions are admitted in order while they fit.
function chooseSessions(plan, maxTurns) {
  const evidenceTurns = plan
    .filter((session) => session.evidence)
    .reduce((sum, session) => sum + session.users.length, 0);
  let budget = maxTurns - evidenceTurns;
  return plan.filter((session) => {
    if (session.evidence) return true;
    if (session.users.length === 0 || session.users.length > budget) return false;
    budget -= session.users.length;
    return true;
  });
}

// Evidence sessions are synthetic persona chats and stay verbatim, so the answer stays findable; the
// filler sessions come from public chat logs and are redacted like every other real text.
function benchmarkTurns(sessions) {
  const redactions = emptyRedactionCounts();
  const turns = sessions.flatMap((session) =>
    session.users.map((text) => {
      if (session.evidence) return { user: text };
      const redacted = redactText(text);
      addRedactionCounts(redactions, redacted.counts);
      return { user: redacted.text };
    }),
  );
  return { turns, redactions };
}

function benchmarkTruth(instance, abstention, answer) {
  if (abstention) return [];
  return [{ key: instance.question_id, seed: answer, must: true, terms: [[answer]] }];
}

function benchmarkProbe(instance, abstention, answer) {
  const expect = abstention ? { kind: "abstain" } : { kind: "answer", terms: [[answer]] };
  return { id: "question", question: instance.question, expect };
}

function benchmarkDescription(instance, abstention, plan, kept, turns) {
  const type = typeof instance.question_type === "string" ? instance.question_type : "unknown";
  return `LongMemEval ${type} question${abstention ? " (abstention)" : ""} over ${String(kept.length)} of ${String(plan.length)} sessions of a synthetic history; ${String(turns.length)} user turns.`;
}

function malformedInstance(instance) {
  return (
    typeof instance?.question_id !== "string" ||
    typeof instance.question !== "string" ||
    instance.question.trim().length === 0 ||
    !Array.isArray(instance.haystack_sessions) ||
    scenarioIdOf(instance.question_id) === undefined
  );
}

// The answer of a "single-session-preference" question is a rubric describing the preferred reply
// ("The user would prefer ..."), judged by a model in the benchmark. Deterministic term matching can
// never find it in an answer, so such a question could not pass and is skipped by name instead.
const RUBRIC_QUESTION_TYPE = "single-session-preference";

// Returns the skip reason of an instance that cannot become a scenario, or undefined.
function benchmarkSkip(instance, abstention, answer, plan) {
  if (malformedInstance(instance)) return "malformed";
  if (abstention) return undefined;
  if (instance.question_type === RUBRIC_QUESTION_TYPE) return "rubricAnswer";
  if (answer === undefined) return "noAnswer";
  return plan.some((session) => session.evidence) ? undefined : "noEvidence";
}

/** Converts one LongMemEval instance; `maxTurns` caps the user turns, evidence sessions first. */
export function convertLongMemEval(instance, maxTurns = CONVERSION_LIMITS.defaultMaxTurns) {
  const abstention = isAbstention(instance ?? {});
  const answer = answerText(instance?.answer);
  const plan = Array.isArray(instance?.haystack_sessions) ? sessionPlan(instance) : [];
  const skip = benchmarkSkip(instance, abstention, answer, plan);
  if (skip !== undefined) return { skip };
  const kept = chooseSessions(plan, maxTurns);
  const { turns, redactions } = benchmarkTurns(kept);
  if (turns.length === 0) return { skip: "noUserTurns" };
  return {
    scenario: {
      schemaVersion: 1,
      id: scenarioIdOf(instance.question_id),
      language: "en",
      class: "anchor-benchmark",
      difficulty: "split",
      description: benchmarkDescription(instance, abstention, plan, kept, turns),
      truth: benchmarkTruth(instance, abstention, answer),
      turns,
      probes: [benchmarkProbe(instance, abstention, answer)],
    },
    redactions,
  };
}
