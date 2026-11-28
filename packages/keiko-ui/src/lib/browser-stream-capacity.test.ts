import { afterEach, describe, expect, it, vi } from "vitest";
import { createOriginLocksFixture } from "../test-utils/origin-locks-fixture";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "./client-diagnostics";

import {
  STREAM_WAITING_THRESHOLD_MS,
  acquirePersistentBrowserStreamCapacity,
  backgroundBrowserStreamsSuspended,
  admitDirectBrowserStream,
  admitDirectBrowserStreamAsync,
  type DirectStreamAdmission,
  type DirectStreamOptions,
  PERSISTENT_STREAM_CONNECTION_CEILING,
  sharedStreamConnectionBudget,
  reserveInteractiveBrowserStreamCapacity,
  resetBrowserStreamCapacityForTests,
  subscribeBrowserStreamCapacity,
} from "./browser-stream-capacity";

afterEach(() => {
  Reflect.deleteProperty(document, "visibilityState");
  resetBrowserStreamCapacityForTests();
  resetClientDiagnosticWriter();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("browser stream capacity", () => {
  it("suspends background streams until every interactive reservation is released", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBrowserStreamCapacity(listener);
    const releaseFirst = reserveInteractiveBrowserStreamCapacity();
    const releaseSecond = reserveInteractiveBrowserStreamCapacity();

    expect(backgroundBrowserStreamsSuspended()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    releaseFirst();
    releaseFirst();
    expect(backgroundBrowserStreamsSuspended()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    releaseSecond();
    expect(backgroundBrowserStreamsSuspended()).toBe(false);
    expect(listener).toHaveBeenLastCalledWith(false);
    unsubscribe();
  });
});

describe("origin-wide persistent stream capacity", () => {
  it("limits independent consumers to three origin slots and yields every five seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
    const active = new Set<number>();
    const granted = new Set<number>();
    let peak = 0;
    const releases = Array.from({ length: 6 }, (_, index) =>
      acquirePersistentBrowserStreamCapacity(
        () => {
          active.add(index);
          granted.add(index);
          peak = Math.max(peak, active.size);
        },
        () => active.delete(index),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(active.size).toBe(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(peak).toBe(3);
    expect(granted.size).toBe(6);
    expect(active.size).toBe(3);
    releases.forEach((release) => release());
    expect(active.size).toBe(0);
  });

  it("cancels queued and held leases without opening stale consumers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
    const held = Array.from({ length: 3 }, () =>
      acquirePersistentBrowserStreamCapacity(vi.fn(), vi.fn()),
    );
    const grant = vi.fn();
    const release = vi.fn();
    const cancel = acquirePersistentBrowserStreamCapacity(grant, release);
    await vi.advanceTimersByTimeAsync(0);
    cancel();
    cancel();
    held.forEach((stop) => stop());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(grant).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("cancelled");
  });

  it("bounds pending acquisition and does not open streams without a coordinator", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: { request: () => new Promise(() => undefined) } });
    const grant = vi.fn();
    const release = vi.fn();
    acquirePersistentBrowserStreamCapacity(grant, release);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(grant).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith("unavailable");
    vi.stubGlobal("navigator", {});
    acquirePersistentBrowserStreamCapacity(grant, vi.fn())();
    expect(grant).not.toHaveBeenCalled();
  });
});

it("retains an uncontended lease and probes another free slot across independent tabs", async () => {
  vi.useFakeTimers();
  const locks = createOriginLocksFixture();
  vi.stubGlobal("navigator", { locks });
  const first = vi.fn();
  const released = vi.fn();
  const stop = acquirePersistentBrowserStreamCapacity(first, released);
  await vi.advanceTimersByTimeAsync(0);
  resetBrowserStreamCapacityForTests(); // A second independent page starts its own slot counter at zero.
  const second = vi.fn();
  const stopSecond = acquirePersistentBrowserStreamCapacity(second, vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(released).not.toHaveBeenCalled();
  stop();
  stopSecond();
});

it("never interrupts an active non-replayable connection for a queued consumer", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
  const releases = Array.from({ length: 3 }, () => vi.fn());
  const held = releases.map((released) =>
    acquirePersistentBrowserStreamCapacity(vi.fn(), released, { yieldable: false }),
  );
  await vi.advanceTimersByTimeAsync(0);
  const grant = vi.fn();
  const cancel = acquirePersistentBrowserStreamCapacity(grant, vi.fn());
  await vi.advanceTimersByTimeAsync(10_000);
  expect(grant).not.toHaveBeenCalled();
  expect(releases.every((released) => released.mock.calls.length === 0)).toBe(true);
  cancel();
  held.forEach((stop) => stop());
});

it("never cycles the only healthy connection without an origin waiter", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
  const released = vi.fn();
  const stop = acquirePersistentBrowserStreamCapacity(vi.fn(), released);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(released).not.toHaveBeenCalled();
  stop();
});

it("records a failed contention query once without dropping a healthy connection or error prose", async () => {
  vi.useFakeTimers();
  const locks = createOriginLocksFixture();
  const query = vi.fn().mockRejectedValue(new TypeError("private customer query failure"));
  vi.stubGlobal("navigator", { locks: { request: locks.request, query } });
  const writer = vi.fn();
  setClientDiagnosticWriter(writer);
  const grant = vi.fn();
  const released = vi.fn();
  const stop = acquirePersistentBrowserStreamCapacity(grant, released, {
    correlationId: "capacity-failure-1",
  });
  await vi.advanceTimersByTimeAsync(15_000);
  expect(grant).toHaveBeenCalledOnce();
  expect(released).not.toHaveBeenCalled();
  expect(writer).toHaveBeenCalledOnce();
  expect(writer).toHaveBeenCalledWith(
    "[keiko] persistent stream contention query unavailable",
    expect.objectContaining({ correlationId: "capacity-failure-1", errorKind: "unavailable" }),
  );
  expect(JSON.stringify(writer.mock.calls)).not.toContain("private customer query failure");
  stop();
});

// U-37 / #4573: persistent streams of every document of the origin share four connection slots, so
// two of the six HTTP/1.1 connections stay free for finite reads. The ceiling is enforced when a
// stream is admitted, not by counting streams after they opened.
describe("persistent stream connection ceiling", () => {
  function admitAll(
    count: number,
    admitted: Set<number>,
    options: DirectStreamOptions = {},
  ): DirectStreamAdmission[] {
    return Array.from({ length: count }, (_, index) =>
      admitDirectBrowserStream(() => admitted.add(index), options),
    );
  }

  it("admits at most four direct streams and lets the shared pool yield its last slot", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
    expect(sharedStreamConnectionBudget()).toBe(3);
    const admitted = new Set<number>();
    const admissions = admitAll(6, admitted);
    await vi.advanceTimersByTimeAsync(0);
    expect(admitted.size).toBe(PERSISTENT_STREAM_CONNECTION_CEILING);
    // Six direct streams are declared, yet the shared pool keeps one connection: it is never
    // starved of its last slot (the original pin of "keeps one shared connection").
    expect(sharedStreamConnectionBudget()).toBe(1);
    admissions[0]?.release();
    admissions[0]?.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(admitted.size).toBe(PERSISTENT_STREAM_CONNECTION_CEILING + 1);
    admissions.forEach((admission) => admission.release());
    expect(sharedStreamConnectionBudget()).toBe(3);
  });

  it("leaves the shared pool one connection beside three direct streams and two once one ends", () => {
    const admissions = admitAll(3, new Set<number>());
    expect(sharedStreamConnectionBudget()).toBe(1);
    admissions[0]?.release();
    admissions[0]?.release();
    expect(sharedStreamConnectionBudget()).toBe(2);
    admissions.forEach((admission) => admission.release());
    expect(sharedStreamConnectionBudget()).toBe(3);
  });

  it("serves a shared-pool consumer by making a visible document's background streams yield", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
    const yielded = vi.fn();
    const background = admitAll(4, new Set<number>(), { priority: "background", onYield: yielded });
    await vi.advanceTimersByTimeAsync(0);
    const granted = vi.fn();
    const pool = acquirePersistentBrowserStreamCapacity(granted, vi.fn());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(granted).toHaveBeenCalledOnce();
    expect(yielded).toHaveBeenCalledTimes(1);
    pool();
    background.forEach((admission) => admission.release());
  });

  it("shares the ceiling across documents and with the shared pool", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
    let live = 0;
    let peak = 0;
    const open = (): void => {
      live += 1;
      peak = Math.max(peak, live);
    };
    const pool = Array.from({ length: 3 }, () =>
      acquirePersistentBrowserStreamCapacity(open, () => (live -= 1)),
    );
    const documentA = Array.from({ length: 2 }, () => admitDirectBrowserStream(open));
    resetBrowserStreamCapacityForTests(); // Another tab starts its own counters, not its locks.
    const documentB = Array.from({ length: 3 }, () => admitDirectBrowserStream(open));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(peak).toBeLessThanOrEqual(PERSISTENT_STREAM_CONNECTION_CEILING);
    expect(live).toBeLessThanOrEqual(PERSISTENT_STREAM_CONNECTION_CEILING);
    [...pool, ...documentA.map((a) => a.release), ...documentB.map((b) => b.release)].forEach(
      (stop) => stop(),
    );
  });

  // The Workbench run streams must open eventually, however long other streams hold the slots.
  it("keeps asking for a slot past the acquisition deadline until one frees", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
    const admitted = new Set<number>();
    const admissions = admitAll(5, admitted);
    await vi.advanceTimersByTimeAsync(40_000);
    expect([...admitted]).toEqual([0, 1, 2, 3]);
    expect(admissions[4]?.active).toBe(true);
    admissions[0]?.release();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(admitted.has(4)).toBe(true);
    admissions.forEach((admission) => admission.release());
  });

  it("makes a background stream yield its slot to an essential one and take it back later", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
    const yielded = vi.fn();
    const background = admitAll(4, new Set<number>(), { priority: "background", onYield: yielded });
    await vi.advanceTimersByTimeAsync(0);
    const essential = new Set<number>();
    const waiting = admitAll(1, essential);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(essential.size).toBe(1);
    expect(yielded).toHaveBeenCalledTimes(1);
    waiting.forEach((admission) => admission.release());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(background.filter((admission) => admission.active)).toHaveLength(4);
    background.forEach((admission) => admission.release());
  });

  it("never yields an essential stream to another essential one", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
    const held = admitAll(4, new Set<number>());
    await vi.advanceTimersByTimeAsync(0);
    const waiting = new Set<number>();
    admitAll(1, waiting);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(waiting.size).toBe(0);
    held.forEach((admission) => admission.release());
  });

  it("stops asking once released while it waits", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
    const held = admitAll(4, new Set<number>());
    const late = new Set<number>();
    const [waiting] = admitAll(1, late);
    await vi.advanceTimersByTimeAsync(20_000);
    waiting?.release();
    held[0]?.release();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(late.size).toBe(0);
    held.forEach((admission) => admission.release());
  });

  it("admits a stream asynchronously and not at all once its signal aborted", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
    const controller = new AbortController();
    const first = admitDirectBrowserStreamAsync(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    const release = await first;
    expect(release).not.toBeNull();
    release?.();
    controller.abort();
    await expect(admitDirectBrowserStreamAsync(controller.signal)).resolves.toBeNull();
  });

  it("falls back to this document's ceiling when Web Locks are unavailable", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {});
    const admitted = new Set<number>();
    const admissions = admitAll(5, admitted);
    expect(admitted.size).toBe(PERSISTENT_STREAM_CONNECTION_CEILING);
    // The refused stream stays pending (not settled), so a caller's stored handle stays valid.
    expect(admissions[4]?.active).toBe(true);
    admissions[0]?.release();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(admitted.has(4)).toBe(true);
    admissions.forEach((admission) => admission.release());
  });
});

// #4491 stream fairness: who may take whose slot. A background stream gives its slot up only to an
// essential waiter; an essential stream of a hidden document gives its slot up to an essential
// waiter of a visible one; an essential waiter keeps its place and says when it waits long.
describe("stream fairness between documents and priorities", () => {
  function setVisibility(state: "visible" | "hidden"): void {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  }

  function admitMany(
    count: number,
    options: DirectStreamOptions = {},
    admitted: Set<number> = new Set<number>(),
  ): DirectStreamAdmission[] {
    return Array.from({ length: count }, (_, index) =>
      admitDirectBrowserStream(() => admitted.add(index), options),
    );
  }

  function useLocks(): void {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
  }

  it("does not make background streams yield to each other, only to an essential waiter", async () => {
    useLocks();
    const yielded = vi.fn();
    const background: DirectStreamOptions = { priority: "background", onYield: yielded };
    const holders = admitMany(4, background);
    await vi.advanceTimersByTimeAsync(0);
    const queuedAdmitted = new Set<number>();
    const queued = admitMany(1, background, queuedAdmitted);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(yielded).not.toHaveBeenCalled();
    expect(queuedAdmitted.size).toBe(0);
    const essentialAdmitted = new Set<number>();
    const essential = admitMany(1, {}, essentialAdmitted);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(yielded).toHaveBeenCalledTimes(1);
    expect(essentialAdmitted.size).toBe(1);
    expect(queuedAdmitted.size).toBe(0);
    [...holders, ...queued, ...essential].forEach((admission) => admission.release());
  });

  it("makes a hidden document's essential streams yield to an essential stream of a visible one", async () => {
    useLocks();
    setVisibility("visible");
    const yielded = vi.fn();
    const holders = admitMany(4, { yieldWhenHidden: true, onYield: yielded });
    await vi.advanceTimersByTimeAsync(0);
    const waiterAdmitted = new Set<number>();
    const waiter = admitMany(1, {}, waiterAdmitted);
    await vi.advanceTimersByTimeAsync(0);
    // The waiter's document is the visible one; the holders' document went into the background.
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(waiterAdmitted.size).toBe(1);
    expect(yielded).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(yielded).toHaveBeenCalledTimes(1);
    [...holders, ...waiter].forEach((admission) => admission.release());
  });

  it("keeps a visible document's essential streams and never yields hidden ones to a hidden waiter", async () => {
    useLocks();
    const yielded = vi.fn();
    setVisibility("visible");
    const visibleHolders = admitMany(4, { yieldWhenHidden: true, onYield: yielded });
    await vi.advanceTimersByTimeAsync(0);
    const visibleWaiter = admitMany(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(yielded).not.toHaveBeenCalled();
    [...visibleHolders, ...visibleWaiter].forEach((admission) => admission.release());
    await vi.advanceTimersByTimeAsync(0);
    setVisibility("hidden");
    const hiddenHolders = admitMany(4, { yieldWhenHidden: true, onYield: yielded });
    await vi.advanceTimersByTimeAsync(0);
    const hiddenWaiter = admitMany(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(yielded).not.toHaveBeenCalled();
    [...hiddenHolders, ...hiddenWaiter].forEach((admission) => admission.release());
  });

  it("asks again at once when the yielded document becomes visible", async () => {
    useLocks();
    setVisibility("visible");
    const onAdmitted = vi.fn();
    const holders = Array.from({ length: 4 }, () =>
      admitDirectBrowserStream(onAdmitted, { yieldWhenHidden: true, onYield: vi.fn() }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const [waiter] = admitMany(1);
    await vi.advanceTimersByTimeAsync(0);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5_150);
    expect(onAdmitted).toHaveBeenCalledTimes(4);
    waiter?.release();
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(50);
    expect(onAdmitted).toHaveBeenCalledTimes(5);
    holders.forEach((admission) => admission.release());
  });

  it("does not hold a yield while the stream is mid-action", async () => {
    useLocks();
    const yielded = vi.fn();
    let busy = true;
    const holders = admitMany(4, {
      priority: "background",
      onYield: yielded,
      canYield: () => !busy,
    });
    await vi.advanceTimersByTimeAsync(0);
    const [essential] = admitMany(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(yielded).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(yielded).toHaveBeenCalledTimes(1);
    [...holders, essential].forEach((admission) => admission?.release());
  });

  it("tells a waiting essential stream once after the threshold and clears it on admission", async () => {
    useLocks();
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    const holders = admitMany(4);
    await vi.advanceTimersByTimeAsync(0);
    const onWaiting = vi.fn();
    const waiting = admitDirectBrowserStream(vi.fn(), { onWaiting, correlationId: "wait-1" });
    await vi.advanceTimersByTimeAsync(STREAM_WAITING_THRESHOLD_MS - 1);
    expect(onWaiting).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onWaiting.mock.calls).toEqual([[true]]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onWaiting.mock.calls).toEqual([[true]]);
    const messages = (): string[] => writer.mock.calls.map(([message]) => String(message));
    expect(messages().filter((message) => message.includes("waiting for origin"))).toHaveLength(1);
    expect(messages().filter((message) => message.includes("acquisition unavailable"))).toEqual([]);
    holders[0]?.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(onWaiting.mock.calls).toEqual([[true], [false]]);
    expect(messages().filter((message) => message.includes("admitted after waiting"))).toHaveLength(
      1,
    );
    [...holders, waiting].forEach((admission) => admission.release());
  });

  it("keeps an essential stream's place in the queue past the old acquisition deadline", async () => {
    useLocks();
    const holders = admitMany(4);
    await vi.advanceTimersByTimeAsync(0);
    const firstAdmitted = new Set<number>();
    const first = admitMany(1, {}, firstAdmitted);
    await vi.advanceTimersByTimeAsync(10_000);
    const secondAdmitted = new Set<number>();
    const second = admitMany(1, {}, secondAdmitted);
    await vi.advanceTimersByTimeAsync(10_000);
    holders[0]?.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(firstAdmitted.size).toBe(1);
    expect(secondAdmitted.size).toBe(0);
    [...holders, ...first, ...second].forEach((admission) => admission.release());
  });

  it("leaves no queued lock request behind a lease that ended while it was choosing a slot", async () => {
    vi.useFakeTimers();
    const base = createOriginLocksFixture();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let gated = false;
    vi.stubGlobal("navigator", {
      locks: {
        request: base.request,
        query: () => (gated ? gate.then(() => base.query()) : base.query()),
      },
    });
    const held = Array.from({ length: 3 }, () =>
      acquirePersistentBrowserStreamCapacity(vi.fn(), vi.fn(), { yieldable: false }),
    );
    await vi.advanceTimersByTimeAsync(0);
    gated = true;
    const cancel = acquirePersistentBrowserStreamCapacity(vi.fn(), vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    cancel();
    open();
    await vi.advanceTimersByTimeAsync(0);
    expect((await base.query()).pending).toEqual([]);
    held.forEach((stop) => stop());
  });
});

describe("stream fairness: who a waiter may displace", () => {
  // `notify` is false where the flip stands for ANOTHER document's visibility, which this
  // document never hears about; a flip of this document itself dispatches the event.
  function setVisibility(state: "visible" | "hidden", notify = true): void {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    if (notify) document.dispatchEvent(new Event("visibilitychange"));
  }

  function admitMany(
    count: number,
    options: DirectStreamOptions = {},
    admitted: Set<number> = new Set<number>(),
  ): DirectStreamAdmission[] {
    return Array.from({ length: count }, (_, index) =>
      admitDirectBrowserStream(() => admitted.add(index), options),
    );
  }

  it("does not let a hidden document's waiter displace another document's background streams", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
    setVisibility("visible");
    const yielded = vi.fn();
    const background = admitMany(4, { priority: "background", onYield: yielded });
    await vi.advanceTimersByTimeAsync(0);
    setVisibility("hidden", false);
    const hiddenAdmitted = new Set<number>();
    const hidden = admitMany(1, {}, hiddenAdmitted);
    await vi.advanceTimersByTimeAsync(0);
    // The background streams belong to another document: this document's waiter is not theirs.
    resetBrowserStreamCapacityForTests();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(yielded).not.toHaveBeenCalled();
    expect(hiddenAdmitted.size).toBe(0);
    setVisibility("visible", false);
    const visibleAdmitted = new Set<number>();
    const visible = admitMany(1, {}, visibleAdmitted);
    await vi.advanceTimersByTimeAsync(0);
    // This document is the hidden one again; the visible waiter's marker is already placed.
    setVisibility("hidden", false);
    // Judged within the first check after the visible waiter queued, before the hidden waiter's
    // retry: that retry would count as a waiter of this (the holders') document.
    await vi.advanceTimersByTimeAsync(900);
    expect(yielded).toHaveBeenCalledTimes(1);
    expect(visibleAdmitted.size).toBe(1);
    expect(hiddenAdmitted.size).toBe(0);
    [...background, ...hidden, ...visible].forEach((admission) => admission.release());
  });

  it("lets a hidden document's own waiter displace its own background streams", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
    setVisibility("hidden");
    const yielded = vi.fn();
    const background = admitMany(4, { priority: "background", onYield: yielded });
    await vi.advanceTimersByTimeAsync(0);
    const waiterAdmitted = new Set<number>();
    const waiter = admitMany(1, {}, waiterAdmitted);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(yielded).toHaveBeenCalledTimes(1);
    expect(waiterAdmitted.size).toBe(1);
    [...background, ...waiter].forEach((admission) => admission.release());
  });

  it("withdraws a waiter's visible marker when its document turns hidden and restores it when visible", async () => {
    vi.useFakeTimers();
    const base = createOriginLocksFixture();
    vi.stubGlobal("navigator", { locks: base });
    setVisibility("visible");
    const holders = admitMany(4);
    await vi.advanceTimersByTimeAsync(0);
    const waiter = admitMany(1);
    await vi.advanceTimersByTimeAsync(0);
    const markers = async (): Promise<number> =>
      [...((await base.query()).held ?? []), ...((await base.query()).pending ?? [])].filter(
        (lock) => lock.name?.endsWith(":waiting:visible") === true,
      ).length;
    expect(await markers()).toBeGreaterThan(0);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(0);
    expect(await markers()).toBe(0);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(await markers()).toBeGreaterThan(0);
    [...holders, ...waiter].forEach((admission) => admission.release());
  });

  it("hands a slot freed for a visible waiter past two hidden waiters queued ahead of it", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
    setVisibility("hidden", false);
    const holders = admitMany(4, { yieldWhenHidden: true, onYield: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    const first = new Set<number>();
    const second = new Set<number>();
    const hidden = [...admitMany(1, {}, first), ...admitMany(1, {}, second)];
    await vi.advanceTimersByTimeAsync(0);
    setVisibility("visible", false);
    const visibleAdmitted = new Set<number>();
    const visible = admitMany(1, {}, visibleAdmitted);
    await vi.advanceTimersByTimeAsync(0);
    // The holders' document stays hidden; the visible waiter's marker is already placed.
    setVisibility("hidden", false);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(visibleAdmitted.size).toBe(1);
    expect(first.size).toBe(0);
    expect(second.size).toBe(0);
    [...holders, ...hidden, ...visible].forEach((admission) => admission.release());
  });
});

describe("a synchronous admission and its abort signal", () => {
  it("does not release an admitted slot when the signal aborts afterwards", async () => {
    vi.useFakeTimers();
    // Without Web Locks the admission is granted before the promise form returns.
    vi.stubGlobal("navigator", {});
    const held = Array.from({ length: 3 }, () => admitDirectBrowserStream(() => undefined));
    const controller = new AbortController();
    const release = await admitDirectBrowserStreamAsync(controller.signal);
    expect(release).not.toBeNull();
    const queuedAdmitted = vi.fn();
    const queued = admitDirectBrowserStream(queuedAdmitted);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(queuedAdmitted).not.toHaveBeenCalled();
    release?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(queuedAdmitted).toHaveBeenCalledOnce();
    [...held, queued].forEach((admission) => admission.release());
  });
});
