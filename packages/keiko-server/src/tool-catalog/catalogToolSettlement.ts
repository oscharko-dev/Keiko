import {
  catalogJsonBytes,
  captureCatalogJson,
  validateToolResultEnvelope,
} from "@oscharko-dev/keiko-tool-catalog";
import type {
  CatalogJsonValue,
  ToolResultEnvelope,
  ToolResultMetrics,
  ToolResultReason,
  ToolResultStatus,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  captureToolInvocationReceipt,
  type ToolInvocationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import type { CodingToolMutationGuard } from "../coding-runtime/codingToolFacadePorts.js";
import { errorKindOf } from "../observability/server-log.js";
import { causeChain, keikoStackFrames } from "../observability/stack-frames.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import { correlationIdOrUnknown } from "../correlation.js";
import {
  lifecycleIdentity,
  type CatalogBindingState,
  type CatalogBoundHandler,
} from "./catalogToolBinder.js";
import type { CatalogContinuation } from "./catalogToolContinuation.js";
import { emitToolLifecycleEvent } from "./catalogToolLifecycle.js";
import {
  CatalogDispatchFault,
  catalogBudgetOperation,
  requireDispatch,
} from "./catalogToolRuntimeAuthority.js";
import type {
  CatalogActionIdentity,
  CatalogHandlerResult,
  CatalogToolBudgetReservation,
  CatalogToolDispatchOutcome,
  CatalogTrustedContext,
} from "./catalogToolPorts.js";

type Settlement = Extract<CatalogToolDispatchOutcome, { kind: "settled" }>;
export class CatalogInvocation {
  public readonly invocationId: string;
  public readonly promise: Promise<Settlement>;
  public readonly controller = new AbortController();
  public handler: CatalogBoundHandler | undefined;
  public inputBytes = 0;
  public continuation: CatalogContinuation | undefined;
  private readonly startedAt: number;
  private readonly settlementId: string;
  private resolve!: (outcome: Settlement) => void;
  private outcome: Settlement | undefined;
  private finishing = false;
  private claimed = false;
  private effectStarted = false;
  private accountingUncertain = false;
  private reservation: CatalogToolBudgetReservation | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly cleanup: (() => void)[] = [];
  private deadlineAt = Number.POSITIVE_INFINITY;
  private discarded = false;

  public constructor(
    public readonly state: CatalogBindingState,
    public readonly context: CatalogTrustedContext,
    public readonly identity: CatalogActionIdentity,
  ) {
    this.invocationId = mintCatalogId(state);
    this.settlementId = mintCatalogId(state);
    this.startedAt = state.options.now();
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
  public get settled(): boolean {
    return this.finishing || this.outcome !== undefined;
  }
  public markClaimed(signal: AbortSignal): void {
    this.claimed = true;
    this.watch(signal);
  }
  public arm(): void {
    const duration = this.handler?.descriptor.bounds.maxDurationMs ?? 30_000;
    this.deadlineAt = Math.min(Date.parse(this.context.deadlineAt), this.startedAt + duration);
    requireDispatch(Number.isSafeInteger(this.deadlineAt), "invalid", "recovery-required");
    this.watch(this.context.signal);
    this.timer = setTimeout(
      () => {
        this.checkStopped();
      },
      Math.max(0, this.deadlineAt - this.state.options.now()),
    );
    this.timer.unref();
    this.checkStopped();
  }
  private watch(signal: AbortSignal): void {
    const stop = (): void => {
      this.checkStopped(signal);
    };
    signal.addEventListener("abort", stop, { once: true });
    this.cleanup.push(() => {
      signal.removeEventListener("abort", stop);
    });
    if (signal.aborted) stop();
  }
  public checkStopped(additionalSignal?: AbortSignal): boolean {
    if (this.settled) return true;
    if (this.state.options.now() >= this.deadlineAt) {
      this.finish("timeout", "deadline-exceeded");
      return true;
    }
    if (this.context.signal.aborted || additionalSignal?.aborted === true) {
      this.finish("cancelled", "parent-cancelled");
      return true;
    }
    return false;
  }
  public reserve(): void {
    requireDispatch(this.handler !== undefined, "failed", "handler-unavailable");
    const descriptor = this.handler.descriptor;
    const reserved = catalogBudgetOperation(() =>
      this.state.input.budgetPort.reserve(descriptor, this.context, this.invocationId),
    );
    requireDispatch(reserved !== undefined, "denied", "budget-exhausted");
    this.continuation?.assertFreshReservation(reserved);
    // Qualify the trusted port's bounded receipt before it can enter lifecycle evidence.
    captureToolInvocationReceipt({
      invocationId: this.invocationId,
      settlementId: this.settlementId,
      reservationId: reserved.reservationId,
      status: "cancelled",
      effectStarted: false,
      budgetDisposition: "released",
    });
    this.reservation = Object.freeze({ ...reserved });
  }
  public createCursor(): string {
    requireDispatch(
      !this.settled && this.reservation !== undefined && this.continuation !== undefined,
      "invalid",
      "cursor-invalid",
    );
    return this.continuation.issue(this.reservation);
  }
  public started(): void {
    requireDispatch(
      this.handler !== undefined && this.reservation !== undefined,
      "failed",
      "handler-mismatch",
    );
    emitToolLifecycleEvent(this.state.input.logPort, {
      ...lifecycleIdentity(this.state, this.context),
      op: "tool-catalog.invocation-started",
      invocationId: this.invocationId,
      toolRef: this.handler.descriptor.toolRef,
      state: "started",
      reason: "none",
      reservationId: this.reservation.reservationId,
    });
  }
  public beforeEffect(guard: CodingToolMutationGuard, revalidate: () => void): boolean {
    if (this.checkStopped()) return false;
    try {
      revalidate();
      requireDispatch(
        this.reservation !== undefined &&
          catalogBudgetOperation(
            () =>
              this.reservation !== undefined &&
              this.state.input.budgetPort.check(this.reservation, this.context),
          ),
        "denied",
        "budget-exhausted",
      );
      requireDispatch(guard.check(), "denied", "effect-denied");
      if (this.checkStopped()) return false;
      this.effectStarted = true;
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }
  public complete(source: CatalogHandlerResult): void {
    if (this.checkStopped()) {
      this.discardCompletion();
      return;
    }
    try {
      requireDispatch(this.effectStarted, "failed", "effect-outcome-unknown");
      const data = captureCatalogJson(source.data, this.handler?.descriptor.bounds.maxResultBytes);
      const candidate = this.envelope("completed", "none", data, source);
      requireDispatch(
        this.continuation?.owns(candidate.page?.cursor ?? null) === true,
        "failed",
        "result-contract-failed",
      );
      if (this.checkStopped()) {
        this.discardCompletion();
        return;
      }
      this.finish("completed", "none", candidate);
    } catch (error) {
      this.finish("failed", "result-contract-failed", undefined, error);
    }
  }
  public fail(error: unknown): void {
    if (this.checkStopped()) {
      this.discardCompletion();
      return;
    }
    if (error instanceof CatalogDispatchFault)
      this.finish(error.status, error.reason, undefined, error);
    else this.finish("failed", "handler-failed", undefined, error);
  }
  private envelope(
    status: ToolResultStatus,
    reason: ToolResultReason,
    data: CatalogJsonValue = null,
    source?: CatalogHandlerResult,
  ): ToolResultEnvelope {
    const descriptor = this.handler?.descriptor;
    return validateToolResultEnvelope(
      {
        schemaVersion: 1,
        invocationId: this.invocationId,
        toolRef: descriptor?.toolRef ?? null,
        projectionDigest: this.state.projection.projectionDigest,
        status,
        reason,
        effectStarted: this.effectStarted,
        metrics: this.metrics(data, source),
        data,
        page: source?.page ?? null,
      },
      descriptor === undefined
        ? undefined
        : { descriptor, projectionDigest: this.state.projection.projectionDigest },
    );
  }
  private metrics(
    data: CatalogJsonValue,
    source: CatalogHandlerResult | undefined,
  ): ToolResultMetrics {
    return {
      inputBytes: this.inputBytes,
      outputBytes: source === undefined ? 0 : catalogJsonBytes(data),
      resultCount: source?.resultCount ?? 0,
      durationMs: Math.max(0, this.state.options.now() - this.startedAt),
    };
  }
  public finish(
    status: ToolResultStatus,
    reason: ToolResultReason,
    result?: ToolResultEnvelope,
    error?: unknown,
  ): void {
    if (this.settled) return;
    this.finishing = true;
    this.stopWatching();
    const initialTerminal = result ?? this.envelope(status, reason);
    let terminal = initialTerminal;
    try {
      this.account();
    } catch (error_) {
      this.accountingUncertain = true;
      terminal = this.envelope("failed", "budget-port-failed");
      error = error_;
    }
    this.continuation?.discardUnless(terminal.page?.cursor ?? null);
    const receipt = this.receipt(terminal.status);
    this.outcome = { kind: "settled", result: terminal, receipt };
    const outcome = this.outcome;
    if (this.claimed)
      this.state.options.invocationRegistry.settle(
        { ...this.identity, runId: this.context.runId },
        receipt,
      );
    this.controller.abort();
    // The dispatch promise resolves in `finally` no matter what: a shape failure inside
    // `emitSettlement` (an unvalidated correlation id, item 17) must not leave the caller waiting
    // on a promise that never settles (b3-10). The failure itself still gets a body-free
    // diagnostic instead of vanishing as an unhandled rejection.
    try {
      this.emitSettlement(terminal, receipt, error);
    } catch (emitFailure) {
      this.settlementEmitFailure(emitFailure);
    } finally {
      this.resolve(outcome);
    }
  }
  private account(): void {
    if (this.reservation === undefined) return;
    if (this.effectStarted) this.state.input.budgetPort.commit(this.reservation);
    else this.state.input.budgetPort.release(this.reservation);
  }
  private receipt(status: ToolResultStatus): ToolInvocationReceipt {
    return captureToolInvocationReceipt({
      invocationId: this.invocationId,
      settlementId: this.settlementId,
      reservationId: this.reservation?.reservationId ?? null,
      status,
      effectStarted: this.effectStarted,
      budgetDisposition: this.budgetDisposition(),
    });
  }
  private budgetDisposition(): ToolInvocationReceipt["budgetDisposition"] {
    if (this.reservation === undefined) return "not-reserved";
    if (this.accountingUncertain)
      return this.effectStarted ? "commit-uncertain" : "release-uncertain";
    return this.effectStarted ? "committed" : "released";
  }
  private emitSettlement(
    result: ToolResultEnvelope,
    receipt: ToolInvocationReceipt,
    error: unknown,
  ): void {
    emitToolLifecycleEvent(this.state.input.logPort, {
      ...lifecycleIdentity(this.state, this.context),
      op: "tool-catalog.invocation-settled",
      ...receipt,
      toolRef: result.toolRef,
      reason: result.reason,
      ...result.metrics,
      truncated: result.page?.truncated ?? false,
      ...(result.status === "failed"
        ? {
            errorKind: errorKindOf(error),
            frames: keikoStackFrames(error),
            causeChain: causeChain(error),
          }
        : {}),
    });
  }
  private settlementEmitFailure(error: unknown): void {
    emitServerDiagnostic(
      this.state.input.logPort.diagnostics,
      serverDiagnosticFromError({
        correlationId: correlationIdOrUnknown(this.context.correlationId),
        operation: "tool-catalog.settlement-emit-failed",
        source: "tool-catalog-settlement",
        error,
        redact: () => "server-operation-failed",
      }),
    );
  }
  private stopWatching(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    for (const cleanup of this.cleanup) cleanup();
    this.cleanup.length = 0;
  }
  public discardCompletion(): void {
    if (this.discarded || this.outcome === undefined || this.handler === undefined) return;
    this.discarded = true;
    emitToolLifecycleEvent(this.state.input.logPort, {
      ...lifecycleIdentity(this.state, this.context),
      op: "tool-catalog.completion-discarded",
      invocationId: this.invocationId,
      toolRef: this.handler.descriptor.toolRef,
      settlementId: this.settlementId,
      reason: "late-completion",
    });
  }
}
export function mintCatalogId(state: CatalogBindingState): string {
  const id = state.options.mintId();
  requireDispatch(/^[A-Za-z0-9_-]{1,128}$/u.test(id), "invalid", "recovery-required");
  return id;
}
