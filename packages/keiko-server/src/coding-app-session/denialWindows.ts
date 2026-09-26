// KEIKO-0838 follow-up (#2906 round 3 review). The pairing/rotate denial-aggregate diagnostic in
// codingAppSessionRoutes.ts used to keep its rate-limit window state in module-global counters.
// That combines independent `UiHandlerDeps` instances: nine denials on server A plus one on server
// B could emit B's diagnostic carrying a cross-server count, and A's own window would then be
// suppressed (`emitted: true`) for the rest of that minute even though A never crossed the
// threshold. This mirrors the KEIKO-0565 fix already applied to the Atlassian connector registries
// (atlassian/actionApprovals.ts, atlassian/syncService.ts): the counters move onto the composed
// deps graph, constructed once per graph in deps.ts and reset on disposal. Every real consumer
// resolves through `resolveCodingAppSessionDenialWindows` -- never a bare module-level instance --
// so it always reads the injected graph's own counters; the resolver falls back to the process-wide
// singleton only for a `UiHandlerDeps`-shaped value that skips `buildUiHandlerDeps` (e.g. a
// hand-rolled test double that never sets the field).

import type { UiHandlerDeps } from "../deps.js";

interface DenialWindow {
  windowStartMs: number;
  count: number;
  emitted: boolean;
}

const DENIAL_WINDOW_MS = 60_000;
export const DENIAL_ALERT_THRESHOLD = 10;

function freshWindow(): DenialWindow {
  return { windowStartMs: 0, count: 0, emitted: false };
}

function recordDenial(window: DenialWindow, now: number, emit: (count: number) => void): void {
  if (now - window.windowStartMs >= DENIAL_WINDOW_MS) {
    window.windowStartMs = now;
    window.count = 0;
    window.emitted = false;
  }
  window.count += 1;
  if (!window.emitted && window.count >= DENIAL_ALERT_THRESHOLD) {
    window.emitted = true;
    emit(window.count);
  }
}

/**
 * Per-graph pairing/rotate denial-window counters (KEIKO-0838). One instance per composed
 * `UiHandlerDeps` graph -- see the module comment above for why this must not be a module
 * singleton shared across independently composed servers.
 */
export class CodingAppSessionDenialWindows {
  private readonly pairing: DenialWindow = freshWindow();
  private readonly rotate: DenialWindow = freshWindow();

  recordPairingDenial(now: number, onThresholdReached: (count: number) => void): void {
    recordDenial(this.pairing, now, onThresholdReached);
  }

  recordRotateDenial(now: number, onThresholdReached: (count: number) => void): void {
    recordDenial(this.rotate, now, onThresholdReached);
  }

  /** Disposal hook (deps.ts `createUiHandlerDispose`): drop counters so nothing outlives the graph. */
  reset(): void {
    Object.assign(this.pairing, freshWindow());
    Object.assign(this.rotate, freshWindow());
  }
}

const codingAppSessionDenialWindows = new CodingAppSessionDenialWindows();

export function resolveCodingAppSessionDenialWindows(
  deps: Pick<UiHandlerDeps, "codingAppSessionDenialWindows">,
): CodingAppSessionDenialWindows {
  return deps.codingAppSessionDenialWindows ?? codingAppSessionDenialWindows;
}
