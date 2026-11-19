// Where a needed memory was lost, per answer probe (#4205). When a memory an answer needs never
// reaches the model, `neededNotSupplied` only says so. The trace asks the product's own retrieval
// route (`POST /api/memory/context`) AFTER the answer was received, so it cannot influence it, and
// names the stage: not stored, not a candidate, not admitted, ranked out, cut by the budget, moved
// down by the reorder, or ranked too low. Ids, positions, scores and closed values only: no memory
// text, no question, no excerpt.
//
// An honest limit, repeated in docs/qa/memoria-viva-lab.md: the route ranks with the same signals,
// fusion and reorder as the chat path, but without the chat path's strict relevance floor and
// standing profile, and with the route's own limit on included memories. It is a diagnostic
// approximation of the chat path, not the chat path.
import { listMemories } from "./instance.mjs";
import { neededStage } from "./recall-stage.mjs";
import { carrierIds, wantedOf } from "./score.mjs";

export const TRACE_SOURCE = "memory-context-route";
/** Large enough that the token budget cuts nothing: the route accepts any non-negative integer. */
export const TRACE_BUDGET_TOKENS = 1_000_000;

/** The closed reasons the route reports for an omitted memory (`OmittedReason`). */
export const OMITTED_REASONS = Object.freeze([
  "suppressed-by-status",
  "below-threshold",
  "budget-exceeded",
  "max-included-exceeded",
  "out-of-scope",
  "type-filtered",
]);

/** The closed ways the route call itself can fail. */
export const TRACE_FAILURES = Object.freeze([
  "http-error",
  "malformed-response",
  "request-failed",
  "store-unreadable",
]);

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

/**
 * One entry per fact the probe needs. `wanted` comes from `wantedOf`, `carriers` maps its label to
 * the ids of the stored memories that carry it, `notSupplied` is the probe's `neededNotSupplied`.
 * `response` is the route's answer, or undefined when the call failed.
 */
export function neededEntries({
  wanted,
  carriers,
  notSupplied,
  suppliedIds,
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
  return wanted.map((item) => {
    const ids = carriers.get(item.label) ?? [];
    const id = chosenCarrier(ids, { suppliedIds, positionOf, live });
    const suppliedByChat = !notSupplied.includes(item.label);
    const position = id === null ? null : (positionOf.get(id) ?? null);
    const scoreRank = position === null ? null : (included?.rank.get(id) ?? null);
    const omittedReason = id === null ? null : (omittedBy.get(id) ?? null);
    const entry = { key: item.label, id, suppliedByChat, position, scoreRank, omittedReason };
    return {
      ...entry,
      carrierCount: ids.length,
      stage: neededStage({ storeKnown, traceAvailable: response !== undefined, ...entry }),
    };
  });
}

/** The body-free trace from the route's answer, or from a closed failure when there is none. */
export function buildRecallTrace({ response, failure, ...rest }) {
  const base = { source: TRACE_SOURCE, strictFloor: false };
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

/**
 * Records the trace of one answered probe on the same chat and question. Never throws: a route or
 * store failure becomes a closed failure value on the trace, and the probe result stands.
 * `row` is the scored probe row (`neededNotSupplied`, `suppliedIds`).
 */
export async function traceRecall({ instance, scenario, probe, row, chatId, queryText, links }) {
  const wanted = wantedOf(scenario, probe);
  const stored = await storedMemories(instance);
  const memories = stored.memories ?? [];
  const carriers = new Map(wanted.map((item) => [item.label, carrierIds(memories, item, links)]));
  const asked = stored.failure === undefined ? await askRoute(instance, chatId, queryText) : stored;
  return buildRecallTrace({
    ...asked,
    wanted,
    carriers,
    memories,
    storeKnown: stored.failure === undefined,
    notSupplied: row.neededNotSupplied ?? [],
    suppliedIds: new Set(row.suppliedIds),
  });
}
