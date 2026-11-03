import type { ToolHandlerReadiness } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import { describe, expect, it, vi } from "vitest";
import {
  createInitialToolCatalog,
  compileToolProjection,
  computeHandlerSetDigest as computeCanonicalHandlerSetDigest,
} from "@oscharko-dev/keiko-tool-catalog";
import {
  catalogBoundToolSet,
  computeHandlerSetDigest,
  createCatalogBinding,
  createCatalogBindingFromPreparation,
  createCatalogBindingPreparation,
  createCatalogOffer,
  lifecycleIdentity,
} from "./catalogToolBinder.js";
import { catalogToolFixture } from "./__fixtures__/catalogToolFixture.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { createGatewayToolCatalogBridge } from "@oscharko-dev/keiko-model-gateway";
import { createCatalogToolBinder } from "./catalogToolDispatch.js";

describe("catalog handler binding and offered projection", () => {
  it.each([
    { deadline: 91_000, authority: 121_000, arrival: 50_000, accepted: true },
    { deadline: 91_000, authority: 121_000, arrival: 91_000, accepted: false },
    { deadline: 121_000, authority: 61_000, arrival: 60_000, accepted: true },
    { deadline: 121_000, authority: 61_000, arrival: 61_000, accepted: false },
  ])(
    "bounds model response lifetime by consumer deadline and authority: %j",
    async ({ deadline, authority, arrival, accepted }) => {
      const fixture = catalogToolFixture();
      const execute = vi.fn(fixture.handler.execute);
      const binder = createCatalogToolBinder(
        { ...fixture.input, handlerBindings: [{ ...fixture.handler, execute }] },
        {
          ...fixture.options,
          context: () => ({
            ...fixture.context,
            deadlineAt: new Date(deadline).toISOString(),
            authorityExpiresAt: new Date(authority).toISOString(),
          }),
        },
      );
      const offered = binder.offer();
      const gateway = createGatewayToolCatalogBridge(
        {
          modelId: "fixture-model",
          messages: [],
          toolCatalog: {
            kind: "bound",
            catalog: fixture.pure.catalog,
            projection: fixture.pure.projection,
            offered,
          },
        },
        fixture.now,
      );
      fixture.now.mockReturnValue(arrival);
      const bind = (): ReturnType<typeof gateway.bind> =>
        gateway.bind({
          id: "delayed-model-call",
          name: "fixture_read",
          arguments: { path: "fixture.ts" },
        });
      if (accepted) {
        const call = bind();
        expect(
          await binder.dispatch(call.invocation, {
            actionId: "delayed-action",
            idempotencyKey: "delayed-key",
          }),
        ).toMatchObject({
          kind: "settled",
          result: { status: "completed", effectStarted: true },
        });
        expect(execute).toHaveBeenCalledOnce();
      } else {
        const expiredCause: unknown = expect.objectContaining({ reason: "expired-compatibility" });
        expect(bind).toThrow(
          expect.objectContaining({
            reason: "invalid-arguments",
            cause: expiredCause,
          }),
        );
        expect(
          await binder.dispatch(
            {
              kind: "bound",
              toolRef: fixture.handler.toolRef,
              projectionDigest: offered.binding.projectionDigest,
              offerId: offered.offerId,
              arguments: { path: "fixture.ts" },
            },
            { actionId: "expired-action", idempotencyKey: "expired-key" },
          ),
        ).toMatchObject({
          kind: "settled",
          result: { effectStarted: false },
        });
        expect(execute).not.toHaveBeenCalled();
      }
      expect(Date.parse(offered.expiresAt)).toBe(Math.min(deadline, authority));
    },
  );
  it("offers only the bound ready handler and keeps all server material out of the wire shape", () => {
    const fixture = catalogToolFixture();
    const state = createCatalogBinding(fixture.input, fixture.options);
    const offer = createCatalogOffer(state);
    expect(offer.toolRefs).toEqual([fixture.pure.descriptor.toolRef]);
    expect(Object.keys(offer).sort()).toEqual(["binding", "expiresAt", "offerId", "toolRefs"]);
    expect(Object.isFrozen(offer.toolRefs)).toBe(true);
    expect(Object.keys(offer.binding).sort()).toEqual([
      "catalogRevision",
      "handlerSetDigest",
      "profile",
      "projectionDigest",
      "readiness",
    ]);
    expect(JSON.stringify(offer)).not.toMatch(
      /private|authority|handlerBindings|execute|environment|workspaceRoot/u,
    );
    expect(fixture.primary.events.map((event) => event.op)).toEqual([
      "tool-catalog.bind-ready",
      "tool-catalog.projection",
    ]);
    expect(fixture.preview).toHaveBeenCalledOnce();
  });
  it.each(["unavailable", "dry-run", "unsupported", "mismatch"] as const)(
    "never advertises a %s handler as productive",
    (readiness) => {
      const fixture = catalogToolFixture();
      const state = createCatalogBinding(
        {
          ...fixture.input,
          handlerBindings: [
            { ...fixture.handler, readiness: (): ToolHandlerReadiness => readiness },
          ],
        },
        fixture.options,
      );
      expect(createCatalogOffer(state).toolRefs).toEqual([]);
      expect(catalogBoundToolSet(state).readiness).toBe("unavailable");
      expect(fixture.preview).not.toHaveBeenCalled();
    },
  );
  it("does not advertise missing handlers and rejects duplicates or mismatched handler identities", () => {
    const fixture = catalogToolFixture();
    expect(
      createCatalogOffer(
        createCatalogBinding({ ...fixture.input, handlerBindings: [] }, fixture.options),
      ).toolRefs,
    ).toEqual([]);
    for (const bindings of [
      [fixture.handler, fixture.handler],
      [{ ...fixture.handler, handlerId: "wrong" }],
      [{ ...fixture.handler, handlerVersion: 2 }],
      [{ ...fixture.handler, descriptorDigest: "a".repeat(64) }],
      [{ ...fixture.handler, catalogAction: "unmapped" }],
    ])
      expect(() =>
        createCatalogBinding(
          { ...fixture.input, handlerBindings: bindings as typeof fixture.input.handlerBindings },
          fixture.options,
        ),
      ).toThrow("Invalid catalog handler binding");
  });
  it("rejects altered projections before offering any affected tool", () => {
    const fixture = catalogToolFixture();
    expect(() =>
      createCatalogBinding(
        { ...fixture.input, projection: { ...fixture.input.projection, tools: [] } },
        fixture.options,
      ),
    ).toThrow("Invalid catalog handler binding");
    expect(fixture.primary.events).toEqual([]);
  });
  it("requires live authority, approval channel and remaining budget independently", () => {
    const fixture = catalogToolFixture();
    const state = createCatalogBinding(fixture.input, fixture.options);
    fixture.preview.mockReturnValue({ ok: false, reason: "approval-required" });
    expect(createCatalogOffer(state).toolRefs).toEqual([]);
    fixture.approvalAvailable.mockReturnValue(true);
    expect(createCatalogOffer(state).toolRefs).toHaveLength(1);
    fixture.preview.mockReturnValue({ ok: false, reason: "action-not-authorized" });
    expect(createCatalogOffer(state).toolRefs).toEqual([]);
    fixture.preview.mockReturnValue({ ok: true });
    fixture.budgetAvailable.mockReturnValue(false);
    expect(createCatalogOffer(state).toolRefs).toEqual([]);
  });
  it("rechecks readiness and fails closed after expiry", () => {
    const fixture = catalogToolFixture();
    const readiness = vi.fn<typeof fixture.handler.readiness>(() => "ready");
    const state = createCatalogBinding(
      { ...fixture.input, handlerBindings: [{ ...fixture.handler, readiness }] },
      fixture.options,
    );
    expect(createCatalogOffer(state).toolRefs).toHaveLength(1);
    readiness.mockReturnValue("unavailable");
    expect(createCatalogOffer(state).toolRefs).toEqual([]);
    fixture.now.mockReturnValue(60_000);
    expect(() => createCatalogOffer(state)).toThrow("Invalid catalog handler binding");
  });
  it("does not equate a legacy action alias with runtime authority", () => {
    const fixture = catalogToolFixture();
    const catalog = createInitialToolCatalog();
    const projection = compileToolProjection(catalog, { id: "legacy-native", version: 1 });
    const descriptor = catalog.descriptors.find(
      (item) => item.toolRef.canonicalId === "keiko.file.read",
    );
    if (descriptor === undefined) throw new Error("Missing production descriptor");
    const handler = {
      ...fixture.handler,
      toolRef: descriptor.toolRef,
      descriptorDigest: descriptor.descriptorDigest,
      handlerId: descriptor.handlerRequirement.id,
      catalogAction: "read_file",
    };
    const state = createCatalogBinding(
      { ...fixture.input, projection, handlerBindings: [handler] },
      { ...fixture.options, catalog },
    );
    expect(createCatalogOffer(state).toolRefs).toEqual([descriptor.toolRef]);
    expect(fixture.preview).toHaveBeenCalledWith(
      "private-capability",
      expect.objectContaining({ action: "read" }),
    );
  });
  it("captures each readiness observation once per offered-set computation", () => {
    const fixture = catalogToolFixture();
    const readiness = vi
      .fn<() => ToolHandlerReadiness>()
      .mockReturnValueOnce("ready")
      .mockReturnValue("unavailable");
    const state = createCatalogBinding(
      { ...fixture.input, handlerBindings: [{ ...fixture.handler, readiness }] },
      fixture.options,
    );
    const offer = createCatalogOffer(state);
    expect(readiness).toHaveBeenCalledOnce();
    expect(offer.binding.readiness).toBe("ready");
    expect(offer.toolRefs).toEqual([fixture.pure.descriptor.toolRef]);
  });
  it("captures prepared handler identities before caller-owned input mutation", () => {
    const fixture = catalogToolFixture();
    const sourceHandler = { ...fixture.handler };
    const sourceBindings = [sourceHandler];
    const preparation = createCatalogBindingPreparation(
      { ...fixture.input, handlerBindings: sourceBindings },
      fixture.options.catalog,
    );
    const digest = preparation.handlerSetDigest;

    sourceHandler.handlerId = "mutated-handler";
    sourceBindings.splice(0);
    const state = createCatalogBindingFromPreparation(preparation, fixture.options);

    expect(state.handlers[0]?.binding?.handlerId).toBe(fixture.handler.handlerId);
    expect(state.handlerSetDigest).toBe(digest);
    expect(createCatalogOffer(state).toolRefs).toEqual([fixture.pure.descriptor.toolRef]);
  });
  it("falls back an invalid correlation id to the unknown sentinel and drops an invalid parent id (b3-17)", () => {
    const fixture = catalogToolFixture();
    const state = createCatalogBinding(fixture.input, fixture.options);
    // "bad id!" fails SAFE_CORRELATION_ID (space and "!" are not allowed) -- exactly the shape
    // `bindingFailure` in this same file already guards, and what `emitToolLifecycleEvent`'s own
    // validation would otherwise throw on further downstream.
    const invalid = lifecycleIdentity(state, {
      ...fixture.context,
      correlationId: "bad id!",
      parentCorrelationId: "also bad!",
    });
    expect(invalid.correlationId).toBe(UNKNOWN_CORRELATION_ID);
    expect(invalid).not.toHaveProperty("parentCorrelationId");
  });
  // #3413 F8 review, finding b1-2 / #3414-AC4: `handlerSetDigest` must be the ONE real digest a
  // caller outside this module (e.g. opencodeToolSchemas.ts's advertisement, once its composition
  // supplies real bindings) can reuse rather than re-deriving independently -- this pins that the
  // exported formula is exactly what `createCatalogBinding` itself stamps onto the binding state,
  // and that it actually changes when the bound handler identity changes (not a constant alias).
  it("exports the real handler-set digest formula, reused verbatim by createCatalogBinding", () => {
    const fixture = catalogToolFixture();
    const state = createCatalogBinding(fixture.input, fixture.options);
    expect(state.handlerSetDigest).toBe(computeHandlerSetDigest(state.projection, state.handlers));
    expect(state.handlerSetDigest).toBe(
      computeCanonicalHandlerSetDigest(
        state.projection.projectionDigest,
        state.handlers.map(({ descriptor, binding }) => ({
          toolRef: descriptor.toolRef,
          descriptorDigest: descriptor.descriptorDigest,
          handlerId: binding?.handlerId ?? null,
          handlerVersion: binding?.handlerVersion ?? null,
          catalogAction: binding?.catalogAction ?? null,
        })),
      ),
    );
    expect(state.handlerSetDigest).toMatch(/^[a-f0-9]{64}$/u);
    const unbound = createCatalogBinding(
      { ...fixture.input, handlerBindings: [] },
      fixture.options,
    );
    expect(unbound.handlerSetDigest).not.toBe(state.handlerSetDigest);
  });
  it("passes a well-formed correlation and parent correlation id through unchanged", () => {
    const fixture = catalogToolFixture();
    const state = createCatalogBinding(fixture.input, fixture.options);
    const valid = lifecycleIdentity(state, {
      ...fixture.context,
      correlationId: "correlation-1",
      parentCorrelationId: "parent-correlation-1",
    });
    expect(valid.correlationId).toBe("correlation-1");
    expect(valid.parentCorrelationId).toBe("parent-correlation-1");
  });
});
