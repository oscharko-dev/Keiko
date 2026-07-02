import { afterEach, describe, expect, it, vi } from "vitest";
import { createSameOriginApiEventSource, sameOriginApiEventSourceUrl } from "./safe-event-source";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    // test double
  }
}

afterEach(() => {
  FakeEventSource.instances = [];
  vi.unstubAllGlobals();
});

describe("sameOriginApiEventSourceUrl", () => {
  it("accepts and normalizes same-origin API paths", () => {
    expect(sameOriginApiEventSourceUrl("/api/runs/events?runId=abc")).toBe(
      "/api/runs/events?runId=abc",
    );
    expect(sameOriginApiEventSourceUrl(`${window.location.origin}/api/runs/events`)).toBe(
      "/api/runs/events",
    );
  });

  it("rejects off-origin, protocol-relative, non-API, credentialed, and fragmented URLs", () => {
    expect(sameOriginApiEventSourceUrl("https://evil.example/api/runs/events")).toBeNull();
    expect(sameOriginApiEventSourceUrl("//evil.example/api/runs/events")).toBeNull();
    expect(sameOriginApiEventSourceUrl("/metrics/events")).toBeNull();
    expect(sameOriginApiEventSourceUrl("http://user:pass@localhost/api/runs/events")).toBeNull();
    expect(sameOriginApiEventSourceUrl("/api/runs/events#secret")).toBeNull();
  });
});

describe("createSameOriginApiEventSource", () => {
  it("does not construct EventSource for rejected URLs", () => {
    vi.stubGlobal("EventSource", FakeEventSource);

    expect(createSameOriginApiEventSource("https://evil.example/api/runs/events")).toBeNull();

    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
