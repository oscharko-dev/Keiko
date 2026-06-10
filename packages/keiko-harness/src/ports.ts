// Hexagonal port interfaces. The harness (high-level policy) depends only on these
// abstractions, never on the concrete Gateway, file system, or terminal. Issues #6,
// #10, and #13 each plug in their own implementations without touching the harness.
//
// The tool ports (ToolPort, ToolCallRequest, ToolCallResult, ToolCallMetadata) are
// shared with the tools package via contracts. Re-export them here as part of the
// harness package surface.

import type {
  GatewayRequest,
  GatewayStreamChunk,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import type {
  ToolCallMetadata,
  ToolCallRequest,
  ToolCallResult,
  ToolPort,
} from "@oscharko-dev/keiko-contracts";
import type { HarnessEvent, HarnessLimits, TaskInput, TaskType } from "./types.js";

export type { ToolCallMetadata, ToolCallRequest, ToolCallResult, ToolPort };

export interface ModelPort {
  readonly call: (request: GatewayRequest, signal: AbortSignal) => Promise<NormalizedResponse>;
  // Optional streaming variant (#152). Present only on ports backed by a streaming-capable
  // gateway; absent on buffered-only ports. Yields content deltas then a terminal `done` chunk
  // carrying the redacted NormalizedResponse. Keeping it optional leaves every existing
  // ModelPort and its tests valid without a streaming implementation.
  readonly callStream?: (
    request: GatewayRequest,
    signal: AbortSignal,
  ) => AsyncIterable<GatewayStreamChunk>;
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
