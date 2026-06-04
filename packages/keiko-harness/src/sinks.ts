// Event sinks. MemoryEventSink collects events in order for tests and for assembling
// the replay manifest (issue #10 persists it). CliEventSink renders a one-line summary
// per event for the CLI; it NEVER prints SENSITIVE fields verbatim (rationale,
// modelResponse, diff) — only safe metadata and byte counts (ADR-0004 D6).

import type { EventSink } from "./ports.js";
import type { HarnessEvent, RunManifest } from "./types.js";

// Structural IO surface (matches CliIo) so the harness has no dependency on the CLI layer.
export interface EventWriter {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

// The run-identity fields the manifest needs beyond the collected event array.
export interface ManifestSeed {
  readonly runId: string;
  readonly fingerprint: string;
  readonly harnessVersion: string;
  readonly taskType: RunManifest["taskType"];
  readonly taskInput: RunManifest["taskInput"];
  readonly limits: RunManifest["limits"];
  readonly modelId: string;
  readonly workingDirectory: string;
  readonly dryRun: boolean;
  readonly startedAt: string;
}

export class MemoryEventSink implements EventSink {
  // The in-memory collector retains SENSITIVE fields verbatim so the manifest is a faithful
  // replay record. The audit ledger (issue #10) applies its own redaction before persistence.
  readonly retainsRawContent = true;
  private readonly collected: HarnessEvent[] = [];

  emit(event: HarnessEvent): void {
    this.collected.push(event);
  }

  events(): readonly HarnessEvent[] {
    return this.collected;
  }

  collectManifest(seed: ManifestSeed): RunManifest {
    return { ...seed, events: this.collected };
  }
}

// Per-variant one-line summary. SENSITIVE fields (rationale, modelResponse, diff) are
// never included — only safe metadata and byte counts. The handler map keeps cyclomatic
// complexity bounded (one entry per event type, no growing switch).
const SUMMARISERS: {
  readonly [K in HarnessEvent["type"]]: (event: HarnessEvent & { type: K }) => string;
} = {
  "run:started": (e) => `task=${e.taskType} model=${e.modelId}`,
  "state:transition": (e) => `${e.from} -> ${e.to} (${e.reason})`,
  "model:call:started": (e) =>
    `model=${e.modelId} messages=${String(e.messageCount)} bytes=${String(e.contextBytes)}`,
  "model:call:completed": (e) =>
    `model=${e.modelId} finish=${e.finishReason} tools=${String(e.toolCallCount)}`,
  "model:call:failed": (e) => `model=${e.modelId} code=${e.errorCode}`,
  "tool:call:started": (e) => `tool=${e.toolName} id=${e.toolCallId}`,
  "tool:call:completed": (e) => `tool=${e.toolName} id=${e.toolCallId}`,
  "tool:call:failed": (e) => `tool=${e.toolName} code=${e.errorCode}`,
  "sandbox:configured": (e) =>
    `env=${e.envAllowlist.join(",")} network=${e.network} timeoutMs=${String(e.timeoutMs)} maxOutputBytes=${String(e.maxOutputBytes)} cwdRequested=${String(e.cwdRequested)}`,
  "command:executed": (e) =>
    `exec=${e.executable} args=${String(e.argCount)} exit=${String(e.exitCode)} timedOut=${String(e.timedOut)}`,
  "patch:applied": (e) =>
    `changed=${String(e.changedFiles)} created=${String(e.created)} deleted=${String(e.deleted)}`,
  "reasoning:trace": (e) => `phase=${e.phase} (rationale redacted)`,
  "patch:proposed": (e) => `file=${e.targetFile} bytes=${String(e.patchBytes)} (diff redacted)`,
  "verification:result": (e) => `passed=${String(e.passed)}`,
  "run:completed": () => "completed",
  "run:cancelled": (e) =>
    `cancelled at ${e.atState}${e.reason === undefined ? "" : ` (${e.reason})`}`,
  "run:failed": (e) => `${e.failure.category}: ${e.failure.message}`,
  // ADR-0017 — browser-tool events. originOnly is the scheme+authority only; never a path/query.
  "browser:session-opened": (e) =>
    `session=${e.sessionId} port=${String(e.cdpPort)} target=${e.targetId}`,
  "browser:navigated": (e) =>
    `session=${e.sessionId} origin=${e.originOnly} status=${String(e.httpStatus)}`,
  "browser:screenshot-captured": (e) =>
    `session=${e.sessionId} seq=${String(e.captureSeq)} persisted=${String(e.persisted)}`,
  "browser:page-content-captured": (e) =>
    `session=${e.sessionId} seq=${String(e.captureSeq)} bytes=${String(e.byteLength)}`,
  "browser:session-closed": (e) => `session=${e.sessionId} reason=${e.reason}`,
  "browser:trust-warning": (e) => `session=${e.sessionId} warning=${e.warning}`,
  "browser:error": (e) => `session=${e.sessionId} code=${e.code}`,
};

function summarise(event: HarnessEvent): string {
  const handler = SUMMARISERS[event.type] as (event: HarnessEvent) => string;
  return handler(event);
}

function isFailureEvent(event: HarnessEvent): boolean {
  return (
    event.type === "run:failed" ||
    event.type === "model:call:failed" ||
    event.type === "tool:call:failed"
  );
}

export class CliEventSink implements EventSink {
  constructor(private readonly io: EventWriter) {}

  emit(event: HarnessEvent): void {
    const line = `[${String(event.seq)}] ${event.type} ${summarise(event)}\n`;
    if (isFailureEvent(event)) {
      this.io.err(line);
      return;
    }
    this.io.out(line);
  }
}
