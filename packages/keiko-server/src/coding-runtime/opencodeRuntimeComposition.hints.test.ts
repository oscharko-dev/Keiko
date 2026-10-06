// Lab ledger F2 (#3873): with live streaming the OpenCode V2 event stream can carry an event for
// every streamed token, and every sync hint costs the adapter one full history read. Hints that pile
// up while a read runs collapse into one; control hints keep their order and are never dropped.
import { describe, expect, it } from "vitest";

import { coalescedSyncHints } from "./opencodeRuntimeComposition.js";
import type { OpenCodeSyncHint } from "./opencodeRuntimeAdapter.js";

type EventRecord = Readonly<Record<string, unknown>>;

const PLAIN: OpenCodeSyncHint = { requiresHistoryIdentity: false };

function controlHint(state: "activity" | "terminal"): OpenCodeSyncHint {
  return { requiresHistoryIdentity: false, control: { sessionId: "ses_1", state } };
}

// Events carry the hint they map to, so the source and the expected hints stay one fixture.
function event(hint: OpenCodeSyncHint): EventRecord {
  return { hint };
}

function toHint(value: EventRecord): OpenCodeSyncHint {
  return value.hint as OpenCodeSyncHint;
}

function source(
  events: readonly EventRecord[],
  options: { readonly failure?: Error; readonly closed?: { value: boolean } } = {},
): AsyncIterable<EventRecord> {
  return (async function* (): AsyncGenerator<EventRecord> {
    try {
      for (const item of events) {
        await Promise.resolve();
        yield item;
      }
      if (options.failure !== undefined) throw options.failure;
    } finally {
      if (options.closed !== undefined) options.closed.value = true;
    }
  })();
}

// A history read that takes long enough for every already-sent event to arrive meanwhile.
async function slowRead(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

async function consumeSlowly(hints: AsyncIterable<OpenCodeSyncHint>): Promise<OpenCodeSyncHint[]> {
  const seen: OpenCodeSyncHint[] = [];
  for await (const hint of hints) {
    seen.push(hint);
    await slowRead();
  }
  return seen;
}

describe("coalescedSyncHints", () => {
  it("collapses the plain hints that arrive while a history read runs into one", async () => {
    const burst = Array.from({ length: 200 }, () => event(PLAIN));

    const seen = await consumeSlowly(coalescedSyncHints(source(burst), toHint));

    expect(seen.length).toBeLessThanOrEqual(3);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((hint) => hint === PLAIN)).toBe(true);
  });

  it("keeps every control hint, in order, and lets it cover the plain hints before it", async () => {
    const events = [
      event(PLAIN),
      event(PLAIN),
      event(controlHint("activity")),
      event(PLAIN),
      event(controlHint("terminal")),
      event(PLAIN),
    ];

    const seen = await consumeSlowly(coalescedSyncHints(source(events), toHint));

    const controls = seen.flatMap((hint) => ("control" in hint ? [hint.control.state] : []));
    expect(controls).toEqual(["activity", "terminal"]);
    expect(seen.at(-1)).toBe(PLAIN);
    expect(seen.length).toBeLessThan(events.length);
  });

  it("hands out the hints read before a stream failure, then the failure", async () => {
    const failure = new Error("opencode-v2-event-truncated");
    const hints = coalescedSyncHints(
      source([event(controlHint("activity")), event(controlHint("terminal"))], { failure }),
      toHint,
    );
    const seen: OpenCodeSyncHint[] = [];

    await expect(
      (async (): Promise<void> => {
        for await (const hint of hints) seen.push(hint);
      })(),
    ).rejects.toBe(failure);
    expect(seen).toEqual([controlHint("activity"), controlHint("terminal")]);
  });

  it("closes the event source once the consumer stops", async () => {
    const closed = { value: false };
    const events = Array.from({ length: 5 }, () => event(controlHint("activity")));
    const hints = coalescedSyncHints(source(events, { closed }), toHint);

    for await (const hint of hints) {
      expect(hint).toEqual(controlHint("activity"));
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(closed.value).toBe(true);
  });
});
