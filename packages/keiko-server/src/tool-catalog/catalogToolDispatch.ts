import type { CatalogConsumer, CodingCatalogConsumer } from "./catalogToolPorts.js";
/** Canonical offer, dispatch, replay, cursor, deadline, and settlement owner. Production coding
 * tool calls adapt their parsed request at `catalogToolFacadeBridge.ts` and enter this path. */
import { Buffer } from "node:buffer";
import { catalogJsonBytes } from "@oscharko-dev/keiko-tool-catalog";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import { GOVERNED_TOOL_SETTLEMENT_GRACE_MS } from "@oscharko-dev/keiko-contracts/runtime/tools";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import {
  catalogBoundToolSet,
  catalogHandlerFor,
  createCatalogBinding,
  createCatalogBindingFromPreparation,
  createCatalogBindingPreparation,
  createCatalogOffer,
  createCatalogOfferForTool,
  type CatalogBindingPreparation,
  type CatalogBindingState,
} from "./catalogToolBinder.js";
import {
  approveCatalogAction,
  catalogBudgetOperation,
  captureCatalogInvocation,
  captureHandlerAction,
  catalogDispatchContext,
  requireDispatch,
  revalidateCatalogContext,
} from "./catalogToolRuntimeAuthority.js";
import { CATALOG_CURSOR_ID_PREFIX } from "./catalogToolCursor.js";
import { CatalogContinuation } from "./catalogToolContinuation.js";
import { catalogRequestDigest } from "./catalogToolRequest.js";
import { CatalogInvocation } from "./catalogToolSettlement.js";
import type {
  BoundToolInvocation,
  CatalogActionIdentity,
  CatalogHandlerContext,
  CatalogToolBinder,
  CatalogToolBinderInput,
  CatalogToolBinderOptions,
  CatalogToolDispatchOutcome,
  CatalogToolExecutionOverride,
} from "./catalogToolPorts.js";

function claimInvocation<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  invocation: CatalogInvocation<Consumer>,
  request: BoundToolInvocation,
): CatalogToolDispatchOutcome | undefined {
  const { context, identity, state } = invocation;
  const payload = Buffer.from(canonicalise(request.arguments));
  const digest = catalogRequestDigest(request, invocation.scopeDigest, identity.idempotencyKey);
  const staged = state.options.invocationRegistry.stage({
    ...identity,
    runId: context.runId,
    digest,
    payload,
    authorityExpiresAt: context.authorityExpiresAt,
    // Held until the catalog has settled the call: its descriptor's budget plus one grace, so the
    // catalog's own timeout always answers first (F43/F44, PR #3452).
    lifeMs: invocation.settlementBudgetMs + GOVERNED_TOOL_SETTLEMENT_GRACE_MS,
  });
  if (staged.kind !== "staged") payload.fill(0);
  if (staged.kind === "replayed") {
    const prior = state.options.invocationRegistry.inspect({ ...identity, runId: context.runId });
    if (prior.kind === "terminal" && prior.receipt !== undefined) {
      revalidateReplay<Consumer>(invocation, request);
      return { kind: "replayed", receipt: prior.receipt };
    }
    requireDispatch(prior.kind !== "in-flight", "busy", "invocation-in-flight");
    requireDispatch(false, "invalid", "recovery-required");
  }
  requireDispatch(staged.kind !== "busy", "busy", "capacity-exhausted");
  requireDispatch(staged.kind !== "duplicate", "busy", "invocation-in-flight");
  requireDispatch(staged.kind !== "conflict", "invalid", "replay-conflict");
  requireDispatch(staged.kind !== "revoked", "denied", "authority-revoked");
  requireDispatch(staged.kind === "staged", "invalid", "invalid-arguments");
  const taken = state.options.invocationRegistry.take({ ...identity, runId: context.runId });
  requireDispatch(taken.kind === "ready", "invalid", "recovery-required");
  invocation.markClaimed(taken.signal);
  return undefined;
}
function revalidateReplay<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  invocation: CatalogInvocation<Consumer>,
  request: BoundToolInvocation,
): void {
  const context = currentContext<Consumer>(invocation);
  requireDispatch(invocation.handler !== undefined, "failed", "handler-unavailable");
  const action = captureHandlerAction<Consumer>(
    invocation.state.input.consumerPort,
    invocation.handler,
    request.arguments,
    invocation.identity,
    invocation.state.executionOverride,
    invocation.state.profile,
  );
  const preview = invocation.state.input.authorityPort.preview(context.authority, action);
  // Receipt-only replay performs no new action; it neither consumes an old approval nor requests another.
  requireDispatch(preview.ok || preview.reason === "approval-required", "denied", "hard-denial");
}
function currentContext<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  invocation: CatalogInvocation<Consumer>,
): Consumer["context"] {
  requireDispatch(invocation.handler !== undefined, "failed", "handler-unavailable");
  return revalidateCatalogContext<Consumer>(
    invocation.state,
    invocation.context,
    invocation.handler,
    invocation.admittedAt,
    invocation.scopeDigest,
  );
}
function handlerContext<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  invocation: CatalogInvocation<Consumer>,
  request: Consumer["action"],
): CatalogHandlerContext<Consumer> {
  const context = currentContext<Consumer>(invocation);
  const admitted = invocation.state.input.authorityPort.admit(context.authority, request);
  requireDispatch(admitted.ok, "denied", "hard-denial");
  const beforeEffect = (): boolean =>
    invocation.beforeEffect(admitted.mutationGuard, () => {
      currentContext<Consumer>(invocation);
    });
  return {
    ...context,
    invocationId: invocation.invocationId,
    signal: invocation.controller.signal,
    mutationGuard: {
      ...admitted.mutationGuard,
      check: beforeEffect,
      executionBudget: {
        nowMs: () => invocation.state.options.now(),
        deadlineAtMs: invocation.deadlineAtMs,
      },
    },
    beforeEffect,
    pageSequence: invocation.continuation?.pageSequence ?? 0,
    createCursor: (): string => {
      requireDispatch(beforeEffect(), "denied", "effect-denied");
      return invocation.createCursor();
    },
  };
}
async function executeInvocation<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  invocation: CatalogInvocation<Consumer>,
  input: BoundToolInvocation,
): Promise<void> {
  try {
    if (invocation.checkStopped()) return;
    const initial = currentContext<Consumer>(invocation);
    const handler = invocation.handler;
    requireDispatch(handler?.binding !== undefined, "failed", "handler-unavailable");
    const action = captureHandlerAction<Consumer>(
      invocation.state.input.consumerPort,
      handler,
      input.arguments,
      invocation.identity,
      invocation.state.executionOverride,
      invocation.state.profile,
    );
    const approved = await approveCatalogAction<Consumer>(invocation.state, action, {
      ...initial,
      signal: invocation.controller.signal,
    });
    if (invocation.checkStopped()) return;
    const current = currentContext<Consumer>(invocation);
    requireDispatch(
      catalogBudgetOperation(() =>
        invocation.state.input.budgetPort.available(handler.descriptor, current),
      ),
      "denied",
      "budget-exhausted",
    );
    invocation.reserve();
    const context = handlerContext<Consumer>(invocation, approved);
    if (invocation.checkStopped()) return;
    invocation.started();
    const execute = invocation.state.executionOverride?.execute ?? handler.binding.execute;
    const result = await execute(input.arguments, context);
    invocation.complete(result);
  } catch (error) {
    invocation.fail(error);
  }
}
// `catalogDispatchContext` runs before a `CatalogInvocation` exists to route a failure through
// (`state.options.context()` is a caller-supplied callback and can throw). Without this guard the
// throw reached no lifecycle event and no diagnostic (b3-18); this mirrors `bindingFailure` in
// `catalogToolBinder.ts` -- correlation id unknown by construction, since establishing it is
// exactly what failed.
function dispatchContextFailure<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  state: CatalogBindingState<Consumer>,
  error: unknown,
): void {
  emitServerDiagnostic(
    state.input.logPort.diagnostics,
    serverDiagnosticFromError({
      correlationId: UNKNOWN_CORRELATION_ID,
      operation: "tool-catalog.dispatch-context-failed",
      source: "tool-catalog-dispatch",
      error,
      redact: () => "server-operation-failed",
    }),
  );
}
function dispatchCatalogInvocation<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  state: CatalogBindingState<Consumer>,
  source: unknown,
  identity: CatalogActionIdentity,
  cursor?: string,
): Promise<CatalogToolDispatchOutcome> {
  let context: Consumer["context"];
  let invocation: CatalogInvocation<Consumer>;
  try {
    context = catalogDispatchContext<Consumer>(state);
    invocation = new CatalogInvocation<Consumer>(state, context, Object.freeze({ ...identity }));
  } catch (error) {
    dispatchContextFailure<Consumer>(state, error);
    // Matches `createCatalogBinding`/`createCatalogOffer` in `catalogToolBinder.ts`: an unknown
    // caught value never leaves this module unwrapped.
    return Promise.reject(new TypeError("Invalid catalog dispatch context", { cause: error }));
  }
  try {
    requireDispatch(
      !identity.actionId.startsWith(CATALOG_CURSOR_ID_PREFIX) &&
        !identity.idempotencyKey.startsWith(CATALOG_CURSOR_ID_PREFIX),
      "invalid",
      "invalid-arguments",
    );
    const input = captureCatalogInvocation<Consumer>(state, source);
    invocation.handler = catalogHandlerFor<Consumer>(state, input.toolRef);
    invocation.inputBytes = catalogJsonBytes(input.arguments);
    const replay = claimInvocation<Consumer>(invocation, input);
    if (replay !== undefined) return Promise.resolve(replay);
    invocation.continuation = new CatalogContinuation<Consumer>(
      state,
      context,
      input,
      invocation.identity,
      invocation.scopeDigest,
    );
    if (cursor !== undefined) invocation.continuation.resume(cursor);
    invocation.arm();
    void executeInvocation<Consumer>(invocation, input);
  } catch (error) {
    invocation.fail(error);
  }
  return invocation.promise;
}
/** Composition supplies domain handlers and the existing authority, invocation and run-budget owners. */
export function createCatalogToolBinder<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  input: CatalogToolBinderInput<Consumer>,
  options: CatalogToolBinderOptions<Consumer>,
): CatalogToolBinder {
  return binderForState<Consumer>(createCatalogBinding<Consumer>(input, options));
}

export function prepareCatalogToolBinder<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  input: CatalogToolBinderInput<Consumer>,
  catalog: CatalogToolBinderOptions<Consumer>["catalog"],
): CatalogBindingPreparation<Consumer> {
  // A prepared binding is reused across availability-mask variants. Keep whole-set readiness
  // invocation-local: each selected binding still has its live readiness callback, while a
  // derived variant removes identities observed unavailable at its attested snapshot.
  return createCatalogBindingPreparation<Consumer>(input, catalog, false);
}

export { deriveCatalogBindingPreparation } from "./catalogToolBinder.js";

export function createCatalogToolBinderFromPreparation<
  Consumer extends CatalogConsumer = CodingCatalogConsumer,
>(
  preparation: CatalogBindingPreparation<Consumer>,
  options: CatalogToolBinderOptions<Consumer>,
  executionOverride: CatalogToolExecutionOverride<Consumer>,
): CatalogToolBinder {
  return binderForState<Consumer>(
    createCatalogBindingFromPreparation<Consumer>(preparation, options, executionOverride),
  );
}

function binderForState<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  state: CatalogBindingState<Consumer>,
): CatalogToolBinder {
  return Object.freeze({
    dispatchPage: (
      source: unknown,
      identity: CatalogActionIdentity,
      cursor: string,
    ): Promise<CatalogToolDispatchOutcome> =>
      dispatchCatalogInvocation<Consumer>(state, source, identity, cursor),
    binding: (): ReturnType<typeof catalogBoundToolSet> => catalogBoundToolSet<Consumer>(state),
    offer: (): ReturnType<typeof createCatalogOffer> => createCatalogOffer<Consumer>(state),
    offerTool: (
      toolRef: BoundToolInvocation["toolRef"],
    ): ReturnType<typeof createCatalogOfferForTool> =>
      createCatalogOfferForTool<Consumer>(state, toolRef),
    dispatch: (
      source: unknown,
      identity: CatalogActionIdentity,
    ): Promise<CatalogToolDispatchOutcome> =>
      dispatchCatalogInvocation<Consumer>(state, source, identity),
  });
}
