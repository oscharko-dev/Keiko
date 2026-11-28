// When the Git window re-reads the selected repository's status: Keiko's own repository-state
// invalidation, a workspace file mutation (an Editor save, or a Coding run's changes read with
// `agent` provenance, #4103 F3), or the page regaining focus after a change made outside Keiko's
// windows, as the Files window does. The events name roots; only the selected repository or its
// canonical repository root refreshes this window.
//
// U-35 (#4491): a change made by an IDE, a terminal or another Git client announces itself to no
// event, and an in-app window gaining focus fires no `window` focus. The window therefore also
// re-reads, debounced, when it gains focus or its document becomes visible, and while the document
// is visible a backed-off probe reads the status and re-reads the window only when it differs, so
// the commit evidence and diff are not invalidated by an unchanged repository. A hidden document is
// never polled, probes never overlap, and a status read already in flight defers the tick.
//
// PERF-5 (#4491): every trigger above funnels into ONE coalescer. A trigger that arrives while a
// read cycle is still running, or right after the previous refresh was dispatched, marks a single
// trailing refresh instead of starting another cycle, so one restore, focus or invalidation costs
// one refresh however many listeners fire for it, and a feedback loop cannot run faster than one
// cycle per coalescing window.

import { type RefObject, useEffect, useRef, useState } from "react";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { bffRequestErrorKind } from "@/lib/http";
import type { GitRepositoryStatusResponse } from "@/lib/types";
import {
  GIT_REPOSITORY_STATE_INVALIDATED_EVENT,
  gitRepositoryStateInvalidationRoots,
} from "../git-repository-state-events";
import { WORKSPACE_FILE_MUTATED_EVENT, workspaceFileMutationRoots } from "../workspace-file-events";

// A status read spawns about ten Git processes: never faster than every 10 s, doubling while the
// repository stays unchanged up to a minute.
export const AMBIENT_BASE_INTERVAL_MS = 10_000;
export const AMBIENT_MAX_INTERVAL_MS = 60_000;
export const AMBIENT_FOCUS_DEBOUNCE_MS = 250;
// A check asked for by focus that finds a read or mutation running is retried this soon.
export const AMBIENT_BUSY_RETRY_MS = 500;
// A probe that has not answered by then is a failed one (U-45): a read that never settles must not
// hold the loop's single in-flight slot forever. A status read answers in well under a second.
export const AMBIENT_PROBE_TIMEOUT_MS = 30_000;
// Triggers closer together than this share one refresh; a trailing one covers the later trigger.
export const REFRESH_COALESCE_MS = 300;

export interface AmbientRefresh {
  // Reads the status and reports whether it differs from what the window shows.
  readonly probe: () => Promise<boolean>;
  // True while a status read is already running; the tick is skipped, never queued.
  readonly isBusy: () => boolean;
  // Drops the status the probe kept for its own refresh: a refresh that another trigger shares
  // must read again, because that trigger may follow a change the probe's read predates.
  readonly discardProbed?: () => void;
  // True while the window is not rendered (minimized, or under a hidden ancestor) although the
  // document itself is visible; nothing is probed then.
  readonly isPaused?: () => boolean;
  // Restoring a minimized window fires neither focus nor visibilitychange: the window announces
  // that it is rendered again, and the hook checks at once. Returns its teardown.
  readonly watchRendered?: (onRendered: () => void) => () => void;
}

export function statusFingerprintDiffers(
  shown: GitRepositoryStatusResponse | null,
  fresh: GitRepositoryStatusResponse,
): boolean {
  return shown !== null && JSON.stringify(shown) !== JSON.stringify(fresh);
}

type RootsOfEvent = (event: Event) => readonly string[];

const REPOSITORY_ROOT_EVENTS: readonly (readonly [string, RootsOfEvent])[] = [
  [GIT_REPOSITORY_STATE_INVALIDATED_EVENT, gitRepositoryStateInvalidationRoots],
  [WORKSPACE_FILE_MUTATED_EVENT, workspaceFileMutationRoots],
];

// One refresh per burst of triggers. The first trigger of a quiet window refreshes at once; any
// trigger during the coalescing window (which covers a read still in flight) queues exactly one
// trailing refresh when the window has elapsed. A refresh supersedes a read in flight, so a hung
// read can never hold a later refresh back.
class RefreshCoalescer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastDispatchAt = Number.NEGATIVE_INFINITY;
  private coalesced = 0;
  private probeOnly = true;

  constructor(
    private readonly refreshRef: RefObject<() => void>,
    private readonly ambientRef: RefObject<AmbientRefresh | undefined>,
  ) {}

  trigger(fromProbe = false): void {
    if (!fromProbe) this.probeOnly = false;
    if (this.timer !== undefined) {
      this.coalesced += 1;
      return;
    }
    const wait = this.waitMs();
    if (wait === 0) this.dispatch();
    else {
      this.coalesced += 1;
      this.arm(wait);
    }
  }

  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.coalesced = 0;
    this.probeOnly = true;
  }

  private waitMs(): number {
    return Math.max(0, this.lastDispatchAt + REFRESH_COALESCE_MS - Date.now());
  }

  private arm(wait: number): void {
    this.timer = setTimeout((): void => {
      this.timer = undefined;
      const remaining = this.waitMs();
      if (remaining === 0) this.dispatch();
      else this.arm(remaining);
    }, wait);
  }

  private dispatch(): void {
    if (this.coalesced > 0) {
      reportClientDiagnostic("git-client: status refresh triggers coalesced", { kind: "other" });
    }
    this.coalesced = 0;
    if (!this.probeOnly) this.ambientRef.current?.discardProbed?.();
    this.probeOnly = true;
    this.lastDispatchAt = Date.now();
    this.refreshRef.current();
  }
}

export function useRepositoryStatusRefresh(
  selectedPath: string | null,
  repositoryRoot: string | null | undefined,
  refresh: () => void,
  ambient?: AmbientRefresh,
): void {
  const ambientRef = useRef(ambient);
  const refreshRef = useRef(refresh);
  useEffect((): void => {
    ambientRef.current = ambient;
    refreshRef.current = refresh;
  }, [ambient, refresh]);
  const [coalescer] = useState(
    (): RefreshCoalescer => new RefreshCoalescer(refreshRef, ambientRef),
  );
  useEffect((): (() => void) => (): void => coalescer.cancel(), [coalescer, selectedPath]);

  useEffect((): (() => void) => {
    const canonicalRoot = repositoryRoot ?? null;
    const namesThisRepository = (roots: readonly string[]): boolean =>
      roots.some(
        (root): boolean =>
          root === selectedPath || (canonicalRoot !== null && root === canonicalRoot),
      );
    const listeners = REPOSITORY_ROOT_EVENTS.map(
      ([name, rootsOf]): readonly [string, (event: Event) => void] => {
        const listener = (event: Event): void => {
          if (namesThisRepository(rootsOf(event))) coalescer.trigger();
        };
        window.addEventListener(name, listener);
        return [name, listener] as const;
      },
    );
    return (): void => {
      for (const [name, listener] of listeners) window.removeEventListener(name, listener);
    };
  }, [coalescer, repositoryRoot, selectedPath]);

  useEffect((): (() => void) | undefined => {
    if (selectedPath === null) return undefined;
    return watchRepositoryFromOutside(coalescer, ambientRef);
  }, [coalescer, selectedPath]);
}

/**
 * A window that only re-reads when the page regains focus or its document becomes visible, with no
 * ambient probe (U-39, #4491): the Coding Workbench's branch chip re-reads the checkout this way, so
 * a branch changed in a terminal while the window was away shows on return, not after a refused
 * start. It reuses the Git window's debounced focus and visibility watcher.
 */
export function useRefreshOnWindowReturn(selectedPath: string | null, refresh: () => void): void {
  const refreshRef = useRef(refresh);
  const ambientRef = useRef<AmbientRefresh | undefined>(undefined);
  useEffect((): void => {
    refreshRef.current = refresh;
  }, [refresh]);
  // The same one-trigger-one-refresh funnel as the Git window (PERF-5): a focus burst costs one read.
  const [coalescer] = useState(
    (): RefreshCoalescer => new RefreshCoalescer(refreshRef, ambientRef),
  );
  useEffect((): (() => void) => (): void => coalescer.cancel(), [coalescer, selectedPath]);
  useEffect((): (() => void) | undefined => {
    if (selectedPath === null) return undefined;
    return watchRepositoryFromOutside(coalescer, ambientRef);
  }, [coalescer, selectedPath]);
}

function documentVisible(): boolean {
  return document.visibilityState === "visible";
}

function reportProbeFailure(error: unknown): void {
  reportClientDiagnostic("git-client: ambient status check failed", {
    kind: "other",
    errorKind: bffRequestErrorKind(error),
    errorEvidence: clientErrorEvidence(error),
  });
}

// The probe's own read carries no deadline of its own on every transport, so the loop bounds it: a
// late answer is ignored, the failure takes the ordinary failure path.
function boundedProbe(probe: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DOMException("The ambient status check did not answer in time.", "TimeoutError"));
    }, AMBIENT_PROBE_TIMEOUT_MS);
  });
  return Promise.race([probe, expired]).finally((): void => {
    clearTimeout(timer);
  });
}

// The visible-only, non-overlapping, backed-off probe: it re-reads only when the status differs.
// Focus and visibility use the same comparison, so an unchanged repository never invalidates the
// commit evidence or the diff.
class ProbeLoop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private delay = AMBIENT_BASE_INTERVAL_MS;
  private inFlight = false;
  private pending = false;
  private failureReported = false;
  private disposed = false;

  constructor(
    private readonly coalescer: RefreshCoalescer,
    private readonly ambientRef: RefObject<AmbientRefresh | undefined>,
  ) {}

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  schedule(): void {
    this.stop();
    if (this.disposed || !documentVisible()) return;
    this.timer = setTimeout(() => this.tick(), this.pending ? AMBIENT_BUSY_RETRY_MS : this.delay);
  }

  // Focus or visibility: restart the backoff and check now; a check that finds the window busy is
  // retried until the read or mutation has settled.
  requestCheck(): void {
    this.delay = AMBIENT_BASE_INTERVAL_MS;
    this.pending = true;
    this.stop();
    this.tick();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  private backOff(): void {
    this.delay = Math.min(this.delay * 2, AMBIENT_MAX_INTERVAL_MS);
  }

  private settle(changed: boolean): void {
    if (this.disposed) return;
    this.failureReported = false;
    if (!changed) {
      // A "no difference" answered while a read or mutation started meanwhile is not an answer:
      // check again once the window is quiet instead of backing off.
      if (this.ambientRef.current?.isBusy() === true) this.pending = true;
      else this.backOff();
      return;
    }
    this.delay = AMBIENT_BASE_INTERVAL_MS;
    this.coalescer.trigger(true);
  }

  private fail(error: unknown): void {
    if (this.disposed) return;
    this.backOff();
    if (!this.failureReported) reportProbeFailure(error);
    this.failureReported = true;
  }

  private tick(): void {
    this.timer = undefined;
    const ambient = this.ambientRef.current;
    if (this.disposed || ambient === undefined) return;
    if (ambient.isPaused?.() === true) {
      this.pending = false;
      this.schedule();
      return;
    }
    if (this.inFlight || ambient.isBusy()) {
      this.schedule();
      return;
    }
    this.pending = false;
    this.inFlight = true;
    boundedProbe(ambient.probe())
      .then(
        (changed) => this.settle(changed),
        (error: unknown) => this.fail(error),
      )
      .finally((): void => {
        this.inFlight = false;
        this.schedule();
      });
  }
}

// Focus and visibility re-reads (debounced) plus the probe loop. Returns its teardown.
function watchRepositoryFromOutside(
  coalescer: RefreshCoalescer,
  ambientRef: RefObject<AmbientRefresh | undefined>,
): () => void {
  const loop = new ProbeLoop(coalescer, ambientRef);
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const checkSoon = (): void => {
    if (debounce !== undefined) clearTimeout(debounce);
    debounce = setTimeout((): void => {
      debounce = undefined;
      if (!documentVisible()) return;
      // Without a probe the window can only re-read.
      if (ambientRef.current === undefined) coalescer.trigger();
      else loop.requestCheck();
    }, AMBIENT_FOCUS_DEBOUNCE_MS);
  };
  const onVisibility = (): void => {
    if (documentVisible()) checkSoon();
    else loop.stop();
  };
  const stopWatchingRendered = ambientRef.current?.watchRendered?.((): void => {
    if (documentVisible()) loop.requestCheck();
  });
  window.addEventListener("focus", checkSoon);
  document.addEventListener("visibilitychange", onVisibility);
  loop.schedule();
  return (): void => {
    loop.dispose();
    stopWatchingRendered?.();
    if (debounce !== undefined) clearTimeout(debounce);
    window.removeEventListener("focus", checkSoon);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
