// Duration-balanced Vitest shards (quality-gate hardening plan 2026-11-21, P5).
//
// Vitest's own `--shard` sorts the test files by a hash of their path and gives every shard the
// same NUMBER of files, so a shard that draws the slow integration suites runs for 38 minutes while
// its neighbour finishes in 24, and the slowest shard is the verdict. This sequencer gives every
// shard the same measured TIME instead: the longest files are placed first, each on the shard with
// the least time so far (longest-processing-time scheduling). The times come from
// `vitest-file-durations.json`, measured on hosted runners from the coverage blobs of a green run
// (`node scripts/generate-vitest-durations.mjs`).
//
// Stale or missing times can only make the balance worse, never change what runs: every shard
// derives the same assignment from the same file list, so each file runs on exactly one shard. A
// file without a measured time counts as the median measured file.

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { URL } from "node:url";
import { BaseSequencer } from "vitest/node";

const DURATIONS_URL = new URL("./vitest-file-durations.json", import.meta.url);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The measured seconds per repository-relative test file, or none when there is no document. A
 * document that is not valid JSON, or whose `files` is not an object, fails the run: a corrupted
 * balance must be repaired, not silently replaced by path-hash shards.
 */
export function readFileDurations(url = DURATIONS_URL) {
  let text;
  try {
    text = readFileSync(url, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  const parsed = JSON.parse(text);
  if (!isPlainObject(parsed) || !isPlainObject(parsed.files)) {
    throw new TypeError("vitest-file-durations.json needs an object of files to seconds");
  }
  return parsed.files;
}

function median(values) {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * A fixed cost every file carries on top of its measured time. The first balanced CI run
 * (44945708966) put 1135 short files on one shard and 836 on each other; that shard measured 3442
 * worker seconds against 2681–3125 on the others, because a file measured as short tends to take
 * longer next time. Re-assigning that run's files with this floor brings its slowest shard from
 * 3442 to 3164 seconds on the run's own times; any floor from 0.5 to 5 s lands within runner noise.
 */
export const PER_FILE_SECONDS = 1;

function assertShard(index, count) {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index)) {
    throw new TypeError(`shard must be i/n with integers, got ${String(index)}/${String(count)}`);
  }
  if (index < 1 || index > count) {
    throw new RangeError(`shard index ${String(index)} is outside 1..${String(count)}`);
  }
}

/**
 * The keys of shard `index` of `count` when `keys` are spread by `durations` plus the per-file
 * floor. Deterministic for a given key set whatever its order: keys are ordered by cost, highest
 * first, ties by key.
 */
export function assignShard(keys, durations, index, count, perFileSeconds = PER_FILE_SECONDS) {
  assertShard(index, count);
  const known = keys.map((key) => durations[key]).filter((value) => Number.isFinite(value));
  const fallback = median(known);
  const timed = [...new Set(keys)]
    .map((key) => ({
      key,
      seconds: (Number.isFinite(durations[key]) ? durations[key] : fallback) + perFileSeconds,
    }))
    .sort((a, b) => b.seconds - a.seconds || (a.key < b.key ? -1 : Number(a.key > b.key)));
  const load = Array.from({ length: count }, () => 0);
  const selected = [];
  for (const { key, seconds } of timed) {
    let target = 0;
    for (let shard = 1; shard < count; shard += 1) if (load[shard] < load[target]) target = shard;
    load[target] += seconds;
    if (target === index - 1) selected.push(key);
  }
  return selected;
}

function specKey(root, spec) {
  return relative(root, spec.moduleId).replaceAll("\\", "/");
}

export default class DurationSequencer extends BaseSequencer {
  /** The measured times; a seam for tests, which cannot hand Vitest's constructor any. */
  fileDurations() {
    return readFileDurations();
  }

  // Vitest awaits the result, so a plain promise keeps the base class's asynchronous contract.
  shard(files) {
    const { root, shard } = this.ctx.config;
    const durations = this.fileDurations();
    // The project name keeps two projects' copies of a path apart; specs that still share a key
    // (one file collected twice in one project) move together, so none of them is dropped.
    const byKey = new Map();
    for (const spec of files) {
      const key = `${spec.project.name}:${specKey(root, spec)}`;
      byKey.set(key, [...(byKey.get(key) ?? []), spec]);
    }
    const lookup = {};
    for (const [key, [spec]] of byKey) lookup[key] = durations[specKey(root, spec)];
    const keys = assignShard([...byKey.keys()], lookup, shard.index, shard.count);
    return Promise.resolve(keys.flatMap((key) => byKey.get(key)));
  }
}
