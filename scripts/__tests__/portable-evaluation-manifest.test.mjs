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

const RUN_ARTIFACTS = [
  { name: "portable-stage-windows-x64-evaluation-unsigned", id: 910001 },
  { name: "portable-stage-macos-arm64-evaluation-unsigned", id: 910002 },
  { name: "portable-stage-macos-x64-evaluation-unsigned", id: 910003 },
];

function manifest(overrides = {}) {
  const built = buildPortableEvaluationManifest({
    releaseTag: "v0.3.1",
    sourceCommitSha: SOURCE_COMMIT,
    repository: "oscharko-dev/Keiko",
    workflowPath: ".github/workflows/portable-assets.yml",
    workflowRunId: 31300595709,
    workflowRunAttempt: 1,
    artifacts: RUN_ARTIFACTS,
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
      "provenance.workflowRunAttempt must be a positive attempt number.",
      "provenance.artifacts must list the run artifacts that carried the published bytes.",
    ]);
  });

  it("refuses provenance whose attempt or artifact identities are unusable", () => {
    // A run id is reused across reruns; the attempt and the immutable artifact ids are what pin
    // the exact execution and bytes, so evidence without them authorizes nothing.
    expect(
      portableEvaluationManifestFailures(
        manifest({ provenance: { ...manifest().provenance, workflowRunAttempt: "0" } }),
        EXPECTED,
      ),
    ).toContain("provenance.workflowRunAttempt must be a positive attempt number.");
    expect(
      portableEvaluationManifestFailures(
        manifest({ provenance: { ...manifest().provenance, artifacts: [] } }),
        EXPECTED,
      ),
    ).toContain(
      "provenance.artifacts must list the run artifacts that carried the published bytes.",
    );
    expect(
      portableEvaluationManifestFailures(
        manifest({
          provenance: {
            ...manifest().provenance,
            artifacts: [{ name: "portable-stage-windows-x64-evaluation-unsigned", id: 0 }],
          },
        }),
        EXPECTED,
      ),
    ).toContain(
      "every provenance artifact must carry a filesystem-safe name and a positive numeric id.",
    );
    // A non-string name must refuse BEFORE the regex: test() would coerce a number like 123
    // into a matching token.
    expect(
      portableEvaluationManifestFailures(
        manifest({
          provenance: { ...manifest().provenance, artifacts: [{ name: 123, id: 7 }] },
        }),
        EXPECTED,
      ),
    ).toContain(
      "every provenance artifact must carry a filesystem-safe name and a positive numeric id.",
    );
    // Declared names reach filesystem and API paths in the verifier: separators and traversal
    // are hostile evidence, refused here at the owning validation layer.
    expect(
      portableEvaluationManifestFailures(
        manifest({
          provenance: {
            ...manifest().provenance,
            artifacts: [{ name: "../escape", id: 7 }],
          },
        }),
        EXPECTED,
      ),
    ).toContain(
      "every provenance artifact must carry a filesystem-safe name and a positive numeric id.",
    );
    expect(
      portableEvaluationManifestFailures(
        manifest({
          provenance: {
            ...manifest().provenance,
            artifacts: [
              { name: "portable-stage-windows-x64-evaluation-unsigned", id: 1 },
              { name: "portable-stage-windows-x64-evaluation-unsigned", id: 2 },
            ],
          },
        }),
        EXPECTED,
      ),
    ).toContain("provenance.artifacts must name each artifact exactly once.");
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

  it("refuses a manifest that declares the same asset twice", () => {
    // Two entries for one name could carry different digests while every set-based check still
    // balances — the publisher would then bind the download to whichever entry it happened to
    // read first.
    const duplicated = manifest();
    duplicated.assets = [...duplicated.assets, { ...duplicated.assets[0], sha256: "b".repeat(64) }];

    expect(portableEvaluationManifestFailures(duplicated, EXPECTED)).toContain(
      "manifest declares the same asset more than once.",
    );
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
