import type { ToolHandlerReadiness } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import { describe, expect, it, vi } from "vitest";
import { createInitialToolCatalog, compileToolProjection } from "@oscharko-dev/keiko-tool-catalog";
import {
  catalogBoundToolSet,
  createCatalogBinding,
  createCatalogOffer,
  lifecycleIdentity,
} from "./catalogToolBinder.js";
import { catalogToolFixture } from "./__fixtures__/catalogToolFixture.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";

describe("catalog handler binding and offered projection", () => {
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
