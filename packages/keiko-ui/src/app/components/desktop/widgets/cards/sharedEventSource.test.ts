import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSharedEventSourcesForTests, subscribeSharedEventSource } from "./sharedEventSource";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(): void {
    // test double
  }

  removeEventListener(): void {
    // test double
  }

  close(): void {
    // test double
  }
}

afterEach(() => {
  resetSharedEventSourcesForTests();
  FakeEventSource.instances = [];
  vi.unstubAllGlobals();
});

describe("subscribeSharedEventSource", () => {
  it("opens same-origin API streams", () => {
    vi.stubGlobal("EventSource", FakeEventSource);

    const unsubscribe = subscribeSharedEventSource("/api/commands/events", ["command:run"], () => {});

    expect(FakeEventSource.instances.map((source) => source.url)).toEqual(["/api/commands/events"]);
    unsubscribe();
  });

  it("rejects off-origin stream URLs before constructing EventSource", () => {
    vi.stubGlobal("EventSource", FakeEventSource);

    const unsubscribe = subscribeSharedEventSource(
      "https://evil.example/api/commands/events",
      ["command:run"],
      () => {},
    );

    expect(FakeEventSource.instances).toHaveLength(0);
    unsubscribe();
  });
});
