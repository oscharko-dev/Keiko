// Builds the four-dimension appliedLimits record for a step (ADR-0007 D2), with HONEST `enforced`
// flags: wall-time and output-size are enforced by #6; memory is enforced only on Linux with a
// ceiling set; network egress is OS/container-enforced for a `network:"none"` run via keiko-sandbox
// (ADR-0043) and documented-not-enforced for an inherited-network run. `breached` is set only on the
// single dimension that actually fired for the step. Pure — no IO; the caller passes the run's
// network-enforcement attestation (default false preserves the inherited-network behaviour).

import type { ResourceLimitDecision, VerificationResourceLimits } from "./types.js";

// Which dimension (if any) tripped for this step, so exactly one row is marked breached:true.
export type BreachedDimension = "wall-time" | "output-size" | "memory" | undefined;

const NETWORK_OFF_NOTE =
  "documented; OS-level isolation deferred to the container wave (ADR-0006) for an inherited-network " +
  'run. A network:"none" run is OS/container-enforced via keiko-sandbox (ADR-0043).';
const NETWORK_ON_NOTE =
  'OS/container-enforced via keiko-sandbox for a network:"none" run (ADR-0043)';
const MEMORY_OFF_NOTE = "best-effort; Linux /proc sampler only — not enforced on this run";

function memoryEnforced(limits: VerificationResourceLimits): boolean {
  return process.platform === "linux" && limits.maxMemoryBytes !== undefined;
}

export function buildAppliedLimits(
  limits: VerificationResourceLimits,
  breached: BreachedDimension,
  networkEnforced = false,
): readonly ResourceLimitDecision[] {
  const memEnforced = memoryEnforced(limits);
  return [
    {
      dimension: "wall-time",
      limit: limits.wallTimeMs,
      enforced: true,
      breached: breached === "wall-time" ? true : undefined,
    },
    {
      dimension: "output-size",
      limit: limits.maxOutputBytes,
      enforced: true,
      breached: breached === "output-size" ? true : undefined,
    },
    {
      dimension: "memory",
      limit: limits.maxMemoryBytes ?? 0,
      enforced: memEnforced,
      note: memEnforced ? undefined : MEMORY_OFF_NOTE,
      breached: breached === "memory" ? true : undefined,
    },
    {
      dimension: "network",
      limit: limits.network,
      enforced: networkEnforced,
      note: networkEnforced ? NETWORK_ON_NOTE : NETWORK_OFF_NOTE,
      breached: undefined,
    },
  ];
}
