// Server-side HarnessShaperPort wiring. The harness package stays decoupled from workflows; the
// server already depends on workflows and evidence and is therefore the right tier to inject the
// command shaper plus optional tool-result artifact writer.

import type { CommandResult } from "@oscharko-dev/keiko-contracts";
import type { HarnessShaperInput, HarnessShaperPort } from "@oscharko-dev/keiko-harness";
import {
  shapeCommandObservation,
  type ToolResultArtifactWriter,
} from "@oscharko-dev/keiko-workflows";

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
  if (!isRecord(parsed) || !("stdout" in parsed) || !("stderr" in parsed)) {
    return undefined;
  }
  return {
    command: "",
    args: [],
    exitCode: asExitCode(parsed.exitCode),
    signal: typeof parsed.signal === "string" ? parsed.signal : null,
    stdout: asString(parsed.stdout),
    stderr: asString(parsed.stderr),
    durationMs,
    timedOut: asBoolean(parsed.timedOut),
    truncated: asBoolean(parsed.truncated),
    ...(omittedByteCount === undefined ? {} : { omittedByteCount }),
  };
}

export interface ServerHarnessToolShaperOptions {
  readonly artifactWriter?: ToolResultArtifactWriter | undefined;
}

export function createServerHarnessToolShaper(
  options: ServerHarnessToolShaperOptions = {},
): HarnessShaperPort {
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

export const serverHarnessToolShaper: HarnessShaperPort = createServerHarnessToolShaper();
