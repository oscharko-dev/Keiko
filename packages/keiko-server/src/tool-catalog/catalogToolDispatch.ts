/** Canonical offer, dispatch, replay, cursor, deadline, and settlement owner. Production coding
 * tool calls adapt their parsed request at `catalogToolFacadeBridge.ts` and enter this path. */
import { Buffer } from "node:buffer";
import { catalogJsonBytes } from "@oscharko-dev/keiko-tool-catalog";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import type { CodingToolActionRequest } from "../coding-runtime/codingToolIpc.js";
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
  CatalogTrustedContext,
} from "./catalogToolPorts.js";

function claimInvocation(
  invocation: CatalogInvocation,
  request: BoundToolInvocation,
): CatalogToolDispatchOutcome | undefined {
  const { context, identity, state } = invocation;
  const payload = Buffer.from(canonicalise(request.arguments));
  const digest = catalogRequestDigest(request, context, identity.idempotencyKey);
  const staged = state.options.invocationRegistry.stage({
    ...identity,
    runId: context.runId,
    digest,
    payload,
    authorityExpiresAt: context.authorityExpiresAt,
  });
  if (staged.kind !== "staged") payload.fill(0);
  if (staged.kind === "replayed") {
    const prior = state.options.invocationRegistry.inspect({ ...identity, runId: context.runId });
    if (prior.kind === "terminal" && prior.receipt !== undefined) {
      revalidateReplay(invocation, request);
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
function revalidateReplay(invocation: CatalogInvocation, request: BoundToolInvocation): void {
  const context = currentContext(invocation);
  requireDispatch(invocation.handler !== undefined, "failed", "handler-unavailable");
  const action = captureHandlerAction(
    invocation.handler,
    request.arguments,
    invocation.identity,
    invocation.state.executionOverride,
  );
  const preview = invocation.state.input.authorityPort.preview(context.authority, action);
  // Receipt-only replay performs no new action; it neither consumes an old approval nor requests another.
  requireDispatch(preview.ok || preview.reason === "approval-required", "denied", "hard-denial");
}
function currentContext(invocation: CatalogInvocation): ReturnType<typeof catalogDispatchContext> {
  requireDispatch(invocation.handler !== undefined, "failed", "handler-unavailable");
  return revalidateCatalogContext(invocation.state, invocation.context, invocation.handler);
}
function handlerContext(
  invocation: CatalogInvocation,
  request: CodingToolActionRequest,
): CatalogHandlerContext {
  const context = currentContext(invocation);
  const admitted = invocation.state.input.authorityPort.admit(context.authority, request);
  requireDispatch(admitted.ok, "denied", "hard-denial");
  const beforeEffect = (): boolean =>
    invocation.beforeEffect(admitted.mutationGuard, () => {
      currentContext(invocation);
    });
  return {
    ...context,
    invocationId: invocation.invocationId,
    signal: invocation.controller.signal,
    mutationGuard: { ...admitted.mutationGuard, check: beforeEffect },
    beforeEffect,
    pageSequence: invocation.continuation?.pageSequence ?? 0,
    createCursor: (): string => {
      requireDispatch(beforeEffect(), "denied", "effect-denied");
      return invocation.createCursor();
    },
  };
}
async function executeInvocation(
  invocation: CatalogInvocation,
  input: BoundToolInvocation,
): Promise<void> {
  try {
    if (invocation.checkStopped()) return;
    const initial = currentContext(invocation);
    const handler = invocation.handler;
    requireDispatch(handler?.binding !== undefined, "failed", "handler-unavailable");
    const action = captureHandlerAction(
      handler,
      input.arguments,
      invocation.identity,
      invocation.state.executionOverride,
    );
    const approved = await approveCatalogAction(invocation.state, action, initial);
    if (invocation.checkStopped()) return;
    const current = currentContext(invocation);
    requireDispatch(
      catalogBudgetOperation(() =>
        invocation.state.input.budgetPort.available(handler.descriptor, current),
      ),
      "denied",
      "budget-exhausted",
    );
    invocation.reserve();
    const context = handlerContext(invocation, approved);
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
function dispatchContextFailure(state: CatalogBindingState, error: unknown): void {
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
function dispatchCatalogInvocation(
  state: CatalogBindingState,
  source: unknown,
  identity: CatalogActionIdentity,
  cursor?: string,
): Promise<CatalogToolDispatchOutcome> {
  let context: CatalogTrustedContext;
  try {
    context = catalogDispatchContext(state);
  } catch (error) {
    dispatchContextFailure(state, error);
    // Matches `createCatalogBinding`/`createCatalogOffer` in `catalogToolBinder.ts`: an unknown
    // caught value never leaves this module unwrapped.
    return Promise.reject(new TypeError("Invalid catalog dispatch context", { cause: error }));
  }
  const invocation = new CatalogInvocation(state, context, Object.freeze({ ...identity }));
  try {
    requireDispatch(
      !identity.actionId.startsWith(CATALOG_CURSOR_ID_PREFIX) &&
        !identity.idempotencyKey.startsWith(CATALOG_CURSOR_ID_PREFIX),
      "invalid",
      "invalid-arguments",
    );
    const input = captureCatalogInvocation(state, source);
    invocation.handler = catalogHandlerFor(state, input.toolRef);
    invocation.inputBytes = catalogJsonBytes(input.arguments);
    const replay = claimInvocation(invocation, input);
    if (replay !== undefined) return Promise.resolve(replay);
    invocation.continuation = new CatalogContinuation(state, context, input, invocation.identity);
    if (cursor !== undefined) invocation.continuation.resume(cursor);
    invocation.arm();
    void executeInvocation(invocation, input);
  } catch (error) {
    invocation.fail(error);
  }
  return invocation.promise;
}
/** Composition supplies domain handlers and the existing authority, invocation and run-budget owners. */
export function createCatalogToolBinder(
  input: CatalogToolBinderInput,
  options: CatalogToolBinderOptions,
): CatalogToolBinder {
  return binderForState(createCatalogBinding(input, options));
}

export function prepareCatalogToolBinder(
  input: CatalogToolBinderInput,
  catalog: CatalogToolBinderOptions["catalog"],
): CatalogBindingPreparation {
  return createCatalogBindingPreparation(input, catalog);
}

export { deriveCatalogBindingPreparation } from "./catalogToolBinder.js";

export function createCatalogToolBinderFromPreparation(
  preparation: CatalogBindingPreparation,
  options: CatalogToolBinderOptions,
  executionOverride: CatalogToolExecutionOverride,
): CatalogToolBinder {
  return binderForState(
    createCatalogBindingFromPreparation(preparation, options, executionOverride),
  );
}

function binderForState(state: CatalogBindingState): CatalogToolBinder {
  return Object.freeze({
    dispatchPage: (
      source: unknown,
      identity: CatalogActionIdentity,
      cursor: string,
    ): Promise<CatalogToolDispatchOutcome> =>
      dispatchCatalogInvocation(state, source, identity, cursor),
    binding: (): ReturnType<typeof catalogBoundToolSet> => catalogBoundToolSet(state),
    offer: (): ReturnType<typeof createCatalogOffer> => createCatalogOffer(state),
    offerTool: (
      toolRef: BoundToolInvocation["toolRef"],
    ): ReturnType<typeof createCatalogOfferForTool> => createCatalogOfferForTool(state, toolRef),
    dispatch: (
      source: unknown,
      identity: CatalogActionIdentity,
    ): Promise<CatalogToolDispatchOutcome> => dispatchCatalogInvocation(state, source, identity),
  });
}
