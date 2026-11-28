import { CatalogDispatchFault } from "./catalogToolErrors.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogToolBinder } from "./catalogToolDispatch.js";
import { catalogToolFixture } from "./__fixtures__/catalogToolFixture.js";
import { openCodeCatalogSettlementBudgetMs } from "./catalogToolFacadeBridge.js";
import { largeHashTimeoutMs } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { MAX_RUNTIME_MAX_DURATION_MINUTES } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { runtimeMaxDurationMs } from "../coding-runtime/productionRuntimeWorkspaceAuthority.js";
import { chatTurnDeadlineSignal } from "../chat-tool-turn-deadline.js";
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
  maxDurationMs?: number,
): ReturnType<typeof catalogToolFixture> & {
  binder: ReturnType<typeof createCatalogToolBinder>;
  request: object;
} {
  const fixture = catalogToolFixture(maxDurationMs);
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
const STAGE_EXECUTE = {
  ...ID,
  action: "git",
  operation: "stage",
  phase: "execute",
  proposalId: "stage-1",
} as const;
const MIB = 1_048_576;
// A supported 6 GiB staging file read at 10 MiB/s: one hash pass takes 614.4 s, which lies between
// the former ten-minute outer bound and the 674.4 s the hash itself is granted.
const SIX_GIB_HASH_MS = (6_144 / 10) * 1_000;
// Dispatches `keiko.git.execute` stage under the production budget; `hold` is the handler's work.
function stageDispatch(
  hold: Promise<CatalogHandlerResult>,
  options: { readonly authorityMs?: number; readonly signal?: AbortSignal } = {},
): { readonly fixture: ReturnType<typeof fixtureWith>; readonly started: Promise<undefined> } {
  const budget = openCodeCatalogSettlementBudgetMs(STAGE_EXECUTE) ?? 0;
  const started = deferred<undefined>();
  const fixture = fixtureWith(
    (f) => ({
      ...f.input,
      handlerBindings: [
        {
          ...f.handler,
          execute: (_args, context): Promise<CatalogHandlerResult> => {
            expect(context.beforeEffect()).toBe(true);
            started.resolve(undefined);
            return hold;
          },
        },
      ],
    }),
    (f) => ({
      ...f.context,
      // The run's authority ends the call: its deadline, and the expiry the claim is held until.
      deadlineAt: new Date(1000 + (options.authorityMs ?? budget)).toISOString(),
      authorityExpiresAt: new Date(1000 + (options.authorityMs ?? budget)).toISOString(),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),
    budget,
  );
  return { fixture, started: started.promise };
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
  it.each([
    undefined,
    { text: "safe", credentials: "private-provider-data" },
    { text: "x".repeat(65) },
  ])(
    "settles invalid provider-error data without publishing it or retaining a reservation",
    async (data) => {
      const release = vi.fn();
      const diagnosticsRecord = vi.fn<ServerDiagnosticSink["record"]>();
      const error = new CatalogDispatchFault("failed", "provider-reported-error", undefined, data);
      const fixture = fixtureWith((f) => ({
        ...f.input,
        logPort: { ...f.input.logPort, diagnostics: { record: diagnosticsRecord } },
        budgetPort: { ...f.input.budgetPort, release },
        handlerBindings: [
          { ...f.handler, execute: (): Promise<CatalogHandlerResult> => Promise.reject(error) },
        ],
      }));
      const outcome = await fixture.binder.dispatch(fixture.request, ID);
      expect(outcome).toMatchObject({
        kind: "settled",
        result: {
          status: "failed",
          reason: "result-contract-failed",
          data: null,
          effectStarted: false,
        },
      });
      expect(release).toHaveBeenCalledOnce();
      expect(diagnosticsRecord).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "tool-catalog.provider-result-invalid" }),
      );
      expect(JSON.stringify(diagnosticsRecord.mock.calls)).not.toContain("private-provider-data");
      expect(JSON.stringify(error)).not.toContain("private-provider-data");
      expect(JSON.stringify(fixture.primary.events)).not.toContain("private-provider-data");
    },
  );

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
  // Owner decision 2026-11-24 (work-ending limits): a redeemed git delivery proposal runs many
  // subprocesses that carry their own timeouts, so a 30 s catalog budget ended healthy work on a
  // loaded host. The call is given the budget the production catalog declares for it.
  it("does not settle a governed git execute that runs past the 30 s sandbox default", async () => {
    vi.useFakeTimers();
    const budget =
      openCodeCatalogSettlementBudgetMs({
        ...ID,
        action: "git",
        operation: "stage",
        phase: "execute",
        proposalId: "stage-1",
      }) ?? 0;
    expect(budget).toBeGreaterThan(30_000);
    const started = deferred<undefined>();
    const finish = deferred<CatalogHandlerResult>();
    const fixture = fixtureWith(
      (f) => ({
        ...f.input,
        handlerBindings: [
          {
            ...f.handler,
            execute: (_args, context): Promise<CatalogHandlerResult> => {
              expect(context.beforeEffect()).toBe(true);
              started.resolve(undefined);
              return finish.promise;
            },
          },
        ],
      }),
      (f) => ({ ...f.context, deadlineAt: new Date(1000 + budget).toISOString() }),
      budget,
    );
    const pending = fixture.binder.dispatch(fixture.request, ID);
    await started.promise;
    fixture.now.mockReturnValue(1000 + 45_000);
    await vi.advanceTimersByTimeAsync(45_000);
    finish.resolve(RESULT);
    const settled = await pending;
    expect(settled).toMatchObject({ kind: "settled", result: { status: "completed" } });
    expect(fixture.primary.events.at(-1)?.extra).toMatchObject({
      status: "completed",
      budgetMs: budget,
    });
  });
  describe("large-file staging is not cut by the outer budget", () => {
    it("completes a successful 6 GiB hash that outlasts ten minutes but not its own deadline", async () => {
      vi.useFakeTimers();
      expect(SIX_GIB_HASH_MS).toBeGreaterThan(600_000);
      expect(SIX_GIB_HASH_MS).toBeLessThan(largeHashTimeoutMs(6_144 * MIB));
      const finish = deferred<CatalogHandlerResult>();
      const { fixture, started } = stageDispatch(finish.promise);
      const pending = fixture.binder.dispatch(fixture.request, ID);
      await started;
      fixture.now.mockReturnValue(1000 + SIX_GIB_HASH_MS);
      await vi.advanceTimersByTimeAsync(SIX_GIB_HASH_MS);
      finish.resolve(RESULT);
      expect(await pending).toMatchObject({ kind: "settled", result: { status: "completed" } });
    });
    it("grants the call at least the deadline of the hash it admits", () => {
      const budget = openCodeCatalogSettlementBudgetMs(STAGE_EXECUTE) ?? 0;
      expect(budget).toBeGreaterThanOrEqual(largeHashTimeoutMs(6_144 * MIB));
    });
    it("keeps a finite backstop no longer than the longest authorizable run", () => {
      const budget = openCodeCatalogSettlementBudgetMs(STAGE_EXECUTE) ?? 0;
      expect(budget).toBe(runtimeMaxDurationMs(MAX_RUNTIME_MAX_DURATION_MINUTES));
      expect(budget).toBeLessThan(TOOL_CATALOG_LIMITS.maxDurationMs);
    });
    it("still ends a hung call when the run's authority expires", async () => {
      vi.useFakeTimers();
      const { fixture, started } = stageDispatch(new Promise(() => undefined), {
        authorityMs: 700_000,
      });
      const pending = fixture.binder.dispatch(fixture.request, ID);
      await started;
      fixture.now.mockReturnValue(1000 + 700_000);
      await vi.advanceTimersByTimeAsync(700_000);
      expect(await pending).toMatchObject({ kind: "settled", result: { status: "timeout" } });
      expect(fixture.primary.events.at(-1)?.extra).toMatchObject({ reason: "deadline-exceeded" });
    });
    it("still ends the call at once when the run is cancelled", async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const { fixture, started } = stageDispatch(new Promise(() => undefined), {
        signal: controller.signal,
      });
      const pending = fixture.binder.dispatch(fixture.request, ID);
      await started;
      fixture.now.mockReturnValue(1000 + SIX_GIB_HASH_MS);
      await vi.advanceTimersByTimeAsync(SIX_GIB_HASH_MS);
      controller.abort();
      expect(await pending).toMatchObject({ kind: "settled", result: { status: "cancelled" } });
    });
    it("ends a call that never settles at the backstop", async () => {
      vi.useFakeTimers();
      const budget = openCodeCatalogSettlementBudgetMs(STAGE_EXECUTE) ?? 0;
      const { fixture, started } = stageDispatch(new Promise(() => undefined));
      const pending = fixture.binder.dispatch(fixture.request, ID);
      await started;
      fixture.now.mockReturnValue(1000 + budget);
      await vi.advanceTimersByTimeAsync(budget);
      expect(await pending).toMatchObject({ kind: "settled", result: { status: "timeout" } });
    });
  });
  it("names the budget that fired on a deadline-exceeded line", async () => {
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
    await pending;
    expect(fixture.primary.events.at(-1)?.extra).toMatchObject({
      status: "timeout",
      reason: "deadline-exceeded",
      budgetMs: 5000,
    });
  });
  it.each([false, true])(
    "settles timeout and late completion exactly once (effect started=%s)",
    async (effectStarted) => {
      vi.useFakeTimers();
      const started = deferred<CatalogHandlerContext>();
      const late = deferred<CatalogHandlerResult>();
      const commit = vi.fn();
      const release = vi.fn();
      const fixture = fixtureWith((f) => ({
        ...f.input,
        budgetPort: { ...f.input.budgetPort, commit, release },
        handlerBindings: [
          {
            ...f.handler,
            execute: (_args, context): Promise<CatalogHandlerResult> => {
              if (effectStarted) expect(context.beforeEffect()).toBe(true);
              started.resolve(context);
              return late.promise;
            },
          },
        ],
      }));
      const pending = fixture.binder.dispatch(fixture.request, ID);
      const context = await started.promise;
      fixture.now.mockReturnValue(6000);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toMatchObject({
        kind: "settled",
        result: { status: "timeout", effectStarted },
      });
      expect(context.beforeEffect()).toBe(false);
      late.resolve(RESULT);
      await vi.advanceTimersByTimeAsync(0);
      expect(
        fixture.primary.events.filter((event) => event.op === "tool-catalog.completion-discarded"),
      ).toHaveLength(1);
      expect(
        fixture.primary.events.filter((event) => event.op === "tool-catalog.invocation-settled"),
      ).toHaveLength(1);
      expect(commit).toHaveBeenCalledTimes(effectStarted ? 1 : 0);
      expect(release).toHaveBeenCalledTimes(effectStarted ? 0 : 1);
      expect((await fixture.binder.dispatch(fixture.request, ID)).kind).toBe("replayed");
      expect(commit).toHaveBeenCalledTimes(effectStarted ? 1 : 0);
      expect(release).toHaveBeenCalledTimes(effectStarted ? 0 : 1);
    },
  );

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
      expect(fixture.primary.events.at(-1)).toMatchObject({
        errorKind: "internal",
        extra: {
          status: "failed",
        },
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

// #4355: the deadline is a fact (the turn's deadline signal that fired, the timer that fired), not a
// wall-clock comparison inside the callback that already announces it. The wall clock here stays a
// full second short of the deadline throughout.
describe("catalog invocation settlement: which cause fired decides (#4355)", () => {
  async function stopped(
    stop: (controller: AbortController) => void,
  ): Promise<{ status: string | undefined; late: boolean }> {
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
    await started.promise;
    expect(fixture.now()).toBeLessThan(5000);
    stop(controller);
    const outcome = await pending;
    return {
      status: outcome.kind === "settled" ? outcome.result.status : undefined,
      late: fixture.now() >= 5000,
    };
  }

  it("settles timeout when the turn's deadline signal fires before the wall clock reaches the deadline", async () => {
    const timeouts: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      timeouts.push(controller);
      return controller.signal;
    });
    try {
      const deadline = chatTurnDeadlineSignal(1);
      const result = await stopped((controller) => {
        timeouts[0]?.abort(new DOMException("The operation timed out", "TimeoutError"));
        // The call's own signal is the stop controller's: the turn's deadline stops it with the
        // deadline's reason, which `isChatTurnDeadlineReason` recognises by identity.
        controller.abort(deadline.reason);
      });
      expect(deadline.aborted).toBe(true);
      expect(result).toEqual({ status: "timeout", late: false });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("settles cancelled for a TimeoutError that is not the turn's deadline", async () => {
    const result = await stopped((controller) => {
      controller.abort(new DOMException("A provider call timed out", "TimeoutError"));
    });
    expect(result).toEqual({ status: "cancelled", late: false });
  });

  it("settles cancelled for a stop before the deadline", async () => {
    const result = await stopped((controller) => {
      controller.abort();
    });
    expect(result).toEqual({ status: "cancelled", late: false });
  });

  it("settles timeout when the call's own timer fires a millisecond before the wall clock reaches its deadline", async () => {
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
    // The timer is due by its own clock; the wall clock mock never moves, so it never reads the deadline.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fixture.now()).toBe(1000);
    expect((await pending).kind).toBe("settled");
    expect(fixture.primary.events.at(-1)?.extra?.status).toBe("timeout");
  });
});
