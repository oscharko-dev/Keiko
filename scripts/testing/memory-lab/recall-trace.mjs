// Where a needed memory was lost, per answer probe (#4205). When a memory an answer needs never
// reaches the model, `neededNotSupplied` only says so. The trace asks the product's own retrieval
// route (`POST /api/memory/context`) AFTER the answer was received, so it cannot influence it, and
// names the stage (recall-stage.mjs): not stored, not a candidate, not admitted, refused by the chat,
// beyond the chat's limit, or moved down by the reorder. Ids, positions, scores and closed values
// only: no memory text, no question, no excerpt. The route's own token budget is made so large that it
// cuts nothing: a budget cut would only blur the order the stages are read from.
//
// An honest limit, repeated in docs/qa/memoria-viva-lab.md: the route ranks with the same signals,
// fusion and reorder as the chat path, but without the chat path's strict relevance floor and
// standing profile, and with its own limit (12) on included memories where the chat keeps fewer. It
// is a diagnostic approximation of the chat path, not the chat path.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listMemories } from "./instance.mjs";
import { neededVerdict } from "./recall-stage.mjs";
import { carrierIds, suppliedCarries, wantedOf } from "./score.mjs";

const TRACE_SOURCE = "memory-context-route";
/** Large enough that the token budget cuts nothing: the route accepts any non-negative integer. */
export const TRACE_BUDGET_TOKENS = 1_000_000;

/** The closed reasons the route reports for an omitted memory (`OmittedReason`). */
const OMITTED_REASONS = Object.freeze([
  "suppressed-by-status",
  "below-threshold",
  "budget-exceeded",
  "max-included-exceeded",
  "out-of-scope",
  "type-filtered",
]);

// The route call itself can fail in four closed ways, each set where it is detected below:
// "http-error", "malformed-response", "request-failed" and "store-unreadable".

const UNKNOWN_REASON = "unknown";

const finite = (value) => (Number.isFinite(value) ? value : null);

function numericSubscores(subscores) {
  const entries = Object.entries(subscores ?? {}).filter(([, value]) => Number.isFinite(value));
  return Object.fromEntries(entries.toSorted(([left], [right]) => (left < right ? -1 : 1)));
}

// The route's included entries in their final order, with the place when sorted by score. Ties keep
// their final order (a stable sort), so equal scores never read as a reorder.
function includedView(included) {
  const rows = included.map((entry, index) => ({
    id: String(entry.memoryId),
    position: index + 1,
    score: finite(entry.score),
    subscores: numericSubscores(entry.subscores),
  }));
  const byScore = rows.toSorted(
    (left, right) => (right.score ?? -Infinity) - (left.score ?? -Infinity),
  );
  const rank = new Map(byScore.map((row, index) => [row.id, index + 1]));
  return { rows, rank };
}

function omittedCounts(omitted) {
  const counts = {};
  for (const entry of omitted) {
    const reason = OMITTED_REASONS.includes(entry.reason) ? entry.reason : UNKNOWN_REASON;
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).toSorted(([a], [b]) => (a < b ? -1 : 1)));
}

// Which of several memories that carry a fact to report: the one the chat supplied, then the one
// the route placed first, then a live one, then any. Deterministic, by id order within each tier.
function chosenCarrier(ids, { suppliedIds, positionOf, live }) {
  const ordered = ids.toSorted();
  const tiers = [
    (id) => suppliedIds.has(id),
    (id) => positionOf.has(id),
    (id) => live.has(id),
    () => true,
  ];
  for (const tier of tiers) {
    const hits = ordered.filter(tier);
    if (hits.length > 0)
      return hits.toSorted(
        (a, b) => (positionOf.get(a) ?? Infinity) - (positionOf.get(b) ?? Infinity),
      )[0];
  }
  return null;
}

// What the chat supplied as retrieved memories (never the standing profile), each with the place the
// route gave it: its listed position, `Infinity` when the route omitted it by its limit, null when the
// route did not rank it at all.
function suppliedRetrieved(retrievedIds, { positionOf, omittedBy }) {
  const positions = retrievedIds.map((id) => {
    if (positionOf.has(id)) return positionOf.get(id);
    return omittedBy.get(id) === "max-included-exceeded" ? Number.POSITIVE_INFINITY : null;
  });
  return { count: retrievedIds.length, positions };
}

/**
 * One entry per wanted fact. `wanted` carries labels, `carriers` maps a label to the ids of the stored
 * memories that carry it, `suppliedLabels` holds the labels the chat supplied, `retrievedIds` the
 * retrieved memories the chat supplied, `limit` the chat's limit on them (null when unreadable).
 * `response` is the route's answer, or undefined when the call failed.
 */
function neededEntries({
  wanted,
  carriers,
  suppliedLabels,
  suppliedIds,
  retrievedIds,
  limit,
  response,
  memories,
  storeKnown = true,
}) {
  const included = response === undefined ? undefined : includedView(response.included);
  const positionOf = new Map((included?.rows ?? []).map((row) => [row.id, row.position]));
  const omittedBy = new Map(
    (response?.omitted ?? []).map((entry) => [
      String(entry.memoryId),
      OMITTED_REASONS.includes(entry.reason) ? entry.reason : UNKNOWN_REASON,
    ]),
  );
  const live = new Set(
    memories.filter((memory) => memory.status === "accepted").map((memory) => memory.id),
  );
  const supplied = suppliedRetrieved(retrievedIds, { positionOf, omittedBy });
  return wanted.map((item) => {
    const ids = carriers.get(item.label) ?? [];
    const id = chosenCarrier(ids, { suppliedIds, positionOf, live });
    const suppliedByChat = suppliedLabels.has(item.label);
    const position = id === null ? null : (positionOf.get(id) ?? null);
    const scoreRank = position === null ? null : (included?.rank.get(id) ?? null);
    const omittedReason = id === null ? null : (omittedBy.get(id) ?? null);
    const entry = { key: item.label, id, suppliedByChat, position, scoreRank, omittedReason };
    const { stage, reason } = neededVerdict({
      storeKnown,
      traceAvailable: response !== undefined,
      limit,
      supplied,
      ...entry,
    });
    return {
      ...entry,
      carrierCount: ids.length,
      stage,
      ...(reason === undefined ? {} : { unavailableReason: reason }),
    };
  });
}

/**
 * The body-free trace from the route's answer, or from a closed failure when there is none. It names
 * the chat's limit it compared with (`chatLimit`, null with `limitFailure` when it could not be read)
 * and how many retrieved memories the chat supplied.
 */
export function buildRecallTrace({ response, failure, limitFailure, ...rest }) {
  const base = {
    source: TRACE_SOURCE,
    strictFloor: false,
    chatLimit: rest.limit,
    chatRetrievedCount: rest.retrievedIds.length,
    ...(limitFailure === undefined ? {} : { limitFailure }),
  };
  if (response === undefined)
    return {
      ...base,
      failure: failure.kind,
      ...(failure.status === undefined ? {} : { status: failure.status }),
      needed: neededEntries({ ...rest, response: undefined }),
    };
  const { rows } = includedView(response.included);
  return {
    ...base,
    includedCount: rows.length,
    included: rows,
    omittedByReason: omittedCounts(response.omitted),
    needed: neededEntries({ ...rest, response }),
  };
}

function wellFormed(json) {
  return (
    Array.isArray(json?.included) &&
    Array.isArray(json?.omitted) &&
    json.included.every((entry) => typeof entry?.memoryId === "string") &&
    json.omitted.every((entry) => typeof entry?.memoryId === "string")
  );
}

async function askRoute(instance, chatId, queryText) {
  try {
    const result = await instance.request("POST", "/api/memory/context", {
      projectPath: instance.project,
      chatId,
      queryText,
      budgetTokens: TRACE_BUDGET_TOKENS,
    });
    if (result.status < 200 || result.status >= 300)
      return { failure: { kind: "http-error", status: result.status } };
    if (!wellFormed(result.json)) return { failure: { kind: "malformed-response" } };
    return { response: result.json };
  } catch {
    return { failure: { kind: "request-failed" } };
  }
}

async function storedMemories(instance) {
  try {
    return { memories: await listMemories(instance) };
  } catch {
    return { failure: { kind: "store-unreadable" } };
  }
}

/** The closed reason the chat's limit could not be read. */
export const LIMIT_UNREADABLE = "chat-limit-unreadable";

/**
 * The chat's limit on retrieved memories, read from the SUBJECT's built server (the exported
 * `CHAT_MAX_RETRIEVED_MEMORIES` of `packages/keiko-server/dist/chat-handlers.js`), never assumed.
 * `{limit}` or `{failure: "chat-limit-unreadable"}`.
 */
export function readChatRetrievalLimit(subjectRoot) {
  try {
    const source = readFileSync(
      join(subjectRoot, "packages", "keiko-server", "dist", "chat-handlers.js"),
      "utf8",
    );
    return limitFromSource(source);
  } catch {
    return { failure: LIMIT_UNREADABLE };
  }
}

// Exactly one declaration at a line start (a commented-out line is no declaration) whose value is a
// plain positive integer literal; anything else, including a constant that has gone, fails closed.
// The number itself is never assumed: it is read, so it may change.
export function limitFromSource(source) {
  const declarations = [...source.matchAll(/^export const CHAT_MAX_RETRIEVED_MEMORIES\b.*$/gmu)];
  if (declarations.length !== 1) return { failure: LIMIT_UNREADABLE };
  const literal = /^export const CHAT_MAX_RETRIEVED_MEMORIES\s*=\s*(\d+)\s*;\s*(?:\/\/.*)?$/u.exec(
    declarations[0][0],
  );
  const limit = literal === null ? Number.NaN : Number(literal[1]);
  return Number.isSafeInteger(limit) && limit > 0 ? { limit } : { failure: LIMIT_UNREADABLE };
}

// The limit read from the build, unless the chat supplied more retrieved memories than it: then the
// build contradicts the observation and the limit is unreadable.
function limitFor(chatLimit, retrievedCount) {
  if (chatLimit.limit !== undefined && retrievedCount > chatLimit.limit)
    return { failure: LIMIT_UNREADABLE };
  return chatLimit;
}

// Every term group of the truth is contained in a group of the probe's terms: the probe accepts at
// least the truth's own words (and may accept more, such as an inflected form).
function termsCovered(truthTerms, probeTerms) {
  return truthTerms.every((group) =>
    probeTerms.some((accepted) => group.every((term) => accepted.includes(term))),
  );
}

/**
 * The facts a probe's trace follows: the ones it needs (`wantedOf`) and, for a probe that expects
 * answer terms, the truth whose terms the probe's terms cover (each of its groups is contained in one of them). The second kind exists for the trace
 * only; the score never sees it.
 */
export function traceWanted(scenario, probe) {
  const wanted = wantedOf(scenario, probe);
  const terms = probe.expect.terms;
  if (terms === undefined) return wanted;
  const own = scenario.truth
    .filter((fact) => termsCovered(fact.terms, terms))
    .filter((fact) => !wanted.some((item) => item.label === fact.key))
    .map((fact) => ({ label: fact.key, link: { truth: fact.key }, terms: fact.terms }));
  return [...wanted, ...own];
}

/**
 * Records the trace of one answered probe on the same chat and question. Never throws: a route or
 * store failure becomes a closed failure value on the trace, and the probe result stands. `supplied`
 * is everything that reached the model, `retrievedIds` the retrieved part of it, `chatLimit` the
 * result of `readChatRetrievalLimit`. The time the trace took is its `durationMs`.
 */
export async function traceRecall({
  instance,
  scenario,
  probe,
  supplied,
  retrievedIds,
  chatLimit,
  chatId,
  queryText,
  links,
}) {
  const startedAt = Date.now();
  const readLimit = limitFor(chatLimit, retrievedIds.length);
  const wanted = traceWanted(scenario, probe);
  const stored = await storedMemories(instance);
  const memories = stored.memories ?? [];
  const carriers = new Map(wanted.map((item) => [item.label, carrierIds(memories, item, links)]));
  const asked = stored.failure === undefined ? await askRoute(instance, chatId, queryText) : stored;
  const trace = buildRecallTrace({
    ...asked,
    wanted,
    carriers,
    memories,
    storeKnown: stored.failure === undefined,
    limit: readLimit.limit ?? null,
    ...(readLimit.failure === undefined ? {} : { limitFailure: readLimit.failure }),
    suppliedLabels: new Set(
      wanted.filter((item) => suppliedCarries(supplied, item, links)).map((item) => item.label),
    ),
    suppliedIds: new Set(supplied.map((entry) => entry.memoryId)),
    retrievedIds,
  });
  return { ...trace, durationMs: Date.now() - startedAt };
}

/**
 * What a run recorded, for its manifest: `on` when every answer probe of an arm with memory carries a
 * trace, `off` when none does, `partial` otherwise. Counted from the results, never from the request.
 */
export function recallTraceCoverage(results) {
  const eligible = results
    .filter((result) => result.arm !== "off")
    .flatMap((result) => result.probes ?? [])
    .filter((probe) => probe.kind === "answer");
  const traced = eligible.filter((probe) => probe.recallTrace !== undefined).length;
  if (traced === 0) return "off";
  return traced === eligible.length ? "on" : "partial";
}
