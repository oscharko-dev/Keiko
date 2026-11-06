import { describe, expect, it } from "vitest";

import {
  characters,
  checkProperty,
  shrinkArray,
  type SeededRandom,
} from "../../../tests/support/seeded-property.js";
import {
  isUsableToolCallId,
  parseNormalizedToolCalls,
  SYNTHESIZED_TOOL_CALL_ID_PREFIX,
} from "./normalize.js";

/**
 * #4271: the normalizer is the first layer that sees a provider's call ids, and the catalog bridge
 * refuses a batch whose ids it cannot carry. Generated batches mix usable, repeated, empty,
 * oversized, foreign-character, non-string and Keiko-looking ids.
 */

interface RawCall {
  readonly id?: unknown;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

const ID_CHARACTERS = characters("abcXYZ019_.:-");

function rawId(random: SeededRandom, earlier: readonly unknown[]): unknown {
  switch (random.integer(0, 8)) {
    case 0:
      return earlier.length === 0 ? "" : random.pick(earlier);
    case 1:
      return "";
    case 2:
      return "x".repeat(random.integer(129, 140));
    case 3:
      return `call ${random.string(ID_CHARACTERS, 1, 6)}`;
    case 4:
      return random.pick([undefined, null, 7, { id: "nested" }, ["a"]]);
    case 5:
      return `${SYNTHESIZED_TOOL_CALL_ID_PREFIX}${random.string(characters("0123456789abcdef"), 12, 12)}-${String(random.integer(0, 4))}`;
    case 6:
      return `call_${random.string(characters("äé😀/"), 1, 3)}`;
    default:
      return `call_${random.string(ID_CHARACTERS, 1, 20)}`;
  }
}

function batch(random: SeededRandom): readonly RawCall[] {
  const calls: RawCall[] = [];
  const ids: unknown[] = [];
  const count = random.integer(0, 12);
  for (let index = 0; index < count; index += 1) {
    const id = rawId(random, ids);
    ids.push(id);
    const descriptor = {
      name: random.pick(["read", "edit", "bash", "grep"]),
      arguments: `{"n":${String(index)}}`,
    };
    calls.push(
      random.boolean(0.1)
        ? { type: "function", function: descriptor }
        : { id, type: "function", function: descriptor },
    );
  }
  return calls;
}

function firstSeenUsable(calls: readonly RawCall[]): ReadonlyMap<number, string> {
  const seen = new Set<string>();
  const kept = new Map<number, string>();
  calls.forEach((call, position) => {
    if (isUsableToolCallId(call.id) && !seen.has(call.id)) {
      seen.add(call.id);
      kept.set(position, call.id);
    }
  });
  return kept;
}

describe("the id shape the catalog bridge carries", () => {
  // A literal pin of the rule itself: the properties below use it as their oracle.
  it.each(["a", "call_1", "x.y:z-0", "A".repeat(128)])("carries %j", (id) => {
    expect(isUsableToolCallId(id)).toBe(true);
  });
  it.each(["", "A".repeat(129), "call 1", "call/1", "cäll", 7, undefined])("refuses %j", (id) => {
    expect(isUsableToolCallId(id)).toBe(false);
  });
});

describe("tool call ids of a provider response", () => {
  it("leaves every call with an id the bridge carries and no sibling shares", () => {
    checkProperty(
      batch,
      (calls) => {
        const ids = parseNormalizedToolCalls(calls).map((call) => call.id);
        expect(ids.every((id) => isUsableToolCallId(id))).toBe(true);
        expect(new Set(ids).size).toBe(ids.length);
      },
      { runs: 500, shrink: shrinkArray },
    );
  });

  it("keeps each usable first-seen provider id, every call's position, name and arguments", () => {
    checkProperty(
      batch,
      (calls) => {
        const normalized = parseNormalizedToolCalls(calls);
        expect(normalized.map((call) => [call.name, call.arguments])).toEqual(
          calls.map((call) => [call.function.name, JSON.parse(call.function.arguments) as unknown]),
        );
        for (const [position, id] of firstSeenUsable(calls)) {
          expect(normalized[position]?.id).toBe(id);
        }
      },
      { runs: 500, shrink: shrinkArray },
    );
  });

  it("never mints in one response an id another response minted", () => {
    checkProperty(
      batch,
      (calls) => {
        const minted = (): string[] =>
          parseNormalizedToolCalls(calls)
            .map((call) => call.id)
            .filter((id, position) => id !== calls[position]?.id);
        const first = new Set(minted());
        expect(minted().filter((id) => first.has(id))).toEqual([]);
      },
      { runs: 300 },
    );
  });
});
