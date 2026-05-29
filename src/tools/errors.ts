// Tool error taxonomy, mirroring gateway/harness/workspace (ADR-0003/0004/0005/0006).
// Errors carry a stable `code` discriminant; callers switch on `code`, never parse `message`.
// Every message is redacted at construction so errors are always safe to log or surface.

import { redact } from "../gateway/redaction.js";
import type { PatchRejection } from "./types.js";

export const TOOL_CODES = {
  ARGUMENT: "TOOL_ARGUMENT",
  UNKNOWN: "TOOL_UNKNOWN",
  COMMAND_DENIED: "TOOL_COMMAND_DENIED",
  COMMAND_TIMEOUT: "TOOL_COMMAND_TIMEOUT",
  COMMAND_CANCELLED: "TOOL_COMMAND_CANCELLED",
  OUTPUT_LIMIT: "TOOL_OUTPUT_LIMIT",
  PATCH_INVALID: "TOOL_PATCH_INVALID",
  PATCH_APPLY_DISABLED: "TOOL_PATCH_APPLY_DISABLED",
  PATCH_APPLY_FAILED: "TOOL_PATCH_APPLY_FAILED",
} as const;

export type ToolCode = (typeof TOOL_CODES)[keyof typeof TOOL_CODES];

export abstract class ToolError extends Error {
  abstract readonly code: ToolCode;

  constructor(message: string, secrets: readonly string[] = []) {
    super(redact(message, secrets));
    this.name = new.target.name;
  }
}

// Malformed tool arguments (a required field missing or of the wrong type).
export class ToolArgumentError extends ToolError {
  readonly code = TOOL_CODES.ARGUMENT;
  readonly toolName: string;

  constructor(message: string, toolName: string, secrets: readonly string[] = []) {
    super(message, secrets);
    this.toolName = toolName;
  }
}

// No such tool in the host's dispatch map.
export class UnknownToolError extends ToolError {
  readonly code = TOOL_CODES.UNKNOWN;
  readonly toolName: string;

  constructor(message: string, toolName: string, secrets: readonly string[] = []) {
    super(message, secrets);
    this.toolName = toolName;
  }
}

// Executable or subcommand not on the allowlist (deny-by-default). Raised BEFORE any spawn.
export class CommandDeniedError extends ToolError {
  readonly code = TOOL_CODES.COMMAND_DENIED;
  readonly executable: string;

  constructor(message: string, executable: string, secrets: readonly string[] = []) {
    super(message, secrets);
    this.executable = executable;
  }
}

// The command exceeded its wall-time budget and was terminated.
export class CommandTimeoutError extends ToolError {
  readonly code = TOOL_CODES.COMMAND_TIMEOUT;
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number, secrets: readonly string[] = []) {
    super(message, secrets);
    this.timeoutMs = timeoutMs;
  }
}

// Abort-driven cancellation of a command or a patch apply.
export class CommandCancelledError extends ToolError {
  readonly code = TOOL_CODES.COMMAND_CANCELLED;
}

// A hard output-limit breach (used where truncate-and-flag is not acceptable, e.g. patch input).
export class OutputLimitError extends ToolError {
  readonly code = TOOL_CODES.OUTPUT_LIMIT;
  readonly limitBytes: number;

  constructor(message: string, limitBytes: number, secrets: readonly string[] = []) {
    super(message, secrets);
    this.limitBytes = limitBytes;
  }
}

// Patch validation failed; carries the structured rejection reasons. Nothing was written.
export class PatchValidationError extends ToolError {
  readonly code = TOOL_CODES.PATCH_INVALID;
  readonly reasons: readonly PatchRejection[];

  constructor(
    message: string,
    reasons: readonly PatchRejection[],
    secrets: readonly string[] = [],
  ) {
    super(message, secrets);
    this.reasons = reasons;
  }
}

// Fail-closed: apply requested while applyEnabled is false. Nothing was written.
export class PatchApplyDisabledError extends ToolError {
  readonly code = TOOL_CODES.PATCH_APPLY_DISABLED;
}

// A write (or rollback) failed during the apply phase at the filesystem boundary.
export class PatchApplyError extends ToolError {
  readonly code = TOOL_CODES.PATCH_APPLY_FAILED;
  readonly path: string;

  constructor(message: string, path: string, secrets: readonly string[] = []) {
    super(message, secrets);
    this.path = path;
  }
}
