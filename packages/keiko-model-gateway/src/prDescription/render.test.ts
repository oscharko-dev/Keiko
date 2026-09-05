import { describe, expect, it } from "vitest";
import {
  GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION,
  resolveGitChangeSnapshotLimits,
  summarizeGitChangeSnapshotCompleteness,
} from "@oscharko-dev/keiko-contracts/runtime/git-change-snapshot";
import { PR_DESCRIPTION_ATTRIBUTION } from "@oscharko-dev/keiko-contracts/runtime/pr-description-region";
import { isWorkbenchDescriptionDraftReview } from "@oscharko-dev/keiko-contracts/runtime/workbench-description-status";
import type { GitChangeSnapshot } from "@oscharko-dev/keiko-contracts";
import { resolvePrDescriptionBrandingFromConfig } from "../config.js";
import type { GatewayConfig } from "../types.js";
import { buildPrDescriptionArtifact, emptyPrDescriptionCandidate } from "./render.js";
import type { PrDescriptionRenderInput } from "./render.js";

const IMMUTABLE = `https://cdn.example.org/${"a".repeat(40)}/keiko-logo.svg`;

function emptySnapshot(): GitChangeSnapshot {
  const completeness = summarizeGitChangeSnapshotCompleteness({
    entries: [],
    totalFiles: 0,
    bytes: 0,
  });
  return {
    schemaVersion: GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION,
    repositoryId: "repo-fixture",
    baseRef: "main",
    baseSha: "a".repeat(40),
    headRef: "feature",
    headSha: "b".repeat(40),
    mergeBaseSha: "a".repeat(40),
    capturedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T01:00:00.000Z",
    outcome: "complete",
    limits: resolveGitChangeSnapshotLimits(),
    completeness,
    entries: [],
    localDivergence: {
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
    },
    snapshotDigest: "c".repeat(64),
  };
}

function baseInput(): Omit<PrDescriptionRenderInput, "branding"> {
  const snapshot = emptySnapshot();
  return {
    snapshot,
    candidate: emptyPrDescriptionCandidate(),
    language: "en",
    outcome: "complete",
    reason: "none",
    coverage: {
      snapshot: snapshot.completeness,
      suppliedEvidenceCount: 0,
      processedEvidenceCount: 0,
      omittedEvidenceCount: 0,
    },
  };
}

function gatewayConfigWithBranding(logoUrl: string | undefined): GatewayConfig {
  return {
    providers: [],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    ...(logoUrl === undefined ? {} : { branding: { logoUrl } }),
  };
}

// Issue #3398 (child correction 8): the config-derived branding must actually change the
// rendered footer, not merely resolve to a differently-shaped object nobody reads.
describe("PR-description footer branding, threaded from GatewayConfig (#3398)", () => {
  it("produces an artifact accepted by the complete Workbench draft-review validator", () => {
    const evidenceId = "e".repeat(64);
    const artifact = buildPrDescriptionArtifact({
      ...baseInput(),
      candidate: {
        summary: [{ text: "Bound change summary", evidenceIds: [evidenceId] }],
        keyChanges: [{ text: "One source change", evidenceIds: [evidenceId] }],
        risks: [],
        reviewerFocus: [],
      },
    });
    expect(
      isWorkbenchDescriptionDraftReview({
        schemaVersion: "1",
        proposalId: "proposal-1",
        expiresAt: "2026-09-05T18:00:00.000Z",
        artifact,
      }),
    ).toBe(true);
  });

  it("renders the logo when the configured URL clears validatedPrDescriptionLogoUrl", () => {
    const branding = resolvePrDescriptionBrandingFromConfig(gatewayConfigWithBranding(IMMUTABLE));
    const artifact = buildPrDescriptionArtifact({ ...baseInput(), branding });
    expect(artifact.markdown).toContain(`![Keiko](${IMMUTABLE}) ${PR_DESCRIPTION_ATTRIBUTION}`);
  });

  it("falls back to text-only attribution when the key is absent", () => {
    const branding = resolvePrDescriptionBrandingFromConfig(gatewayConfigWithBranding(undefined));
    const artifact = buildPrDescriptionArtifact({ ...baseInput(), branding });
    expect(artifact.markdown).toContain(`\n${PR_DESCRIPTION_ATTRIBUTION}\n`);
    expect(artifact.markdown).not.toContain("![Keiko]");
  });

  it("falls back to text-only attribution when the configured URL is invalid", () => {
    const invalid = "http://cdn.example.org/logo.svg";
    const branding = resolvePrDescriptionBrandingFromConfig(gatewayConfigWithBranding(invalid));
    const artifact = buildPrDescriptionArtifact({ ...baseInput(), branding });
    expect(artifact.markdown).toContain(`\n${PR_DESCRIPTION_ATTRIBUTION}\n`);
    expect(artifact.markdown).not.toContain("![Keiko]");
    expect(artifact.markdown).not.toContain(invalid);
  });
});
