// ADR-0055 D4 (PR4-W3): the production HarnessShaperPort wired in keiko-cli dispatches run_command
// results to the pure keiko-workflows command shaper and degrades to undefined for everything else.
// Pure/total: malformed output and non-command tools never throw and yield no observation.

import { describe, expect, it } from "vitest";
import { validateContextToolObservation } from "@oscharko-dev/keiko-contracts";
import type { ToolCallResult } from "@oscharko-dev/keiko-harness";
import { harnessToolShaper } from "./tool-shaper.js";

const SANDBOX = {
  envAllowlist: ["PATH"],
  network: "inherit" as const,
  maxOutputBytes: 1_024,
  timeoutMs: 500,
  terminationGraceMs: 50,
  cwdRequested: false,
};

function commandResult(output: string, omittedByteCount?: number): ToolCallResult {
  return {
    toolCallId: "call-1",
    output,
    durationMs: 12,
    commandExecuted: true,
    metadata: {
      kind: "command",
      executable: "node",
      argCount: 0,
      exitCode: 0,
      timedOut: false,
      ...(omittedByteCount === undefined ? {} : { omittedByteCount }),
      sandbox: SANDBOX,
    },
  };
}

describe("harnessToolShaper", () => {
  it("shapes a run_command result into a valid command observation", () => {
    const output = JSON.stringify({
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: false,
      stdout: "hello",
      stderr: "",
    });
    const observation = harnessToolShaper({
      result: commandResult(output),
      toolName: "run_command",
      toolCallId: "call-1",
      arguments: {},
    });
    expect(observation?.kind).toBe("command");
    expect(observation?.observationId).toBe("call-1");
    expect(validateContextToolObservation(observation)).toEqual({ ok: true });
  });

  it("preserves omittedByteCount internally without adding it to the model-facing output JSON", () => {
    const output = JSON.stringify({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      truncated: true,
      stdout: "[TRUNCATED OUTPUT REDACTED]",
      stderr: "[TRUNCATED OUTPUT REDACTED]",
    });
    expect(output).not.toContain("omittedByteCount");

    const observation = harnessToolShaper({
      result: commandResult(output, 2048),
      toolName: "run_command",
      toolCallId: "call-1",
      arguments: {},
    });

    expect(observation?.kind).toBe("command");
    if (observation?.kind !== "command") {
      throw new Error("expected command observation");
    }
    expect(observation.omittedByteCount).toBe(2048);
    expect(validateContextToolObservation(observation)).toEqual({ ok: true });
  });

  it("returns undefined for a non-command tool", () => {
    const observation = harnessToolShaper({
      result: { toolCallId: "c", output: "{}", durationMs: 1 },
      toolName: "read_file",
      toolCallId: "c",
      arguments: {},
    });
    expect(observation).toBeUndefined();
  });

  it("returns undefined (never throws) for malformed command output", () => {
    const observation = harnessToolShaper({
      result: commandResult("not json"),
      toolName: "run_command",
      toolCallId: "call-1",
      arguments: {},
    });
    expect(observation).toBeUndefined();
  });

  it("returns undefined when the output JSON lacks stream fields", () => {
    const observation = harnessToolShaper({
      result: commandResult(JSON.stringify({ exitCode: 0 })),
      toolName: "run_command",
      toolCallId: "call-1",
      arguments: {},
    });
    expect(observation).toBeUndefined();
  });
});
