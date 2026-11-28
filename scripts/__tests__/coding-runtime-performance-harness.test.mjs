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

  it("measures the first byte at the open comment and validates the first event after it", async () => {
    const frame = `event: status\ndata: ${JSON.stringify(event())}\n\n`;
    let clock = 12;
    const now = () => clock;
    const parts = [": open\n\n", frame];
    const read = reader(parts);
    const timed = {
      read: async () => {
        const part = await read.read();
        clock += 3;
        return part;
      },
    };
    await expect(readCodingPerformanceFirstEvent(timed, 10, now)).resolves.toBe(5);
    await expect(
      readCodingPerformanceFirstEvent(reader([`: open\n\n${frame}`]), 10, () => 15),
    ).resolves.toBe(5);
  });

  it("refuses a stream that only ever sends comments", async () => {
    await expect(
      readCodingPerformanceFirstEvent(reader([": open\n\n", ": keep\n\n"]), 10, () => 15),
    ).rejects.toThrow("fixture-sse-empty-or-incomplete");
  });

  it("refuses an empty or unbounded initial event", async () => {
    await expect(readCodingPerformanceFirstEvent(reader([]), 10, () => 15)).rejects.toThrow();
    await expect(
      readCodingPerformanceFirstEvent(reader(["x".repeat(65_537)]), 10, () => 15),
    ).rejects.toThrow();
  });
});
