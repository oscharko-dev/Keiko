// #3384 B5-12: `prepareDescription` must keep the specific "generation failed / retry" outcome
// (the artifact's own bilingual "did not complete — refresh or retry" markdown, and
// `status.completeness === "fallback"`) instead of collapsing it into a generic
// `PrDescriptionFailure("provider-failed")` block that discards the artifact entirely — exactly
// what `prepareDescriptionArtifact` (the sibling call path) already does for the same outcome.

import { afterEach, describe, expect, it, vi } from "vitest";
import { PrDescription } from "@oscharko-dev/keiko-model-gateway";
import type { PrDescriptionArtifact } from "@oscharko-dev/keiko-contracts";
import { prDescriptionArtifactDigestFields } from "@oscharko-dev/keiko-contracts/runtime/pr-description";
import { framePrDescriptionRegion } from "@oscharko-dev/keiko-contracts/runtime/pr-description-region";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { DescriptionFixture } from "./prDescriptionTestSupport.js";
import { prepareDescription, prepareDescriptionArtifact } from "./prDescriptionPreparation.js";
import { PrDescriptionFailure } from "./prDescriptionTypes.js";
import type { PrDescriptionServiceOptions } from "./prDescriptionTypes.js";

vi.mock("@oscharko-dev/keiko-model-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oscharko-dev/keiko-model-gateway")>();
  return {
    ...actual,
    PrDescription: {
      ...actual.PrDescription,
      generatePrDescription: vi.fn(actual.PrDescription.generatePrDescription),
    },
  };
});

const RETRY_MARKDOWN =
  "Description generation did not complete. Refresh or retry before applying a description.";

function failedOutcomeArtifact(base: PrDescriptionArtifact): PrDescriptionArtifact {
  const fields = {
    ...base,
    outcome: "failed" as const,
    reason: "cancelled" as const,
    markdown: framePrDescriptionRegion(RETRY_MARKDOWN),
  };
  return {
    ...fields,
    artifactDigest: sha256Hex(canonicalise(prDescriptionArtifactDigestFields(fields))),
  };
}

describe("prepareDescription — failed generation outcome (#3384 B5-12)", () => {
  afterEach(() => {
    vi.mocked(PrDescription.generatePrDescription).mockClear();
  });

  it("keeps the specific failed/retry outcome instead of collapsing to a generic provider-failed block", async () => {
    const fixture = new DescriptionFixture();
    try {
      // A real, completely generated artifact (proves every other field this test does not touch —
      // binding, candidate, coverage — is a genuinely valid production shape), then flip only
      // outcome/reason/markdown to the "failed" shape `completeGeneration` produces for a cancelled
      // generation (generate.ts).
      const complete = await fixture.generateArtifact();
      const failed = failedOutcomeArtifact(complete);
      vi.mocked(PrDescription.generatePrDescription).mockResolvedValueOnce({
        status: "generated",
        artifact: failed,
      });

      const result = await prepareDescription(
        fixture.options,
        fixture.context,
        { language: "en" },
        fixture.now,
      );

      expect(result.review.status.completeness).toBe("fallback");
      expect(result.review.finalBody).toContain(RETRY_MARKDOWN);
      expect(result.artifact.outcome).toBe("failed");
    } finally {
      fixture.close();
    }
  });

  it("still throws provider-failed when no artifact was produced at all", async () => {
    const fixture = new DescriptionFixture();
    try {
      vi.mocked(PrDescription.generatePrDescription).mockResolvedValueOnce({
        status: "unavailable",
        reason: "model-unavailable",
      });

      const failure = await prepareDescription(
        fixture.options,
        fixture.context,
        { language: "en" },
        fixture.now,
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PrDescriptionFailure);
      expect((failure as PrDescriptionFailure).reason).toBe("provider-failed");
    } finally {
      fixture.close();
    }
  });
});

// Wave-3 W3-4 item 3 — a retained PR-description snapshot reference must not be evicted by
// unrelated capture activity while a proposal is in flight, and a reservation made for a proposal
// that never ends up held must not leak.
function instrumentSnapshotReservations(options: PrDescriptionServiceOptions): {
  readonly reserved: string[];
  readonly released: string[];
} {
  const reserved: string[] = [];
  const released: string[] = [];
  const original = options.snapshots;
  Object.assign(options, {
    snapshots: {
      ...original,
      reserve: (reference: string, scope: object, correlationId: string): boolean => {
        reserved.push(reference);
        return original.reserve?.(reference, scope, correlationId) ?? true;
      },
      release: (reference: string, scope: object, correlationId: string): void => {
        released.push(reference);
        original.release?.(reference, scope, correlationId);
      },
    },
  });
  return { reserved, released };
}

describe("prepareDescription/prepareDescriptionArtifact — snapshot reservation (wave-3 W3-4 item 3)", () => {
  afterEach(() => {
    vi.mocked(PrDescription.generatePrDescription).mockClear();
  });

  it("reserves the captured snapshot reference for a successfully prepared description", async () => {
    const fixture = new DescriptionFixture();
    try {
      const { reserved, released } = instrumentSnapshotReservations(fixture.options);
      const result = await prepareDescription(
        fixture.options,
        fixture.context,
        { language: "en" },
        fixture.now,
      );
      expect(reserved).toEqual([result.snapshotReference]);
      expect(released).toHaveLength(0);
    } finally {
      fixture.close();
    }
  });

  it("releases the reservation when generation fails after the snapshot was captured", async () => {
    const fixture = new DescriptionFixture();
    try {
      const { reserved, released } = instrumentSnapshotReservations(fixture.options);
      vi.mocked(PrDescription.generatePrDescription).mockResolvedValueOnce({
        status: "unavailable",
        reason: "model-unavailable",
      });
      await expect(
        prepareDescription(fixture.options, fixture.context, { language: "en" }, fixture.now),
      ).rejects.toBeInstanceOf(PrDescriptionFailure);
      expect(reserved).toHaveLength(1);
      expect(released).toEqual(reserved);
    } finally {
      fixture.close();
    }
  });

  it("releases the reservation when prepareDescriptionArtifact rejects a tampered digest", async () => {
    const fixture = new DescriptionFixture();
    try {
      const artifact = await fixture.generateArtifact();
      const { reserved, released } = instrumentSnapshotReservations(fixture.options);
      const tampered = { ...artifact, artifactDigest: "f".repeat(64) };
      await expect(
        prepareDescriptionArtifact(fixture.options, fixture.context, tampered, fixture.now),
      ).rejects.toBeInstanceOf(PrDescriptionFailure);
      expect(reserved).toHaveLength(1);
      expect(released).toEqual(reserved);
    } finally {
      fixture.close();
    }
  });
});
