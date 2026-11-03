// Variety figures of a corpus (#4208). Volume alone proves little: ten thousand conversations from one
// generator repeat its style and can make weak behavior look strong. These pure functions measure how
// much a set of user turns repeats itself, how large each generator's share is, how long the turns are
// and how rich their vocabulary is, so the figures can be reported next to every corpus version.
//
// The near-duplicate rate is the share of user turns that have at least one partner elsewhere in the
// set whose 5-gram shingle sets overlap with a Jaccard similarity of 0.8 or more. The pairs are found
// exactly, by a prefix-filter set-similarity join, so a set of tens of thousands of turns is measured
// without comparing every pair.

import { compareStrings } from "../../../lib/compare-strings.mjs";

export const NEAR_DUPLICATE_THRESHOLD = 0.8;
export const SHINGLE_SIZE = 5;
const RATE_DIGITS = 10000;

function rounded(value) {
  return Math.round(value * RATE_DIGITS) / RATE_DIGITS;
}

/** Lowercased letter and digit runs of a text. */
export function tokenize(text) {
  return String(text)
    .toLocaleLowerCase("und")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/** The distinct word shingles of a text; a text shorter than one shingle is its own single shingle. */
export function shingleSet(text, size = SHINGLE_SIZE) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return new Set();
  if (tokens.length < size) return new Set([tokens.join(" ")]);
  const shingles = new Set();
  for (let start = 0; start + size <= tokens.length; start += 1)
    shingles.add(tokens.slice(start, start + size).join(" "));
  return shingles;
}

/** Jaccard similarity of two sets; two empty sets are not similar to anything. */
export function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const element of small) if (large.has(element)) shared += 1;
  return shared / (left.size + right.size - shared);
}

// Every set sorted by the same total order, rarest shingle first, so that two similar sets must share
// an element in their short prefixes.
function orderedSets(sets) {
  const frequency = new Map();
  for (const set of sets)
    for (const shingle of set) frequency.set(shingle, (frequency.get(shingle) ?? 0) + 1);
  return sets.map((set) =>
    [...set].toSorted(
      (left, right) => frequency.get(left) - frequency.get(right) || compareStrings(left, right),
    ),
  );
}

function prefixLength(size, threshold) {
  return size - Math.ceil(threshold * size) + 1;
}

function lengthsCompatible(left, right, threshold) {
  const [small, large] = left <= right ? [left, right] : [right, left];
  return small >= threshold * large;
}

function addToIndex(index, shingles, id) {
  for (const shingle of shingles) {
    const bucket = index.get(shingle);
    if (bucket === undefined) index.set(shingle, [id]);
    else bucket.push(id);
  }
}

// The earlier turns that share a prefix shingle with turn `id` and are truly similar to it.
function similarPartners(id, prefix, context) {
  const candidates = new Set(prefix.flatMap((shingle) => context.index.get(shingle) ?? []));
  return [...candidates].filter(
    (other) =>
      lengthsCompatible(context.sets[id].size, context.sets[other].size, context.threshold) &&
      jaccard(context.sets[id], context.sets[other]) >= context.threshold,
  );
}

/**
 * The share of `texts` with at least one near-duplicate partner in the same list. Returns the counts
 * behind the rate: `turns`, `duplicated` (turns with a partner), `pairs` (similar pairs) and `rate`.
 */
export function nearDuplicateRate(texts, options = {}) {
  const threshold = options.threshold ?? NEAR_DUPLICATE_THRESHOLD;
  const shingleSize = options.shingleSize ?? SHINGLE_SIZE;
  const sets = texts.map((text) => shingleSet(text, shingleSize));
  const context = { sets, threshold, index: new Map() };
  const flagged = new Set();
  let pairs = 0;
  for (const [id, shingles] of orderedSets(sets).entries()) {
    if (shingles.length === 0) continue;
    const prefix = shingles.slice(0, prefixLength(shingles.length, threshold));
    const partners = similarPartners(id, prefix, context);
    pairs += partners.length;
    if (partners.length > 0) for (const other of [id, ...partners]) flagged.add(other);
    addToIndex(context.index, prefix, id);
  }
  const rate = texts.length === 0 ? 0 : rounded(flagged.size / texts.length);
  return { turns: texts.length, duplicated: flagged.size, pairs, rate, threshold, shingleSize };
}

/** Per generator: scenarios, user turns and the share of all user turns, sorted by generator. */
export function generatorShare(entries) {
  const totals = new Map();
  for (const { generator, userTurns } of entries) {
    const known = totals.get(generator) ?? { generator, scenarios: 0, userTurns: 0 };
    totals.set(generator, {
      generator,
      scenarios: known.scenarios + 1,
      userTurns: known.userTurns + userTurns,
    });
  }
  const all = [...totals.values()].reduce((sum, entry) => sum + entry.userTurns, 0);
  return [...totals.values()]
    .toSorted((left, right) => left.generator.localeCompare(right.generator))
    .map((entry) => ({ ...entry, share: all === 0 ? 0 : rounded(entry.userTurns / all) }));
}

/** Minimum, median and maximum turn length in characters; null when there are no turns. */
export function turnLengthSpread(texts) {
  if (texts.length === 0) return { min: null, median: null, max: null };
  const lengths = texts.map((text) => [...text].length).toSorted((left, right) => left - right);
  const middle = Math.floor(lengths.length / 2);
  const median =
    lengths.length % 2 === 1 ? lengths[middle] : (lengths[middle - 1] + lengths[middle]) / 2;
  return { min: lengths[0], median, max: lengths.at(-1) };
}

/** Distinct tokens divided by all tokens over every text; null when there are no tokens. */
export function typeTokenRatio(texts) {
  const types = new Set();
  let tokens = 0;
  for (const text of texts)
    for (const token of tokenize(text)) {
      types.add(token);
      tokens += 1;
    }
  return tokens === 0 ? null : rounded(types.size / tokens);
}

/**
 * All figures of a corpus from its scenarios' user turns. `records` are
 * `{ generator, userTexts }`, one per scenario.
 */
export function varietyReport(records) {
  const texts = records.flatMap((record) => record.userTexts);
  return {
    userTurns: texts.length,
    nearDuplicate: nearDuplicateRate(texts),
    generators: generatorShare(
      records.map((record) => ({
        generator: record.generator,
        userTurns: record.userTexts.length,
      })),
    ),
    turnLength: turnLengthSpread(texts),
    typeTokenRatio: typeTokenRatio(texts),
  };
}
