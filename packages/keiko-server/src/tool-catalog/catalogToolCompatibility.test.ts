import { describe, expect, it } from "vitest";
import {
  createToolCatalog,
  createToolDescriptor,
  compileToolProjection,
} from "@oscharko-dev/keiko-tool-catalog";
import { declaration, profile } from "./__fixtures__/catalogDefinition.js";
import { catalogToolFixture } from "./__fixtures__/catalogToolFixture.js";
import { createCatalogToolBinder } from "./catalogToolDispatch.js";
import type { CatalogHandlerContext, CatalogHandlerResult } from "./catalogToolPorts.js";

function transitionedFixture(): ReturnType<typeof catalogToolFixture> {
  const fixture = catalogToolFixture();
  const to = createToolDescriptor(declaration(2));
  const compatibility = {
    from: {
      toolRef: fixture.pure.descriptor.toolRef,
      descriptorDigest: fixture.pure.descriptor.descriptorDigest,
    },
    to: { toolRef: to.toolRef, descriptorDigest: to.descriptorDigest },
    profile: { id: "fixture", version: 1 },
    adapter: { id: "keiko", version: "0.3.17" },
    transformId: "identity-v1",
    ownerIssue: 3406,
    expiresAt: new Date(2000).toISOString(),
    removalIssue: 3415,
  };
  const catalog = createToolCatalog(
    {
      descriptors: [to],
      profiles: [{ ...profile(to), compatibility: [compatibility] }],
      compatibility: [compatibility],
    },
    { referenceTimeMs: 0, previous: fixture.pure.catalog },
  );
  const projection = compileToolProjection(catalog, { id: "fixture", version: 1 });
  const handler = {
    ...fixture.handler,
    toolRef: to.toolRef,
    descriptorDigest: to.descriptorDigest,
  };
  return {
    ...fixture,
    pure: { descriptor: to, catalog, projection },
    handler,
    input: { ...fixture.input, projection, handlerBindings: [handler] },
    options: { ...fixture.options, catalog },
  };
}
const ID = { actionId: "action-1", idempotencyKey: "key-1" };
describe("runtime finite compatibility eligibility", () => {
  it("checks the trusted clock at advertisement and again on every invocation", async () => {
    const fixture = transitionedFixture();
    const binder = createCatalogToolBinder(fixture.input, fixture.options);
    const offer = binder.offer();
    fixture.now.mockReturnValue(2000);
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
    expect(result.kind === "settled" && result.result.reason).toBe("recovery-required");
    expect(() => binder.offer()).toThrow("Invalid catalog handler binding");
  });
  it("checks compatibility eligibility once more at the actual effect boundary", async () => {
    const fixture = transitionedFixture();
    let resolveStarted!: (context: CatalogHandlerContext) => void;
    const started = new Promise<CatalogHandlerContext>((resolve) => {
      resolveStarted = resolve;
    });
    const binder = createCatalogToolBinder(
      {
        ...fixture.input,
        handlerBindings: [
          {
            ...fixture.handler,
            execute: (_args, context): Promise<CatalogHandlerResult> => {
              resolveStarted(context);
              return new Promise(() => undefined);
            },
          },
        ],
      },
      fixture.options,
    );
    const offer = binder.offer();
    const pending = binder.dispatch(
      {
        kind: "bound",
        toolRef: fixture.handler.toolRef,
        offerId: offer.offerId,
        projectionDigest: offer.binding.projectionDigest,
        arguments: { path: "fixture.ts" },
      },
      ID,
    );
    const context = await started;
    fixture.now.mockReturnValue(2000);
    expect(context.beforeEffect()).toBe(false);
    const result = await pending;
    expect(result.kind === "settled" && result.result.reason).toBe("recovery-required");
  });
});
