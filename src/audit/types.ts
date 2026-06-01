// All Evidence* interfaces, the retention/redaction config, the injectable deps, and the frozen
// EVIDENCE_SCHEMA_VERSION / DEFAULT_RETENTION tables (ADR-0010 D2/D6/D10). No runtime logic beyond
// the two frozen tables. Everything here is plain-JSON, deeply readonly, and JSON-serializable:
// timestamps are epoch-ms numbers sourced from events/RunResult, never Date objects.

import type { CostClass } from "../gateway/types.js";
import type {
  HarnessCode,
  HarnessStateName,
  RunManifest,
  RunOutcome,
  RunResult,
  TaskType,
} from "../harness/types.js";
import type { AuditSummary } from "../workspace/types.js";
import type { VerificationAuditSummary } from "../verification/summary.js";
import type { EvidenceStore } from "./store.js";

// The schema discriminant — distinct from the harness event `schemaVersion`. A breaking change
// produces "2" as a NEW union member rather than mutating "1" (ADR-0010 D2).
export const EVIDENCE_SCHEMA_VERSION = "1" as const;

// Run identity + configuration fingerprint + outcome.
export interface EvidenceRunIdentity {
  readonly runId: string;
  readonly fingerprint: string;
  readonly harnessVersion: string;
  readonly taskType: EvidenceTaskType;
  readonly outcome: RunOutcome;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
}

// Model metadata + cost class recovered from the gateway capability registry (D7).
export interface EvidenceModel {
  readonly modelId: string;
  readonly costClass: CostClass | "unknown";
}

// Per-run usage totals (pure fold over model:call:completed events — D7).
export interface EvidenceUsageTotals {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly requestCount: number;
  readonly totalLatencyMs: number;
}

// One harness state transition (from state:transition events). Counts/labels only.
export interface EvidenceStateTransition {
  readonly seq: number;
  readonly ts: number;
  readonly from: HarnessStateName;
  readonly to: HarnessStateName;
  readonly reason: string;
}

// One tool-call record (from tool:call:started/completed/failed). Metadata only — no output.
export interface EvidenceToolCall {
  readonly seq: number;
  readonly ts: number;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly outcome: "completed" | "failed";
  readonly durationMs?: number | undefined;
  readonly errorCode?: string | undefined;
}

// One command-execution record (from command:executed). Counts/flags only — no args, no stdout.
export interface EvidenceCommandExecution {
  readonly seq: number;
  readonly ts: number;
  readonly executable: string;
  readonly argCount: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

// One sandbox configuration snapshot (from sandbox:configured). Names/limits only — no env values,
// command args, output, or paths.
export interface EvidenceSandboxConfiguration {
  readonly seq: number;
  readonly ts: number;
  readonly envAllowlist: readonly string[];
  readonly network: "inherit" | "none";
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly terminationGraceMs: number;
  readonly cwdRequested: boolean;
}

// One harness verification result (from verification:result). The full #7 verification audit summary
// remains in `verification`; this compact event projection keeps the #4 harness structural
// verification visible even when no #7 report was supplied.
export interface EvidenceVerificationResult {
  readonly seq: number;
  readonly ts: number;
  readonly passed: boolean;
  readonly detail: string;
}

// Generated-patch metadata (from patch:proposed / patch:applied). Byte/file counts always; the
// diff itself ONLY under the includeDiff opt-in, and ALWAYS redacted (D2/D3).
export interface EvidencePatch {
  readonly proposed: boolean;
  readonly applied: boolean;
  readonly targetFileCount: number;
  readonly patchBytes: number;
  readonly changedFiles: number;
  readonly created: number;
  readonly deleted: number;
  readonly redactedDiff?: string | undefined;
}

// Optional reasoning trace (opt-in, default excluded — D8). Each entry redacted at build time.
export interface EvidenceReasoningEntry {
  readonly seq: number;
  readonly ts: number;
  readonly phase: HarnessStateName;
  readonly rationale: string;
  readonly modelResponse?: string | undefined;
}

export interface EvidenceFailure {
  readonly category: HarnessCode;
  readonly message: string;
}

export type EvidenceTaskType = TaskType | "browser-capture" | "terminal-execution";

export interface EvidenceBrowserViewportPx {
  readonly width: number;
  readonly height: number;
}

export type EvidenceBrowserEventType =
  | "browser:session-opened"
  | "browser:navigated"
  | "browser:screenshot-captured"
  | "browser:page-content-captured"
  | "browser:session-closed"
  | "browser:trust-warning"
  | "browser:error";

export interface EvidenceBrowserEvent {
  readonly schemaVersion: "1";
  readonly type: EvidenceBrowserEventType;
  readonly sessionId: string;
  readonly seq: number;
  readonly ts: number;
  readonly originOnly?: string | undefined;
  readonly httpStatus?: number | null | undefined;
  readonly captureSeq?: number | undefined;
  readonly persisted?: boolean | undefined;
  readonly viewportPx?: EvidenceBrowserViewportPx | undefined;
  readonly path?: string | undefined;
  readonly sha256?: string | undefined;
  readonly bytes?: number | undefined;
  readonly byteLength?: number | undefined;
  readonly reason?: string | undefined;
  readonly warning?: string | undefined;
  readonly code?: string | undefined;
  readonly message?: string | undefined;
}

export interface EvidenceBrowserScreenshot {
  readonly seq: number;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly capturedAt: number;
  readonly viewportPx: EvidenceBrowserViewportPx;
}

export interface EvidenceBrowserContentCapture {
  readonly seq: number;
  readonly byteLength: number;
  readonly capturedAt: number;
  readonly redactedHtml: string;
}

export interface EvidenceBrowserCapture {
  readonly sessionId: string;
  readonly cdpPort: number;
  readonly targetId: string;
  readonly status: "open" | "closed";
  readonly startedAt: number;
  readonly closedAt?: number | undefined;
  readonly closeReason?: string | undefined;
  readonly lastOriginOnly?: string | undefined;
  readonly events: readonly EvidenceBrowserEvent[];
  readonly screenshots?: readonly EvidenceBrowserScreenshot[] | undefined;
  readonly contentCaptures?: readonly EvidenceBrowserContentCapture[] | undefined;
}

export interface EvidenceManifest {
  readonly evidenceSchemaVersion: "1";
  readonly run: EvidenceRunIdentity;
  readonly model: EvidenceModel;
  readonly usageTotals: EvidenceUsageTotals;
  readonly context?: AuditSummary | undefined;
  readonly stateTransitions: readonly EvidenceStateTransition[];
  readonly toolCalls: readonly EvidenceToolCall[];
  readonly commandExecutions: readonly EvidenceCommandExecution[];
  readonly sandboxConfigurations?: readonly EvidenceSandboxConfiguration[] | undefined;
  readonly verificationResults?: readonly EvidenceVerificationResult[] | undefined;
  readonly patch?: EvidencePatch | undefined;
  readonly verification?: VerificationAuditSummary | undefined;
  readonly failure?: EvidenceFailure | undefined;
  readonly reasoning?: readonly EvidenceReasoningEntry[] | undefined;
  readonly browser?: EvidenceBrowserCapture | undefined;
}

// ─── Redaction config (D3) ──────────────────────────────────────────────────────

export interface AuditRedactionConfig {
  // Caller-supplied literal secrets, forwarded to gateway redact()'s additionalSecrets.
  readonly additionalSecrets?: readonly string[] | undefined;
  // Environment-VALUE redaction: the values (not names) of these env vars are scrubbed as literals.
  readonly redactEnvValues?: readonly string[] | undefined;
  // Configurable sensitive-output strings, scrubbed as LITERALS (escaped), never as raw regex.
  readonly sensitiveLiterals?: readonly string[] | undefined;
}

// ─── Retention policy (D6) ────────────────────────────────────────────────────────

export interface RetentionPolicy {
  readonly maxRuns?: number | undefined;
  readonly maxAgeMs?: number | undefined;
  readonly maxTotalBytes?: number | undefined;
  readonly disabled?: boolean | undefined;
}

export const DEFAULT_RETENTION: RetentionPolicy = { maxRuns: 50 } as const;

// ─── Build input + injectable deps (D10) ──────────────────────────────────────────

export interface BuildOptions {
  readonly includeReasoning?: boolean | undefined;
  readonly includeDiff?: boolean | undefined;
}

// The build input: a harness RunResult/RunManifest plus optional summaries from #5/#7. The result
// carries the raw event array (MemoryEventSink.retainsRawContent); the manifest contributes the
// run-identity fields RunResult lacks (harnessVersion, modelId). modelId also appears in run:started.
export interface EvidenceBuildInput {
  readonly result: RunResult;
  readonly manifest: RunManifest;
  readonly context?: AuditSummary | undefined;
  readonly verification?: VerificationAuditSummary | undefined;
  readonly redaction?: AuditRedactionConfig | undefined;
  readonly options?: BuildOptions | undefined;
}

// Injectable dependencies — the determinism seam (D10). No Date.now()/new Date() in src/audit/**.
export interface EvidenceDeps {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly store?: EvidenceStore | undefined;
  // Random suffix source for the atomic temp file (store), injectable for deterministic tests.
  readonly randomSuffix?: (() => string) | undefined;
  // Wall-clock seam, kept for parity with sibling workflow layers; unused unless a future report
  // field needs it. Bare function (matches #8/#9), not the harness Clock.
  readonly now?: (() => number) | undefined;
}
