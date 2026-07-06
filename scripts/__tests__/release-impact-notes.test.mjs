import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { renderReleaseImpactNotes } from "../release-impact-notes.mjs";

function rootManifest(overrides = {}) {
  return {
    files: [
      "dist",
      "README.md",
      "LICENSE",
      "NOTICE",
      "TRADEMARKS.md",
      "release-impact.catalog.json",
    ],
    name: "@oscharko-dev/keiko",
    version: "0.2.11",
    ...overrides,
  };
}

function entry(overrides = {}) {
  return {
    affectedStateStores: [],
    defaultPatchNotes: true,
    distTag: "latest",
    id: "2026-06-30-keiko-0.2.11-release-note-baseline",
    internalOnly: false,
    observableImpact: true,
    oneClickEligible: true,
    packageName: "@oscharko-dev/keiko",
    packageVersion: "0.2.11",
    publishGates: [
      "version-consistency",
      "publish-manifests",
      "release-impact",
      "workspace-supply-chain",
      "package-surface",
      "qi-supply-chain",
    ],
    registry: "https://registry.npmjs.org/",
    releaseNoteBullets: ["Release-impact metadata now governs stable package publication."],
    releaseNoteCategory: "update-notes",
    releaseNotePriority: "normal",
    releaseTag: "v0.2.11",
    remediation: "no-action-required",
    review: {
      approvalReference: "issue:#1691",
      humanApproved: true,
      rationale: "Reviewed release-note metadata.",
      reviewedAt: "2026-06-30",
      reviewer: "release-owner",
      status: "reviewed",
    },
    stateImpact: [],
    supportedFrom: ["0.2.0"],
    userActionRequired: false,
    userVisibleChange: "observable",
    userVisibleSummary: "Release-impact metadata is reviewed before stable publication.",
    ...overrides,
  };
}

function catalog(entries) {
  return { entries, schemaVersion: 1 };
}

function indexOfNeedle(text, needle) {
  const index = text.indexOf(needle);
  expect(index, `${needle} not found in release notes`).toBeGreaterThanOrEqual(0);
  return index;
}

function releasePublish(args) {
  return spawnSync(process.execPath, ["scripts/release-publish.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("release-impact release notes", () => {
  it("renders reviewed impact metadata as ordered human-readable notes", () => {
    const critical = entry({
      id: "critical-security-fix",
      releaseNoteBullets: ["Protects release approval checks from forged review metadata (#1703)."],
      releaseNoteCategory: "critical-security",
      releaseNotePriority: "critical",
      breakingException: {
        carryForwardPath: "docs/release/release-impact-runbook.md",
        rationale: "Security-sensitive publish metadata must be prominent.",
        verifiedCarryForward: true,
        warningText: "Release approval metadata is stricter.",
      },
    });
    const state = entry({
      affectedStateStores: ["local-knowledge"],
      id: "state-reindex",
      releaseNoteBullets: ["Rebuilds Local Knowledge indexes after update PR #1704."],
      releaseNoteCategory: "state-or-compatibility-changes",
      releaseNotePriority: "high",
      remediation: "local-knowledge-reindex-required",
      stateImpact: [
        {
          description: "Local Knowledge indexes need to be rebuilt.",
          remediation: "local-knowledge-reindex-required",
          store: "local-knowledge",
          userActionRequired: true,
        },
      ],
      userActionRequired: true,
      userVisibleChange: "compatibility",
    });
    const polish = entry({
      id: "ui-polish",
      releaseNoteBullets: ["Polishes the Updates window copy."],
      releaseNoteCategory: "ui-polish",
      releaseNotePriority: "low",
    });

    const result = renderReleaseImpactNotes(catalog([polish, state, critical]), rootManifest());

    expect(result.ok).toBe(true);
    const criticalIndex = indexOfNeedle(result.notes, "### Critical · Critical Security");
    const stateIndex = indexOfNeedle(result.notes, "### High · State and Compatibility");
    const polishIndex = indexOfNeedle(result.notes, "### Low · UI Polish");
    expect(criticalIndex).toBeLessThan(stateIndex);
    expect(stateIndex).toBeLessThan(polishIndex);
    expect(result.notes).toContain(
      "- Protects release approval checks from forged review metadata.",
    );
    expect(result.notes).toContain("- Rebuilds Local Knowledge indexes after update.");
    const userFacingNotes = result.notes.split("<details>")[0];
    expect(userFacingNotes).not.toContain("(#1703)");
    expect(userFacingNotes).not.toContain("PR #1704");
    expect(result.notes).toContain("traceability catalog:critical-security-fix");
    expect(result.notes).toContain("source:#1703");
    expect(result.notes).toContain("source:PR #1704");
  });

  it("deduplicates sanitized bullets and hides internal-only entries from default notes", () => {
    const first = entry({
      id: "dedupe-first",
      releaseNoteBullets: ["Improves release-note publishing (#1703)."],
      releaseNoteCategory: "improvements",
    });
    const second = entry({
      id: "dedupe-second",
      releaseNoteBullets: ["Improves release-note publishing (#1704)."],
      releaseNoteCategory: "improvements",
    });
    const internal = entry({
      defaultPatchNotes: false,
      id: "internal-build-refactor",
      internalOnly: true,
      observableImpact: false,
      releaseNoteBullets: ["Internal build graph refactor."],
      releaseNoteCategory: "internal-only",
      releaseNotePriority: "internal",
      userVisibleChange: "none",
    });

    const result = renderReleaseImpactNotes(catalog([first, second, internal]), rootManifest());

    expect(result.ok).toBe(true);
    expect(result.notes.match(/Improves release-note publishing\./gu)).toHaveLength(1);
    expect(result.notes).not.toContain("- Internal build graph refactor.");
    expect(result.notes).not.toContain("internal-build-refactor");
  });

  it("renders observable internal-only entries when default patch notes explicitly include them", () => {
    const result = renderReleaseImpactNotes(
      catalog([
        entry({
          id: "observable-internal-release-gate",
          internalOnly: true,
          observableImpact: true,
          releaseNoteBullets: ["Improves release publish reliability for maintainers."],
          releaseNoteCategory: "internal-only",
          releaseNotePriority: "internal",
          userVisibleChange: "observable",
        }),
      ]),
      rootManifest(),
    );

    expect(result.ok).toBe(true);
    expect(result.notes).toContain("### Internal · Internal Only");
    expect(result.notes).toContain("- Improves release publish reliability for maintainers.");
    expect(result.notes).toContain("observable-internal-release-gate");
  });

  it("fails closed when metadata does not match the package version", () => {
    const result = renderReleaseImpactNotes(
      catalog([entry({ packageVersion: "0.2.10", releaseTag: "v0.2.10" })]),
      rootManifest(),
    );

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("@oscharko-dev/keiko@0.2.11 has no latest");
  });

  it("fails closed when public release notes contain local paths or secret-like values", () => {
    const pathResult = renderReleaseImpactNotes(
      catalog([
        entry({
          id: "path-leak",
          releaseNoteBullets: ["Avoids reading from /Users/alice/private/project."],
        }),
      ]),
      rootManifest(),
    );
    const secretResult = renderReleaseImpactNotes(
      catalog([
        entry({
          id: "secret-leak",
          releaseNoteBullets: ["Rotates sk-live-123456789 before release."],
        }),
      ]),
      rootManifest(),
    );

    expect(pathResult.ok).toBe(false);
    expect(pathResult.failures.join("\n")).toContain("absolute local filesystem path");
    expect(secretResult.ok).toBe(false);
    expect(secretResult.failures.join("\n")).toContain("secret-like token");
  });

  it("prints generated notes during plan-only release proof without publishing", () => {
    const result = releasePublish(["--plan-only", "--tag", "beta"]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain("-----BEGIN KEIKO RELEASE NOTES-----");
    expect(output).toContain("## Keiko 0.2.14 Release Notes");
    expect(output).toContain(
      "Fixes Local Knowledge startup for encrypted stores created with the previous v2 content-encryption scope by upgrading them to the current v3 scope instead of surfacing LOCAL_KNOWLEDGE_UNAVAILABLE.",
    );
    expect(output).toContain("release-publish: PLAN-ONLY complete.");
  }, 60_000);
});
