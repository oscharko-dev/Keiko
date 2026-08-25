// The ResourceMonitor seam and its Node adapter (ADR-0007 D3). The orchestrator wraps the injected
// SpawnFn and calls watch(pid, maxBytes, onBreach) on the spawned child; the returned function
// clears the interval. This is the swap point the container wave replaces with a cgroup sampler.
//
// nodeResourceMonitor reads the complete Linux /proc process tree's VmRSS — SYSTEM paths, not
// workspace content — so it uses raw node:fs (read-only, bounded, no secrets), NOT WorkspaceFs.
// VmRSS is reported by the kernel directly in kB, making it page-size-independent (correct on
// aarch64 with 16/64 KiB pages). On hosts without this complete-tree sampler, a requested ceiling
// is refused by the orchestrator rather than reported as enforced.

export interface ResourceMonitor {
  // True only when watch() can account for and terminate the complete spawned process tree.
  readonly canEnforceProcessTreeMemory: () => boolean;
  // Returns an unwatch function. A no-op watch returns a no-op unwatch.
  readonly watch: (
    pid: number | undefined,
    maxBytes: number | undefined,
    onBreach: () => void,
  ) => () => void;
}

const NO_OP = (): void => {
  // Documented no-op: nothing to unwatch when monitoring is disabled or unavailable.
};

// Live ancestry sampling cannot retain descendants after Linux reparents them. Until the
// verification runner owns a cgroup/container boundary, the only honest capability is unavailable.
function canEnforceProcessTreeMemory(): boolean {
  return false;
}

export function readProcessTreeRssBytes(_rootPid: number): number | undefined {
  return undefined;
}

export const nodeResourceMonitor: ResourceMonitor = {
  canEnforceProcessTreeMemory,
  watch: (_pid, _maxBytes, _onBreach): (() => void) => NO_OP,
};
