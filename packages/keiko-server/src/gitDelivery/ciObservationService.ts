import type { CodingRuntimeCiResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-ci";
import {
  isGitCiFailureContextResult,
  gitDeliveryObservationFailure,
  type GitCiFailureContextResult,
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

function resultFields(result: CodingRuntimeCiResult): Readonly<Record<string, unknown>> {
  if (result.status === "unavailable") return { reason: result.reason };
  const snapshot = result.snapshot;
  return {
    reason: snapshot.reason,
    state: snapshot.state,
    headSha: snapshot.headSha,
    baseSha: snapshot.baseSha,
    requirementsDigest: snapshot.requirementsDigest,
    evidenceRef: snapshot.evidenceRef,
    complete: snapshot.complete,
    requiredCount: snapshot.requiredChecks.total,
    failingCount: snapshot.requiredChecks.failed,
    ...failureContextFields(result.failureContext),
  };
}
function failureContextFields(
  value: GitCiFailureContextResult | undefined,
): Readonly<Record<string, unknown>> {
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
  private async observationDraft(
    context: DraftDeliveryRunContext,
  ): Promise<DraftDeliveryRecord | undefined> {
    const snapshot = this.options.snapshots.get(context.runId);
    if (snapshot === undefined) return undefined;
    if (snapshot.draftDelivery !== undefined)
      return snapshot.draftDelivery.phase === "draft-created" ? snapshot.draftDelivery : undefined;
    const candidate = draftDeliveryLineageRecord(snapshot, (runId) =>
      this.options.snapshots.get(runId),
    )?.record;
    if (candidate?.pullRequest === undefined) return undefined;
    const { DraftDeliveryController } = await import("./draftDeliveryService.js");
    const result = await new DraftDeliveryController({
      ...this.options,
      onChanged: (): void => undefined,
    }).reconcileInherited();
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
    (this.options.execution?.activityLog ?? processServerLogSink()).write({
      category: "process",
      op: "git.ci-observation",
      correlationId: observation.context.correlationId,
      extra: {
        runId: observation.context.runId,
        phase: "started",
        revision: observation.ticket.revision,
        headSha: observation.draft.binding.headSha,
        remoteDigest: observation.draft.binding.remoteDigest,
      },
    });
  }
  private record(
    context: DraftDeliveryRunContext | undefined,
    result: CodingRuntimeCiResult,
    error?: unknown,
  ): CodingRuntimeCiResult {
    (this.options.execution?.activityLog ?? processServerLogSink()).write({
      category: "process",
      op: "git.ci-observation",
      correlationId: context?.correlationId ?? UNKNOWN_CORRELATION_ID,
      level: error === undefined ? "info" : "warn",
      ...(error === undefined ? {} : { errorKind: "internal" }),
      extra: {
        runId: context?.runId,
        phase: result.status,
        ...resultFields(result),
        retryAfterMs: result.retryAfterMs,
        ...(error === undefined ? {} : describeError(error)),
      },
    });
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
