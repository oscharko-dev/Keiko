import { spawnSync } from "node:child_process";
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
    publishGates: [
      "version-consistency",
      "publish-manifests",
      "release-impact",
      "package-surface",
      "qi-supply-chain",
      "install-smoke",
    ],
    registry: "https://registry.npmjs.org/",
    releaseNoteBullets: ["Release-impact metadata now governs stable package publication."],
    releaseNoteCategory: "update-notes",
    releaseNotePriority: "normal",
    releaseTag: "v0.2.11",
    remediation: "no-action-required",
    review: {
      approvalReference: "issue:#1690",
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

function oldEntry(overrides = {}) {
  return entry({
    id: "2026-05-01-keiko-0.2.10-baseline",
    packageVersion: "0.2.10",
    releaseNoteBullets: ["Earlier stable metadata remains retained."],
    releaseTag: "v0.2.10",
    ...overrides,
  });
}

function releasePublish(args) {
  return spawnSync(process.execPath, ["scripts/release-publish.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
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

  it("allows explicit correction records without editing the original entry", () => {
    const correction = entry({
      correctionOf: "2026-06-30-keiko-0.2.11-governed-release-impact-baseline",
      correctionRationale: "Clarifies the release-note bullet without mutating the original entry.",
      defaultPatchNotes: false,
      id: "2026-06-30-keiko-0.2.11-governed-release-impact-baseline-correction-1",
      releaseNoteBullets: ["Correction: release-impact metadata is source-controlled."],
    });

    const result = validateReleaseImpactCatalog(catalog([entry(), correction]), rootManifest());

    expect(result).toEqual({ failures: [], ok: true });
  });

  it("rejects correction records that reference missing or self ids", () => {
    const missingTarget = entry({
      correctionOf: "missing-entry",
      correctionRationale: "Attempts to correct a missing row.",
      defaultPatchNotes: false,
      id: "2026-06-30-keiko-0.2.11-missing-correction",
      releaseNoteBullets: ["Correction: missing target."],
    });
    const selfTarget = entry({
      correctionOf: "2026-06-30-keiko-0.2.11-self-correction",
      correctionRationale: "Attempts to correct itself.",
      defaultPatchNotes: false,
      id: "2026-06-30-keiko-0.2.11-self-correction",
      releaseNoteBullets: ["Correction: self target."],
    });

    const result = validateReleaseImpactCatalog(
      catalog([entry(), missingTarget, selfTarget]),
      rootManifest(),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("correctionOf references unknown id missing-entry");
    expect(messages(result)).toContain("correctionOf must not reference itself");
  });

  it("rejects superseding records that point outside the same package release", () => {
    const result = validateReleaseImpactCatalog(
      catalog([
        entry(),
        oldEntry(),
        entry({
          correctionRationale: "Attempts to supersede a different release.",
          defaultPatchNotes: false,
          id: "2026-06-30-keiko-0.2.11-wrong-release-superseding",
          releaseNoteBullets: ["Correction: wrong release target."],
          supersedes: ["2026-05-01-keiko-0.2.10-baseline"],
        }),
      ]),
      rootManifest(),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("supersedes must reference the same package release");
  });

  it("rejects in-place edits or deletions of previously published entries", () => {
    const previousCatalog = catalog([oldEntry()]);
    const changedOldEntry = oldEntry({ userVisibleSummary: "Edited after publication." });

    const changed = validateReleaseImpactCatalog(
      catalog([entry(), changedOldEntry]),
      rootManifest(),
      { previousCatalog },
    );
    const deleted = validateReleaseImpactCatalog(catalog([entry()]), rootManifest(), {
      previousCatalog,
    });

    expect(changed.ok).toBe(false);
    expect(messages(changed)).toContain(
      "published entry 2026-05-01-keiko-0.2.10-baseline changed in place",
    );
    expect(deleted.ok).toBe(false);
    expect(messages(deleted)).toContain(
      "published entry 2026-05-01-keiko-0.2.10-baseline must remain",
    );
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
            approvalReference: "issue:#1690",
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

  it("requires trusted release-owner review and complete stable publish gates", () => {
    const result = validateReleaseImpactCatalog(
      catalog([
        entry({
          publishGates: ["release-impact"],
          review: {
            approvalReference: "issue:#1690",
            humanApproved: true,
            rationale: "Untrusted reviewer should not be enough.",
            reviewedAt: "2026-06-30",
            reviewer: "mallory",
            status: "reviewed",
          },
        }),
      ]),
      rootManifest(),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("review.reviewer must be a trusted release owner");
    expect(messages(result)).toContain("must record publish gate version-consistency");
  });

  it("requires exception metadata for critical or manual-review one-click updates", () => {
    const result = validateReleaseImpactCatalog(
      catalog([
        entry({
          releaseNoteCategory: "critical-security",
          releaseNotePriority: "critical",
          remediation: "manual-review-required",
          userActionRequired: true,
        }),
      ]),
      rootManifest(),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain(
      "requires breakingException metadata for critical or manual-review updates",
    );
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

  it("rejects stable untagged publish and credential-bearing registry URLs", () => {
    const untagged = releasePublish(["--plan-only", "--tag", "latest", "--allow-untagged"]);
    const credentialRegistry = releasePublish([
      "--plan-only",
      "--tag",
      "latest",
      "--registry",
      "https://user:secret@example.invalid/npm/",
    ]);

    expect(untagged.status).toBe(1);
    expect(untagged.stderr).toContain("--allow-untagged cannot be used with --tag latest");
    expect(credentialRegistry.status).toBe(1);
    expect(credentialRegistry.stderr).toContain("registry URL must not include credentials");
    expect(credentialRegistry.stderr).not.toContain("secret");
  });
});
