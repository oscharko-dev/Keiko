import { describe, expect, it } from "vitest";
import {
  canonicalise,
  configFingerprint,
  counterIdSource,
  defaultFingerprinter,
} from "../../src/harness/fingerprint.js";
import { DEFAULT_LIMITS } from "../../src/harness/types.js";
import type { FingerprintInput } from "../../src/harness/ports.js";

function baseInput(): FingerprintInput {
  return {
    taskType: "explain-plan",
    taskInput: { taskType: "explain-plan", input: { filePath: "src/foo.ts" } },
    limits: DEFAULT_LIMITS,
    modelId: "model-a",
    workingDirectory: "/repo",
    dryRun: true,
    harnessVersion: "0.1.5",
  };
}

describe("configFingerprint", () => {
  it("produces the same fingerprint for the same input", () => {
    expect(configFingerprint(baseInput())).toBe(configFingerprint(baseInput()));
  });

  it("is a 64-character lowercase hex SHA-256 digest", () => {
    expect(configFingerprint(baseInput())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores key order in nested objects (canonical JSON sorts keys)", () => {
    const a = configFingerprint(baseInput());
    const reordered: FingerprintInput = {
      harnessVersion: "0.1.5",
      modelId: "model-a",
      workingDirectory: "/repo",
      dryRun: true,
      limits: DEFAULT_LIMITS,
      taskInput: { input: { filePath: "src/foo.ts" }, taskType: "explain-plan" },
      taskType: "explain-plan",
    };
    expect(configFingerprint(reordered)).toBe(a);
  });

  it("differs when modelId differs", () => {
    expect(configFingerprint({ ...baseInput(), modelId: "model-b" })).not.toBe(
      configFingerprint(baseInput()),
    );
  });

  it("differs when a single limit differs", () => {
    const tweaked: FingerprintInput = {
      ...baseInput(),
      limits: { ...DEFAULT_LIMITS, maxIterations: 11 },
    };
    expect(configFingerprint(tweaked)).not.toBe(configFingerprint(baseInput()));
  });

  it("differs when workingDirectory differs", () => {
    expect(configFingerprint({ ...baseInput(), workingDirectory: "/other-repo" })).not.toBe(
      configFingerprint(baseInput()),
    );
  });

  it("differs when dryRun differs", () => {
    expect(configFingerprint({ ...baseInput(), dryRun: false })).not.toBe(
      configFingerprint(baseInput()),
    );
  });
});

describe("canonicalise", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalise({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalise([3, 1, 2])).toBe("[3,1,2]");
  });

  it("serialises undefined-valued optional fields by omission via JSON semantics", () => {
    expect(canonicalise({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("defaultFingerprinter", () => {
  it("delegates to configFingerprint", () => {
    expect(defaultFingerprinter.compute(baseInput())).toBe(configFingerprint(baseInput()));
  });
});

describe("counterIdSource", () => {
  it("returns run-1 then run-2 on successive calls", () => {
    const ids = counterIdSource();
    expect(ids.newRunId()).toBe("run-1");
    expect(ids.newRunId()).toBe("run-2");
  });
});
