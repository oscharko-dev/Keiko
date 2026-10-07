// Lab ledger F2 (#3873): with live streaming the OpenCode V2 event stream can carry an event for
// every streamed token, and every sync hint costs the adapter one full history read. Hints that pile
// up while a read runs collapse into one; control hints keep their order and are never dropped.
import { describe, expect, it, vi } from "vitest";

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

// A source the test drives by hand: an event, the end, or a failure arrives exactly when the test says,
// so a pull can be made to wait before it does. `returns` counts how often the pump closed it.
function channel(): {
  readonly events: AsyncIterable<EventRecord>;
  push(value: EventRecord): void;
  end(): void;
  fail(error: Error): void;
  readonly returns: () => number;
} {
  type Item = { readonly result: IteratorResult<EventRecord> } | { readonly error: Error };
  const buffered: Item[] = [];
  let waiter:
    | {
        readonly resolve: (result: IteratorResult<EventRecord>) => void;
        readonly reject: (error: Error) => void;
      }
    | undefined;
  let returns = 0;
  const settleWaiter = (item: Item): void => {
    const current = waiter;
    waiter = undefined;
    if (current === undefined) return;
    if ("error" in item) current.reject(item.error);
    else current.resolve(item.result);
  };
  const deliver = (item: Item): void => {
    if (waiter === undefined) buffered.push(item);
    else settleWaiter(item);
  };
  const iterator: AsyncIterator<EventRecord> = {
    next: () =>
      new Promise<IteratorResult<EventRecord>>((resolve, reject) => {
        waiter = { resolve, reject };
        const item = buffered.shift();
        if (item !== undefined) settleWaiter(item);
      }),
    return: () => {
      returns += 1;
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  return {
    events: { [Symbol.asyncIterator]: () => iterator },
    push: (value): void => {
      deliver({ result: { done: false, value } });
    },
    end: (): void => {
      deliver({ result: { done: true, value: undefined } });
    },
    fail: (error): void => {
      deliver({ error });
    },
    returns: (): number => returns,
  };
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

  // SonarCloud typescript:S9382: the wait for the next hint sat in a loop body. It is now the
  // iterator's own pull, one wait per hint; these pin the edges of a pull that waits.
  describe("a pull that waits", () => {
    it("is woken by the event that arrives while it waits", async () => {
      const source = channel();
      const hints = coalescedSyncHints(source.events, toHint);

      const waiting = hints.next();
      await Promise.resolve();
      source.push(event(controlHint("activity")));

      await expect(waiting).resolves.toEqual({ done: false, value: controlHint("activity") });
      source.end();
      await expect(hints.next()).resolves.toEqual({ done: true, value: undefined });
    });

    it("ends when the source ends while it waits", async () => {
      const source = channel();
      const hints = coalescedSyncHints(source.events, toHint);

      const waiting = hints.next();
      await Promise.resolve();
      source.end();

      await expect(waiting).resolves.toEqual({ done: true, value: undefined });
    });

    it("surfaces a failure of the source that arrives while it waits, then stays ended", async () => {
      const source = channel();
      const failure = new Error("opencode-v2-event-truncated");
      const hints = coalescedSyncHints(source.events, toHint);

      const waiting = hints.next();
      await Promise.resolve();
      source.fail(failure);

      await expect(waiting).rejects.toBe(failure);
      await expect(hints.next()).resolves.toEqual({ done: true, value: undefined });
    });

    it("delivers every hint queued before the source ended, in order, and then ends", async () => {
      const source = channel();
      source.push(event(controlHint("activity")));
      source.push(event(PLAIN));
      source.push(event(controlHint("terminal")));
      source.end();
      const hints = coalescedSyncHints(source.events, toHint);

      const seen = await consumeSlowly(hints);

      expect(seen.filter((hint) => "control" in hint)).toEqual([
        controlHint("activity"),
        controlHint("terminal"),
      ]);
      expect(seen.at(-1)).toEqual(controlHint("terminal"));
    });

    it("delivers every hint queued before a failure of the source, then the failure", async () => {
      const source = channel();
      const failure = new Error("opencode-v2-event-oversized");
      source.push(event(controlHint("activity")));
      source.push(event(controlHint("terminal")));
      source.fail(failure);
      const hints = coalescedSyncHints(source.events, toHint);
      const seen: OpenCodeSyncHint[] = [];

      await expect(
        (async (): Promise<void> => {
          for await (const hint of hints) {
            seen.push(hint);
            await slowRead();
          }
        })(),
      ).rejects.toBe(failure);
      expect(seen).toEqual([controlHint("activity"), controlHint("terminal")]);
    });

    it("closes the source when an event arrives after the consumer has gone", async () => {
      const source = channel();
      const hints = coalescedSyncHints(source.events, toHint);
      const first = hints.next();
      await Promise.resolve();
      source.push(event(controlHint("activity")));
      await first;

      await hints.return(undefined);
      expect(source.returns()).toBe(0);
      // The read the pump still had in flight resolves after the consumer left.
      source.push(event(controlHint("terminal")));

      await vi.waitFor(() => {
        expect(source.returns()).toBe(1);
      });
      await expect(hints.next()).resolves.toEqual({ done: true, value: undefined });
    });
  });

  // PR #3876 review: a merged event is a history read saved, and the history projection's line carries
  // how many. `onMerged` reports them as the pump folds them into another hint's read.
  describe("the events it merges into one read", () => {
    // The pump reads its source on its own: let it settle everything pushed so far.
    const settled = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

    function mergeCounter(): { readonly onMerged: (count: number) => void; total(): number } {
      let total = 0;
      return {
        onMerged: (count): void => {
          total += count;
        },
        total: (): number => total,
      };
    }

    // The consumer takes the first hint and then stays busy, as it does during a history read, while
    // the rest of the burst arrives.
    async function busyAfterFirst(
      source: ReturnType<typeof channel>,
      counter: ReturnType<typeof mergeCounter>,
    ): Promise<AsyncGenerator<OpenCodeSyncHint>> {
      const hints = coalescedSyncHints(source.events, toHint, counter.onMerged);
      const first = hints.next();
      source.push(event(PLAIN));
      await expect(first).resolves.toEqual({ done: false, value: PLAIN });
      return hints;
    }

    it("counts the plain events a queued plain hint already covers", async () => {
      const source = channel();
      const counter = mergeCounter();
      const hints = await busyAfterFirst(source, counter);
      expect(counter.total()).toBe(0);

      for (let sent = 0; sent < 5; sent += 1) source.push(event(PLAIN));
      await settled();

      // One of the five asks for the next read; the other four are covered by it.
      expect(counter.total()).toBe(4);
      await expect(hints.next()).resolves.toEqual({ done: false, value: PLAIN });
      source.end();
      await expect(hints.next()).resolves.toEqual({ done: true, value: undefined });
      expect(counter.total()).toBe(4);
    });

    it("counts the queued plain events a control hint's read replaces and keeps the controls", async () => {
      const source = channel();
      const counter = mergeCounter();
      const hints = await busyAfterFirst(source, counter);

      for (const hint of [
        PLAIN, // queued
        PLAIN, // covered by it: 1
        controlHint("activity"), // replaces the queued plain hint: 2
        PLAIN, // queued behind the control hint
        controlHint("terminal"), // replaces it: 3
        PLAIN, // queued behind the control hint
      ]) {
        source.push(event(hint));
      }
      await settled();

      expect(counter.total()).toBe(3);
      source.end();
      const rest: OpenCodeSyncHint[] = [];
      for await (const hint of hints) rest.push(hint);
      expect(rest).toEqual([controlHint("activity"), controlHint("terminal"), PLAIN]);
      // Events: 1 read before the burst + 6 in it. Hints yielded: 1 + 3. Merged: 3.
      expect(counter.total()).toBe(3);
    });

    it("counts nothing while no hint is folded into another", async () => {
      const source = channel();
      const counter = mergeCounter();
      const hints = await busyAfterFirst(source, counter);

      source.push(event(controlHint("activity")));
      source.push(event(controlHint("terminal")));
      source.push(event(controlHint("activity")));
      await settled();
      source.end();
      const rest: OpenCodeSyncHint[] = [];
      for await (const hint of hints) rest.push(hint);

      expect(rest).toHaveLength(3);
      expect(counter.total()).toBe(0);
    });

    it("accounts for every event of a stream read to its end: hints yielded plus events merged", async () => {
      const burst = [
        ...Array.from({ length: 120 }, () => event(PLAIN)),
        event(controlHint("activity")),
        ...Array.from({ length: 80 }, () => event(PLAIN)),
        event(controlHint("terminal")),
      ];
      const counter = mergeCounter();

      const seen = await consumeSlowly(coalescedSyncHints(source(burst), toHint, counter.onMerged));

      expect(counter.total()).toBeGreaterThan(0);
      expect(seen.length + counter.total()).toBe(burst.length);
    });

    it("reports to nobody when no one listens for the count", async () => {
      const events = [event(PLAIN), event(PLAIN), event(controlHint("activity"))];

      const seen = await consumeSlowly(coalescedSyncHints(source(events), toHint));

      expect(seen.some((hint) => "control" in hint)).toBe(true);
    });
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
