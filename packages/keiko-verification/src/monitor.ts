// The ResourceMonitor seam and its Node adapter (ADR-0007 D3). The orchestrator wraps the injected
// SpawnFn and calls watch(pid, maxBytes, onBreach) on the spawned child; the returned function
// clears the interval. This is the swap point the container wave replaces with a cgroup sampler.
//
// nodeResourceMonitor reads the complete Linux /proc process tree's VmRSS — SYSTEM paths, not
// workspace content — so it uses raw node:fs (read-only, bounded, no secrets), NOT WorkspaceFs.
// VmRSS is reported by the kernel directly in kB, making it page-size-independent (correct on
// aarch64 with 16/64 KiB pages). On hosts without this complete-tree sampler, a requested ceiling
// is refused by the orchestrator rather than reported as enforced.

import { existsSync, readFileSync } from "node:fs";

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

const SAMPLE_INTERVAL_MS = 250;

const NO_OP = (): void => {
  // Documented no-op: nothing to unwatch when monitoring is disabled or unavailable.
};

// Reads resident-set bytes from /proc/<pid>/status (VmRSS line). The kernel reports VmRSS
// directly in kB, so the result is page-size-independent. Returns undefined when the file is
// gone (process exited), when VmRSS is absent (zombie), or on any parse failure — so a transient
// read race or zombie process is never treated as a breach.
function readRssBytes(pid: number): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${String(pid)}/status`, "utf8");
  } catch {
    return undefined;
  }
  for (const line of raw.split("\n")) {
    if (line.startsWith("VmRSS:")) {
      const parts = line.split(/\s+/);
      // Expected format: "VmRSS:    1234 kB"  → parts = ["VmRSS:", "1234", "kB"]
      const kb = Number.parseInt(parts[1] ?? "", 10);
      if (!Number.isFinite(kb)) {
        return undefined;
      }
      return kb * 1_024;
    }
  }
  return undefined;
}

function childPids(pid: number): readonly number[] {
  try {
    return readFileSync(`/proc/${String(pid)}/task/${String(pid)}/children`, "utf8")
      .trim()
      .split(/\s+/u)
      .map(Number)
      .filter((value) => Number.isSafeInteger(value) && value > 0);
  } catch {
    // The process may have exited between samples. It no longer consumes RSS in this run.
    return [];
  }
}

function processTreePids(rootPid: number): readonly number[] {
  const seen = new Set<number>();
  const pending = [rootPid];
  const pids: number[] = [];
  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    pids.push(pid);
    pending.push(...childPids(pid));
  }
  return pids;
}

// Exported for the production-shaped descendant regression only. It never exposes process output,
// command lines, or paths; callers receive only an aggregate byte count.
export function readProcessTreeRssBytes(rootPid: number): number | undefined {
  let total = 0;
  for (const pid of processTreePids(rootPid)) {
    const rss = readRssBytes(pid);
    if (rss === undefined) continue;
    total += rss;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

function terminateProcessTree(rootPid: number): void {
  for (const pid of [...processTreePids(rootPid)].reverse()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // A raced process exit is already safe; never let cleanup mask the memory breach.
    }
  }
}

function canEnforceProcessTreeMemory(): boolean {
  return (
    process.platform === "linux" &&
    existsSync(`/proc/${String(process.pid)}/task/${String(process.pid)}/children`)
  );
}

export const nodeResourceMonitor: ResourceMonitor = {
  canEnforceProcessTreeMemory,
  watch: (pid, maxBytes, onBreach): (() => void) => {
    if (!canEnforceProcessTreeMemory() || maxBytes === undefined || pid === undefined) {
      return NO_OP;
    }
    let fired = false;
    const timer = setInterval(() => {
      const rss = readProcessTreeRssBytes(pid);
      if (rss !== undefined && rss > maxBytes && !fired) {
        fired = true;
        terminateProcessTree(pid);
        onBreach();
      }
    }, SAMPLE_INTERVAL_MS);
    timer.unref();
    return (): void => {
      clearInterval(timer);
    };
  },
};
