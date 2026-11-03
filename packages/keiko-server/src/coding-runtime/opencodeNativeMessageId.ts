import { randomBytes } from "node:crypto";

/**
 * The producer's ascending message ids, minted by Keiko (#3897, PR #4064 review, ADR-0137 D10).
 *
 * A prompt body may carry the producer's supported `Session.Message.ID` (`id`, the pinned 2.1.4 schema
 * declares the pattern `^msg_`). The producer stores one input per id and answers a second post of the
 * same id with the receipt it already holds, so binding the operator's request identity to such an id
 * turns a retry after a lost acknowledgement into the same input instead of a second one.
 *
 * The layout is the producer's own ascending identifier, observed on the pinned executable: `msg_`,
 * twelve lowercase hex digits (the low 48 bits of `milliseconds * 0x1000 + counter`, the counter
 * starting at 1 within a millisecond) and fourteen base-62 characters of randomness. Keeping the same
 * layout keeps a minted id comparable with the ids the producer mints itself, so it never sorts before
 * a message the session already holds; the clock is the host's, which Keiko and the producer share.
 */

const PREFIX = "msg_";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SUFFIX_LENGTH = 14;
const COUNTER_BITS = 12n;
const COUNTER_MAX = 0xfff;
const TIME_AND_COUNTER_MASK = (1n << 48n) - 1n;
/** Bytes at or above this value are discarded so every base-62 character is equally likely. */
const UNBIASED_BYTE_LIMIT = 248;

export interface OpenCodeNativeMessageIdSources {
  /** The wall clock in milliseconds; injectable so a test owns the time. */
  readonly now?: (() => number) | undefined;
  /** Random bytes; injectable so a test owns the suffix. */
  readonly random?: ((size: number) => Uint8Array) | undefined;
}

function randomSuffix(random: (size: number) => Uint8Array): string {
  let suffix = "";
  while (suffix.length < SUFFIX_LENGTH) {
    for (const byte of random(SUFFIX_LENGTH * 2)) {
      if (byte >= UNBIASED_BYTE_LIMIT || suffix.length === SUFFIX_LENGTH) continue;
      suffix += BASE62.charAt(byte % BASE62.length);
    }
  }
  return suffix;
}

function timeAndCounter(milliseconds: number, counter: number): string {
  const value = ((BigInt(milliseconds) << COUNTER_BITS) | BigInt(counter)) & TIME_AND_COUNTER_MASK;
  return value.toString(16).padStart(12, "0");
}

/**
 * A minter whose ids strictly ascend, within the process and across a backward step of the clock: the
 * time never moves back and a burst inside one millisecond counts up (a full counter carries into the
 * next millisecond).
 */
export function createOpenCodeNativeMessageIdMinter(
  sources: OpenCodeNativeMessageIdSources = {},
): () => string {
  const now = sources.now ?? Date.now;
  const random = sources.random ?? randomBytes;
  let milliseconds = 0;
  let counter = 0;
  return (): string => {
    const observed = Math.max(Math.trunc(now()), milliseconds);
    counter = observed === milliseconds ? counter + 1 : 1;
    milliseconds = observed;
    if (counter > COUNTER_MAX) {
      milliseconds += 1;
      counter = 1;
    }
    return `${PREFIX}${timeAndCounter(milliseconds, counter)}${randomSuffix(random)}`;
  };
}
