import { FeedbackPublicationError } from "./feedback-publication-types.js";
import { PostgresFeedbackPublicationWorkerStore } from "./feedback-publication-worker-store.js";
import {
  FEEDBACK_PUBLICATION_MAX_RETRY_MS,
  leaseIdentity,
  type FeedbackPublicationManualCode,
  type FeedbackPublicationWorkerLease,
} from "./feedback-publication-worker-types.js";
import {
  GovernedGithubIssueAdapter,
  GithubIssueAdapterError,
  type GithubIssueFailureCode,
  type GithubIssueProjection,
} from "./github-issue-adapter.js";

export type FeedbackPublicationDiagnosticCategory = "circuit" | "delivery" | "worker";

export interface FeedbackPublicationDiagnostic {
  readonly category: FeedbackPublicationDiagnosticCategory;
  readonly code: string;
  readonly count: number;
  readonly durationMs: number;
}

export interface FeedbackPublicationWorkerDependencies {
  readonly store: PostgresFeedbackPublicationWorkerStore;
  readonly adapter: GovernedGithubIssueAdapter;
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly circuitCooldownMs: number;
  readonly now?: (() => number) | undefined;
  readonly random?: (() => number) | undefined;
  readonly diagnostics?: ((event: FeedbackPublicationDiagnostic) => void) | undefined;
}

const TRANSIENT = new Set<GithubIssueFailureCode>(["rate-limited", "provider-unavailable"]);
const MANUAL = new Set<FeedbackPublicationManualCode>([
  "permission-denied",
  "validation-error",
  "repository-unavailable",
  "duplicate-candidate",
  "target-policy-drift",
  "projection-drift",
  "payload-private",
  "payload-expired",
]);

function requiresReconciliationRetry(
  lease: FeedbackPublicationWorkerLease,
  error: GithubIssueAdapterError,
): boolean {
  return (
    error.commitCertainty === "may-have-committed" ||
    (lease.mode === "reconcile-only" && TRANSIENT.has(error.code))
  );
}

export class FeedbackPublicationWorker {
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly dependencies: FeedbackPublicationWorkerDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
  }

  async runOne(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted === true) return false;
    const value = await this.dependencies.store.withCandidate(
      {
        workerId: this.dependencies.workerId,
        leaseDurationMs: this.dependencies.leaseDurationMs,
      },
      async (lease) => this.deliver(lease, signal),
    );
    if (value === undefined) this.event("worker", "no-work", 1, this.now());
    return value !== undefined;
  }

  private async deliver(
    lease: FeedbackPublicationWorkerLease,
    signal?: AbortSignal,
  ): Promise<void> {
    const startedAt = this.now();
    const circuit = await this.dependencies.store.enterProviderCircuit(lease);
    if (!circuit.allowed) {
      await this.defer(lease, circuit.delayMs);
      this.event("circuit", "open", 1, startedAt);
      return;
    }
    try {
      const reconciled = await this.dependencies.adapter.reconcileIssue(lease, signal);
      if (reconciled.kind === "exact") {
        await this.recordSuccess(lease, reconciled.issue, "reconciled");
        this.event("delivery", "reconciled", 1, startedAt);
        return;
      }
      if (lease.mode === "reconcile-only") {
        const delayMs = this.retryDelay(lease);
        if (circuit.probe) {
          await this.dependencies.store.recordProviderProbeSuccess(lease);
        }
        await this.dependencies.store.scheduleReconciliation(leaseIdentity(lease), delayMs);
        this.event("delivery", "not-observed", 1, startedAt);
        return;
      }
      const created = await this.dependencies.adapter.publishClaimedCandidate(
        this.dependencies.store,
        lease,
        signal,
      );
      await this.recordSuccess(lease, created, "created");
      this.event("delivery", "created", 1, startedAt);
    } catch (error) {
      await this.settleFailure(lease, error);
      this.event("delivery", this.failureCode(error), 1, startedAt);
    }
  }

  private async recordSuccess(
    lease: FeedbackPublicationWorkerLease,
    issue: GithubIssueProjection,
    source: "created" | "reconciled",
  ): Promise<void> {
    await this.dependencies.store.recordSuccess(
      leaseIdentity(lease),
      {
        repositoryId: issue.repositoryId,
        issueNodeId: issue.nodeId,
        issueNumber: issue.number,
      },
      source,
    );
  }

  private async settleFailure(
    lease: FeedbackPublicationWorkerLease,
    error: unknown,
  ): Promise<void> {
    const identity = leaseIdentity(lease);
    if (error instanceof GithubIssueAdapterError) {
      const delayMs = this.retryDelay(lease, error);
      if (TRANSIENT.has(error.code)) {
        await this.dependencies.store.recordProviderFailure(
          lease,
          Math.max(this.dependencies.circuitCooldownMs, delayMs),
          error.code === "rate-limited",
        );
      }
      if (requiresReconciliationRetry(lease, error)) {
        await this.dependencies.store.scheduleReconciliation(identity, delayMs);
        return;
      }
      if (TRANSIENT.has(error.code)) {
        const retryCode = error.code === "rate-limited" ? "rate-limited" : "provider-unavailable";
        await this.dependencies.store.scheduleRetry(identity, retryCode, delayMs);
        return;
      }
      if (MANUAL.has(error.code as FeedbackPublicationManualCode)) {
        await this.dependencies.store.recordManual(
          identity,
          error.code as FeedbackPublicationManualCode,
        );
        return;
      }
      throw error;
    }
    if (
      error instanceof FeedbackPublicationError &&
      MANUAL.has(error.code as FeedbackPublicationManualCode)
    ) {
      await this.dependencies.store.recordManual(
        identity,
        error.code as FeedbackPublicationManualCode,
      );
      return;
    }
    throw error;
  }

  private async defer(lease: FeedbackPublicationWorkerLease, delayMs: number): Promise<void> {
    await this.dependencies.store.scheduleCircuitDeferral(lease, delayMs);
  }

  private retryDelay(
    lease: FeedbackPublicationWorkerLease,
    error?: GithubIssueAdapterError,
  ): number {
    const providerMs = (error?.retryAfterSeconds ?? 0) * 1_000;
    const exponential = 1_000 * 2 ** Math.min(lease.createAttemptCount, 10);
    const jittered = exponential * (0.75 + this.random() * 0.5);
    return Math.min(FEEDBACK_PUBLICATION_MAX_RETRY_MS, Math.max(providerMs, jittered));
  }

  private failureCode(error: unknown): string {
    if (error instanceof GithubIssueAdapterError) return error.code;
    if (error instanceof FeedbackPublicationError) return error.code;
    return "internal-failure";
  }

  private event(
    category: FeedbackPublicationDiagnosticCategory,
    code: string,
    count: number,
    startedAt: number,
  ): void {
    this.dependencies.diagnostics?.({
      category,
      code,
      count,
      durationMs: Math.max(0, this.now() - startedAt),
    });
  }
}
