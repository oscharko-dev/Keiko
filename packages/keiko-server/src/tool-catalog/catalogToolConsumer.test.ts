import { describe, expect, it } from "vitest";
import { codingCatalogConsumer } from "./catalogCodingConsumer.js";
import { catalogToolFixture } from "./__fixtures__/catalogToolFixture.js";
import { createCatalogToolBinder } from "./catalogToolDispatch.js";

describe("catalog consumer action codec", () => {
  it("captures the server-selected codec rather than accepting a later replacement", async () => {
    const fixture = catalogToolFixture();
    const consumerPort = { ...codingCatalogConsumer };
    const binder = createCatalogToolBinder({ ...fixture.input, consumerPort }, fixture.options);
    try {
      const offer = binder.offer();
      consumerPort.captureAction = (): undefined => undefined;
      const result = await binder.dispatch(
        {
          kind: "bound",
          toolRef: offer.toolRefs[0],
          projectionDigest: offer.binding.projectionDigest,
          offerId: offer.offerId,
          arguments: { path: "fixture.ts" },
        },
        { actionId: "action-codec", idempotencyKey: "key-codec" },
      );
      expect(result).toMatchObject({ kind: "settled", result: { status: "completed" } });
    } finally {
      fixture.options.invocationRegistry.dispose();
    }
  });
});
