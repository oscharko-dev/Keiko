import { createHash } from "node:crypto";

/**
 * A fixed-size, per-run record of identities the invocation registry evicted after they settled
 * and expired. A Bloom filter has no false negatives: an evicted identity is always recognised, so
 * a replay of a completed call still never executes (the registry's replay invariant). A false
 * positive only refuses a brand-new identity, which fails closed. Memory is constant per run.
 */
export const CODING_TOOL_REPLAY_FILTER_BITS = 1 << 23;
const HASH_COUNT = 6;

export class CodingToolReplayFilter {
  private readonly bits = new Uint8Array(CODING_TOOL_REPLAY_FILTER_BITS >>> 3);
  private count = 0;

  public get size(): number {
    return this.count;
  }

  public add(value: string): void {
    for (const index of indexes(value)) {
      this.bits[index >>> 3] = (this.bits[index >>> 3] ?? 0) | (1 << (index & 7));
    }
    this.count += 1;
  }

  public has(value: string): boolean {
    return indexes(value).every(
      (index) => ((this.bits[index >>> 3] ?? 0) & (1 << (index & 7))) !== 0,
    );
  }
}

function indexes(value: string): readonly number[] {
  const digest = createHash("sha256").update(value).digest();
  const first = digest.readUInt32LE(0);
  const second = digest.readUInt32LE(4) | 1;
  const result: number[] = [];
  for (let round = 0; round < HASH_COUNT; round += 1) {
    result.push(((first + Math.imul(round, second)) >>> 0) % CODING_TOOL_REPLAY_FILTER_BITS);
  }
  return result;
}
