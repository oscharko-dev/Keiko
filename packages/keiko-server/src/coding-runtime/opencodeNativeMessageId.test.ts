import { describe, expect, it } from "vitest";

import { createOpenCodeNativeMessageIdMinter } from "./opencodeNativeMessageId.js";

/**
 * The layout is the one the pinned 2.1.4 executable mints for its own messages (observed on the real
 * binary: `msg_16b08469d001DaT0xxHG2PAKe6`, where `16b08469d001` is the low 48 bits of
 * `milliseconds * 0x1000 + 1`), so a minted id sorts among the session's own ids. The real producer
 * accepts a minted id in `opencodeNativePromptInputs.real.test.ts`.
 */

const LAYOUT = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/u;
/** The producer's own first id of the 2026-10-24 probe run and the clock reading it was minted at. */
const PRODUCER_ID = "msg_16b08469d001DaT0xxHG2PAKe6";
const PRODUCER_CLOCK = 1_792_797_067_268 - 359;

function minter(clock: { now: number }): () => string {
  return createOpenCodeNativeMessageIdMinter({
    now: () => clock.now,
    random: (size) => new Uint8Array(size).fill(7),
  });
}

describe("the native message id minter", () => {
  it("mints the producer's layout: msg_, twelve hex digits, fourteen base-62 characters", () => {
    const mint = createOpenCodeNativeMessageIdMinter();
    for (let index = 0; index < 50; index += 1) expect(mint()).toMatch(LAYOUT);
  });

  it("encodes the clock and a counter starting at 1 exactly as the producer does", () => {
    const id = minter({ now: PRODUCER_CLOCK })();
    expect(id.slice(0, 16)).toBe(PRODUCER_ID.slice(0, 16));
    expect(id.slice(0, 16)).toBe("msg_16b08469d001");
  });

  it("counts up inside one millisecond and carries into the next when the counter is full", () => {
    const clock = { now: 1_000 };
    const mint = minter(clock);
    const ids = Array.from({ length: 4097 }, () => mint());
    expect(ids[0]?.slice(4, 16)).toBe(((1_000n << 12n) | 1n).toString(16).padStart(12, "0"));
    expect(ids[1]?.slice(4, 16)).toBe(((1_000n << 12n) | 2n).toString(16).padStart(12, "0"));
    expect(ids[4094]?.slice(4, 16)).toBe(((1_000n << 12n) | 0xfffn).toString(16).padStart(12, "0"));
    // The 4096th id of the millisecond would overflow the counter: it moves to the next millisecond.
    expect(ids[4095]?.slice(4, 16)).toBe(((1_001n << 12n) | 1n).toString(16).padStart(12, "0"));
    expect(ids[4096]?.slice(4, 16)).toBe(((1_001n << 12n) | 2n).toString(16).padStart(12, "0"));
  });

  it("strictly ascends across milliseconds, bursts and a clock that steps backward", () => {
    const clock = { now: 5_000 };
    const mint = minter(clock);
    const minted = [mint(), mint()];
    clock.now = 5_001;
    minted.push(mint());
    clock.now = 4_000;
    minted.push(mint(), mint());
    clock.now = 9_000;
    minted.push(mint());
    for (let index = 1; index < minted.length; index += 1) {
      expect((minted[index] ?? "") > (minted[index - 1] ?? ""), `id ${String(index)}`).toBe(true);
    }
  });

  it("never sorts before an id the producer minted earlier in the same session", () => {
    const earlier = PRODUCER_ID;
    const clock = { now: PRODUCER_CLOCK + 1 };
    expect(minter(clock)() > earlier).toBe(true);
  });

  it("draws every suffix character uniformly from the base-62 alphabet, discarding biased bytes", () => {
    const bytes = [255, 248, 249, 61, 62, 0, 123, 247, ...Array.from({ length: 64 }, () => 9)];
    let cursor = 0;
    const mint = createOpenCodeNativeMessageIdMinter({
      now: () => 1_000,
      random: (size) => {
        const slice = new Uint8Array(size);
        for (let index = 0; index < size; index += 1) slice[index] = bytes[cursor++] ?? 9;
        return slice;
      },
    });
    const suffix = mint().slice(16);
    expect(suffix).toHaveLength(14);
    // 255, 248 and 249 are discarded; 61 -> 'z', 62 -> '0', 0 -> '0', 123 -> 'z', 247 -> 'z', 9 -> '9'.
    expect(suffix.startsWith("z00zz9")).toBe(true);
  });

  it("gives two ids minted in the same millisecond different suffixes from the real entropy source", () => {
    const mint = createOpenCodeNativeMessageIdMinter({ now: () => 1_000 });
    const [first, second] = [mint(), mint()];
    expect(first.slice(16)).not.toBe(second.slice(16));
  });
});
