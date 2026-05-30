// Hexagonal port interfaces. The harness (high-level policy) depends only on these
// abstractions, never on the concrete Gateway, file system, or terminal. Issues #6,
// #10, and #13 each plug in their own implementations without touching the harness.

import type { GatewayRequest, NormalizedResponse, ToolDefinition } from "../gateway/types.js";
import type { HarnessEvent, HarnessLimits, TaskInput, TaskType } from "./types.js";

export interface ModelPort {
  readonly call: (request: GatewayRequest, signal: AbortSignal) => Promise<NormalizedResponse>;
}

export interface ToolCallRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  // MUST be honoured: abort terminates any spawned subprocess (no zombie processes).
  readonly signal: AbortSignal;
}

// S-M1: a small, REDACTED audit struct a command/patch tool fills so the executor can emit a
// command:executed / patch:applied event for the issue #10 ledger. Counts/flags ONLY — never
// stdout, argument values, or file paths/contents.
export type ToolCallMetadata =
  | {
      readonly kind: "command";
      readonly executable: string;
      readonly argCount: number;
      readonly exitCode: number | null;
      readonly timedOut: boolean;
      readonly sandbox: {
        readonly envAllowlist: readonly string[];
        readonly network: "inherit" | "none";
        readonly maxOutputBytes: number;
        readonly timeoutMs: number;
        readonly terminationGraceMs: number;
        readonly cwdRequested: boolean;
      };
    }
  | {
      readonly kind: "patch-apply";
      readonly changedFiles: number;
      readonly created: number;
      readonly deleted: number;
    };

export interface ToolCallResult {
  readonly toolCallId: string;
  readonly output: string;
  readonly durationMs: number;
  // True only for tools that spawn a subprocess (run_command). The executor counts these
  // against maxCommandExecutions; absence/false leaves the command budget untouched (issue #6).
  readonly commandExecuted?: boolean | undefined;
  // S-M1: when present, the executor emits the matching redacted audit event in addition to
  // tool:call:completed. Absent for read-only tools.
  readonly metadata?: ToolCallMetadata | undefined;
}

export interface ToolPort {
  readonly execute: (request: ToolCallRequest) => Promise<ToolCallResult>;
  readonly listTools: () => readonly ToolDefinition[];
}

export interface EventSink {
  readonly emit: (event: HarnessEvent) => void;
  // When true, the harness emits SENSITIVE fields (rationale, modelResponse, diff) verbatim
  // because this sink retains them for replay (the in-memory test/manifest collector). For
  // any other sink the harness redacts SENSITIVE fields before emitting (ADR-0004 D6).
  readonly retainsRawContent?: boolean | undefined;
}

export interface IdSource {
  readonly newRunId: () => string;
}

export interface FingerprintInput {
  readonly taskType: TaskType;
  readonly taskInput: TaskInput;
  readonly limits: HarnessLimits;
  readonly modelId: string;
  readonly workingDirectory: string;
  readonly dryRun: boolean;
  readonly harnessVersion: string;
}

export interface Fingerprinter {
  readonly compute: (input: FingerprintInput) => string;
}
