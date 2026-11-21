import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { isUsearchWorkerData, type UsearchWorkerData } from "./usearch-worker-protocol.js";

const channels: MessageChannel[] = [];

afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});

function validData(): UsearchWorkerData {
  return {
    binaryPath: "/runtime/usearch.node",
    binarySha256: "a".repeat(64),
    expectedVersion: "2.26.0",
    dimensions: 4,
    rowCount: 2,
    connectivity: 16,
    expansionAdd: 128,
    expansionSearch: 64,
    controlBuffer: new SharedArrayBuffer(8),
    keysBuffer: new SharedArrayBuffer(8),
    vectorsBuffer: new SharedArrayBuffer(8),
    queryBuffer: new SharedArrayBuffer(8),
    resultKeysBuffer: new SharedArrayBuffer(8),
    resultDistancesBuffer: new SharedArrayBuffer(8),
  };
}

function scopePort(): MessageChannel["port1"] {
  const channel = new MessageChannel();
  channels.push(channel);
  return channel.port1;
}

describe("isUsearchWorkerData", () => {
  it("admits the startup data the index sends, with and without a process scope", () => {
    expect(isUsearchWorkerData(validData())).toBe(true);
    const processScope = { version: 1 as const, pid: 42, port: scopePort() };
    expect(isUsearchWorkerData({ ...validData(), processScope })).toBe(true);
  });

  it.each([
    ["a non-object", null],
    ["an empty binary path", { ...validData(), binaryPath: "" }],
    ["a numeric version", { ...validData(), expectedVersion: 2 }],
    ["a fractional dimension count", { ...validData(), dimensions: 1.5 }],
    ["a missing row count", { ...validData(), rowCount: undefined }],
    ["a plain ArrayBuffer", { ...validData(), queryBuffer: new ArrayBuffer(8) }],
    ["a process scope without a port", { ...validData(), processScope: { version: 1, pid: 1 } }],
    [
      "a process scope of another version",
      { ...validData(), processScope: { version: 2, pid: 1 } },
    ],
  ])("refuses %s", (_case, value) => {
    expect(isUsearchWorkerData(value)).toBe(false);
  });
});
