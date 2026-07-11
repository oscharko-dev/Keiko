// Governed LSP process-manager contracts (Issue #1381, Epic #1491, ADR-0069). These are the
// status, configuration, error-code, and lifecycle-event shapes that cross the contracts boundary
// for the long-lived, supervised language-server process layer (ADR-0069 D1/D5). The process
// manager itself is a keiko-server module; this leaf owns only the wire-stable vocabulary it shares
// with the status route and the language-provider registry.
//
// Content-free by construction (ADR-0069 D6): `LspLifecycleEvent` has no field that could carry
// source text, request/response bodies, raw stderr, LSP method names, or workspace paths. Every
// string field is a member of a closed enum or an opaque id; only enums, ids, counts, and
// timestamps are present. A reviewer confirms content-freedom by reading the type, not every call
// site.
//
// Leaf-package rules (ADR-0019 D1): pure types and frozen const tables plus throw-free pure
// functions only. No filesystem, no clock, no crypto, no randomness, and no imports of other
// `@oscharko-dev/keiko-*` packages. Sibling imports within this same package are permitted, so the
// status descriptor mapping reuses the language-service provider vocabulary directly.

import type { LanguageProviderDescriptor, LanguageServiceOperation } from "./language-service.js";
import type { ManagedLspLanguage } from "./managed-lsp-activation.js";

// Schema version for the lifecycle-event envelope. Bump as a new string member when the shape
// changes incompatibly; consumers pin against the literal to detect skew.
export const LSP_PROCESS_SCHEMA_VERSION = "1" as const;

// Stable, content-free error codes the manager and the status route rely on to drive recovery. They
// name a failure class, never a cause string: no stack traces, no server output, no paths.
export type LspProcessErrorCode =
  | "EXECUTABLE_NOT_FOUND"
  | "SPAWN_FAILED"
  | "INITIALIZE_FAILED"
  | "INITIALIZE_TIMEOUT"
  | "REQUEST_TIMED_OUT"
  | "RESPONSE_TOO_LARGE"
  | "RESOURCE_BUDGET_EXCEEDED"
  | "RUNTIME_STATE_CLEANUP_FAILED"
  | "CRASHED"
  | "RESTART_THROTTLED"
  | "SHUTDOWN_TIMEOUT"
  | "CANCELLED"
  | "DISPOSED";

// The live lifecycle status of a managed process. `READY` is the only status that maps to an
// available provider; every other status is a content-free unavailability label (ADR-0069 D5).
export type LspProcessStatus =
  | "STARTING"
  | "INITIALIZING"
  | "READY"
  | "CRASHED"
  | "RESTART_THROTTLED"
  | "INITIALIZE_TIMEOUT"
  | "SHUTDOWN"
  | "DISPOSED"
  | "EXECUTABLE_NOT_FOUND"
  | "SPAWN_FAILED";

// Reason a base-protocol frame was rejected at the reader boundary (ADR-0069 D3/I3). The oversized
// case is rejected before the body is ever read into memory.
export type LspFrameRejectReason = "RESPONSE_TOO_LARGE" | "MALFORMED_HEADER";

// The governed network posture for a managed process (ADR-0069 I1). `inherit` keeps the env
// allowlist only; `none` is the enforced-egress wrapping a future per-language (Java/Rust) security
// review must provide. This issue plumbs the field but never wires `none`.
export type LspNetworkPolicy = "inherit" | "none";

// Operator-supplied configuration for one managed process. All bounds are explicit milliseconds /
// byte counts so a misbehaving server cannot exhaust the host; `envAllowlist` is the copy-only env
// allowlist handed to `buildSandboxEnv`. `managerId` is an opaque, hash-derived id (ADR-0069 D6).
export interface LspProcessConfig {
  readonly managerId: string;
  readonly executableName: string;
  readonly executableArgs?: readonly string[];
  readonly initializeTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly maxFrameBytes: number;
  readonly restartWindowMs: number;
  readonly maxRestartsInWindow: number;
  readonly envAllowlist: readonly string[];
  readonly networkPolicy?: LspNetworkPolicy;
}

// A single content-free lifecycle attestation (ADR-0069 I4/D6). `stderrBytesSeen` is a count of
// drained child-stderr bytes — the bytes themselves are never stored. There is no field that could
// carry source text, request/response bodies, raw stderr, method names, or workspace paths.
export interface LspLifecycleEvent {
  readonly schemaVersion: typeof LSP_PROCESS_SCHEMA_VERSION;
  readonly managerId: string;
  readonly status: LspProcessStatus;
  readonly errorCode?: LspProcessErrorCode;
  readonly timestampMs: number;
  readonly pendingRequestCount: number;
  readonly restartCount: number;
  readonly stderrBytesSeen: number;
}

export interface LspLatencyHistogram {
  readonly count: number;
  readonly totalMs: number;
  readonly maximumMs: number;
  readonly lessThanOrEqual10Ms: number;
  readonly lessThanOrEqual50Ms: number;
  readonly lessThanOrEqual250Ms: number;
  readonly lessThanOrEqual1Second: number;
  readonly greaterThan1Second: number;
}

export interface ManagedLspProcessHealthSnapshot {
  readonly schemaVersion: typeof LSP_PROCESS_SCHEMA_VERSION;
  readonly managerId: string;
  readonly language: ManagedLspLanguage;
  readonly status: LspProcessStatus;
  readonly restartCount: number;
  readonly configurationRevision: number;
  readonly negotiatedOperations: readonly LanguageServiceOperation[];
  readonly lastTransitionTimestampMs: number;
  readonly pendingRequestCount: number;
  readonly requestCount: number;
  readonly successCount: number;
  readonly timeoutCount: number;
  readonly cancellationCount: number;
  readonly failureCount: number;
  readonly latency: LspLatencyHistogram;
}

export const LSP_PROCESS_ERROR_CODES: readonly LspProcessErrorCode[] = Object.freeze([
  "EXECUTABLE_NOT_FOUND",
  "SPAWN_FAILED",
  "INITIALIZE_FAILED",
  "INITIALIZE_TIMEOUT",
  "REQUEST_TIMED_OUT",
  "RESPONSE_TOO_LARGE",
  "RESOURCE_BUDGET_EXCEEDED",
  "RUNTIME_STATE_CLEANUP_FAILED",
  "CRASHED",
  "RESTART_THROTTLED",
  "SHUTDOWN_TIMEOUT",
  "CANCELLED",
  "DISPOSED",
] as const satisfies readonly LspProcessErrorCode[]);

export const LSP_PROCESS_STATUSES: readonly LspProcessStatus[] = Object.freeze([
  "STARTING",
  "INITIALIZING",
  "READY",
  "CRASHED",
  "RESTART_THROTTLED",
  "INITIALIZE_TIMEOUT",
  "SHUTDOWN",
  "DISPOSED",
  "EXECUTABLE_NOT_FOUND",
  "SPAWN_FAILED",
] as const satisfies readonly LspProcessStatus[]);

// Operator-overridable defaults for every config field except the per-process identity
// (`managerId`, `executableName`). `requestTimeoutMs` equals the language-service deadline
// (DEFAULT_LANGUAGE_SERVICE_LIMITS.deadlineMs, 2 000 ms) by design. Deeply frozen so a consumer
// cannot mutate the shared default through the `envAllowlist` array reference.
export const DEFAULT_LSP_PROCESS_CONFIG: Readonly<
  Omit<LspProcessConfig, "managerId" | "executableName">
> = Object.freeze({
  initializeTimeoutMs: 10_000,
  requestTimeoutMs: 2_000,
  shutdownTimeoutMs: 5_000,
  maxFrameBytes: 4_194_304,
  restartWindowMs: 60_000,
  maxRestartsInWindow: 5,
  envAllowlist: Object.freeze(["PATH", "HOME", "USERPROFILE", "LANG", "LC_ALL"]),
  networkPolicy: "inherit",
} as const satisfies Readonly<Omit<LspProcessConfig, "managerId" | "executableName">>);

// True for the statuses from which the manager does not recover on its own: a disposed manager is
// inert; a missing/unspawnable executable is a configuration fault; a throttled manager has
// exhausted its restart window and stays down (ADR-0069 D4). Fail-closed: an unrecognised status
// returns false (non-terminal), so a stale caller never treats an unknown state as a dead end.
export function isTerminalLspStatus(status: LspProcessStatus): boolean {
  return (
    status === "DISPOSED" ||
    status === "EXECUTABLE_NOT_FOUND" ||
    status === "SPAWN_FAILED" ||
    status === "RESTART_THROTTLED"
  );
}

// Maps a live process status onto a `LanguageProviderDescriptor` (ADR-0069 D5). `READY` is the only
// available status; every other status yields `unavailable` with a content-free reason derived
// solely from the status enum name (no source text, no paths, no stack traces). Pure and total: the
// same inputs always produce the same descriptor.
export function lspStatusToProviderDescriptor(
  managerId: string,
  languages: readonly string[],
  operations: readonly LanguageServiceOperation[],
  status: LspProcessStatus,
): LanguageProviderDescriptor {
  if (status === "READY") {
    return { id: managerId, languages, operations, availability: "available" };
  }
  return {
    id: managerId,
    languages,
    operations,
    availability: "unavailable",
    unavailableReason: status,
  };
}

// Header lines arrive split from the raw byte stream, so leading/trailing ASCII whitespace and a
// possible trailing CR are tolerated. Per LSP base protocol the value is a non-negative decimal
// integer byte count; a zero-length frame (`Content-Length: 0`) is valid.
const CONTENT_LENGTH_HEADER = /^content-length:\s*(\d+)\s*$/i;

// Parses a single `Content-Length: N` header line into its declared byte count. Fail-closed: any
// malformed, empty, whitespace-only, fractional, signed, or non-`Content-Length` line returns
// `null` rather than throwing, so the frame reader rejects it deterministically (MALFORMED_HEADER).
export function parseLspFrameHeader(line: string): { contentLength: number } | null {
  const match = CONTENT_LENGTH_HEADER.exec(line);
  // The capture group `(\d+)` is non-optional, so on a match `[, digits]` is always a string;
  // defaulting to "" keeps the narrowing sound under noUncheckedIndexedAccess without an
  // untestable branch (Number.parseInt("") is NaN, which the safe-integer guard already rejects).
  const [, digits = ""] = match ?? [];
  const contentLength = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    return null;
  }
  return { contentLength };
}
