import type {
  AvailableCodingSafeActivityFeed,
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeSseEvent,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import type { CodingWorkbenchTranslate } from "./coding-workbench-i18n";

/**
 * What a live run is doing right now, as far as the Workbench can tell (#3873 live review: with a
 * model that takes minutes per turn, "Running" alone left the operator guessing). `decision` is
 * any human decision the run waits for: an approval, a changeset review, a question or a pause
 * reason only an operator can resolve. `gateway` is a model gateway that is unavailable and being
 * retried (#3873 review: an outage rides on for minutes, and "Waiting for the model" read the same
 * as a slow generation).
 */
export type CodingWorkbenchRunPhase = "decision" | "gateway" | "verifier" | "tool" | "model";

export interface CodingWorkbenchRunPhaseInput {
  readonly snapshot: CodingWorkbenchRuntimeSnapshot | null;
  readonly feed: AvailableCodingSafeActivityFeed | null;
  /** The run's runtime events the Workbench holds; the gateway facts among them decide `gateway`. */
  readonly events: readonly CodingWorkbenchRuntimeSseEvent[];
  /** True while a question or a changeset review waits for the operator. */
  readonly pendingDecision: boolean;
}

// The vetted verifier tool (opencodeToolSchemas.ts); any other tool is ordinary tool work.
const VERIFIER_TOOL = "keiko_verification";
const UNSETTLED_TOOL_STATES: ReadonlySet<string> = new Set(["pending", "running"]);
const TERMINAL_RUN_STATES: ReadonlySet<CodingWorkbenchRuntimeStateName> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "taken-over",
]);

/** True for a run that has settled: it will not change again. */
export function settledRunState(state: CodingWorkbenchRuntimeStateName): boolean {
  return TERMINAL_RUN_STATES.has(state);
}

function awaitsDecision(input: CodingWorkbenchRunPhaseInput): boolean {
  const snapshot = input.snapshot;
  if (snapshot === null) return false;
  if (input.pendingDecision || snapshot.pendingPermission !== undefined) return true;
  if (snapshot.state === "awaiting-approval") return true;
  return snapshot.state === "paused" && snapshot.pauseReason !== undefined;
}

// Only the newest turn counts: a tool an older turn never settled is not what the run does now.
function unsettledTool(input: CodingWorkbenchRunPhaseInput): string | undefined {
  const feed = input.feed;
  if (feed === null || feed.runId !== input.snapshot?.runId) return undefined;
  const tools = feed.turns.at(-1)?.tools ?? [];
  return tools.findLast((tool) => UNSETTLED_TOOL_STATES.has(tool.state))?.tool;
}

/**
 * True while the run's model gateway is being retried: the newest event the Workbench holds for the
 * run is the `model-gateway-retrying` fact. The answer that ends an outage publishes
 * `model-gateway-recovered`, and any later event of the run — a failed turn, a pause, a settlement —
 * is newer still, so a lost recovery frame cannot leave the status claiming an outage for good.
 */
export function modelGatewayRetrying(
  events: readonly CodingWorkbenchRuntimeSseEvent[],
  runId: string | undefined,
): boolean {
  if (runId === undefined) return false;
  const newest = events.findLast((event) => event.runId === runId);
  return newest?.kind === "runtime-event" && newest.eventKind === "model-gateway-retrying";
}

/** The current phase of the run, or null when the run is not live or its phase is not known. */
export function runPhase(input: CodingWorkbenchRunPhaseInput): CodingWorkbenchRunPhase | null {
  if (awaitsDecision(input)) return "decision";
  if (input.snapshot?.state !== "running") return null;
  if (modelGatewayRetrying(input.events, input.snapshot.runId)) return "gateway";
  const tool = unsettledTool(input);
  if (tool === undefined) return "model";
  return tool === VERIFIER_TOOL ? "verifier" : "tool";
}

function instant(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function runEvents(
  events: readonly CodingWorkbenchRuntimeSseEvent[],
  runId: string,
): readonly CodingWorkbenchRuntimeSseEvent[] {
  return events.filter((event) => event.runId === runId);
}

/**
 * When the run started, from the events the Workbench already receives: the run's first published
 * event (sequence 0) or its `starting` status. No other event can stand in for the start — the
 * earliest retained event of a long run is not its start — so an unknown start stays unknown.
 */
export function runStartedAt(
  events: readonly CodingWorkbenchRuntimeSseEvent[],
  runId: string,
): number | null {
  const start = runEvents(events, runId).find(
    (event) => event.sequence === 0 || (event.kind === "status" && event.state === "starting"),
  );
  return start === undefined ? null : instant(start.occurredAt);
}

/** When a settled run settled: its terminal status event, else the settled snapshot's update. */
export function runSettledAt(
  snapshot: CodingWorkbenchRuntimeSnapshot | null,
  events: readonly CodingWorkbenchRuntimeSseEvent[],
): number | null {
  if (snapshot?.runId === undefined || !TERMINAL_RUN_STATES.has(snapshot.state)) return null;
  const terminal = runEvents(events, snapshot.runId).find(
    (event) => event.kind === "status" && TERMINAL_RUN_STATES.has(event.state),
  );
  return instant(terminal?.occurredAt ?? snapshot.updatedAt);
}

/** A run duration in the operator's language: "45 s", "2 min 14 s", "1 h 3 min". */
export function formatRunDuration(milliseconds: number, t: CodingWorkbenchTranslate): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (hours > 0) return t("codingWorkbench.runStatus.duration.hours", { hours, minutes });
  if (minutes > 0) return t("codingWorkbench.runStatus.duration.minutes", { minutes, seconds });
  return t("codingWorkbench.runStatus.duration.seconds", { seconds });
}
