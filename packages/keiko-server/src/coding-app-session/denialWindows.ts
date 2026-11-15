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
import { SESSION_PROOF_REFUSAL_REASONS } from "./sessionRegistry.js";

/**
 * Every reason a `POST /local-session` repair can be refused: the registry's proof refusals plus the
 * three the repair itself adds. This is the closed set the per-window histogram counts (#4370).
 */
export const LOCAL_SESSION_DENIAL_REASONS = [
  ...SESSION_PROOF_REFUSAL_REASONS,
  "lifetime-insufficient",
  "proof-unavailable",
  "channel-unavailable",
] as const;
export type LocalSessionDenialReason = (typeof LOCAL_SESSION_DENIAL_REASONS)[number];
export type LocalSessionDenialHistogram = Readonly<Record<LocalSessionDenialReason, number>>;

/** What one window of local-session denials reports: the total, its closed reasons, its state. */
export interface LocalSessionDenialSummary {
  readonly count: number;
  readonly histogram: LocalSessionDenialHistogram;
  /** `false` for the threshold alert raised mid-window, `true` for the window's final summary. */
  readonly windowClosed: boolean;
}

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

function recordDenial(
  window: DenialWindow,
  now: number,
  emit: (count: number) => void,
  threshold = DENIAL_ALERT_THRESHOLD,
): void {
  if (now - window.windowStartMs >= DENIAL_WINDOW_MS) {
    window.windowStartMs = now;
    window.count = 0;
    window.emitted = false;
  }
  window.count += 1;
  if (!window.emitted && window.count >= threshold) {
    window.emitted = true;
    emit(window.count);
  }
}

function emptyHistogram(): Record<LocalSessionDenialReason, number> {
  return Object.fromEntries(LOCAL_SESSION_DENIAL_REASONS.map((reason) => [reason, 0])) as Record<
    LocalSessionDenialReason,
    number
  >;
}

/**
 * The local-session window keeps its reason histogram and reports it twice at most per window: once
 * when the alert threshold is crossed and once when the window closes. The closing summary is what
 * makes an isolated refusal visible: below the threshold it used to leave no line at all. Closing
 * happens on the window's own (unref'd) timer and, deterministically, when the next denial arrives
 * after the window ended, so a window is never reported twice and never lost.
 */
class LocalSessionDenialWindow {
  private window: DenialWindow = freshWindow();
  private histogram = emptyHistogram();
  private emit: ((summary: LocalSessionDenialSummary) => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  record(
    now: number,
    reason: LocalSessionDenialReason,
    emit: (summary: LocalSessionDenialSummary) => void,
  ): void {
    if (this.emit !== undefined && now - this.window.windowStartMs >= DENIAL_WINDOW_MS)
      this.close();
    this.emit = emit;
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.close();
      }, DENIAL_WINDOW_MS);
      this.timer.unref();
    }
    this.histogram[reason] += 1;
    recordDenial(this.window, now, () => {
      emit(this.summary(false));
    });
  }

  private summary(windowClosed: boolean): LocalSessionDenialSummary {
    return { count: this.window.count, histogram: { ...this.histogram }, windowClosed };
  }

  private close(): void {
    const emit = this.emit;
    const summary = this.summary(true);
    this.reset();
    if (emit !== undefined && summary.count > 0) emit(summary);
  }

  /** Report the pending window's summary instead of dropping it, then release the timer. */
  flush(): void {
    if (this.timer !== undefined) this.close();
    this.reset();
  }

  reset(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.emit = undefined;
    this.window = freshWindow();
    this.histogram = emptyHistogram();
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
  private readonly localSession = new LocalSessionDenialWindow();

  recordPairingDenial(now: number, onThresholdReached: (count: number) => void): void {
    recordDenial(this.pairing, now, onThresholdReached);
  }

  recordRotateDenial(now: number, onThresholdReached: (count: number) => void): void {
    recordDenial(this.rotate, now, onThresholdReached);
  }

  recordLocalSessionDenial(
    now: number,
    reason: LocalSessionDenialReason,
    emit: (summary: LocalSessionDenialSummary) => void,
  ): void {
    this.localSession.record(now, reason, emit);
  }

  /**
   * Disposal hook (deps.ts `createUiHandlerDispose`): nothing outlives the graph. The pending
   * local-session window is reported first, so a refusal counted in the last minute before
   * shutdown reaches the log instead of vanishing with the process.
   */
  reset(): void {
    Object.assign(this.pairing, freshWindow());
    Object.assign(this.rotate, freshWindow());
    this.localSession.flush();
  }
}

const codingAppSessionDenialWindows = new CodingAppSessionDenialWindows();

export function resolveCodingAppSessionDenialWindows(
  deps: Pick<UiHandlerDeps, "codingAppSessionDenialWindows">,
): CodingAppSessionDenialWindows {
  return deps.codingAppSessionDenialWindows ?? codingAppSessionDenialWindows;
}
