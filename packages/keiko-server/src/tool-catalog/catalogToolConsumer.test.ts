import { describe, expect, it } from "vitest";
import { codingCatalogConsumer } from "./catalogCodingConsumer.js";
import { catalogToolFixture } from "./__fixtures__/catalogToolFixture.js";
import { createCatalogToolBinder } from "./catalogToolDispatch.js";

describe("catalog consumer action codec", () => {
  it.each(["captureAction", "requiredEffects", "scope"])(
    "captures %s before a later replacement",
    async (member) => {
      const fixture = catalogToolFixture();
      const consumerPort = { ...codingCatalogConsumer };
      const binder = createCatalogToolBinder({ ...fixture.input, consumerPort }, fixture.options);
      try {
        Object.assign(consumerPort, { [member]: (): undefined => undefined });
        const offer = binder.offer();
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
    },
  );
  it("retains the captured approval decoder through actual approval redemption", async () => {
    const fixture = catalogToolFixture();
    const consumerPort = { ...codingCatalogConsumer };
    fixture.preview.mockReturnValue({ ok: false, reason: "approval-required" });
    const binder = createCatalogToolBinder(
      {
        ...fixture.input,
        consumerPort,
        approvalPort: {
          available: () => true,
          request: (request) => {
            fixture.preview.mockReturnValue({ ok: true });
            return Promise.resolve(request);
          },
        },
      },
      fixture.options,
    );
    try {
      consumerPort.captureApprovedAction = (): undefined => undefined;
      const offer = binder.offer();
      const result = await binder.dispatch(
        {
          kind: "bound",
          toolRef: offer.toolRefs[0],
          projectionDigest: offer.binding.projectionDigest,
          offerId: offer.offerId,
          arguments: { path: "fixture.ts" },
        },
        { actionId: "action-approved-codec", idempotencyKey: "key-approved-codec" },
      );
      expect(result).toMatchObject({ kind: "settled", result: { status: "completed" } });
    } finally {
      fixture.options.invocationRegistry.dispose();
    }
  });
  it.each(
    ["scope", "requiredEffects", "captureAction", "captureApprovedAction"].flatMap((member) =>
      [undefined, 7].map((value) => ({ member, value })),
    ),
  )("rejects malformed $member=$value during binding", ({ member, value }) => {
    const fixture = catalogToolFixture();
    try {
      expect(() =>
        createCatalogToolBinder(
          {
            ...fixture.input,
            consumerPort: { ...codingCatalogConsumer, [member]: value },
          },
          fixture.options,
        ),
      ).toThrow("Invalid catalog handler binding");
    } finally {
      fixture.options.invocationRegistry.dispose();
    }
  });
});
