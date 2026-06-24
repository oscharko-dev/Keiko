// Production HarnessShaperPort wiring (ADR-0055 D4, PR4-W3). keiko-cli already depends on BOTH
// keiko-harness (the port type) AND keiko-workflows (the pure shapers), so it is the correct tier
// to inject the shaper without adding a keiko-harness -> keiko-workflows package edge. The harness
// stays decoupled: it calls the injected port and attaches whatever observation it returns.
//
// The port is pure and total — it never throws and performs no IO. It shapes only `run_command`
// results (the only shapeable tool type the harness emits today); for every other tool it returns
// undefined, leaving the ToolCallResult untouched. The CommandResult is reconstructed from the
// summarizeCommand JSON that keiko-tools writes to ToolCallResult.output (the byte-identical
// model-facing string); the reconstruction is read-only and the model-facing output is unchanged.

import type { CommandResult } from "@oscharko-dev/keiko-contracts";
import type { HarnessShaperInput, HarnessShaperPort } from "@oscharko-dev/keiko-harness";
import { shapeCommandObservation } from "@oscharko-dev/keiko-workflows";

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

// The injected production shaper. Dispatches run_command results to the pure command shaper; every
// other tool type yields undefined (no shape).
export const harnessToolShaper: HarnessShaperPort = (input: HarnessShaperInput) => {
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
  return shapeCommandObservation(command, { observationId: input.toolCallId });
};
