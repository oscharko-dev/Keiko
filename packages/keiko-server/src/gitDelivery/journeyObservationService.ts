import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import { isDraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type { JourneyOutcome } from "@oscharko-dev/keiko-contracts/runtime/git-journey-outcome";
import type { ReadinessSnapshot } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import type { PrDescriptionApplicationStatus } from "@oscharko-dev/keiko-contracts/runtime/pr-description-application";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type {
  GitJourneyReader,
  GitJourneyFactsResult,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { describeError } from "../diagnostics-log.js";
import type { ServerLogSink } from "../observability/server-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { captureJourneyFacts, produceJourneyOutcome } from "./journeyOutcome.js";

const JOURNEY_OBSERVATION_OPERATION_BASE = {
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.journey-observation",
  category: "process",
  owner: "keiko-server",
  emitter: "gitDelivery/journeyObservationService.logJourneyObservationActivity",
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["git-journey-observation"],
  proofIds: ["git.journey-observation.emitted-line"],
  releaseImpact: "patch",
} as const;

const JOURNEY_REASON_VALUES = [
  "authority-denied",
  "draft-unavailable",
  "observation-in-flight",
  "observation-superseded",
  "provider-unavailable",
  "ready-approval-required",
  "technical-ready",
  "human-review-ready",
  "required-reviews-missing",
  "changes-requested",
  "unresolved-conversations",
  "review-visibility-unknown",
  "issue-closure-pending",
  "merge-and-closure-observed",
  "closed-unmerged",
  "issue-closed-without-merge",
  "retargeted",
  "head-changed",
  "readiness-unavailable",
  "readiness-stale",
  "checks-not-ready",
  "description-unavailable",
  "description-stale",
  "description-not-applied",
  "cancelled",
  "ready-effect-uncertain",
] as const;

const JOURNEY_STATE_VALUES = [
  "awaiting-ready-approval",
  "keiko-technical-ready",
  "ready-for-human-review",
  "awaiting-human-requirements",
  "merged-awaiting-issue-closure",
  "completed",
  "blocked",
  "cancelled",
  "recovery-required",
] as const;

const OPTIONAL_ERROR_KIND_FIELD = {
  type: "string",
  dataClass: "error-kind",
  required: false,
  maxLength: 64,
} as const;

const JOURNEY_FAILURE_FIELDS = {
  failureKind: OPTIONAL_ERROR_KIND_FIELD,
  errorClass: OPTIONAL_ERROR_KIND_FIELD,
  code: OPTIONAL_ERROR_KIND_FIELD,
  frames: {
    type: "string-array",
    dataClass: "safe-platform-class",
    required: false,
    maxLength: 512,
    maxItems: 8,
  },
  causeChain: {
    type: "string-array",
    dataClass: "error-kind",
    required: false,
    maxLength: 128,
    maxItems: 5,
  },
} as const;

const JOURNEY_OBSERVATION_FIELDS = {
  phase: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: ["started", "observed", "unavailable", "joined"],
  },
  runId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
  reason: {
    type: "string",
    dataClass: "closed-enum",
    required: false,
    values: JOURNEY_REASON_VALUES,
  },
  state: {
    type: "string",
    dataClass: "closed-enum",
    required: false,
    values: JOURNEY_STATE_VALUES,
  },
  evidenceRef: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
  headSha: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
  remoteDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
  merged: { type: "boolean", dataClass: "closed-enum", required: false },
  unresolvedCount: { type: "integer", dataClass: "count", required: false },
  issueState: {
    type: "string",
    dataClass: "closed-enum",
    required: false,
    values: ["open", "closed"],
  },
  descriptionState: {
    type: "string",
    dataClass: "closed-enum",
    required: false,
    values: ["current", "partial", "fallback", "blocked", "stale", "failed"],
  },
  complete: { type: "boolean", dataClass: "closed-enum", required: false },
  ...JOURNEY_FAILURE_FIELDS,
} as const;

const JOURNEY_OBSERVATION_OPERATION = defineActivityLogOperation({
  ...JOURNEY_OBSERVATION_OPERATION_BASE,
  fields: {
    ...JOURNEY_OBSERVATION_FIELDS,
  },
});

export interface JourneyObservationActivityFields {
  // `joined`: a refresh that landed while one ran for the same run and took its result (PR #3625).
  readonly phase: "started" | "observed" | "unavailable" | "joined";
  readonly runId?: string;
  readonly reason?:
    | Extract<JourneyObservationResult, { status: "unavailable" }>["reason"]
    | JourneyOutcome["reason"];
  readonly state?: JourneyOutcome["state"];
  readonly evidenceRef?: string;
  readonly headSha?: string;
  readonly remoteDigest?: string;
  readonly merged?: boolean;
  readonly unresolvedCount?: number;
  readonly issueState?: "open" | "closed";
  readonly descriptionState?: PrDescriptionApplicationStatus["state"];
  readonly complete?: boolean;
  readonly failureKind?: string;
  readonly errorClass?: string;
  readonly code?: string;
  readonly frames?: readonly string[];
  readonly causeChain?: readonly string[];
}

// `link` names the observation a joined refresh was answered by: its request correlation becomes the
// joined line's parent, so the joiner's timeline reaches that observation's reads and outcome.
export function logJourneyObservationActivity(
  log: ServerLogSink,
  correlationId: string,
  fields: JourneyObservationActivityFields,
  failure?: { readonly errorKind: ActivityLogErrorKind },
  link?: { readonly parentCorrelationId: string },
): void {
  log.write(
    activityLogEvent(
      JOURNEY_OBSERVATION_OPERATION,
      {
        correlationId,
        ...(link === undefined ? {} : { parentCorrelationId: link.parentCorrelationId }),
        ...(failure === undefined ? {} : { level: "warn", errorKind: failure.errorKind }),
      },
      fields,
    ),
  );
}

/** Read authority from the selected workspace/connection; not a resumed coding-runtime mutation lease. */
export interface JourneyObservationContext {
  readonly draft: DraftDeliveryRecord;
  readonly accessScope: object;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
  readonly stillAuthorized: () => boolean;
}
export type JourneyObservationResult =
  | { readonly status: "observed"; readonly outcome: JourneyOutcome }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "authority-denied"
        | "draft-unavailable"
        | "observation-in-flight"
        | "observation-superseded"
        | "provider-unavailable";
    };
export interface JourneyObservationOptions {
  readonly context: () => JourneyObservationContext | undefined;
  readonly reader: (context: JourneyObservationContext) => GitJourneyReader | undefined;
  /** Refreshes exact current checks through the existing CI observation owner. */
  readonly readiness: (context: JourneyObservationContext) => Promise<ReadinessSnapshot | null>;
  /** Read-only reconciliation against the current PR body, never generation or application. */
  readonly description: (
    context: JourneyObservationContext,
  ) => Promise<PrDescriptionApplicationStatus | null>;
  /** Existing delivery projection owner performs CAS against this captured draft before publishing. */
  readonly recordOutcome: (context: JourneyObservationContext, outcome: JourneyOutcome) => boolean;
  readonly now?: () => number;
  readonly activityLog?: ServerLogSink;
}
function unavailable(
  reason: Extract<JourneyObservationResult, { status: "unavailable" }>["reason"],
): JourneyObservationResult {
  return { status: "unavailable", reason };
}
function live(
  context: JourneyObservationContext | undefined,
): context is JourneyObservationContext {
  return context !== undefined && context.signal?.aborted !== true && context.stillAuthorized();
}
function target(
  context: JourneyObservationContext,
): Parameters<GitJourneyReader["readJourney"]>[0] {
  const { draft } = context;
  if (draft.pullRequest === undefined) throw new TypeError("Journey PR missing");
  return {
    repository: draft.binding.repository,
    prNumber: draft.pullRequest.number,
    prNodeId: draft.pullRequest.externalId,
    issueNumber: draft.binding.issueNumber,
    issueIdDigest: draft.binding.issueIdDigest,
  };
}

export class JourneyObservationController {
  private active = false;
  public constructor(private readonly options: JourneyObservationOptions) {}
  public async observe(): Promise<JourneyObservationResult> {
    if (this.active) return unavailable("observation-in-flight");
    this.active = true;
    let context: JourneyObservationContext | undefined;
    try {
      context = this.options.context();
      if (!live(context)) return this.record(context, unavailable("authority-denied"));
      if (!isDraftDeliveryRecord(context.draft) || context.draft.pullRequest === undefined)
        return this.record(context, unavailable("draft-unavailable"));
      context = { ...context, draft: structuredClone(context.draft) };
      return await this.observeCurrent(context);
    } catch (error) {
      return this.record(context, unavailable("provider-unavailable"), error);
    } finally {
      this.active = false;
    }
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  private current(context: JourneyObservationContext, startedAt: number): boolean {
    const current = this.options.context();
    const now = this.now();
    return (
      Number.isSafeInteger(now) &&
      now >= startedAt &&
      now < startedAt + 60_000 &&
      live(context) &&
      live(current) &&
      context.accessScope === current.accessScope &&
      canonicalise(context.draft) === canonicalise(current.draft)
    );
  }
  private async observeCurrent(
    context: JourneyObservationContext,
  ): Promise<JourneyObservationResult> {
    const startedAt = this.now();
    if (!Number.isSafeInteger(startedAt) || startedAt < 0)
      return this.record(context, unavailable("observation-superseded"));
    const reader = this.options.reader(context);
    if (reader === undefined) return this.record(context, unavailable("provider-unavailable"));
    this.started(context);
    const before = captureJourneyFacts(await reader.readJourney(target(context)));
    if (!this.current(context, startedAt))
      return this.record(context, unavailable("observation-superseded"));
    if (before.status === "unavailable") return this.finish(context, startedAt, before, null, null);
    const readiness = await this.readOpenReadiness(context, before);
    if (!this.current(context, startedAt))
      return this.record(context, unavailable("observation-superseded"));
    const description = await this.options.description(context);
    if (!this.current(context, startedAt))
      return this.record(context, unavailable("observation-superseded"));
    const after = captureJourneyFacts(await reader.readJourney(target(context)));
    if (after.status !== "observed" || canonicalise(before) !== canonicalise(after))
      return this.record(context, unavailable("observation-superseded"));
    return this.finish(context, startedAt, after, readiness, description);
  }
  private readOpenReadiness(
    context: JourneyObservationContext,
    facts: Extract<GitJourneyFactsResult, { status: "observed" }>,
  ): Promise<ReadinessSnapshot | null> {
    return facts.mergedAt === null && facts.identity.state === "open"
      ? this.options.readiness(context)
      : Promise.resolve(null);
  }
  private finish(
    context: JourneyObservationContext,
    startedAt: number,
    facts: GitJourneyFactsResult,
    readiness: ReadinessSnapshot | null,
    description: PrDescriptionApplicationStatus | null,
  ): JourneyObservationResult {
    if (!this.current(context, startedAt))
      return this.record(context, unavailable("observation-superseded"));
    const outcome = produceJourneyOutcome({
      draft: context.draft,
      facts,
      readiness,
      description,
      observedAtMs: this.now(),
    });
    if (!this.current(context, startedAt) || !this.options.recordOutcome(context, outcome))
      return this.record(context, unavailable("observation-superseded"));
    return this.record(context, { status: "observed", outcome });
  }
  private started(context: JourneyObservationContext): void {
    logJourneyObservationActivity(
      this.options.activityLog ?? processServerLogSink(),
      context.correlationId,
      {
        phase: "started",
        runId: context.draft.binding.runId,
        headSha: context.draft.binding.headSha,
        remoteDigest: context.draft.binding.remoteDigest,
      },
    );
  }
  private record(
    context: JourneyObservationContext | undefined,
    result: JourneyObservationResult,
    error?: unknown,
  ): JourneyObservationResult {
    logJourneyObservationActivity(
      this.options.activityLog ?? processServerLogSink(),
      context?.correlationId ?? UNKNOWN_CORRELATION_ID,
      {
        phase: result.status,
        ...(context === undefined ? {} : { runId: context.draft.binding.runId }),
        ...observationFields(result),
        ...(error === undefined ? {} : journeyFailureFields(error)),
      },
      error === undefined ? undefined : { errorKind: "internal" },
    );
    return result;
  }
}

function journeyFailureFields(error: unknown): Partial<JourneyObservationActivityFields> {
  const detail = describeError(error);
  return {
    failureKind: detail.errorClass,
    errorClass: detail.errorClass,
    ...(detail.code === undefined ? {} : { code: detail.code }),
    ...(detail.frames === undefined ? {} : { frames: detail.frames }),
    ...(detail.causeChain === undefined ? {} : { causeChain: detail.causeChain }),
  };
}

function observationFields(
  result: JourneyObservationResult,
): Omit<JourneyObservationActivityFields, "phase" | "runId" | "remoteDigest"> {
  if (result.status === "unavailable") return { reason: result.reason };
  const outcome = result.outcome;
  return {
    reason: outcome.reason,
    state: outcome.state,
    evidenceRef: outcome.evidenceRef,
    headSha: outcome.binding.headSha,
    merged: outcome.remote !== null && outcome.remote.mergedAt !== null,
    ...(outcome.remote === null
      ? {}
      : {
          unresolvedCount: outcome.remote.reviewConversations.unresolved,
          issueState: outcome.remote.issue.state,
        }),
    ...(outcome.description === null ? {} : { descriptionState: outcome.description.state }),
    complete: outcome.keikoDescriptionApplied,
  };
}
