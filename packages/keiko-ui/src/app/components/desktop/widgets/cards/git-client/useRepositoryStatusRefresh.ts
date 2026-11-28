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

import { type RefObject, useEffect, useRef } from "react";
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

export interface AmbientRefresh {
  // Reads the status and reports whether it differs from what the window shows.
  readonly probe: () => Promise<boolean>;
  // True while a status read is already running; the tick is skipped, never queued.
  readonly isBusy: () => boolean;
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
          if (namesThisRepository(rootsOf(event))) refresh();
        };
        window.addEventListener(name, listener);
        return [name, listener] as const;
      },
    );
    return (): void => {
      for (const [name, listener] of listeners) window.removeEventListener(name, listener);
    };
  }, [refresh, repositoryRoot, selectedPath]);

  useEffect((): (() => void) | undefined => {
    if (selectedPath === null) return undefined;
    return watchRepositoryFromOutside(refreshRef, ambientRef);
  }, [selectedPath]);
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

// The visible-only, non-overlapping, backed-off probe: it re-reads only when the status differs.
class ProbeLoop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private delay = AMBIENT_BASE_INTERVAL_MS;
  private inFlight = false;
  private failureReported = false;
  private disposed = false;

  constructor(
    private readonly refreshRef: RefObject<() => void>,
    private readonly ambientRef: RefObject<AmbientRefresh | undefined>,
  ) {}

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  schedule(): void {
    this.stop();
    if (!this.disposed && documentVisible()) this.timer = setTimeout(() => this.tick(), this.delay);
  }

  restart(): void {
    this.delay = AMBIENT_BASE_INTERVAL_MS;
    this.schedule();
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
      this.backOff();
      return;
    }
    this.delay = AMBIENT_BASE_INTERVAL_MS;
    this.refreshRef.current();
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
    if (this.disposed || ambient === undefined || this.inFlight || ambient.isBusy()) {
      this.schedule();
      return;
    }
    this.inFlight = true;
    ambient
      .probe()
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
  refreshRef: RefObject<() => void>,
  ambientRef: RefObject<AmbientRefresh | undefined>,
): () => void {
  const loop = new ProbeLoop(refreshRef, ambientRef);
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const refreshSoon = (): void => {
    if (debounce !== undefined) clearTimeout(debounce);
    debounce = setTimeout((): void => {
      debounce = undefined;
      if (!documentVisible() || ambientRef.current?.isBusy() === true) return;
      refreshRef.current();
    }, AMBIENT_FOCUS_DEBOUNCE_MS);
  };
  const onVisibility = (): void => {
    if (!documentVisible()) {
      loop.stop();
      return;
    }
    refreshSoon();
    loop.restart();
  };
  window.addEventListener("focus", refreshSoon);
  document.addEventListener("visibilitychange", onVisibility);
  loop.schedule();
  return (): void => {
    loop.dispose();
    if (debounce !== undefined) clearTimeout(debounce);
    window.removeEventListener("focus", refreshSoon);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
