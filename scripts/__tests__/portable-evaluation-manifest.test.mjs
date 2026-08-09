import { describe, expect, it } from "vitest";

import {
  buildPortableEvaluationManifest,
  PORTABLE_EVALUATION_MANIFEST_ASSET_NAME,
  portableEvaluationManifestFailures,
} from "../lib/portable-evaluation-manifest.mjs";

const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = "a".repeat(64);
const ASSET_NAMES = [
  "keiko-windows-x64.zip",
  "keiko-macos-arm64.zip",
  "keiko-macos-x64.zip",
  "keiko-windows-x64-setup.exe",
];

const EXPECTED = {
  releaseTag: "v0.3.1",
  repository: "oscharko-dev/Keiko",
  workflowPath: ".github/workflows/portable-assets.yml",
  assetNames: ASSET_NAMES,
};

function manifest(overrides = {}) {
  const built = buildPortableEvaluationManifest({
    releaseTag: "v0.3.1",
    sourceCommitSha: SOURCE_COMMIT,
    repository: "oscharko-dev/Keiko",
    workflowPath: ".github/workflows/portable-assets.yml",
    workflowRunId: 31300595709,
    assets: ASSET_NAMES.map((assetName, index) => ({
      assetName,
      sizeBytes: 1024 + index,
      sha256: DIGEST,
    })),
  });
  return { ...built, ...overrides };
}

describe("portable evaluation manifest", () => {
  it("names the asset the publisher looks for", () => {
    expect(PORTABLE_EVALUATION_MANIFEST_ASSET_NAME).toBe("keiko-portable-evaluation-manifest.json");
  });

  it("accepts what the producer writes", () => {
    // The producer and the validator are two halves of one contract: if a freshly built manifest
    // did not validate, the publish path would be dead on arrival. The run id is normalized to a
    // string here so a numeric run id from the workflow API cannot fail its own evidence.
    const built = manifest();
    expect(built.provenance.workflowRunId).toBe("31300595709");
    expect(portableEvaluationManifestFailures(built, EXPECTED)).toEqual([]);
  });

  it.each([
    ["a non-object", "not-a-manifest", "must be a JSON object"],
    ["a foreign schema version", manifest({ schemaVersion: 2 }), "schemaVersion must be 1"],
    [
      "a production policy it is not entitled to claim",
      manifest({ verificationPolicy: "production" }),
      'verificationPolicy must be "evaluation"',
    ],
    [
      "another release's tag",
      manifest({ release: { releaseTag: "v0.3.0", sourceCommitSha: SOURCE_COMMIT } }),
      "release.releaseTag must be v0.3.1",
    ],
    [
      "a truncated source commit",
      manifest({ release: { releaseTag: "v0.3.1", sourceCommitSha: "0123456" } }),
      "release.sourceCommitSha must be an exact commit SHA",
    ],
  ])("refuses %s", (_label, candidate, reason) => {
    expect(portableEvaluationManifestFailures(candidate, EXPECTED).join(" ")).toContain(reason);
  });

  it("refuses provenance that names another repository, workflow, or no run", () => {
    const foreign = manifest({
      provenance: {
        repository: "someone-else/Keiko",
        workflowPath: ".github/workflows/release.yml",
        workflowRunId: "not-a-run",
      },
    });

    expect(portableEvaluationManifestFailures(foreign, EXPECTED)).toEqual([
      "provenance.repository must be oscharko-dev/Keiko.",
      "provenance.workflowPath must be .github/workflows/portable-assets.yml.",
      "provenance.workflowRunId must be a numeric run id.",
    ]);
  });

  it("refuses a manifest that omits a published download", () => {
    // The dangerous shape: evidence that covers three of the four downloads would leave the
    // fourth bound to nothing while every declared entry still checks out.
    const partial = manifest();
    partial.assets = partial.assets.slice(0, 3);

    expect(portableEvaluationManifestFailures(partial, EXPECTED)).toEqual([
      "manifest does not declare keiko-windows-x64-setup.exe.",
    ]);
  });

  it("refuses a manifest that declares an asset the release does not publish", () => {
    const extra = manifest();
    extra.assets = [
      ...extra.assets,
      { assetName: "keiko-linux-x64.zip", sizeBytes: 1, sha256: DIGEST },
    ];

    expect(portableEvaluationManifestFailures(extra, EXPECTED)).toEqual([
      "manifest declares unpublished assets: keiko-linux-x64.zip.",
    ]);
  });

  it.each([
    [{ assetName: "keiko-macos-x64.zip", sizeBytes: 0, sha256: DIGEST }, "sizeBytes"],
    [{ assetName: "keiko-macos-x64.zip", sizeBytes: 10, sha256: "short" }, "sha256"],
    [{ assetName: "keiko-macos-x64.zip", sizeBytes: 10, sha256: DIGEST.toUpperCase() }, "sha256"],
  ])("refuses an entry with an unusable %o", (entry, field) => {
    const broken = manifest();
    broken.assets = broken.assets.map((asset) =>
      asset.assetName === entry.assetName ? entry : asset,
    );

    expect(portableEvaluationManifestFailures(broken, EXPECTED).join(" ")).toContain(
      `keiko-macos-x64.zip.${field}`,
    );
  });

  it("refuses an unnamed entry without letting it stand in for a real one", () => {
    const broken = manifest();
    broken.assets = [{ sizeBytes: 10, sha256: DIGEST }, ...broken.assets.slice(1)];
    const failures = portableEvaluationManifestFailures(broken, EXPECTED);

    expect(failures).toContain("every asset entry must name an asset.");
    expect(failures).toContain("manifest does not declare keiko-windows-x64.zip.");
  });

  it("refuses a manifest with no asset list rather than treating it as complete", () => {
    // A missing `assets` must read as "declares nothing", never as "nothing to object to".
    expect(portableEvaluationManifestFailures(manifest({ assets: undefined }), EXPECTED)).toEqual([
      `manifest does not declare ${ASSET_NAMES.join(", ")}.`,
    ]);
  });
});
