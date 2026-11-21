// Where a needed memory was lost, per answer probe (#4205). When a memory an answer needs never
// reaches the model, `neededNotSupplied` only says so. The trace asks the product's own retrieval
// route (`POST /api/memory/context`) AFTER the answer was received, so it cannot influence it, and
// names the stage (recall-stage.mjs): not stored, not a candidate, not admitted, or admitted but not
// supplied. Ids, positions, scores and closed values only: no memory text, no question, no excerpt.
// The route's own token budget is made so large that it cuts nothing.
//
// An honest limit, repeated in docs/qa/memoria-viva-lab.md: the route is a diagnostic approximation of
// the chat path, not the chat path. It uses the lenient relevance floor and ranks over one window where
// the chat ranks its admitted memories among themselves under the strict floor, has no standing
// profile, and keeps up to 12 included memories where the chat keeps fewer. Its position of a memory is
// recorded as a fact and says nothing certain about the chat's.
import { listMemories } from "./instance.mjs";
import { neededVerdict } from "./recall-stage.mjs";
import { carrierIds, matchesTermGroups, suppliedCarries, wantedOf } from "./score.mjs";

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

/**
 * One entry per wanted fact. `wanted` carries labels, `carriers` maps a label to the ids of the stored
 * memories that carry it, `suppliedLabels` holds the labels the chat supplied. `response` is the route's answer, or undefined when the call failed.
 */
function neededEntries({
  wanted,
  carriers,
  suppliedLabels,
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
    const suppliedByChat = suppliedLabels.has(item.label);
    const position = id === null ? null : (positionOf.get(id) ?? null);
    const scoreRank = position === null ? null : (included?.rank.get(id) ?? null);
    const omittedReason = id === null ? null : (omittedBy.get(id) ?? null);
    const entry = { key: item.label, id, suppliedByChat, position, scoreRank, omittedReason };
    const { stage, reason } = neededVerdict({
      storeKnown,
      traceAvailable: response !== undefined,
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
 * The body-free trace from the route's answer, or from a closed failure when there is none. The
 * route's position and score rank of a needed memory are recorded as facts; no chat stage is derived
 * from them. `chatRetrievedCount` is how many retrieved memories the chat supplied.
 */
export function buildRecallTrace({ response, failure, ...rest }) {
  const base = {
    source: TRACE_SOURCE,
    strictFloor: false,
    chatRetrievedCount: rest.retrievedIds.length,
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

// A term probe is linked to a truth only when the truth's own terms carry the probe's complete
// requirement: every term group of the probe has an alternative that the scorer's matcher finds in one
// of the truth's own term spellings (normalisation, whole words, the `*` prefix). The body is not
// consulted, so an unrelated truth that merely contains a common word of the probe stays unlinked.
function carriesAllGroups(truth, probeTerms) {
  const spellings = truth.terms.flat();
  return probeTerms.every((group) =>
    spellings.some((spelling) => matchesTermGroups(spelling, [group])),
  );
}

/**
 * The facts a probe's trace follows: the ones it needs (`wantedOf`) and, for a probe that expects
 * answer terms, every truth whose own terms carry the probe's complete term requirement (all groups,
 * by the scorer's matcher). The second kind exists for the trace only; the score never sees it.
 */
export function traceWanted(scenario, probe) {
  const wanted = wantedOf(scenario, probe);
  const terms = probe.expect.terms;
  if (terms === undefined) return wanted;
  const own = scenario.truth
    .filter((fact) => carriesAllGroups(fact, terms))
    .filter((fact) => !wanted.some((item) => item.label === fact.key))
    .map((fact) => ({ label: fact.key, link: { truth: fact.key }, terms: fact.terms }));
  return [...wanted, ...own];
}

/**
 * Records the trace of one answered probe on the same chat and question. Never throws: a route or
 * store failure becomes a closed failure value on the trace, and the probe result stands. `supplied`
 * is everything that reached the model, `retrievedIds` the retrieved part of it. The time the trace
 * took is its `durationMs`.
 */
export async function traceRecall({
  instance,
  scenario,
  probe,
  supplied,
  retrievedIds,
  chatId,
  queryText,
  links,
}) {
  const startedAt = Date.now();
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
    suppliedLabels: new Set(
      wanted.filter((item) => suppliedCarries(supplied, item, links)).map((item) => item.label),
    ),
    suppliedIds: new Set(supplied.map((entry) => entry.memoryId)),
    retrievedIds,
  });
  return { ...trace, durationMs: Date.now() - startedAt };
}

// An answer probe of an arm with memory.
const eligibleProbes = (results) =>
  results
    .filter((result) => result.arm !== "off")
    .flatMap((result) => (result.probes ?? []).map((probe) => ({ result, probe })))
    .filter(({ probe }) => probe.kind === "answer");

// A probe whose trace has no fact to follow records nothing a stage could be counted for.
const hasFact = (probe) => (probe.recallTrace?.needed?.length ?? 0) > 0;

/**
 * What a run recorded, for its manifest: `on` when every answer probe of an arm with memory carries a
 * trace with at least one fact to follow, `off` when none carries a trace, `partial` otherwise (a probe
 * untraced, or traced with no fact). Counted from the results, never from the request.
 */
export function recallTraceCoverage(results) {
  const eligible = eligibleProbes(results);
  if (!eligible.some(({ probe }) => probe.recallTrace !== undefined)) return "off";
  return eligible.every(({ probe }) => hasFact(probe)) ? "on" : "partial";
}

/**
 * The answer probes that carry a trace with no fact to follow, as `scenario:arm:rN:probe`, for the
 * summary: such a probe has no stage class, whatever the manifest says about the trace.
 */
export function factlessProbes(results) {
  return eligibleProbes(results)
    .filter(({ probe }) => probe.recallTrace !== undefined && !hasFact(probe))
    .map(
      ({ result, probe }) =>
        `${result.scenario}:${result.arm}:r${String(result.repetition)}:${probe.id}`,
    );
}
