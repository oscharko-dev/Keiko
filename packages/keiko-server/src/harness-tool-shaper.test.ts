import { describe, expect, it } from "vitest";
import { validateContextToolObservation } from "@oscharko-dev/keiko-contracts";
import type { HarnessShaperInput, ToolCallResult } from "@oscharko-dev/keiko-harness";
import { createServerHarnessToolShaper, serverHarnessToolShaper } from "./harness-tool-shaper.js";

function inputFor(
  result: ToolCallResult,
  toolName = "run_command",
): HarnessShaperInput {
  return {
    result,
    toolName,
    toolCallId: "tool-call-1",
    arguments: {},
  };
}

function commandResult(output: string): ToolCallResult {
  return {
    toolCallId: "tool-call-1",
    output,
    durationMs: 42,
    commandExecuted: true,
    metadata: {
      kind: "command",
      executable: "node",
      argCount: 0,
      exitCode: 1,
      timedOut: false,
      omittedByteCount: 123,
      sandbox: {
        envAllowlist: ["PATH"],
        network: "none",
        maxOutputBytes: 1024,
        timeoutMs: 500,
        terminationGraceMs: 50,
        cwdRequested: false,
      },
    },
  };
}

describe("serverHarnessToolShaper", () => {
  it("shapes run_command JSON output into a valid compact observation", () => {
    const observation = serverHarnessToolShaper(
      inputFor(
        commandResult(
          JSON.stringify({
            exitCode: 1,
            signal: null,
            stdout: "large output",
            stderr: "expected failure",
            timedOut: false,
            truncated: true,
          }),
        ),
      ),
    );

    expect(observation).toBeDefined();
    expect(validateContextToolObservation(observation).ok).toBe(true);
    expect(observation?.kind).toBe("command");
    expect(observation?.observationId).toBe("tool-call-1");
  });

  it("returns undefined for malformed or non-command tool results", () => {
    expect(serverHarnessToolShaper(inputFor(commandResult("not-json")))).toBeUndefined();
    expect(serverHarnessToolShaper(inputFor(commandResult("{}"), "read_file"))).toBeUndefined();
  });

  it("persists truncated command artifacts through an injected writer", () => {
    const artifacts = new Map<string, string>();
    const shaper = createServerHarnessToolShaper({
      artifactWriter: {
        write: (artifactId, content): void => {
          artifacts.set(artifactId, content);
        },
      },
    });
    const observation = shaper(
      inputFor(
        commandResult(
          JSON.stringify({
            exitCode: 1,
            signal: null,
            stdout: "full stdout",
            stderr: "full stderr",
            timedOut: false,
            truncated: true,
          }),
        ),
      ),
    );

    expect(observation?.kind).toBe("command");
    if (observation?.kind !== "command") {
      throw new Error("expected command observation");
    }
    expect(observation.rehydration?.notPersistedReason).toBeUndefined();
    expect(artifacts.get(observation.rehydration?.artifactId ?? "")).toContain("full stderr");
  });
});
