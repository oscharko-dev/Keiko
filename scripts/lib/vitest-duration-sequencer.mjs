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

/** The measured seconds per repository-relative test file, or none when the file is unreadable. */
export function readFileDurations(url = DURATIONS_URL) {
  try {
    const parsed = JSON.parse(readFileSync(url, "utf8"));
    return parsed !== null && typeof parsed.files === "object" ? parsed.files : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function median(values) {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * The keys of shard `index` of `count` when `keys` are spread by `durations`. Deterministic for a
 * given key set whatever its order: keys are ordered by time, longest first, ties by key.
 */
export function assignShard(keys, durations, index, count) {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index)) {
    throw new TypeError(`shard must be i/n with integers, got ${String(index)}/${String(count)}`);
  }
  if (index < 1 || index > count) {
    throw new RangeError(`shard index ${String(index)} is outside 1..${String(count)}`);
  }
  const known = keys.map((key) => durations[key]).filter((value) => Number.isFinite(value));
  const fallback = median(known);
  const timed = [...new Set(keys)]
    .map((key) => ({ key, seconds: Number.isFinite(durations[key]) ? durations[key] : fallback }))
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
  return relative(root, spec.moduleId).split("\\").join("/");
}

export default class DurationSequencer extends BaseSequencer {
  // Vitest awaits the result, so a plain promise keeps the base class's asynchronous contract.
  shard(files) {
    const { root, shard } = this.ctx.config;
    const durations = readFileDurations();
    // A file belongs to one project; the project name keeps two projects' copies of a path apart.
    const byKey = new Map(
      files.map((spec) => [`${spec.project.name}:${specKey(root, spec)}`, spec]),
    );
    const lookup = {};
    for (const [key, spec] of byKey) lookup[key] = durations[specKey(root, spec)];
    const keys = assignShard([...byKey.keys()], lookup, shard.index, shard.count);
    return Promise.resolve(keys.map((key) => byKey.get(key)));
  }
}
