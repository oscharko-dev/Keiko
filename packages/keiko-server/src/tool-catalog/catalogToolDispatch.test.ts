import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogToolFixture } from "./__fixtures__/catalogToolFixture.js";
import { createCatalogToolBinder } from "./catalogToolDispatch.js";
import type { ServerDiagnosticSink } from "../diagnostics-log.js";
import type { CatalogHandlerContext, CatalogHandlerResult } from "./catalogToolPorts.js";

function setup(): ReturnType<typeof catalogToolFixture> & {
  readonly binder: ReturnType<typeof createCatalogToolBinder>;
  readonly invocation: object;
} {
  const fixture = catalogToolFixture();
  const binder = createCatalogToolBinder(fixture.input, fixture.options);
  const offer = binder.offer();
  return {
    ...fixture,
    binder,
    invocation: {
      kind: "bound",
      toolRef: offer.toolRefs[0],
      projectionDigest: offer.binding.projectionDigest,
      offerId: offer.offerId,
      arguments: { path: "fixture.ts" },
    },
  };
}
const identity = { actionId: "action-1", idempotencyKey: "key-1" };
afterEach(() => {
  vi.useRealTimers();
});
describe("bound catalog dispatch", () => {
  it("runs a ready handler, validates the result, and replays only its body-free receipt", async () => {
    const fixture = setup();
    const result = await fixture.binder.dispatch(fixture.invocation, identity);
    expect(result.kind).toBe("settled");
    if (result.kind !== "settled") throw new TypeError("Expected settlement");
    expect(result.result).toMatchObject({
      status: "completed",
      data: { text: "fixture-result" },
      effectStarted: true,
    });
    const replay = await fixture.binder.dispatch(fixture.invocation, identity);
    expect(replay).toEqual({ kind: "replayed", receipt: result.receipt });
    expect(JSON.stringify(replay)).not.toContain("fixture-result");
    expect(
      fixture.primary.events.filter((event) => event.op === "tool-catalog.invocation-settled"),
    ).toHaveLength(1);
  });
  it.each([
    { workspaceRoot: "/evil" },
    { correlationId: "override" },
    { arguments: { path: "fixture.ts", authority: "evil" } },
    { projectionDigest: "a".repeat(64) },
    { offerId: "missing" },
  ])("rejects untrusted override or stale identity %j", async (patch) => {
    const fixture = setup();
    const result = await fixture.binder.dispatch({ ...fixture.invocation, ...patch }, identity);
    expect(result.kind === "settled" && result.result.status).toBe("invalid");
  });
  it("revalidates authority and budget after the offer", async () => {
    const fixture = setup();
    fixture.preview.mockReturnValue({ ok: false, reason: "action-not-authorized" });
    const denied = await fixture.binder.dispatch(fixture.invocation, identity);
    expect(denied.kind === "settled" && denied.result.status).toBe("denied");
    fixture.preview.mockReturnValue({ ok: true });
    fixture.budgetAvailable.mockReturnValue(false);
    const exhausted = await fixture.binder.dispatch(fixture.invocation, {
      actionId: "action-2",
      idempotencyKey: "key-2",
    });
    expect(exhausted.kind === "settled" && exhausted.result.reason).toBe("budget-exhausted");
  });
  it("captures arguments before awaiting approval and refuses approval action widening", async () => {
    const fixture = catalogToolFixture();
    fixture.preview.mockReturnValue({ ok: false, reason: "approval-required" });
    fixture.approvalAvailable.mockReturnValue(true);
    const binder = createCatalogToolBinder(
      {
        ...fixture.input,
        approvalPort: {
          available: fixture.approvalAvailable,
          request: (request) => Promise.resolve({ ...request, actionId: "evil" }),
        },
      },
      fixture.options,
    );
    const offer = binder.offer();
    const result = await binder.dispatch(
      {
        kind: "bound",
        toolRef: fixture.pure.descriptor.toolRef,
        projectionDigest: fixture.pure.projection.projectionDigest,
        offerId: offer.offerId,
        arguments: { path: "fixture.ts" },
      },
      identity,
    );
    expect(result.kind === "settled" && result.result.reason).toBe("approval-rejected");
  });
  it("settles cancellation once and discards late content without another charge", async () => {
    const fixture = catalogToolFixture();
    const controller = new AbortController();
    let complete: ((value: CatalogHandlerResult) => void) | undefined;
    let handlerContext: CatalogHandlerContext | undefined;
    const commit = vi.fn();
    const release = vi.fn();
    const binder = createCatalogToolBinder(
      {
        ...fixture.input,
        budgetPort: { ...fixture.input.budgetPort, commit, release },
        handlerBindings: [
          {
            ...fixture.handler,
            execute: (_args, context): Promise<CatalogHandlerResult> => {
              handlerContext = context;
              return new Promise((resolve) => {
                complete = resolve;
              });
            },
          },
        ],
      },
      { ...fixture.options, context: () => ({ ...fixture.context, signal: controller.signal }) },
    );
    const offer = binder.offer();
    const pending = binder.dispatch(
      {
        kind: "bound",
        toolRef: fixture.pure.descriptor.toolRef,
        projectionDigest: offer.binding.projectionDigest,
        offerId: offer.offerId,
        arguments: { path: "fixture.ts" },
      },
      identity,
    );
    await vi.waitFor(() => {
      expect(complete).toBeDefined();
    });
    controller.abort();
    const result = await pending;
    expect(result.kind === "settled" && result.result.status).toBe("cancelled");
    expect(handlerContext?.beforeEffect()).toBe(false);
    complete?.({
      data: { text: "late-secret" },
      page: { truncated: false, reason: "none", cursor: null },
      resultCount: 1,
    });
    await vi.waitFor(() => {
      expect(
        fixture.primary.events.some((event) => event.op === "tool-catalog.completion-discarded"),
      ).toBe(true);
    });
    expect(commit).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(
      fixture.primary.events.filter((event) => event.op === "tool-catalog.invocation-settled"),
    ).toHaveLength(1);
    expect(JSON.stringify(fixture.primary.events)).not.toContain("late-secret");
  });
  it("rejects with a diagnostic instead of throwing uncaught when the context callback itself fails (b3-18)", async () => {
    const fixture = catalogToolFixture();
    let contextShouldThrow = false;
    const contextFailure = new Error("context-source-unavailable");
    const diagnosticsRecord = vi.fn<ServerDiagnosticSink["record"]>();
    const binder = createCatalogToolBinder(
      { ...fixture.input, logPort: { primary: fixture.primary, diagnostics: { record: diagnosticsRecord } } },
      {
        ...fixture.options,
        context: () => {
          if (contextShouldThrow) throw contextFailure;
          return fixture.context;
        },
      },
    );
    // Establishing the offer succeeds first (the context callback works fine here) -- only the
    // later dispatch call observes the callback failing.
    const offer = binder.offer();
    contextShouldThrow = true;
    await expect(
      binder.dispatch(
        {
          kind: "bound",
          toolRef: fixture.pure.descriptor.toolRef,
          projectionDigest: offer.binding.projectionDigest,
          offerId: offer.offerId,
          arguments: { path: "fixture.ts" },
        },
        identity,
      ),
    ).rejects.toMatchObject({
      name: "TypeError",
      message: "Invalid catalog dispatch context",
      cause: contextFailure,
    });
    expect(diagnosticsRecord).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "tool-catalog.dispatch-context-failed" }),
    );
  });
});
