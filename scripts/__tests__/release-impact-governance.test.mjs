import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  validateReleaseImpactCatalog,
  validateReleaseImpactRoot,
} from "../check-release-impact.mjs";

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
    id: "2026-06-30-keiko-0.2.11-governed-release-impact-baseline",
    internalOnly: false,
    observableImpact: true,
    oneClickEligible: true,
    packageName: "@oscharko-dev/keiko",
    packageVersion: "0.2.11",
    publishGates: ["version-consistency", "publish-manifests", "release-impact"],
    registry: "https://registry.npmjs.org/",
    releaseNoteBullets: ["Release-impact metadata now governs stable package publication."],
    releaseNoteCategory: "update-notes",
    releaseNotePriority: "normal",
    releaseTag: "v0.2.11",
    remediation: "no-action-required",
    review: {
      humanApproved: true,
      rationale: "Reviewed for stable publish.",
      reviewedAt: "2026-06-30",
      reviewer: "release-owner",
      status: "reviewed",
    },
    stateImpact: [],
    supportedFrom: ["0.2.0"],
    userActionRequired: false,
    userVisibleChange: "observable",
    userVisibleSummary: "Release-impact metadata is now reviewed before stable publication.",
    ...overrides,
  };
}

function catalog(entries = [entry()]) {
  return { entries, schemaVersion: 1 };
}

function messages(result) {
  return result.failures.join("\n");
}

function writeJson(root, relativePath, value) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("release-impact governance", () => {
  let tempRoot;

  afterEach(() => {
    if (tempRoot !== undefined) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it("accepts reviewed metadata for the current package version", () => {
    const result = validateReleaseImpactCatalog(catalog(), rootManifest());

    expect(result).toEqual({ failures: [], ok: true });
  });

  it("reports missing manifests without throwing", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "keiko-release-impact-"));
    writeJson(tempRoot, "release-impact.catalog.json", catalog());

    const result = validateReleaseImpactRoot(tempRoot);

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("package.json is missing");
  });

  it("blocks publish when the current package version has no catalog entry", () => {
    const result = validateReleaseImpactCatalog(catalog(), rootManifest({ version: "0.2.12" }));

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("@oscharko-dev/keiko@0.2.12 has no latest catalog entry");
  });

  it("blocks duplicated default patch-note bullets", () => {
    const duplicate = entry({
      id: "2026-06-30-keiko-0.2.10-duplicate-note",
      packageVersion: "0.2.10",
      releaseTag: "v0.2.10",
    });

    const result = validateReleaseImpactCatalog(catalog([entry(), duplicate]), rootManifest());

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("duplicates patch note");
  });

  it("requires baseline supported-from coverage", () => {
    const result = validateReleaseImpactCatalog(
      catalog([entry({ supportedFrom: ["0.2.5"] })]),
      rootManifest(),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("must include supportedFrom 0.2.0");
  });

  it("requires affected state records to declare remediation", () => {
    const result = validateReleaseImpactCatalog(
      catalog([
        entry({
          affectedStateStores: ["local-knowledge"],
          releaseNoteCategory: "state-or-compatibility-changes",
          remediation: "restart-required",
          stateImpact: [
            {
              description: "Indexes must be rebuilt.",
              store: "local-knowledge",
              userActionRequired: true,
            },
          ],
        }),
      ]),
      rootManifest(),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("stateImpact[0].remediation");
  });

  it("requires human approval and carry-forward proof for critical breaking entries", () => {
    const result = validateReleaseImpactCatalog(
      catalog([
        entry({
          breakingException: {
            rationale: "Security patch requires explicit warning.",
            warningText: "Update changes local state compatibility.",
          },
          releaseNoteCategory: "critical-security",
          releaseNotePriority: "critical",
          review: {
            humanApproved: false,
            rationale: "Pending release-owner review.",
            reviewedAt: "2026-06-30",
            reviewer: "release-owner",
            status: "pending",
          },
        }),
      ]),
      rootManifest(),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("must have human release-owner review");
    expect(messages(result)).toContain("cannot be one-click eligible without carry-forward proof");
  });

  it("keeps non-observable internal-only entries out of default patch notes", () => {
    const result = validateReleaseImpactCatalog(
      catalog([
        entry({
          defaultPatchNotes: true,
          internalOnly: true,
          observableImpact: false,
          releaseNoteCategory: "internal-only",
          releaseNotePriority: "internal",
          userVisibleChange: "none",
        }),
      ]),
      rootManifest(),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain(
      "internal-only metadata must stay out of default patch notes",
    );
  });

  it("requires the bundled root catalog to be included in package files", () => {
    const result = validateReleaseImpactCatalog(
      catalog(),
      rootManifest({ files: ["dist", "README.md"] }),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain(
      "package.json files must include release-impact.catalog.json",
    );
  });
});
