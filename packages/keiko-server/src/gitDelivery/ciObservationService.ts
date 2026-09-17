import type { CodingRuntimeCiResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-ci";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  isGitCiFailureContextResult,
  gitDeliveryObservationFailure,
  type GitCiFailureContextResult,
  type GitDeliveryObservationFailure,
  type ReadinessSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type {
  GitCiProviderReader,
  GitCiFactsResult,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type {
  CodingRuntimeCiReadinessStore,
  CiObservationTicket,
} from "../coding-runtime/codingRuntimeCiReadinessStore.js";
import { describeError } from "../diagnostics-log.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import { draftDeliveryLineageRecord } from "../coding-runtime/codingRuntimeDraftDeliverySource.js";
import { resolveDraftRepository } from "./draftDeliveryFacts.js";
import {
  DraftDeliveryFailure,
  type DraftDeliveryDependencies,
  type DraftDeliveryRunContext,
} from "./draftDeliveryTypes.js";
import { produceCiReadinessSnapshot } from "./ciReadinessSnapshot.js";

const CI_OBSERVATION_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.ci-observation",
  category: "process",
  owner: "keiko-server",
  emitter: "gitDelivery/ciObservationService.CiObservationController",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["started", "observed", "unavailable"],
    },
    revision: { type: "integer", dataClass: "count", required: false },
    headSha: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    baseSha: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    remoteDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "authority-denied",
        "draft-unavailable",
        "provider-unavailable",
        "observation-in-flight",
        "poll-backoff",
        "observation-superseded",
        "auth-required",
        "invalid-binding",
        "cancelled",
        "provider-forbidden",
        "provider-not-found",
        "rate-limited",
        "timeout",
        "pagination-exhausted",
        "output-truncated",
        "malformed-response",
        "visibility-unknown",
        "requirements-ambiguous",
        "revision-changed",
        "required-checks-passed",
        "required-checks-pending",
        "required-checks-failed",
        "required-checks-blocked",
        "required-checks-unknown",
        "pull-request-closed",
        "merge-conflict",
        "base-outdated",
        "merge-context-unknown",
        "repair-budget-exhausted",
      ],
    },
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["technical-ready", "pending", "failed", "blocked", "unknown"],
    },
    requirementsDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    evidenceRef: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    complete: { type: "boolean", dataClass: "closed-enum", required: false },
    requiredCount: { type: "integer", dataClass: "count", required: false },
    failingCount: { type: "integer", dataClass: "count", required: false },
    retryAfterMs: { type: "integer", dataClass: "duration", required: false },
    contextStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["observed", "unavailable"],
    },
    contextReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "authority-denied",
        "auth-required",
        "invalid-binding",
        "cancelled",
        "provider-forbidden",
        "provider-not-found",
        "rate-limited",
        "provider-unavailable",
        "timeout",
        "pagination-exhausted",
        "output-truncated",
        "malformed-response",
        "visibility-unknown",
        "requirements-ambiguous",
        "revision-changed",
      ],
    },
    sourceCount: { type: "integer", dataClass: "count", required: false },
    entryCount: { type: "integer", dataClass: "count", required: false },
    byteCount: { type: "integer", dataClass: "count", required: false },
    contextComplete: { type: "boolean", dataClass: "closed-enum", required: false },
    failureKind: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    errorClass: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    code: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
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
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["git-ci-observation"],
  proofIds: ["git.ci-observation"],
  releaseImpact: "patch",
});

interface CiObservationActivityFields {
  readonly runId?: string;
  readonly phase: "started" | CodingRuntimeCiResult["status"];
  readonly revision?: number;
  readonly headSha?: string;
  readonly baseSha?: string;
  readonly remoteDigest?: string;
  readonly reason?:
    | Extract<CodingRuntimeCiResult, { status: "unavailable" }>["reason"]
    | ReadinessSnapshot["reason"];
  readonly state?: ReadinessSnapshot["state"];
  readonly requirementsDigest?: string;
  readonly evidenceRef?: string;
  readonly complete?: boolean;
  readonly requiredCount?: number;
  readonly failingCount?: number;
  readonly retryAfterMs?: number;
  readonly contextStatus?: "observed" | "unavailable";
  readonly contextReason?: GitDeliveryObservationFailure["reason"];
  readonly sourceCount?: number;
  readonly entryCount?: number;
  readonly byteCount?: number;
  readonly contextComplete?: boolean;
  readonly failureKind?: string;
  readonly errorClass?: string;
  readonly code?: string;
  readonly frames?: readonly string[];
  readonly causeChain?: readonly string[];
}

export interface CiObservationService {
  observe(forceFresh?: boolean): Promise<CodingRuntimeCiResult>;
}
export interface CiObservationOptions extends DraftDeliveryDependencies {
  readonly context: () => DraftDeliveryRunContext | undefined;
  readonly persistence: CodingRuntimeCiReadinessStore;
  readonly onChanged: (snapshot: ReadinessSnapshot) => void;
  /**
   * Read-only raw fact from the run's CI repair budget owner (#3384 B5-1): true once the ledger
   * reports its deadline, tool-call, prompt-token, or attempt-count budget spent.
   * `produceCiReadinessSnapshot` is the one place this becomes the emitted `repair-budget-exhausted`
   * reason. Absent is a deliberate closed default -- no caller means never exhausted.
   */
  readonly repairBudgetExhausted?: () => boolean;
}
interface Observation {
  readonly context: DraftDeliveryRunContext;
  readonly draft: DraftDeliveryRecord;
  readonly ticket: CiObservationTicket;
  readonly startedAt: number;
}
function unavailable(
  reason: Extract<CodingRuntimeCiResult, { status: "unavailable" }>["reason"],
  retryAfterMs = 0,
): CodingRuntimeCiResult {
  return { status: "unavailable", reason, retryAfterMs };
}
function live(context: DraftDeliveryRunContext | undefined): context is DraftDeliveryRunContext {
  return context !== undefined && context.stillAuthorized() && context.signal?.aborted !== true;
}
function retryAfter(snapshot: ReadinessSnapshot): number {
  if (snapshot.reason === "rate-limited") return 30_000;
  return snapshot.state === "technical-ready" || snapshot.state === "blocked" ? 0 : 5_000;
}
function observationFailure(error: unknown): CodingRuntimeCiResult {
  if (error instanceof DraftDeliveryFailure && error.reason !== "provider-failed")
    return unavailable("authority-denied");
  return unavailable("provider-unavailable", 5_000);
}

function resultFields(
  result: CodingRuntimeCiResult,
): Omit<
  CiObservationActivityFields,
  | "runId"
  | "phase"
  | "revision"
  | "remoteDigest"
  | "failureKind"
  | "errorClass"
  | "code"
  | "frames"
  | "causeChain"
> {
  if (result.status === "unavailable") return { reason: result.reason };
  const snapshot = result.snapshot;
  return {
    reason: snapshot.reason,
    state: snapshot.state,
    headSha: snapshot.headSha,
    baseSha: snapshot.baseSha,
    ...(snapshot.requirementsDigest === null
      ? {}
      : { requirementsDigest: snapshot.requirementsDigest }),
    evidenceRef: snapshot.evidenceRef,
    complete: snapshot.complete,
    requiredCount: snapshot.requiredChecks.total,
    failingCount: snapshot.requiredChecks.failed,
    ...failureContextFields(result.failureContext),
  };
}
function failureContextFields(
  value: GitCiFailureContextResult | undefined,
): Pick<
  CiObservationActivityFields,
  "contextStatus" | "contextReason" | "sourceCount" | "entryCount" | "byteCount" | "contextComplete"
> {
  if (value === undefined) return {};
  if (value.status === "unavailable")
    return { contextStatus: value.status, contextReason: value.failure.reason };
  return {
    contextStatus: value.status,
    sourceCount: value.context.sourceCount,
    entryCount: value.context.entries.length,
    byteCount: Buffer.byteLength(JSON.stringify(value.context), "utf8"),
    contextComplete: value.context.completeness.complete,
  };
}

/** Observes the accepted run's confirmed PR; all mutation and approval paths remain their existing owners. */
export class CiObservationController implements CiObservationService {
  private active = false;
  public constructor(private readonly options: CiObservationOptions) {}
  public async observe(forceFresh = false): Promise<CodingRuntimeCiResult> {
    if (this.active) return unavailable("observation-in-flight", 1_000);
    this.active = true;
    let context: DraftDeliveryRunContext | undefined;
    try {
      context = this.options.context();
      if (!live(context)) return this.record(context, unavailable("authority-denied"));
      return await this.observeLive(context, forceFresh);
    } catch (error) {
      return this.record(context, observationFailure(error), error);
    } finally {
      this.active = false;
    }
  }
  private async observeLive(
    context: DraftDeliveryRunContext,
    forceFresh: boolean,
  ): Promise<CodingRuntimeCiResult> {
    const draft = await this.observationDraft(context);
    if (draft?.pullRequest === undefined)
      return this.record(context, unavailable("draft-unavailable"));
    const startedAt = this.now();
    const backoff = this.backoff(context.runId, startedAt, forceFresh);
    if (backoff !== undefined) return this.record(context, backoff);
    const ticket = this.options.persistence.begin(context.runId);
    const observation = { context, draft, ticket, startedAt };
    this.started(observation);
    const repository = await resolveDraftRepository(this.options, context);
    if (repository !== draft.binding.repository.toLowerCase())
      return this.record(context, unavailable("authority-denied"));
    const reader = this.options.ciReader?.(context);
    if (reader === undefined)
      return this.record(context, unavailable("provider-unavailable", 5_000));
    const facts = await reader.readFacts({
      ownerAndRepo: repository,
      prExternalId: String(draft.pullRequest.number),
      baseBranchName: draft.binding.baseRef,
      headSha: draft.binding.headSha,
    });
    return this.finishRead(observation, facts, reader);
  }
  private observationCandidate(context: DraftDeliveryRunContext): DraftDeliveryRecord | undefined {
    const snapshot = this.options.snapshots.get(context.runId);
    if (snapshot === undefined) return undefined;
    const existing = snapshot.draftDelivery;
    if (existing !== undefined)
      return existing.phase === "draft-created" || existing.phase === "recovery-required"
        ? existing
        : undefined;
    return draftDeliveryLineageRecord(snapshot, (runId) => this.options.snapshots.get(runId))
      ?.record;
  }
  private async observationDraft(
    context: DraftDeliveryRunContext,
  ): Promise<DraftDeliveryRecord | undefined> {
    const candidate = this.observationCandidate(context);
    if (candidate?.pullRequest === undefined) return undefined;
    if (candidate.binding.runId === context.runId && candidate.phase === "draft-created")
      return candidate;
    const { DraftDeliveryController } = await import("./draftDeliveryService.js");
    const result = await new DraftDeliveryController({
      ...this.options,
      onChanged: (): void => undefined,
    }).reconcileForObservation();
    return result.status === "recorded" && result.record.phase === "draft-created"
      ? result.record
      : undefined;
  }
  private async finishRead(
    observation: Observation,
    facts: GitCiFactsResult,
    reader: GitCiProviderReader,
  ): Promise<CodingRuntimeCiResult> {
    const { snapshot } = produceCiReadinessSnapshot(
      observation.draft,
      facts,
      observation.startedAt,
      this.options.repairBudgetExhausted?.() ?? false,
    );
    const failureContext = await readFailureContext(snapshot, facts, reader);
    if (failureContext?.status === "superseded")
      return this.record(observation.context, unavailable("observation-superseded"));
    return this.finish(observation, snapshot, failureContext);
  }
  private now(): number {
    return (this.options.execution?.now ?? Date.now)();
  }
  private backoff(
    runId: string,
    now: number,
    forceFresh: boolean,
  ): CodingRuntimeCiResult | undefined {
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Invalid CI observation clock");
    const prior = this.options.persistence.get(runId);
    if (prior === undefined) return undefined;
    const elapsed = now - Date.parse(prior.observedAt);
    if (elapsed < 0) return unavailable("authority-denied");
    if (forceFresh || elapsed >= Math.max(5_000, retryAfter(prior))) return undefined;
    return unavailable("poll-backoff", Math.max(5_000, retryAfter(prior)) - elapsed);
  }
  private async finish(
    observation: Observation,
    snapshot: ReadinessSnapshot,
    failureContext: GitCiFailureContextResult | undefined,
  ): Promise<CodingRuntimeCiResult> {
    const { context, draft, ticket, startedAt } = observation;
    if (!live(context)) return this.record(context, unavailable("authority-denied"));
    if (
      (await resolveDraftRepository(this.options, context)) !==
      draft.binding.repository.toLowerCase()
    )
      return this.record(context, unavailable("authority-denied"));
    const now = this.now();
    if (
      !live(context) ||
      !Number.isSafeInteger(now) ||
      now < startedAt ||
      now >= startedAt + 60_000
    )
      return this.record(context, unavailable("observation-superseded"));
    if (!this.options.persistence.complete(ticket, snapshot))
      return this.record(context, unavailable("observation-superseded"));
    this.options.onChanged(snapshot);
    return this.record(context, {
      status: "observed",
      snapshot,
      ...(failureContext === undefined ? {} : { failureContext }),
      retryAfterMs: retryAfter(snapshot),
    });
  }
  private started(observation: Observation): void {
    (this.options.execution?.activityLog ?? processServerLogSink()).write(
      activityLogEvent(
        CI_OBSERVATION_OPERATION,
        { correlationId: observation.context.correlationId },
        {
          runId: observation.context.runId,
          phase: "started",
          revision: observation.ticket.revision,
          headSha: observation.draft.binding.headSha,
          remoteDigest: observation.draft.binding.remoteDigest,
        },
      ),
    );
  }
  private record(
    context: DraftDeliveryRunContext | undefined,
    result: CodingRuntimeCiResult,
    error?: unknown,
  ): CodingRuntimeCiResult {
    const detail = error === undefined ? undefined : describeError(error);
    (this.options.execution?.activityLog ?? processServerLogSink()).write(
      activityLogEvent(
        CI_OBSERVATION_OPERATION,
        {
          correlationId: context?.correlationId ?? UNKNOWN_CORRELATION_ID,
          ...(error === undefined ? {} : { level: "warn", errorKind: "internal" }),
        },
        {
          runId: context?.runId,
          phase: result.status,
          ...resultFields(result),
          retryAfterMs: result.retryAfterMs,
          ...(detail === undefined
            ? {}
            : {
                failureKind: detail.errorClass,
                errorClass: detail.errorClass,
                ...(detail.code === undefined ? {} : { code: detail.code }),
                ...(detail.frames === undefined ? {} : { frames: detail.frames }),
                ...(detail.causeChain === undefined ? {} : { causeChain: detail.causeChain }),
              }),
        },
      ),
    );
    return result;
  }
}

async function readFailureContext(
  snapshot: ReadinessSnapshot,
  facts: GitCiFactsResult,
  reader: GitCiProviderReader,
): Promise<GitCiFailureContextResult | { readonly status: "superseded" } | undefined> {
  if (snapshot.state !== "failed" || facts.status !== "observed") return undefined;
  const result = await reader.readFailureContext?.(facts);
  if (result === undefined)
    return { status: "unavailable", failure: gitDeliveryObservationFailure("visibility-unknown") };
  if (!isGitCiFailureContextResult(result))
    return { status: "unavailable", failure: gitDeliveryObservationFailure("malformed-response") };
  if (result.status === "unavailable" && result.failure.reason === "revision-changed")
    return { status: "superseded" };
  if (!failureContextMatches(snapshot, result))
    return { status: "unavailable", failure: gitDeliveryObservationFailure("revision-changed") };
  return structuredClone(result);
}

function failureContextMatches(
  snapshot: ReadinessSnapshot,
  result: GitCiFailureContextResult,
): boolean {
  if (result.status === "unavailable") return true;
  const context = result.context;
  return (
    context.repository === snapshot.repository &&
    context.prNumber === snapshot.prNumber &&
    context.headSha === snapshot.headSha &&
    context.baseSha === snapshot.baseSha
  );
}
