// What a scenario's `seed` section puts into an instance's vault before its first turn (#4207): the
// pure part. A seed is setup, not a measurement: the records are placed with backdated timestamps by
// `seed-store.mjs` so that long histories, scale limits and correction chains exist without
// replaying weeks of conversation. Nothing here reads a clock, a file or the network: the caller
// passes `nowMs`, and the same seed and the same `nowMs` always plan the same records, ids and edges.
import { createHash } from "node:crypto";

export const SEED_STATUSES = Object.freeze(["accepted", "superseded", "archived", "proposed"]);
export const SEED_SCOPES = Object.freeze(["user", "project"]);
/** The scope id the product gives the one local person (`memory-conversation-context.ts`). */
export const LOCAL_MEMORY_USER_ID = "local-operator";
export const MAX_FILLER_RECORDS = 5000;
export const MEMORY_TYPES = Object.freeze([
  "episodic",
  "semantic-fact",
  "procedural",
  "preference",
  "correction",
  "decision",
  "negative",
  "pinned",
]);
const DAY_MS = 86_400_000;
const DEFAULT_FILLER_TYPE = "semantic-fact";
// How the product writes a fact it learned from conversation (keiko-memory-capture `salience.ts`):
// source kind `system-default`, a confidence derived from what its checks saw (0.4 + 0.3 for a named
// subject + 0.15 for evidence coverage, the usual routine fact), public, the person's words as the
// evidence span, and, for a standing fact about the person, the standing retention hint.
export const SEED_ORIGINS = Object.freeze(["learned", "stated"]);
const LEARNED_CONFIDENCE = 0.85;
const LEARNED_RATIONALE = "Automatically inferred from conversation (salience capture)";
const STANDING_POLICY_KEY = "standing";
const SUPERSEDED_REASON = "A newer statement by the person replaced this fact.";
// Invented syllables: a filler record names things no scenario talks about, so a term of a real
// scenario cannot occur in it by accident (the scenario validator also checks that it does not).
const SYLLABLES = Object.freeze(
  "zor lek vim tra qua nel pho ska dri mub fen gal hux jet kiv lom nax oph pir rul sab tev ulo wex yar zin".split(
    " ",
  ),
);

// mulberry32: a small seeded generator, so the filler of a scenario never depends on a platform.
function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function pseudoWord(next) {
  const length = 2 + Math.floor(next() * 2);
  return Array.from({ length }, () => SYLLABLES[Math.floor(next() * SYLLABLES.length)]).join("");
}

/**
 * The body of the `index`th filler record of a group: deterministic in the group's seed and the
 * index alone (a larger count extends a smaller one), unique within the group, and about nothing a
 * scenario asks.
 */
export function fillerBody(seed, index) {
  const next = generator(Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca6b));
  const label = String(index + 1).padStart(4, "0");
  return `Ablage ${label}: ${pseudoWord(next)} ${pseudoWord(next)} gehoert zu ${pseudoWord(next)}.`;
}

// A uuid-shaped id from a label: the routes that take a memory id accept any non-empty id, but a
// uuid shape keeps the seeded records indistinguishable in form from the product's own.
function seedId(label) {
  const hex = createHash("sha256").update(`memory-lab-seed:${label}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function scopeOf(kind, projectId) {
  return kind === "user"
    ? { kind: "user", userId: LOCAL_MEMORY_USER_ID }
    : { kind: "project", projectId };
}

// A stated fact is what the person asked Keiko to remember ("Merke dir"): the explicit path's 1.0.
function provenanceOf(spec, atMs) {
  if (spec.origin === "stated")
    return {
      sourceKind: "explicit-user-instruction",
      capturedAt: atMs,
      confidence: 1,
      sensitivity: "public",
    };
  return {
    sourceKind: "system-default",
    capturedAt: atMs,
    confidence: LEARNED_CONFIDENCE,
    sensitivity: "public",
    captureRationale: LEARNED_RATIONALE,
    evidenceSpan: spec.body,
  };
}

function recordOf(spec, id, atMs, supersededAtMs, projectId) {
  const superseded = spec.status === "superseded";
  return {
    id,
    schemaVersion: "1",
    scope: scopeOf(spec.scope ?? "project", projectId),
    type: spec.type,
    body: spec.body,
    status: spec.status,
    pinned: spec.pinned === true,
    tags: [],
    provenance: provenanceOf(spec, atMs),
    ...(spec.standing === true ? { retentionHint: { policyKey: STANDING_POLICY_KEY } } : {}),
    validity: superseded ? { validFrom: atMs, validUntil: supersededAtMs } : { validFrom: atMs },
    ...(superseded ? { staleReason: SUPERSEDED_REASON } : {}),
    createdAt: atMs,
    updatedAt: superseded ? supersededAtMs : atMs,
  };
}

function explicitEntries(records) {
  return records.map((spec) => ({ spec, key: spec.key, id: seedId(`record:${spec.key}`) }));
}

// The moment each record was superseded: the creation of the record that supersedes it.
function supersededMoments(entries, nowMs) {
  const moments = new Map();
  for (const { spec } of entries) {
    if (spec.supersedes === undefined) continue;
    moments.set(spec.supersedes, nowMs - spec.ageDays * DAY_MS);
  }
  return moments;
}

// A superseded record with no seeded successor ends one day after it began, never after now.
function afterOneDay(atMs, nowMs) {
  return Math.min(nowMs, atMs + DAY_MS);
}

function explicitPlan(entries, nowMs, projectId) {
  const moments = supersededMoments(entries, nowMs);
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const records = entries.map(({ spec, id, key }) => {
    const atMs = nowMs - spec.ageDays * DAY_MS;
    return recordOf(spec, id, atMs, moments.get(key) ?? afterOneDay(atMs, nowMs), projectId);
  });
  const edges = entries
    .filter(({ spec }) => spec.supersedes !== undefined)
    .map(({ spec, id }) => ({
      id: seedId(`edge:${id}`),
      schemaVersion: "1",
      fromMemoryId: byKey.get(spec.supersedes).id,
      toMemoryId: id,
      kind: "supersedes",
      createdAt: nowMs - spec.ageDays * DAY_MS,
      provenanceSummary: "seeded correction",
    }));
  return { records, edges };
}

function accessOf(entries, nowMs) {
  return entries
    .filter(({ spec }) => (spec.accessCount ?? 0) > 0)
    .map(({ spec, id }) => ({
      id,
      count: spec.accessCount,
      lastAccessedAt: nowMs - (spec.lastAccessDays ?? spec.ageDays) * DAY_MS,
    }));
}

function fillerGroup(group, groupIndex, nowMs, projectId) {
  const next = generator(Math.imul(group.seed + 7, 0x27d4eb2f));
  const span = group.maxAgeDays - group.minAgeDays;
  return Array.from({ length: group.count }, (_, index) => {
    const ageMs = (group.minAgeDays + next() * span) * DAY_MS;
    const atMs = Math.floor(nowMs - ageMs);
    const spec = {
      body: fillerBody(group.seed, index),
      type: group.type ?? DEFAULT_FILLER_TYPE,
      scope: group.scope ?? "user",
      status: group.status,
      origin: group.origin,
    };
    const id = seedId(`filler:${String(groupIndex)}:${String(index)}`);
    return recordOf(spec, id, atMs, afterOneDay(atMs, nowMs), projectId);
  });
}

/** Every body the filler groups of a seed would produce, for the scenario's own collision check. */
export function fillerBodies(filler) {
  return (filler ?? []).flatMap((group) =>
    Array.from({ length: group.count }, (_, index) => fillerBody(group.seed, index)),
  );
}

/**
 * Plans a seed: the records (explicit ones first, then filler groups in order), the `supersedes`
 * edges between explicit records, the reinforcement of records that carry an access count, and the
 * `entries` the lab keeps to tell its own records from what the product learned.
 */
export function planSeed(seed, { nowMs, projectId }) {
  const entries = explicitEntries(seed.records ?? []);
  const explicit = explicitPlan(entries, nowMs, projectId);
  const filler = (seed.filler ?? []).flatMap((group, index) =>
    fillerGroup(group, index, nowMs, projectId),
  );
  return {
    records: [...explicit.records, ...filler],
    edges: explicit.edges,
    access: accessOf(entries, nowMs),
    entries: [
      ...entries.map(({ spec, id, key }) => ({
        id,
        key,
        truth: spec.truth,
        earlier: spec.earlier,
        status: spec.status,
        pinned: spec.pinned === true,
        filler: false,
      })),
      ...filler.map((record) => ({ id: record.id, status: record.status, filler: true })),
    ],
  };
}

/** How many times each value occurs, as an object. */
export function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** The body-free description of a plan the run keeps: counts per status, scope and kind. */
export function describePlan(plan) {
  return {
    total: plan.records.length,
    explicit: plan.entries.filter((entry) => !entry.filler).length,
    filler: plan.entries.filter((entry) => entry.filler).length,
    byStatus: countBy(plan.records.map((record) => record.status)),
    byScope: countBy(plan.records.map((record) => record.scope.kind)),
    supersedesEdges: plan.edges.length,
    reinforced: plan.access.length,
  };
}
