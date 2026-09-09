import { describe, expect, it, vi } from "vitest";
import { catalogToolFixture } from "./__fixtures__/catalogToolFixture.js";
import { createCatalogToolBinder } from "./catalogToolDispatch.js";
import type { CatalogHandlerResult, CatalogToolDispatchOutcome } from "./catalogToolPorts.js";

function pagingFixture(): ReturnType<typeof catalogToolFixture> & {
  binder: ReturnType<typeof createCatalogToolBinder>;
  request: object;
  reserve: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  calls: number[];
} {
  const fixture = catalogToolFixture();
  const calls: number[] = [];
  const reserve = vi.fn(fixture.input.budgetPort.reserve);
  const commit = vi.fn();
  const binder = createCatalogToolBinder(
    {
      ...fixture.input,
      budgetPort: { ...fixture.input.budgetPort, reserve, commit },
      handlerBindings: [
        {
          ...fixture.handler,
          execute: (_args, context): Promise<CatalogHandlerResult> => {
            if (!context.beforeEffect()) throw new TypeError("Effect denied");
            calls.push(context.pageSequence);
            return Promise.resolve({
              data: { text: `page-${String(context.pageSequence)}` },
              resultCount: 1,
              page:
                context.pageSequence === 0
                  ? { truncated: true, reason: "result-cap", cursor: context.createCursor() }
                  : { truncated: false, reason: "none", cursor: null },
            });
          },
        },
      ],
    },
    fixture.options,
  );
  const offer = binder.offer();
  return {
    ...fixture,
    binder,
    reserve,
    commit,
    calls,
    request: {
      kind: "bound",
      toolRef: fixture.pure.descriptor.toolRef,
      projectionDigest: offer.binding.projectionDigest,
      offerId: offer.offerId,
      arguments: { path: "fixture.ts" },
    },
  };
}
function cursorFrom(outcome: CatalogToolDispatchOutcome): string {
  if (
    outcome.kind !== "settled" ||
    outcome.result.status !== "completed" ||
    outcome.result.page.cursor === null
  )
    throw new TypeError("Expected productive cursor");
  return outcome.result.page.cursor;
}
const FIRST = { actionId: "first", idempotencyKey: "first-key" };
const NEXT = { actionId: "next", idempotencyKey: "next-key" };
describe("actual server continuation dispatch", () => {
  it("distinguishes settled response replay from consuming and executing one fresh page", async () => {
    const fixture = pagingFixture();
    const first = await fixture.binder.dispatch(fixture.request, FIRST);
    const cursor = cursorFrom(first);
    expect((await fixture.binder.dispatch(fixture.request, FIRST)).kind).toBe("replayed");
    expect(fixture.calls).toEqual([0]);
    const next = await fixture.binder.dispatchPage(fixture.request, NEXT, cursor);
    expect(next.kind === "settled" && next.result).toMatchObject({
      status: "completed",
      data: { text: "page-1" },
      page: { cursor: null },
    });
    expect((await fixture.binder.dispatchPage(fixture.request, NEXT, cursor)).kind).toBe(
      "replayed",
    );
    expect(fixture.calls).toEqual([0, 1]);
    expect(fixture.reserve).toHaveBeenCalledTimes(2);
    expect(fixture.commit).toHaveBeenCalledTimes(2);
    const replay = await fixture.binder.dispatchPage(
      fixture.request,
      { actionId: "again", idempotencyKey: "again" },
      cursor,
    );
    expect(replay.kind === "settled" && replay.result.reason).toBe("cursor-replayed");
    expect(fixture.calls).toEqual([0, 1]);
  });
  it.each(["authority", "budget"] as const)(
    "revalidates %s after cursor issuance",
    async (kind) => {
      const fixture = pagingFixture();
      const cursor = cursorFrom(await fixture.binder.dispatch(fixture.request, FIRST));
      if (kind === "authority")
        fixture.preview.mockReturnValue({ ok: false, reason: "action-not-authorized" });
      else fixture.budgetAvailable.mockReturnValue(false);
      const next = await fixture.binder.dispatchPage(fixture.request, NEXT, cursor);
      expect(next.kind === "settled" && next.result.status).toBe("denied");
      expect(fixture.calls).toEqual([0]);
      expect(fixture.reserve).toHaveBeenCalledOnce();
    },
  );
  it("rejects cursor reuse for another query before dispatching the next handler", async () => {
    const fixture = pagingFixture();
    const cursor = cursorFrom(await fixture.binder.dispatch(fixture.request, FIRST));
    const next = await fixture.binder.dispatchPage(
      { ...fixture.request, arguments: { path: "other.ts" } },
      NEXT,
      cursor,
    );
    expect(next.kind === "settled" && next.result.reason).toBe("cursor-invalid");
    expect(fixture.calls).toEqual([0]);
  });
  it("cannot use a cursor namespace as an ordinary invocation identity", async () => {
    const fixture = pagingFixture();
    const result = await fixture.binder.dispatch(fixture.request, {
      actionId: "catalog-cursor-spoof",
      idempotencyKey: "ordinary",
    });
    expect(result.kind === "settled" && result.result.reason).toBe("invalid-arguments");
    expect(fixture.calls).toEqual([]);
  });
  it("rejects a budget owner reusing the prior page reservation without another effect or compensation", async () => {
    const fixture = pagingFixture();
    const first = await fixture.binder.dispatch(fixture.request, FIRST);
    const cursor = cursorFrom(first);
    if (first.kind !== "settled" || first.receipt.reservationId === null)
      throw new TypeError("Expected reservation");
    fixture.reserve.mockReturnValue({ reservationId: first.receipt.reservationId });
    const next = await fixture.binder.dispatchPage(fixture.request, NEXT, cursor);
    expect(next.kind === "settled" && next.result.reason).toBe("budget-port-failed");
    expect(fixture.calls).toEqual([0]);
    expect(fixture.commit).toHaveBeenCalledOnce();
  });
});
