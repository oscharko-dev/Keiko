// Bridges harness tool results to the #1387 command observation shaper. The run_command tool's
// summarizeCommand output is a JSON envelope (exit/signal/stdout/stderr/truncation); this port
// parses it back into a CommandResult and lets shapeCommandObservation build the structured,
// redacted observation (with optional overflow artifact persistence). Any non-command tool or
// unparsable payload yields undefined so the harness falls back to the raw output — shaping is
// an enhancement, never a gate.

import type { CommandResult } from "@oscharko-dev/keiko-contracts";
import type { HarnessShaperInput, HarnessShaperPort } from "@oscharko-dev/keiko-harness";
import type { ToolResultArtifactWriter } from "@oscharko-dev/keiko-workflows";
// GEN-PERF-CLI-001 — keiko-workflows loads when a shaper is actually constructed
// (dispatch time), not when the CLI barrel evaluates this module.
import { loadWorkflows } from "./lazy-modules.js";

const COMMAND_TOOL = "run_command";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asExitCode(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asOptionalNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// Recover a CommandResult from the summarizeCommand JSON (exitCode/signal/timedOut/truncated/
// stdout/stderr). Returns undefined when the output is not the expected JSON shape, so the port
// degrades to "no shape" rather than throwing.
function parseCommandResult(
  output: string,
  durationMs: number,
  omittedByteCount: number | undefined,
): CommandResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const record = parsed;
  if (!("stdout" in record) || !("stderr" in record)) {
    return undefined;
  }
  return {
    command: "",
    args: [],
    exitCode: asExitCode(record.exitCode),
    signal: typeof record.signal === "string" ? record.signal : null,
    stdout: asString(record.stdout),
    stderr: asString(record.stderr),
    durationMs,
    timedOut: asBoolean(record.timedOut),
    truncated: asBoolean(record.truncated),
    ...(omittedByteCount === undefined ? {} : { omittedByteCount }),
  };
}

export interface HarnessToolShaperOptions {
  readonly artifactWriter?: ToolResultArtifactWriter | undefined;
}

// The injected production shaper. Dispatches run_command results to the command shaper; every
// other tool type yields undefined (no shape). Async because it loads keiko-workflows on first
// construction (GEN-PERF-CLI-001) — the returned port itself stays synchronous.
export async function createHarnessToolShaper(
  options: HarnessToolShaperOptions = {},
): Promise<HarnessShaperPort> {
  const { shapeCommandObservation } = await loadWorkflows();
  return (input: HarnessShaperInput) => {
    if (input.toolName !== COMMAND_TOOL || input.result.metadata?.kind !== "command") {
      return undefined;
    }
    const command = parseCommandResult(
      input.result.output,
      input.result.durationMs,
      asOptionalNonNegativeNumber(input.result.metadata.omittedByteCount),
    );
    if (command === undefined) {
      return undefined;
    }
    return shapeCommandObservation(command, {
      observationId: input.toolCallId,
      ...(options.artifactWriter === undefined ? {} : { artifactWriter: options.artifactWriter }),
    });
  };
}
