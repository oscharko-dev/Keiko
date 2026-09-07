import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogToolBinder } from "./catalogToolDispatch.js";
import { catalogToolFixture } from "./__fixtures__/catalogToolFixture.js";
import type { ServerDiagnosticSink } from "../diagnostics-log.js";
import type {
  CatalogHandlerContext,
  CatalogHandlerResult,
  CatalogToolBinderInput,
  CatalogTrustedContext,
} from "./catalogToolPorts.js";

// b3-10: `CatalogInvocation.finish()` must resolve its dispatch promise even when the lifecycle
// emit itself throws (an invalid event shape reaching `emitToolLifecycleEvent`, e.g. item 17's
// unvalidated correlation id). Only the terminal "invocation-settled" emit is made to throw here,
// so every other test in this file keeps exercising the real lifecycle producer.
let failSettledEmit = false;
vi.mock("./catalogToolLifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./catalogToolLifecycle.js")>();
  return {
    ...actual,
    emitToolLifecycleEvent: (
      port: Parameters<typeof actual.emitToolLifecycleEvent>[0],
      source: unknown,
    ): void => {
      const event = source as { op?: string };
      if (failSettledEmit && event.op === "tool-catalog.invocation-settled") {
        throw new TypeError("Invalid tool lifecycle evidence");
      }
      actual.emitToolLifecycleEvent(port, source);
    },
  };
});

const ID = { actionId: "action-1", idempotencyKey: "key-1" };
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  return {
    promise: new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    }),
    resolve,
    reject,
  };
}
function fixtureWith(
  input?: (fixture: ReturnType<typeof catalogToolFixture>) => CatalogToolBinderInput,
  context?: (fixture: ReturnType<typeof catalogToolFixture>) => CatalogTrustedContext,
): ReturnType<typeof catalogToolFixture> & {
  binder: ReturnType<typeof createCatalogToolBinder>;
  request: object;
} {
  const fixture = catalogToolFixture();
  const binder = createCatalogToolBinder(input?.(fixture) ?? fixture.input, {
    ...fixture.options,
    context: () => context?.(fixture) ?? fixture.context,
  });
  const offer = binder.offer();
  return {
    ...fixture,
    binder,
    request: {
      kind: "bound",
      toolRef: fixture.pure.descriptor.toolRef,
      projectionDigest: offer.binding.projectionDigest,
      offerId: offer.offerId,
      arguments: { path: "fixture.ts" },
    },
  };
}
const RESULT: CatalogHandlerResult = {
  data: { text: "safe-result" },
  page: { truncated: false, reason: "none", cursor: null },
  resultCount: 1,
};
afterEach(() => {
  vi.useRealTimers();
});
describe("catalog invocation settlement races", () => {
  it("gives an authoritative elapsed deadline precedence over cancellation at the same instant", async () => {
    const started = deferred<CatalogHandlerContext>();
    const controller = new AbortController();
    const fixture = fixtureWith(
      (f) => ({
        ...f.input,
        handlerBindings: [
          {
            ...f.handler,
            execute: (_args, context): Promise<CatalogHandlerResult> => {
              started.resolve(context);
              return new Promise(() => undefined);
            },
          },
        ],
      }),
      (f) => ({ ...f.context, signal: controller.signal }),
    );
    const pending = fixture.binder.dispatch(fixture.request, ID);
    const context = await started.promise;
    fixture.now.mockReturnValue(6000);
    controller.abort();
    const outcome = await pending;
    expect(outcome.kind === "settled" && outcome.result.status).toBe("timeout");
    expect(context.beforeEffect()).toBe(false);
    expect(context.signal.aborted).toBe(true);
  });
  it("settles a cooperative timeout even if the handler never resolves", async () => {
    vi.useFakeTimers();
    const started = deferred<undefined>();
    const fixture = fixtureWith((f) => ({
      ...f.input,
      handlerBindings: [
        {
          ...f.handler,
          execute: (): Promise<CatalogHandlerResult> => {
            started.resolve(undefined);
            return new Promise(() => undefined);
          },
        },
      ],
    }));
    const pending = fixture.binder.dispatch(fixture.request, ID);
    await started.promise;
    fixture.now.mockReturnValue(6000);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).kind).toBe("settled");
    expect(fixture.primary.events.at(-1)?.extra?.status).toBe("timeout");
  });
  it.each(["synchronous", "asynchronous"] as const)(
    "settles %s exceptions body-free and releases the reservation once",
    async (kind) => {
      const release = vi.fn();
      const fixture = fixtureWith((f) => ({
        ...f.input,
        budgetPort: { ...f.input.budgetPort, release },
        handlerBindings: [
          {
            ...f.handler,
            execute: (): Promise<CatalogHandlerResult> => {
              const error = new TypeError("secret-path-and-query");
              if (kind === "synchronous") throw error;
              return Promise.reject(error);
            },
          },
        ],
      }));
      const outcome = await fixture.binder.dispatch(fixture.request, ID);
      expect(outcome.kind === "settled" && outcome.result.reason).toBe("handler-failed");
      expect(release).toHaveBeenCalledOnce();
      expect(fixture.primary.events.at(-1)?.extra).toMatchObject({
        status: "failed",
        errorKind: "TypeError",
      });
      expect(JSON.stringify(fixture.primary.events)).not.toContain("secret-path-and-query");
    },
  );
  it.each([
    { data: { text: "x".repeat(65) } },
    { data: { text: "x", credentials: "secret" } },
    { resultCount: 2 },
    { page: { truncated: false, reason: "result-cap", cursor: null } },
  ])("turns malformed results into a failed bounded envelope %j", async (patch) => {
    const fixture = fixtureWith((f) => ({
      ...f.input,
      handlerBindings: [
        {
          ...f.handler,
          execute: (_args, context): Promise<CatalogHandlerResult> => {
            context.beforeEffect();
            return Promise.resolve({ ...RESULT, ...patch } as CatalogHandlerResult);
          },
        },
      ],
    }));
    const outcome = await fixture.binder.dispatch(fixture.request, ID);
    expect(outcome.kind === "settled" && outcome.result).toMatchObject({
      status: "failed",
      reason: "result-contract-failed",
      data: null,
      effectStarted: true,
    });
  });
  it("returns busy for an active identity and rejects different arguments without duplicate effect", async () => {
    const started = deferred<undefined>();
    const result = deferred<CatalogHandlerResult>();
    const commit = vi.fn();
    const fixture = fixtureWith((f) => ({
      ...f.input,
      budgetPort: { ...f.input.budgetPort, commit },
      handlerBindings: [
        {
          ...f.handler,
          execute: (_args, context): Promise<CatalogHandlerResult> => {
            context.beforeEffect();
            started.resolve(undefined);
            return result.promise;
          },
        },
      ],
    }));
    const first = fixture.binder.dispatch(fixture.request, ID);
    await started.promise;
    const duplicate = await fixture.binder.dispatch(fixture.request, ID);
    expect(duplicate.kind === "settled" && duplicate.result.status).toBe("busy");
    const conflict = await fixture.binder.dispatch(
      { ...fixture.request, arguments: { path: "other.ts" } },
      ID,
    );
    expect(conflict.kind === "settled" && conflict.result.reason).toBe("replay-conflict");
    result.resolve(RESULT);
    await first;
    expect(commit).toHaveBeenCalledOnce();
  });
  it("rechecks workspace revision at the final effect boundary", async () => {
    const started = deferred<CatalogHandlerContext>();
    const result = deferred<CatalogHandlerResult>();
    let revision = "a".repeat(40);
    const fixture = fixtureWith(
      (f) => ({
        ...f.input,
        handlerBindings: [
          {
            ...f.handler,
            execute: (_args, context): Promise<CatalogHandlerResult> => {
              started.resolve(context);
              return result.promise;
            },
          },
        ],
      }),
      (f) => ({ ...f.context, workspaceRevision: revision }),
    );
    const pending = fixture.binder.dispatch(fixture.request, ID);
    const context = await started.promise;
    revision = "b".repeat(40);
    expect(context.beforeEffect()).toBe(false);
    const outcome = await pending;
    expect(outcome.kind === "settled" && outcome.result.reason).toBe("workspace-stale");
    result.resolve(RESULT);
  });
  it("does not retry a failed budget charge or turn its failure into success", async () => {
    const commit = vi.fn(() => {
      throw new Error("secret-accounting-context");
    });
    const fixture = fixtureWith((f) => ({
      ...f.input,
      budgetPort: { ...f.input.budgetPort, commit },
    }));
    const outcome = await fixture.binder.dispatch(fixture.request, ID);
    expect(outcome.kind === "settled" && outcome.result.reason).toBe("budget-port-failed");
    expect(commit).toHaveBeenCalledOnce();
    await fixture.binder.dispatch(fixture.request, ID);
    expect(commit).toHaveBeenCalledOnce();
  });
  it("checks the authoritative deadline again after result validation", async () => {
    const fixture = fixtureWith((f) => ({
      ...f.input,
      handlerBindings: [
        {
          ...f.handler,
          execute: (_args, context): Promise<CatalogHandlerResult> => {
            context.beforeEffect();
            return Promise.resolve({
              ...RESULT,
              get data(): unknown {
                f.now.mockReturnValue(6000);
                return RESULT.data;
              },
            });
          },
        },
      ],
    }));
    const outcome = await fixture.binder.dispatch(fixture.request, ID);
    expect(outcome.kind === "settled" && outcome.result.status).toBe("timeout");
  });
  it("rejects cursor text that was not minted by this invocation owner", async () => {
    const fixture = fixtureWith((f) => ({
      ...f.input,
      handlerBindings: [
        {
          ...f.handler,
          execute: (_args, context): Promise<CatalogHandlerResult> => {
            context.beforeEffect();
            return Promise.resolve({
              ...RESULT,
              page: { truncated: true, reason: "result-cap", cursor: "unowned-cursor" },
            });
          },
        },
      ],
    }));
    const outcome = await fixture.binder.dispatch(fixture.request, ID);
    expect(outcome.kind === "settled" && outcome.result.reason).toBe("result-contract-failed");
  });
  it.each([
    ["commit", "before"],
    ["commit", "after"],
    ["release", "before"],
    ["release", "after"],
  ] as const)(
    "records %s uncertainty when acknowledgement throws %s the accounting effect",
    async (operation, timing) => {
      let accountingEffects = 0;
      const accounting = vi.fn(() => {
        if (timing === "after") accountingEffects++;
        throw new Error("accounting-acknowledgement-lost");
      });
      const fixture = fixtureWith((f) => ({
        ...f.input,
        budgetPort: { ...f.input.budgetPort, [operation]: accounting },
        handlerBindings:
          operation === "commit"
            ? [f.handler]
            : [
                {
                  ...f.handler,
                  execute: (): Promise<CatalogHandlerResult> =>
                    Promise.reject(new Error("no-effect")),
                },
              ],
      }));
      const result = await fixture.binder.dispatch(fixture.request, ID);
      expect(result.kind === "settled" && result.receipt.budgetDisposition).toBe(
        `${operation}-uncertain`,
      );
      expect(result.kind === "settled" && result.result).toMatchObject({
        status: "failed",
        reason: "budget-port-failed",
        effectStarted: operation === "commit",
      });
      expect(accounting).toHaveBeenCalledOnce();
      expect(accountingEffects).toBe(timing === "after" ? 1 : 0);
      await fixture.binder.dispatch(fixture.request, ID);
      expect(accounting).toHaveBeenCalledOnce();
    },
  );
  it.each(["available", "reserve", "check"] as const)(
    "classifies a failing budget %s port before effects",
    async (operation) => {
      const fixture = catalogToolFixture();
      const failed = vi.fn(() => {
        throw new Error("budget-private-context");
      });
      let fail = false;
      const budgetPort = {
        ...fixture.input.budgetPort,
        available: (...args: Parameters<typeof fixture.input.budgetPort.available>): boolean =>
          fail && operation === "available"
            ? failed()
            : fixture.input.budgetPort.available(...args),
        ...(operation === "available" ? {} : { [operation]: failed }),
      };
      const binder = createCatalogToolBinder({ ...fixture.input, budgetPort }, fixture.options);
      const offer = binder.offer();
      fail = true;
      const result = await binder.dispatch(
        {
          kind: "bound",
          toolRef: fixture.handler.toolRef,
          offerId: offer.offerId,
          projectionDigest: offer.binding.projectionDigest,
          arguments: { path: "fixture.ts" },
        },
        ID,
      );
      expect(result.kind === "settled" && result.result).toMatchObject({
        status: "failed",
        reason: "budget-port-failed",
        effectStarted: false,
      });
    },
  );
});

describe("catalog invocation settlement lifecycle-emit failure (b3-10)", () => {
  afterEach(() => {
    failSettledEmit = false;
  });
  it("still resolves the dispatch promise and records a diagnostic instead of hanging forever", async () => {
    const fixture = catalogToolFixture();
    const diagnosticsRecord = vi.fn<ServerDiagnosticSink["record"]>();
    const binder = createCatalogToolBinder(
      {
        ...fixture.input,
        logPort: { primary: fixture.primary, diagnostics: { record: diagnosticsRecord } },
      },
      fixture.options,
    );
    const offer = binder.offer();
    failSettledEmit = true;
    const result = await binder.dispatch(
      {
        kind: "bound",
        toolRef: fixture.handler.toolRef,
        offerId: offer.offerId,
        projectionDigest: offer.binding.projectionDigest,
        arguments: { path: "fixture.ts" },
      },
      ID,
    );
    expect(result.kind).toBe("settled");
    expect(diagnosticsRecord).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "tool-catalog.settlement-emit-failed" }),
    );
  });
});
