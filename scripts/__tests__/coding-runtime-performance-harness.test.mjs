import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  codingPerformanceStartBody,
  readCodingPerformanceFirstEvent,
} from "../coding-runtime-performance-harness.mjs";

function reader(parts) {
  return {
    read: async () => {
      const part = parts.shift();
      return part === undefined ? { done: true } : { done: false, value: Buffer.from(part) };
    },
  };
}

function event() {
  return {
    schemaVersion: "1",
    kind: "status",
    runId: "run-perf",
    cursor: "cursor-perf",
    occurredAt: "2026-09-04T00:00:00.000Z",
    sequence: 1,
    state: "running",
    revision: 1,
  };
}

describe("native coding performance start request", () => {
  // The server refuses a start that does not state the repository it will run in.
  it("states the repository the fixture activated", () => {
    expect(codingPerformanceStartBody("/fixture/repository")).toMatchObject({
      expectedWorkspace: { root: "/fixture/repository" },
      requestedMode: "autonomous-delivery",
    });
  });
});

describe("native coding performance stream admission", () => {
  it("measures the first received byte while waiting for a complete valid frame", async () => {
    const frame = `event: status\ndata: ${JSON.stringify(event())}\n\n`;
    expect(
      await readCodingPerformanceFirstEvent(
        reader([frame.slice(0, 10), frame.slice(10)]),
        10,
        () => 15,
      ),
    ).toBe(5);
  });

  it.each([
    'event: reset\ndata: {"reason":"unknown-run"}\n\n',
    'event: status\ndata: {"prompt":"private"}\n\n',
    "event: status\ndata: malformed\n\n",
  ])("refuses an invalid or reset SSE stream", async (frame) => {
    await expect(readCodingPerformanceFirstEvent(reader([frame]), 10, () => 15)).rejects.toThrow();
  });

  // Every stream opens with the `: open` comment (U-23); the metric stays the time to first data.
  function timedReader(parts, clock) {
    const read = reader(parts);
    return {
      read: async () => {
        const part = await read.read();
        clock.now += 3;
        return part;
      },
    };
  }

  it("times the first event, not the open comment that precedes it", async () => {
    const frame = `event: status\ndata: ${JSON.stringify(event())}\n\n`;
    const clock = { now: 12 };
    await expect(
      readCodingPerformanceFirstEvent(
        timedReader([": open\n\n", frame], clock),
        10,
        () => clock.now,
      ),
    ).resolves.toBe(8);
    await expect(
      readCodingPerformanceFirstEvent(reader([`: open\n\n${frame}`]), 10, () => 15),
    ).resolves.toBe(5);
  });

  it("times an event split across chunks from the chunk that began it", async () => {
    const frame = `event: status\ndata: ${JSON.stringify(event())}\n\n`;
    const clock = { now: 12 };
    const parts = [`: open\n\n${frame.slice(0, 12)}`, frame.slice(12)];
    await expect(
      readCodingPerformanceFirstEvent(timedReader(parts, clock), 10, () => clock.now),
    ).resolves.toBe(5);
  });

  it("refuses a stream that only ever sends comments", async () => {
    await expect(
      readCodingPerformanceFirstEvent(reader([": open\n\n", ": keep\n\n"]), 10, () => 15),
    ).rejects.toThrow("fixture-sse-empty-or-incomplete");
    const endless = reader(Array.from({ length: 40 }, () => ": keep\n\n"));
    await expect(readCodingPerformanceFirstEvent(endless, 10, () => 15)).rejects.toThrow(
      "fixture-sse-no-event",
    );
  });

  it("refuses an empty or unbounded initial event", async () => {
    await expect(readCodingPerformanceFirstEvent(reader([]), 10, () => 15)).rejects.toThrow();
    await expect(
      readCodingPerformanceFirstEvent(reader(["x".repeat(65_537)]), 10, () => 15),
    ).rejects.toThrow();
  });
});
