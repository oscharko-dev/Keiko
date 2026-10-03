import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOriginLocksFixture } from "@/test-utils/origin-locks-fixture";
import {
  acquirePersistentBrowserStreamCapacity,
  resetBrowserStreamCapacityForTests,
} from "@/lib/browser-stream-capacity";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
import { resetSharedEventSourcesForTests, subscribeSharedEventSource } from "./sharedEventSource";

class CapacityEventSource {
  static instances: CapacityEventSource[] = [];
  readonly listeners = new Map<string, Set<EventListener>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  closed = false;
  constructor(readonly url: string) {
    CapacityEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }
  close(): void {
    this.closed = true;
  }
}

function subscribeRoot(index: number): () => void {
  return subscribeSharedEventSource(
    `/api/editor/watch/events?root=${String(index)}`,
    ["change"],
    vi.fn(),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", CapacityEventSource);
  vi.stubGlobal("navigator", { locks: createOriginLocksFixture() });
  setClientDiagnosticWriter(vi.fn());
});
afterEach(() => {
  resetSharedEventSourcesForTests();
  resetBrowserStreamCapacityForTests();
  resetClientDiagnosticWriter();
  CapacityEventSource.instances = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("shared EventSource with actual origin leases", () => {
  it("reopens a yielded stream after another tab's waiter releases, preserving its cursor", async () => {
    const releases = Array.from({ length: 3 }, (_, index) => subscribeRoot(index));
    await vi.advanceTimersByTimeAsync(0);
    expect(CapacityEventSource.instances).toHaveLength(3);
    const first = CapacityEventSource.instances[0];
    first?.listeners.get("change")?.forEach((listener) => {
      listener(new MessageEvent("change", { data: "{}", lastEventId: "42" }));
    });
    const otherTab = vi.fn();
    const releaseOther = acquirePersistentBrowserStreamCapacity(otherTab, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(otherTab).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(otherTab).toHaveBeenCalledOnce();
    expect(first?.closed).toBe(true);
    releaseOther();
    await vi.advanceTimersByTimeAsync(0);
    expect(CapacityEventSource.instances.filter((source) => !source.closed)).toHaveLength(3);
    expect(
      CapacityEventSource.instances.some((source) => source.url.includes("root=0&lastEventId=42")),
    ).toBe(true);
    releases.forEach((release) => release());
  });

  it("keeps three uncontended streams open across lease contention checks", async () => {
    const releases = Array.from({ length: 3 }, (_, index) => subscribeRoot(index));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(CapacityEventSource.instances).toHaveLength(3);
    expect(CapacityEventSource.instances.every((source) => !source.closed)).toBe(true);
    releases.forEach((release) => release());
  });

  it("backs off after a real acquisition timeout instead of spinning lease requests", async () => {
    const request = vi.fn((): Promise<never> => new Promise(() => undefined));
    vi.stubGlobal("navigator", { locks: { request } });
    const release = subscribeRoot(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(CapacityEventSource.instances).toHaveLength(0);
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999);
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(501);
    expect(request).toHaveBeenCalledTimes(2);
    release();
  });
});
