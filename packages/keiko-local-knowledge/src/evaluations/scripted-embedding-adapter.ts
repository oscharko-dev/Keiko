// Scripted (offline, deterministic) embedding adapter for the retrieval eval harness
// (Epic #189, Issue #268). Implements `OpenAIEmbeddingAdapter` so the harness can plug
// directly into #199's retrieval runner — same code path as production, only the model
// call is replaced.
//
// Determinism guarantees (load-bearing for byte-identical scorecards):
//   - No `Date.now()`, `Math.random()`, `performance.now()`, or `Date()` reads.
//   - No global mutable state. The adapter holds only the immutable identity + the
//     constructor's `topicSalts` map; nothing mutates after construction.
//   - No `fetch` import, no network IO of any kind. The `request` method always resolves
//     synchronously through `Promise.resolve`.
//
// Vector layout: a `vectorDimensions`-wide `Float32Array` filled by an FNV-1a hash of the
// input string (32-bit, see RFC reference text). Lane 0 carries a normalised input length
// signal so two strings of clearly different length never collide on the leading lane —
// this matters because the hash collision space on short strings is small, and we want
// the cosine of two distinct inputs to stay strictly < 1.
//
// Topic salt: every chunk in a fixture may declare an optional `topic`. The scripted
// adapter accepts a map `{ [topic]: boost }` — for any request whose text contains a known
// topic marker (a `[[topic]]` envelope in the input string), the corresponding boost is
// blended into the produced vector. This lets a fixture make the ground-truth chunk for a
// query verifiably the top result without depending on real semantic similarity. The
// marker is parsed; the marker itself is stripped from the FNV input so two queries with
// the same body but different topics still hash to similar (not identical) vectors.

import type { EmbeddingModelIdentity } from "@oscharko-dev/keiko-contracts";
import type {
  OpenAIEmbeddingAdapter,
  OpenAIEmbeddingOutcome,
  OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";

// ─── FNV-1a 32-bit ───────────────────────────────────────────────────────────
// We use FNV-1a over UTF-16 code units (`charCodeAt`) so the hash is locale-independent
// and identical across every JS engine the package targets. The literals come from
// http://www.isthe.com/chongo/tech/comp/fnv/ — `OFFSET_BASIS = 2166136261` (0x811c9dc5),
// `PRIME = 16777619` (0x01000193). Multiplication uses `Math.imul` so it stays exact in
// 32-bit even on values that would otherwise round above 2^53.
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  // Coerce to unsigned 32-bit so callers see a consistent positive integer.
  return hash >>> 0;
}

// ─── Topic markers ───────────────────────────────────────────────────────────
// A fixture embeds a topic marker inside the text it asks the adapter to embed. The format
// `[[topic:NAME]]` is chosen so it is impossible to occur in natural text the harness
// might emit by accident — the runner injects it explicitly when seeding chunks. The
// adapter strips the marker before hashing so the FNV component remains stable as topics
// are added or renamed.
const TOPIC_MARKER_PATTERN = /\[\[topic:([a-zA-Z0-9_-]+)\]\]/g;
const VALID_TOPIC_PATTERN = /^[a-zA-Z0-9_-]+$/;

interface ExtractedTopics {
  readonly topics: readonly string[];
  readonly stripped: string;
}

function extractTopics(input: string): ExtractedTopics {
  const topics: string[] = [];
  // Reset state on the shared regex by constructing a fresh local copy — the `/g` flag
  // makes the constant stateful and we never want the next call to inherit `lastIndex`.
  const re = new RegExp(TOPIC_MARKER_PATTERN.source, "g");
  let match: RegExpExecArray | null = re.exec(input);
  while (match !== null) {
    const captured = match[1];
    if (captured !== undefined) topics.push(captured);
    match = re.exec(input);
  }
  const stripped = input.replace(re, "");
  return { topics, stripped };
}

// ─── Vector synthesis ────────────────────────────────────────────────────────
// Lane 0: normalised input length (clipped to `[0, 1]` so it interacts well with cosine).
// Lanes 1..dim-1: a permutation of the FNV hash mixed with the lane index. The mix uses
// `Math.imul` for 32-bit arithmetic, then squashes to `[-1, 1]` so cosine remains in its
// usual range. A topic salt adds a deterministic "topic vector" — derived from the
// topic-name hash — scaled by the configured boost.

const LENGTH_NORMALISATION_DIVISOR = 1024;

function laneFromHash(hash: number, laneIndex: number): number {
  // Mix lane index into the hash so each lane has a different but deterministic value.
  const mixed = Math.imul(hash ^ laneIndex, FNV_PRIME) >>> 0;
  // Map a 32-bit unsigned int into `[-1, 1)` by treating it as a float in `[0, 1)` then
  // shifting + scaling. `0xffffffff + 1` is exact in float64.
  return (mixed / 0x100000000) * 2 - 1;
}

function fillBaseVector(vector: Float32Array, hash: number, stripped: string): void {
  // Lane 0 is the length signal; clip to 1.0 so an extremely long input still produces a
  // value in `[0, 1]`. The divisor is generous enough that natural fixture inputs all
  // land below 1.0 and discriminate by length.
  vector[0] = Math.min(stripped.length / LENGTH_NORMALISATION_DIVISOR, 1);
  for (let i = 1; i < vector.length; i += 1) {
    vector[i] = laneFromHash(hash, i);
  }
}

function applyTopicBoost(vector: Float32Array, topic: string, boost: number): void {
  const topicHash = fnv1a32(`topic:${topic}`);
  // Skip lane 0 — it is the length signal and we never want the boost to make two inputs
  // of different length collide on the leading lane.
  for (let i = 1; i < vector.length; i += 1) {
    const topicLane = laneFromHash(topicHash, i);
    // Blend: each lane becomes `(1 - boost) * base + boost * topicLane`. With `boost = 1`
    // the vector is the pure topic vector — two inputs sharing a topic become identical
    // on every lane except lane 0, which still records length. The resulting cosine is
    // dominated by the topic lanes (1..dim-1), which is exactly the property a fixture
    // needs to make ground-truth assertions deterministic.
    const current = vector[i] ?? 0;
    vector[i] = (1 - boost) * current + boost * topicLane;
  }
}

// ─── Adapter construction ────────────────────────────────────────────────────

export interface ScriptedEmbeddingAdapterOptions {
  // Identity the adapter pretends to be — used to size the returned vector and to fill the
  // `modelId` (+ optional `modelRevision`) in the success outcome. The retrieval runner
  // expects the vector dimensions to match the capsule's pinned identity, so a fixture
  // that uses dim=16 capsules must pass an identity of dim=16 here.
  readonly identity: EmbeddingModelIdentity;
  // Per-topic boost. A boost of `1.0` makes any input carrying that topic marker emit the
  // pure topic vector (modulo lane 0). Values are clamped to `[0, 1]` so a fixture cannot
  // accidentally produce a vector outside cosine's well-conditioned range.
  readonly topicBoosts?: Readonly<Record<string, number>>;
  // Endpoint + apiKey shape — the retrieval runner reads these to populate the outgoing
  // request, but the scripted adapter never actually consults them.
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly apiKeyHeaderName?: string;
}

function clampBoost(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function resolveBoost(
  topics: readonly string[],
  boosts: Readonly<Record<string, number>>,
):
  | {
      readonly topic: string;
      readonly boost: number;
    }
  | undefined {
  // First topic wins. A fixture that wants multiple topics layered should pre-blend them
  // into a single named topic — keeping a single boost per request keeps the cosine math
  // easy to reason about for the determinism test.
  for (const topic of topics) {
    if (Object.prototype.hasOwnProperty.call(boosts, topic)) {
      const raw = boosts[topic];
      if (raw === undefined) continue;
      return { topic, boost: clampBoost(raw) };
    }
  }
  return undefined;
}

export function createScriptedEmbeddingAdapter(
  options: ScriptedEmbeddingAdapterOptions,
): OpenAIEmbeddingAdapter {
  const { identity } = options;
  const topicBoosts: Readonly<Record<string, number>> = options.topicBoosts ?? {};
  const endpoint = options.endpoint ?? "https://scripted.local/v1";
  const apiKey = options.apiKey ?? "scripted-test-key";

  const request = async (req: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> => {
    const { topics, stripped } = extractTopics(req.input);
    const hash = fnv1a32(stripped);
    const vector = new Float32Array(identity.vectorDimensions);
    fillBaseVector(vector, hash, stripped);
    const blend = resolveBoost(topics, topicBoosts);
    if (blend !== undefined) applyTopicBoost(vector, blend.topic, blend.boost);
    const successValue = {
      vector,
      modelId: identity.modelId,
      ...(identity.modelRevision !== undefined ? { modelRevision: identity.modelRevision } : {}),
    };
    return Promise.resolve({ ok: true, value: successValue });
  };

  return {
    endpoint,
    apiKey,
    ...(options.apiKeyHeaderName !== undefined
      ? { apiKeyHeaderName: options.apiKeyHeaderName }
      : {}),
    request,
  };
}

// ─── Marker helpers ──────────────────────────────────────────────────────────
// Exported so fixtures + runner can apply markers without hard-coding the format.

export function withTopicMarker(text: string, topic: string): string {
  if (!VALID_TOPIC_PATTERN.test(topic)) {
    throw new Error(`invalid eval topic marker: ${topic}`);
  }
  return `[[topic:${topic}]]${text}`;
}
