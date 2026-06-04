// UI-side SSE stream aggregation (issue #167). The BFF emits events from three orchestration
// layers (harness, unit-test workflow, bug-investigation workflow) plus a synthetic `ready`
// sentinel. EventSource's `event:` framing requires per-name listeners, so the canonical
// list of event names lives next to its sole consumer (useSSE.ts). No contracts package
// owns the aggregation because none of the orchestration packages know about the others.

import type { HarnessEvent as ContractsHarnessEvent } from "@oscharko-dev/keiko-contracts";
import type { WorkflowEvent } from "@oscharko-dev/keiko-contracts";
import type { BugInvestigationEvent } from "@oscharko-dev/keiko-contracts";

interface ReadySentinel {
  readonly schemaVersion: "1";
  readonly runId: string;
  readonly fingerprint: string;
  readonly seq: number;
  readonly ts: number;
  readonly type: "ready";
}

export type HarnessEvent =
  | ContractsHarnessEvent
  | WorkflowEvent
  | BugInvestigationEvent
  | ReadySentinel;

export type HarnessEventType = HarnessEvent["type"];

export const ALL_SSE_EVENT_TYPES: readonly HarnessEventType[] = [
  "run:started",
  "state:transition",
  "model:call:started",
  "model:call:completed",
  "model:call:failed",
  "tool:call:started",
  "tool:call:completed",
  "tool:call:failed",
  "reasoning:trace",
  "patch:proposed",
  "verification:result",
  "run:completed",
  "run:cancelled",
  "run:failed",
  "command:executed",
  "sandbox:configured",
  "patch:applied",
  "browser:session-opened",
  "browser:navigated",
  "browser:screenshot-captured",
  "browser:page-content-captured",
  "browser:session-closed",
  "browser:trust-warning",
  "browser:error",
  "workflow:started",
  "conventions:detected",
  "context:selected",
  "workflow:model:call:started",
  "workflow:model:call:completed",
  "patch:validated",
  "workflow:patch:applied",
  "workflow:verification:result",
  "workflow:completed",
  "workflow:failed",
  "bug:started",
  "bug:failure:parsed",
  "bug:context:selected",
  "bug:model:call:started",
  "bug:model:call:completed",
  "bug:rootcause:proposed",
  "bug:patch:validated",
  "bug:patch:applied",
  "bug:verification:result",
  "bug:completed",
  "bug:failed",
  "ready",
] as const;

export type TerminalEventType =
  | "run:completed"
  | "run:cancelled"
  | "run:failed"
  | "workflow:completed"
  | "workflow:failed"
  | "bug:completed"
  | "bug:failed";

export const TERMINAL_EVENT_TYPES = new Set<string>([
  "run:completed",
  "run:cancelled",
  "run:failed",
  "workflow:completed",
  "workflow:failed",
  "bug:completed",
  "bug:failed",
]);

export type SseStatus = "connecting" | "live" | "terminal" | "error";
