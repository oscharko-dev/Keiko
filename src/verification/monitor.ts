// The ResourceMonitor seam and its Node adapter (ADR-0007 D3). The orchestrator wraps the injected
// SpawnFn and calls watch(pid, maxBytes, onBreach) on the spawned child; the returned function
// clears the interval. This is the swap point the container wave replaces with a cgroup sampler.
//
// nodeResourceMonitor reads /proc/<pid>/status VmRSS — a SYSTEM path, not workspace content — so
// it uses raw node:fs (read-only, bounded, no secrets), NOT WorkspaceFs. VmRSS is reported by the
// kernel directly in kB, making it page-size-independent (correct on aarch64 with 16/64 KiB pages).
// On non-Linux, or when maxBytes is undefined, watch is a documented no-op and the memory dimension
// is recorded enforced:false.

import { readFileSync } from "node:fs";

export interface ResourceMonitor {
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

export const nodeResourceMonitor: ResourceMonitor = {
  watch: (pid, maxBytes, onBreach): (() => void) => {
    if (process.platform !== "linux" || maxBytes === undefined || pid === undefined) {
      return NO_OP;
    }
    let fired = false;
    const timer = setInterval(() => {
      const rss = readRssBytes(pid);
      if (rss !== undefined && rss > maxBytes && !fired) {
        fired = true;
        onBreach();
      }
    }, SAMPLE_INTERVAL_MS);
    timer.unref();
    return (): void => {
      clearInterval(timer);
    };
  },
};
