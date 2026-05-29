// The ResourceMonitor seam and its Node adapter (ADR-0007 D3). The orchestrator wraps the injected
// SpawnFn and calls watch(pid, maxBytes, onBreach) on the spawned child; the returned function
// clears the interval. This is the swap point the container wave replaces with a cgroup sampler.
//
// nodeResourceMonitor reads /proc/<pid>/statm — a SYSTEM path, not workspace content — so it uses
// raw node:fs (read-only, bounded, no secrets), NOT WorkspaceFs. On non-Linux, or when maxBytes is
// undefined, watch is a documented no-op and the memory dimension is recorded enforced:false.

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
const PAGE_SIZE_BYTES = 4_096; // Linux default; statm reports RSS in pages.

const NO_OP = (): void => {
  // Documented no-op: nothing to unwatch when monitoring is disabled or unavailable.
};

// Reads resident-set bytes from /proc/<pid>/statm (field 2 = resident pages). Returns undefined
// when the file is gone (process exited) or unreadable, so a transient read race is not a breach.
function readRssBytes(pid: number): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${String(pid)}/statm`, "utf8");
  } catch {
    return undefined;
  }
  const fields = raw.trim().split(" ");
  const residentPages = Number.parseInt(fields[1] ?? "", 10);
  if (!Number.isFinite(residentPages)) {
    return undefined;
  }
  return residentPages * PAGE_SIZE_BYTES;
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
