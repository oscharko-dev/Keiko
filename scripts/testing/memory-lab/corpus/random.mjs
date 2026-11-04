// Seeded pseudo-random numbers of the MemoriaViva corpus generator (#4208). The generator must be
// reproducible: the same blueprint, size, seed and writer output give the same scenario, so a corpus
// version can be rebuilt and its digests compared. mulberry32 is small, fast and has a full 32-bit
// period; it is not a source of secrets and is never used as one.
import { createHash } from "node:crypto";

const UINT32_RANGE = 4294967296;

/** A 32-bit seed derived from any parts, so every blueprint and size gets its own stream. */
export function deriveSeed(...parts) {
  const digest = createHash("sha256").update(parts.map((part) => String(part)).join("\u0000"));
  return digest.digest().readUInt32BE(0);
}

function nextMulberry(state) {
  state.value = (state.value + 0x6d2b79f5) >>> 0;
  let mixed = state.value;
  mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
  mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
  return ((mixed ^ (mixed >>> 14)) >>> 0) / UINT32_RANGE;
}

/** A deterministic random source: `next()` in [0, 1), inclusive integers, picks and shuffles. */
export function createRandom(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new RangeError("seed must be an integer >= 0");
  const state = { value: seed >>> 0 };
  const next = () => nextMulberry(state);
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    chance: (probability) => next() < probability,
    pick: (list) => {
      if (list.length === 0) throw new RangeError("cannot pick from an empty list");
      return list[Math.floor(next() * list.length)];
    },
    shuffle: (list) => {
      const copy = [...list];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const other = int(0, index);
        [copy[index], copy[other]] = [copy[other], copy[index]];
      }
      return copy;
    },
  };
}
