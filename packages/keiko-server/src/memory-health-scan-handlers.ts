// GET /api/memory/health-scan (Issue #2129) — on-demand, read-only structural health scan over the
// memory graph. Loads every memory (all scopes) + its edges from the vault, runs the PURE health-scan
// engine (@oscharko-dev/keiko-memory-governance), and returns the findings as the wire projection.
// Deliberately a separate route from POST /api/memory/maintenance (#204): this handler never mutates
// memory state or edges — it is advisory-only, exactly like the engine's own contract (AC5).
//
// CSRF is enforced for state-changing methods only by the server dispatch layer in server.ts — this
// is a GET, no per-handler check needed, mirroring handleMemoryReviewQueue.
//
// Every response is redacted through `deps.redactor` before serialisation to honour D9, defense in
// depth even though the wire shape already carries no raw memory body/tags/payload (AC6).
//
// Rate limiting (AC7 — security-triage follow-up): the per-call cost bound (maxRecordsPerScan /
// maxRecordsPerPartition in the pure engine) caps how expensive ONE scan can be, but not how OFTEN
// this route may be called. A cooldown closes that gap — mirrors the shape of
// editor/inlineCompletionRateLimiter.ts (per-key minInterval), simplified to a single global slot
// since this route has no per-workspace/per-root dimension: one vault, one scan. 5s is short enough
// that a human "run it again" click is never annoyingly blocked, long enough to absorb an accidental
// rapid re-trigger (double-click, a render-loop bug, a naive retry loop) without doing repeated
// full-vault O(n^2)-bounded work back to back.

import { randomUUID } from "node:crypto";
import { scanMemoryHealth } from "@oscharko-dev/keiko-memory-governance";
import type {
  MemoryEdge,
  MemoryHealthScanResultWire,
  MemoryId,
  MemoryRecord,
} from "@oscharko-dev/keiko-contracts";
import { MemoryStorageError, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";

export const HEALTH_SCAN_MIN_INTERVAL_MS = 5_000;

export interface HealthScanRateLimitState {
  lastRunAtMs?: number;
}

// Pure: due iff never run, or the cooldown has elapsed. Mirrors isMaintenanceDue's shape
// (memory-maintenance-handlers.ts) at a much shorter interval appropriate for an interactive,
// user-triggered read rather than a background maintenance cadence.
export function isHealthScanDue(
  lastRunAtMs: number | undefined,
  nowMs: number,
  minIntervalMs: number = HEALTH_SCAN_MIN_INTERVAL_MS,
): boolean {
  if (lastRunAtMs === undefined) return true;
  return nowMs - lastRunAtMs >= minIntervalMs;
}

// Module-scoped cursor, exported so tests can reset it between cases (no shared module-global
// singleton hidden from callers — same "explicit, testable" intent as AutoMaintenanceState).
export const healthScanRateLimitState: HealthScanRateLimitState = {};

function rateLimited(): RouteResult {
  return {
    status: 429,
    body: errorBody(
      "HEALTH_SCAN_RATE_LIMITED",
      "Health scan was run too recently; please wait before retrying.",
    ),
  };
}

function isRouteResult(value: unknown): value is RouteResult {
  return (
    typeof value === "object" && value !== null && typeof (value as RouteResult).status === "number"
  );
}

function resolveVault(deps: UiHandlerDeps): MemoryVaultStore | RouteResult {
  if (deps.memoryVault === undefined) {
    return {
      status: 503,
      body: errorBody("MEMORY_UNAVAILABLE", "Memory vault is not configured."),
    };
  }
  return deps.memoryVault;
}

interface HealthScanInputs {
  readonly records: readonly MemoryRecord[];
  readonly edgesByMemory: ReadonlyMap<MemoryId, readonly MemoryEdge[]>;
}

// Loads every memory across every scope (mirrors runMemoryMaintenance's load style) plus the edge
// map keyed by memory id, so the pure engine can reason about the whole graph in one pass.
function loadHealthScanInputs(vault: MemoryVaultStore): HealthScanInputs {
  const scopes = vault.listMemoryScopes();
  const records = vault.listMemoriesAcrossScopes(scopes, { includeExpired: true });
  const edgesByMemory = vault.listEdgesForMemories(records.map((record) => record.id));
  return { records, edgesByMemory };
}

function redactHealthScanResult(
  deps: UiHandlerDeps,
  result: MemoryHealthScanResultWire,
): MemoryHealthScanResultWire {
  return deps.redactor(result) as MemoryHealthScanResultWire;
}

export function handleGetMemoryHealthScan(_ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const nowMs = Date.now();
  if (!isHealthScanDue(healthScanRateLimitState.lastRunAtMs, nowMs)) return rateLimited();
  healthScanRateLimitState.lastRunAtMs = nowMs;

  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;

  try {
    const { records, edgesByMemory } = loadHealthScanInputs(vault);
    // HealthScanFinding (governance) and MemoryHealthScanFindingWire (contracts) are field-for-field
    // identical, so the pure result is structurally the wire shape — no mapping, no cast to `any`.
    const result: MemoryHealthScanResultWire = scanMemoryHealth(records, edgesByMemory, {
      nowMs,
      newFindingId: () => randomUUID(),
    });
    return { status: 200, body: redactHealthScanResult(deps, result) };
  } catch (err) {
    if (err instanceof MemoryStorageError) {
      return { status: 500, body: errorBody("MEMORY_ERROR", "Failed to run health scan.") };
    }
    throw err;
  }
}
