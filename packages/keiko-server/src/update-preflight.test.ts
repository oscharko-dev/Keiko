import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  UPDATE_PORTABLE_TARGET_ASSET_NAMES,
  type ReleaseImpactCatalog,
  type ReleaseImpactEntry,
  type UpdateInstallMode,
  type UpdatePortableTarget,
} from "@oscharko-dev/keiko-contracts";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import {
  compareSemver,
  createUpdatePreflightService,
  handleGetUpdatePreflight,
  handlePostUpdatePreflightCheck,
  runUpdatePreflight,
} from "./update-preflight.js";
import type { RouteContext } from "./routes.js";

const APPROVED_RELEASE_REFERENCE = "github-pr-review:oscharko-dev/Keiko#1717#484740";
const ARCHIVE_SHA = "a".repeat(64);
const REVIEWED_COMMIT = "c".repeat(40);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain" },
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function baseCatalog(): ReleaseImpactCatalog {
  return {
    schemaVersion: 1,
    entries: [
      {
        id: "0.2.10-a",
        packageName: "@oscharko-dev/keiko",
        packageVersion: "0.2.10",
        distTag: "latest",
        registry: "https://registry.npmjs.org/",
        releaseTag: "v0.2.10",
        releaseNoteCategory: "update-notes",
        releaseNotePriority: "normal",
        userVisibleChange: "observable",
        userVisibleSummary: "Catalog summary for 0.2.10",
        affectedStateStores: ["workspace"],
        stateImpact: [
          {
            store: "workspace",
            description: "Restart once to load the new workspace schema.",
            remediation: "restart-required",
            userActionRequired: true,
          },
        ],
        userActionRequired: true,
        remediation: "restart-required",
        supportedFrom: ["0.2.0"],
        releaseNoteBullets: ["Shared bullet", "Workspace reliability improvement"],
        internalOnly: false,
        observableImpact: true,
        defaultPatchNotes: true,
        oneClickEligible: true,
        publishGates: [
          "version-consistency",
          "publish-manifests",
          "release-impact",
          "package-surface",
          "qi-supply-chain",
        ],
        review: {
          status: "reviewed",
          reviewer: "release-owner",
          reviewedAt: "2026-06-30",
          humanApproved: true,
          approvalReference: APPROVED_RELEASE_REFERENCE,
          rationale: "Reviewed.",
        },
      },
      {
        id: "0.2.11-a",
        packageName: "@oscharko-dev/keiko",
        packageVersion: "0.2.11",
        distTag: "latest",
        registry: "https://registry.npmjs.org/",
        releaseTag: "v0.2.11",
        releaseNoteCategory: "update-notes",
        releaseNotePriority: "normal",
        userVisibleChange: "observable",
        userVisibleSummary: "Catalog summary for 0.2.11",
        affectedStateStores: ["workspace"],
        stateImpact: [
          {
            store: "workspace",
            description: "Restart once to load the new workspace schema.",
            remediation: "restart-required",
            userActionRequired: true,
          },
        ],
        userActionRequired: false,
        remediation: "no-action-required",
        supportedFrom: ["0.2.0"],
        releaseNoteBullets: ["Shared bullet", "Structured update preflight metadata"],
        internalOnly: false,
        observableImpact: true,
        defaultPatchNotes: true,
        oneClickEligible: true,
        publishGates: [
          "version-consistency",
          "publish-manifests",
          "release-impact",
          "package-surface",
          "qi-supply-chain",
        ],
        review: {
          status: "reviewed",
          reviewer: "release-owner",
          reviewedAt: "2026-06-30",
          humanApproved: true,
          approvalReference: APPROVED_RELEASE_REFERENCE,
          rationale: "Reviewed.",
        },
      },
      {
        id: "0.2.12-beta",
        packageName: "@oscharko-dev/keiko",
        packageVersion: "0.2.12-beta.1",
        distTag: "latest",
        registry: "https://registry.npmjs.org/",
        releaseTag: "v0.2.12-beta.1",
        releaseNoteCategory: "update-notes",
        releaseNotePriority: "normal",
        userVisibleChange: "observable",
        userVisibleSummary: "Ignored prerelease entry",
        affectedStateStores: [],
        stateImpact: [],
        userActionRequired: false,
        remediation: "no-action-required",
        supportedFrom: ["0.2.0"],
        releaseNoteBullets: ["Ignored prerelease bullet"],
        internalOnly: false,
        observableImpact: true,
        defaultPatchNotes: true,
        oneClickEligible: true,
        publishGates: [
          "version-consistency",
          "publish-manifests",
          "release-impact",
          "package-surface",
          "qi-supply-chain",
        ],
        review: {
          status: "reviewed",
          reviewer: "release-owner",
          reviewedAt: "2026-06-30",
          humanApproved: true,
          approvalReference: APPROVED_RELEASE_REFERENCE,
          rationale: "Reviewed.",
        },
      },
    ],
  };
}

function depsWith(fetchImpl: typeof fetch): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    gatewayReadinessFetch: fetchImpl,
  };
}

function portableMode(target: UpdatePortableTarget = "macos-arm64"): UpdateInstallMode {
  return {
    schemaVersion: "1",
    status: "supported",
    packageName: "@oscharko-dev/keiko",
    installKind: "portable-managed",
    portable: {
      status: "managed",
      target,
      updateEligible: true,
      packageVersion: "0.2.10",
      stable: true,
    },
    recommendedAction: "portable-managed-update",
  };
}

function portableBootstrapMode(target: UpdatePortableTarget = "macos-arm64"): UpdateInstallMode {
  return {
    schemaVersion: "1",
    status: "unsupported",
    packageName: "@oscharko-dev/keiko",
    installKind: "portable-bootstrap",
    portable: {
      status: "bootstrap",
      target,
      updateEligible: false,
      packageVersion: "0.2.10",
      stable: true,
    },
    recommendedAction: "portable-bootstrap-setup",
    reason: "portable-bootstrap",
    manualInstructions: "Run portable setup before using in-app updates.",
  };
}

function portableAsset(name: string, id: number, size = 10_000): Record<string, unknown> {
  return {
    id,
    name,
    size,
    browser_download_url: `https://github.com/oscharko-dev/Keiko/releases/download/v0.2.11/${name}`,
  };
}

function portableRelease(target: UpdatePortableTarget): Record<string, unknown> {
  const archiveName = UPDATE_PORTABLE_TARGET_ASSET_NAMES[target];
  return {
    id: 987_654_321,
    tag_name: "v0.2.11",
    name: "Keiko 0.2.11",
    html_url: "https://github.com/oscharko-dev/Keiko/releases/tag/v0.2.11",
    published_at: "2026-07-01T12:00:00.000Z",
    draft: false,
    prerelease: false,
    body: "- Portable update metadata",
    assets: [
      portableAsset("keiko-windows-x64.zip", 10),
      portableAsset("keiko-macos-arm64.zip", 11),
      portableAsset("keiko-macos-x64.zip", 12),
      portableAsset(`${target}-portable-manifest.json`, 101, 2_048),
      portableAsset(`${target}-SHA256SUMS.txt`, 102, 128),
    ].map((asset) => (asset.name === archiveName ? { ...asset, id: 42, size: 99_000 } : asset)),
  };
}

function sidecarRuntime(target: UpdatePortableTarget): Record<string, unknown> {
  return {
    name: "opencode-compatible",
    kind: "coding-runtime",
    upstream: { name: "OpenCode-compatible", version: "1.0.0" },
    adapterCompatibility: {
      adapterName: "keiko-coding-sidecar",
      adapterVersion: "1",
      protocolVersion: "coding-sidecar-v1",
    },
    platformTarget: target,
    payloadRootPath: "runtime/sidecars/opencode-compatible",
    executablePath: "runtime/sidecars/opencode-compatible/opencode.cmd",
    payloadSha256: "f".repeat(64),
    sizeBytes: 1234,
    licenseEvidence: {
      path: "runtime/sidecars/opencode-compatible/LICENSE.txt",
      sha256: "d".repeat(64),
    },
    sbomEvidence: {
      path: "runtime/sidecars/opencode-compatible/evidence/sbom.cdx.json",
      sha256: "e".repeat(64),
    },
    signing: {
      ...signingEvidence(target),
    },
  };
}

function signingEvidence(target: UpdatePortableTarget): Record<string, unknown> {
  return {
    verificationPolicy: "production",
    verificationStatus: "verified-production",
    verificationReasonCodes: [],
    signatureKind: target === "windows-x64" ? "authenticode" : "developer-id-notarized",
    signatureVerified: true,
    notarizationRequired: target !== "windows-x64",
    notarizationVerified: target !== "windows-x64",
    verificationChecks:
      target === "windows-x64"
        ? { publisherChainVerified: true, timestampVerified: true }
        : {
            developerIdVerified: true,
            notarizationVerified: true,
            stapleVerified: true,
            assessmentVerified: true,
          },
  };
}

function sidecarRuntimeWith(
  target: UpdatePortableTarget,
  mutate: (sidecar: Record<string, unknown>) => void,
): Record<string, unknown> {
  const sidecar = sidecarRuntime(target);
  mutate(sidecar);
  return sidecar;
}

function portableManifest(
  target: UpdatePortableTarget,
  sidecarRuntimes: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  const archiveName = UPDATE_PORTABLE_TARGET_ASSET_NAMES[target];
  return {
    schemaVersion: 1,
    product: {
      packageName: "@oscharko-dev/keiko",
      packageVersion: "0.2.11",
    },
    release: {
      releaseId: 987_654_321,
      releaseTag: "v0.2.11",
      stable: true,
      commitSha: REVIEWED_COMMIT,
    },
    artifact: {
      platformTarget: target,
      assetId: 42,
      assetName: archiveName,
      archiveFormat: "zip",
      sizeBytes: 99_000,
      sha256: ARCHIVE_SHA,
    },
    releaseImpact: {
      entryPackageVersion: "0.2.11",
      entryReleaseTag: "v0.2.11",
      reviewedBinding: {
        releaseId: 987_654_321,
        releaseTag: "v0.2.11",
        assetId: 42,
        assetName: archiveName,
        assetSizeBytes: 99_000,
        platformTarget: target,
        packageVersion: "0.2.11",
        archiveSha256: ARCHIVE_SHA,
        platformSignatureLocallyVerified: true,
        ...(sidecarRuntimes.length > 0 ? { sidecarRuntimes } : {}),
      },
    },
    security: signingEvidence(target),
    ...(sidecarRuntimes.length > 0 ? { sidecarRuntimes } : {}),
    updateEligibility: {
      stableOnly: true,
      rollbackSupported: false,
      eligibleAfterSetupOnly: true,
      requiredPredicates: {
        artifactShaVerified: true,
        manifestReleaseImpactBound: true,
        platformSignatureLocallyVerified: true,
      },
    },
  };
}

const ctx: RouteContext = {
  req: {} as IncomingMessage,
  res: {} as RouteContext["res"],
  params: {},
  url: new URL("http://127.0.0.1/api/update/preflight"),
};

describe("update preflight service", () => {
  it("reports current with GitHub release notes when npm latest matches the running version", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.9" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          tag_name: "v0.2.9",
          name: "Keiko 0.2.9",
          html_url: "https://github.com/oscharko-dev/keiko/releases/tag/v0.2.9",
          published_at: "2026-06-29T12:00:00.000Z",
          body: [
            "## Keiko 0.2.9 Release Notes",
            "### High · Improvements",
            "- Current release note",
            "### Normal · Fixes",
            "- Another current note",
            "<details>",
            "<summary>Technical release metadata</summary>",
            "- Package: `@oscharko-dev/keiko@0.2.9`",
            "- Generated by: `npm run release:publish`",
            "</details>",
          ].join("\n"),
        }),
      ) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    expect(report.status).toBe("current");
    expect(report.updateAvailable).toBe(false);
    expect(report.targetVersion).toBe("0.2.9");
    expect(report.releaseMetadataStatus).toBe("live");
    expect(report.release).toMatchObject({
      source: "github-release",
      tag: "v0.2.9",
      title: "Keiko 0.2.9",
      summary: "Current release note",
    });
    expect(report.release?.noteSections).toEqual([
      { title: "High · Improvements", bullets: ["Current release note"] },
      { title: "Normal · Fixes", bullets: ["Another current note"] },
    ]);
    expect(report.patchNotes).toMatchObject({
      collapsed: true,
      summary: "Current release note",
      bullets: ["Another current note"],
      sections: [
        { title: "High · Improvements", bullets: ["Current release note"] },
        { title: "Normal · Fixes", bullets: ["Another current note"] },
      ],
    });
    expect(report.patchNotes?.bullets).not.toContain("Current release note");
    expect(report.patchNotes?.bullets).not.toContain("Generated by: `npm run release:publish`");
    deps.store.close();
  });

  it("requests abbreviated npm metadata so the full packument does not trip the response cap", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.9" } }));
    const deps = depsWith(fetchMock);

    await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall?.[0]).toBe("https://registry.npmjs.org/%40oscharko-dev%2Fkeiko");
    expect(firstCall?.[1]?.headers).toEqual(
      expect.objectContaining({
        Accept: "application/vnd.npm.install-v1+json",
      }),
    );
    deps.store.close();
  });

  it("keeps the current status when current release notes are unavailable", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.9" } }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 })) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    expect(report.status).toBe("current");
    expect(report.updateAvailable).toBe(false);
    expect(report.releaseMetadataStatus).toBe("unavailable");
    expect(report.patchNotes).toBeUndefined();
    expect(report.warnings).toEqual(["Current release notes are unavailable."]);
    deps.store.close();
  });

  it("keeps the running version as target when it is ahead of the registry latest", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.12" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          tag_name: "v0.2.13",
          name: "Keiko 0.2.13",
          html_url: "https://github.com/oscharko-dev/keiko/releases/tag/v0.2.13",
          published_at: "2026-07-05T12:00:00.000Z",
          body: "- Current development release note",
        }),
      ) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.13",
      bundledCatalog: baseCatalog(),
    });

    expect(report.status).toBe("current");
    expect(report.updateAvailable).toBe(false);
    expect(report.targetVersion).toBe("0.2.13");
    expect(report.releaseMetadataStatus).toBe("live");
    expect(report.release?.tag).toBe("v0.2.13");
    expect(report.patchNotes?.summary).toBe("Current development release note");
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/oscharko-dev/keiko/releases/tags/v0.2.13",
      expect.anything(),
    );
    deps.store.close();
  });

  it("returns live GitHub release metadata when an update is available", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.11" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          tag_name: "v0.2.11",
          name: "Keiko 0.2.11",
          html_url: "https://github.com/oscharko-dev/keiko/releases/tag/v0.2.11",
          published_at: "2026-06-30T12:00:00.000Z",
          body: "- Public release note\n- Another note",
        }),
      ) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    expect(report.status).toBe("update-available");
    expect(report.targetVersion).toBe("0.2.11");
    expect(report.releaseMetadataStatus).toBe("live");
    expect(report.release).toMatchObject({
      source: "github-release",
      tag: "v0.2.11",
      title: "Keiko 0.2.11",
      summary: "Public release note",
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/oscharko-dev/keiko/releases/tags/v0.2.11",
      expect.anything(),
    );
    const secondRequest = vi.mocked(fetchImpl).mock.calls[1]?.[1];
    expect(secondRequest?.headers).toMatchObject({
      Accept: "application/vnd.github+json",
      "User-Agent": "Keiko",
    });
    deps.store.close();
  });

  it("uses GitHub Release Assets instead of the npm registry for portable-managed preflight", async () => {
    const target: UpdatePortableTarget = "macos-arm64";
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/releases/latest"))
        return Promise.resolve(jsonResponse(portableRelease(target)));
      if (url.endsWith(`${target}-portable-manifest.json`)) {
        return Promise.resolve(textResponse(JSON.stringify(portableManifest(target))));
      }
      if (url.endsWith(`${target}-SHA256SUMS.txt`)) {
        return Promise.resolve(
          textResponse(`${ARCHIVE_SHA}  ${UPDATE_PORTABLE_TARGET_ASSET_NAMES[target]}\n`),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.10",
      bundledCatalog: baseCatalog(),
      installMode: () => portableMode(target),
    });

    expect(report.status).toBe("update-available");
    expect(report.registryStatus).toBe("not-used");
    expect(report.installabilitySource).toBe("github-release-asset");
    expect(report.targetVersion).toBe("0.2.11");
    expect(report.portableAsset).toMatchObject({
      source: "github-release-asset",
      target,
      status: "eligible",
      asset: {
        assetId: 42,
        releaseId: 987_654_321,
        sha256: ARCHIVE_SHA,
        checksumVerified: true,
      },
    });
    expect(report.oneClickEligible).toBe(true);
    expect(fetchImpl.mock.calls.map((call) => requestUrl(call[0]))).toEqual([
      "https://api.github.com/repos/oscharko-dev/keiko/releases/latest",
      `https://github.com/oscharko-dev/Keiko/releases/download/v0.2.11/${target}-portable-manifest.json`,
      `https://github.com/oscharko-dev/Keiko/releases/download/v0.2.11/${target}-SHA256SUMS.txt`,
    ]);
    deps.store.close();
  });

  it("reports redacted sidecar summaries for sidecar-bearing portable assets", async () => {
    const target: UpdatePortableTarget = "macos-arm64";
    const sidecar = sidecarRuntime(target);
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/releases/latest"))
        return Promise.resolve(jsonResponse(portableRelease(target)));
      if (url.endsWith(`${target}-portable-manifest.json`)) {
        return Promise.resolve(textResponse(JSON.stringify(portableManifest(target, [sidecar]))));
      }
      if (url.endsWith(`${target}-SHA256SUMS.txt`)) {
        return Promise.resolve(
          textResponse(`${ARCHIVE_SHA}  ${UPDATE_PORTABLE_TARGET_ASSET_NAMES[target]}\n`),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.10",
      bundledCatalog: baseCatalog(),
      installMode: () => portableMode(target),
    });

    expect(report.oneClickEligible).toBe(true);
    expect(report.portableAsset?.asset?.sidecarRuntimes?.[0]).toMatchObject({
      name: "opencode-compatible",
      upstreamVersion: "1.0.0",
      platformTarget: target,
      payloadSha256: "f".repeat(64),
      payloadSha256Prefix: "f".repeat(12),
      status: "verified",
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("runtime/sidecars");
    expect(serialized).not.toContain("opencode.cmd");
    deps.store.close();
  });

  it("blocks portable one-click readiness when release-impact requires a missing sidecar", async () => {
    const target: UpdatePortableTarget = "macos-x64";
    const manifest = portableManifest(target);
    const releaseImpact = manifest.releaseImpact as Record<string, unknown>;
    releaseImpact.reviewedBinding = {
      ...(releaseImpact.reviewedBinding as Record<string, unknown>),
      sidecarRuntimes: [sidecarRuntime(target)],
    };
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/releases/latest"))
        return Promise.resolve(jsonResponse(portableRelease(target)));
      if (url.endsWith(`${target}-portable-manifest.json`)) {
        return Promise.resolve(textResponse(JSON.stringify(manifest)));
      }
      if (url.endsWith(`${target}-SHA256SUMS.txt`)) {
        return Promise.resolve(
          textResponse(`${ARCHIVE_SHA}  ${UPDATE_PORTABLE_TARGET_ASSET_NAMES[target]}\n`),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.10",
      bundledCatalog: baseCatalog(),
      installMode: () => portableMode(target),
    });

    expect(report.oneClickEligible).toBe(false);
    expect(report.portableAsset).toMatchObject({ target, status: "malformed" });
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ code: "portable-sidecar-verification-failed" }),
    );
    deps.store.close();
  });

  it.each([
    [
      "platform mismatch",
      (target: UpdatePortableTarget): Record<string, unknown> =>
        sidecarRuntimeWith(target, (sidecar) => {
          sidecar.platformTarget = "windows-x64";
        }),
    ],
    [
      "missing license evidence",
      (target: UpdatePortableTarget): Record<string, unknown> =>
        sidecarRuntimeWith(target, (sidecar) => {
          delete sidecar.licenseEvidence;
        }),
    ],
    [
      "missing SBOM evidence",
      (target: UpdatePortableTarget): Record<string, unknown> =>
        sidecarRuntimeWith(target, (sidecar) => {
          delete sidecar.sbomEvidence;
        }),
    ],
    [
      "unverified signing evidence",
      (target: UpdatePortableTarget): Record<string, unknown> =>
        sidecarRuntimeWith(target, (sidecar) => {
          sidecar.signing = {
            ...(sidecar.signing as Record<string, unknown>),
            verificationStatus: "verification-failed",
          };
        }),
    ],
  ])("blocks portable one-click readiness for sidecar %s", async (_label, makeSidecar) => {
    const target: UpdatePortableTarget = "macos-arm64";
    const sidecar = makeSidecar(target);
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/releases/latest"))
        return Promise.resolve(jsonResponse(portableRelease(target)));
      if (url.endsWith(`${target}-portable-manifest.json`)) {
        return Promise.resolve(textResponse(JSON.stringify(portableManifest(target, [sidecar]))));
      }
      if (url.endsWith(`${target}-SHA256SUMS.txt`)) {
        return Promise.resolve(
          textResponse(`${ARCHIVE_SHA}  ${UPDATE_PORTABLE_TARGET_ASSET_NAMES[target]}\n`),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.10",
      bundledCatalog: baseCatalog(),
      installMode: () => portableMode(target),
    });

    expect(report.oneClickEligible).toBe(false);
    expect(report.portableAsset).toMatchObject({ target, status: "malformed" });
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ code: "portable-sidecar-verification-failed" }),
    );
    deps.store.close();
  });

  it("blocks portable one-click readiness when artifact signing evidence is unverified", async () => {
    const target: UpdatePortableTarget = "macos-arm64";
    const manifest = portableManifest(target);
    const security = manifest.security as Record<string, unknown>;
    security.verificationStatus = "verification-failed";
    security.signatureVerified = false;
    security.notarizationVerified = false;
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/releases/latest"))
        return Promise.resolve(jsonResponse(portableRelease(target)));
      if (url.endsWith(`${target}-portable-manifest.json`)) {
        return Promise.resolve(textResponse(JSON.stringify(manifest)));
      }
      if (url.endsWith(`${target}-SHA256SUMS.txt`)) {
        return Promise.resolve(
          textResponse(`${ARCHIVE_SHA}  ${UPDATE_PORTABLE_TARGET_ASSET_NAMES[target]}\n`),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.10",
      bundledCatalog: baseCatalog(),
      installMode: () => portableMode(target),
    });

    expect(report.oneClickEligible).toBe(false);
    expect(report.portableAsset).toMatchObject({ target, status: "malformed" });
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ code: "portable-manifest-malformed" }),
    );
    deps.store.close();
  });

  it("blocks portable one-click readiness when the matching asset set is incomplete", async () => {
    const target: UpdatePortableTarget = "macos-arm64";
    const release = portableRelease(target);
    const assets = release.assets as readonly Record<string, unknown>[];
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/releases/latest")) {
        return Promise.resolve(
          jsonResponse({
            ...release,
            assets: assets.filter(
              (asset) => asset.name !== UPDATE_PORTABLE_TARGET_ASSET_NAMES[target],
            ),
          }),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.10",
      bundledCatalog: baseCatalog(),
      installMode: () => portableMode(target),
    });

    expect(report.updateAvailable).toBe(true);
    expect(report.registryStatus).toBe("not-used");
    expect(report.oneClickEligible).toBe(false);
    expect(report.manualUpdateRequired).toBe(true);
    expect(report.portableAsset).toMatchObject({ target, status: "missing" });
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ code: "portable-asset-missing" }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    deps.store.close();
  });

  it("blocks portable one-click readiness when release-impact metadata is missing", async () => {
    const target: UpdatePortableTarget = "macos-x64";
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/releases/latest"))
        return Promise.resolve(jsonResponse(portableRelease(target)));
      if (url.endsWith(`${target}-portable-manifest.json`)) {
        return Promise.resolve(textResponse(JSON.stringify(portableManifest(target))));
      }
      if (url.endsWith(`${target}-SHA256SUMS.txt`)) {
        return Promise.resolve(
          textResponse(`${ARCHIVE_SHA}  ${UPDATE_PORTABLE_TARGET_ASSET_NAMES[target]}\n`),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.10",
      bundledCatalog: { schemaVersion: 1, entries: baseCatalog().entries.slice(0, 1) },
      installMode: () => portableMode(target),
    });

    expect(report.updateAvailable).toBe(true);
    expect(report.portableAsset?.status).toBe("eligible");
    expect(report.impact).toBeUndefined();
    expect(report.oneClickEligible).toBe(false);
    expect(report.manualUpdateRequired).toBe(true);
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ code: "release-impact-missing" }),
    );
    deps.store.close();
  });

  it("blocks portable one-click readiness when manifest binding is malformed", async () => {
    const target: UpdatePortableTarget = "macos-arm64";
    const manifest = portableManifest(target);
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/releases/latest"))
        return Promise.resolve(jsonResponse(portableRelease(target)));
      if (url.endsWith(`${target}-portable-manifest.json`)) {
        return Promise.resolve(
          textResponse(
            JSON.stringify({
              ...manifest,
              releaseImpact: {
                ...(manifest.releaseImpact as Record<string, unknown>),
                reviewedBinding: {
                  archiveSha256: "b".repeat(64),
                },
              },
            }),
          ),
        );
      }
      if (url.endsWith(`${target}-SHA256SUMS.txt`)) {
        return Promise.resolve(
          textResponse(`${ARCHIVE_SHA}  ${UPDATE_PORTABLE_TARGET_ASSET_NAMES[target]}\n`),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.10",
      bundledCatalog: baseCatalog(),
      installMode: () => portableMode(target),
    });

    expect(report.updateAvailable).toBe(true);
    expect(report.registryStatus).toBe("not-used");
    expect(report.portableAsset).toMatchObject({ target, status: "malformed" });
    expect(report.oneClickEligible).toBe(false);
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ code: "portable-manifest-malformed" }),
    );
    deps.store.close();
  });

  it("blocks portable one-click readiness when checksum binding does not match", async () => {
    const target: UpdatePortableTarget = "windows-x64";
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/releases/latest"))
        return Promise.resolve(jsonResponse(portableRelease(target)));
      if (url.endsWith(`${target}-portable-manifest.json`)) {
        return Promise.resolve(textResponse(JSON.stringify(portableManifest(target))));
      }
      if (url.endsWith(`${target}-SHA256SUMS.txt`)) {
        return Promise.resolve(
          textResponse(`${"b".repeat(64)}  ${UPDATE_PORTABLE_TARGET_ASSET_NAMES[target]}\n`),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.10",
      bundledCatalog: baseCatalog(),
      installMode: () => portableMode(target),
    });

    expect(report.updateAvailable).toBe(true);
    expect(report.registryStatus).toBe("not-used");
    expect(report.portableAsset).toMatchObject({ target, status: "malformed" });
    expect(report.oneClickEligible).toBe(false);
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ code: "portable-checksum-mismatch" }),
    );
    deps.store.close();
  });

  it("fails closed on prerelease portable GitHub metadata without consulting npm", async () => {
    const target: UpdatePortableTarget = "windows-x64";
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/releases/latest")) {
        return Promise.resolve(
          jsonResponse({
            ...portableRelease(target),
            tag_name: "v0.2.12-beta.1",
            prerelease: true,
          }),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.10",
      bundledCatalog: baseCatalog(),
      installMode: () => portableMode(target),
    });

    expect(report.status).toBe("degraded");
    expect(report.registryStatus).toBe("not-used");
    expect(report.releaseMetadataStatus).toBe("malformed");
    expect(report.updateAvailable).toBe(false);
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ code: "portable-release-malformed" }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    deps.store.close();
  });

  it("does not fall back to npm preflight for portable bootstrap folders", async () => {
    const target: UpdatePortableTarget = "macos-arm64";
    const fetchImpl = vi.fn<typeof fetch>();
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.10",
      bundledCatalog: baseCatalog(),
      installMode: () => portableBootstrapMode(target),
    });

    expect(report.status).toBe("degraded");
    expect(report.registryStatus).toBe("not-used");
    expect(report.portableAsset).toMatchObject({ target, status: "install-mode-ineligible" });
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ code: "portable-install-mode-ineligible" }),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    deps.store.close();
  });

  it("fails quietly with a degraded report when the registry times out", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("timeout", "TimeoutError")) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    expect(report.status).toBe("degraded");
    expect(report.registryStatus).toBe("unavailable");
    expect(report.targetVersion).toBeUndefined();
    expect(report.releaseMetadataStatus).toBe("not-needed");
    deps.store.close();
  });

  it("falls back to the bundled catalog when GitHub is unavailable", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.11" } }))
      .mockResolvedValueOnce(new Response("nope", { status: 503 })) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    expect(report.releaseMetadataStatus).toBe("fallback");
    expect(report.release).toMatchObject({
      source: "bundled-catalog",
      tag: "v0.2.11",
      summary: "Catalog summary for 0.2.11",
    });
    expect(report.severity).toBe("normal");
    expect(report.oneClickEligible).toBe(true);
    expect(report.userActionRequired).toBe(true);
    expect(report.manualUpdateRequired).toBe(false);
    expect(report.affectedStateStores).toEqual(["workspace"]);
    expect(report.blockers).toEqual([]);
    expect(report.patchNotes).toMatchObject({
      collapsed: true,
      summary: "Catalog summary for 0.2.11",
    });
    expect(report.warnings).toContain(
      "GitHub release metadata is unavailable; bundled release impact will be used.",
    );
    deps.store.close();
  });

  it("treats malformed GitHub metadata as fallback-able metadata", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.11" } }))
      .mockResolvedValueOnce(jsonResponse({ tag_name: "v0.2.10", body: 42 })) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    expect(report.releaseMetadataStatus).toBe("fallback");
    expect(report.release?.source).toBe("bundled-catalog");
    expect(report.warnings).toContain(
      "GitHub release metadata was malformed; bundled release impact will be used.",
    );
    deps.store.close();
  });

  it("builds the release summary from the bundled catalog when GitHub is unavailable", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.10" } }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 })) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    expect(report.release).toEqual({
      source: "bundled-catalog",
      tag: "v0.2.10",
      title: "Keiko 0.2.10",
      summary: "Catalog summary for 0.2.10",
      notes: ["Shared bullet", "Workspace reliability improvement"],
    });
    deps.store.close();
  });

  it("aggregates same-version bundled notes when GitHub fallback is forced", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.11" } }))
      .mockResolvedValueOnce(new Response("missing", { status: 503 })) as typeof fetch;
    const deps = depsWith(fetchImpl);
    const followUpEntry = {
      id: "0.2.11-b",
      packageName: "@oscharko-dev/keiko",
      packageVersion: "0.2.11",
      distTag: "latest",
      registry: "https://registry.npmjs.org/",
      releaseTag: "v0.2.11",
      releaseNoteCategory: "update-notes",
      releaseNotePriority: "normal",
      userVisibleChange: "observable",
      userVisibleSummary: "Catalog follow-up summary for 0.2.11",
      affectedStateStores: ["workspace"],
      stateImpact: [
        {
          store: "workspace",
          description: "Restart once to load the new workspace schema.",
          remediation: "restart-required",
          userActionRequired: true,
        },
      ],
      userActionRequired: false,
      remediation: "no-action-required",
      supportedFrom: ["0.2.0"],
      releaseNoteBullets: ["Shared bullet", "Target release follow-up"],
      internalOnly: false,
      observableImpact: true,
      defaultPatchNotes: true,
      oneClickEligible: true,
      publishGates: [
        "version-consistency",
        "publish-manifests",
        "release-impact",
        "package-surface",
        "qi-supply-chain",
      ],
      review: {
        status: "reviewed",
        reviewer: "release-owner",
        reviewedAt: "2026-06-30",
        humanApproved: true,
        approvalReference: APPROVED_RELEASE_REFERENCE,
        rationale: "Reviewed.",
      },
    } satisfies ReleaseImpactEntry;
    const catalog = {
      ...baseCatalog(),
      entries: [...baseCatalog().entries, followUpEntry],
    };

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: catalog,
    });

    expect(report.releaseMetadataStatus).toBe("fallback");
    expect(report.release).toEqual({
      source: "bundled-catalog",
      tag: "v0.2.11",
      title: "Keiko 0.2.11",
      summary: "Catalog follow-up summary for 0.2.11",
      notes: ["Shared bullet", "Structured update preflight metadata", "Target release follow-up"],
    });
    deps.store.close();
  });

  it("blocks one-click readiness when the installed version is outside the reviewed supported path", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.10" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          tag_name: "v0.2.10",
          name: "Keiko 0.2.10",
          body: "- Public release note",
        }),
      ) as typeof fetch;
    const deps = depsWith(fetchImpl);
    const catalog = {
      ...baseCatalog(),
      entries: baseCatalog().entries.map((entry, index) =>
        index === 0 ? { ...entry, supportedFrom: ["0.2.5"] } : entry,
      ),
    };

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.4",
      bundledCatalog: catalog,
    });

    expect(report.status).toBe("update-available");
    expect(report.releaseMetadataStatus).toBe("live");
    expect(report.release?.source).toBe("github-release");
    expect(report.blockers).toEqual([
      expect.objectContaining({
        code: "one-click-ineligible",
        userActionRequired: true,
      }),
    ]);
    expect(report.manualUpdateRequired).toBe(true);
    expect(report.oneClickEligible).toBe(false);
    deps.store.close();
  });

  it("uses the highest reviewed supported floor across the whole upgrade chain", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.11" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          tag_name: "v0.2.11",
          name: "Keiko 0.2.11",
          body: "- Public release note",
        }),
      ) as typeof fetch;
    const deps = depsWith(fetchImpl);
    const catalog = {
      ...baseCatalog(),
      entries: baseCatalog().entries.map((entry) =>
        entry.packageVersion === "0.2.10"
          ? { ...entry, supportedFrom: ["0.2.8"] }
          : entry.packageVersion === "0.2.11"
            ? { ...entry, supportedFrom: ["0.2.5"] }
            : entry,
      ),
    };

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.6",
      bundledCatalog: catalog,
    });

    expect(report.impact?.entries.map((entry) => entry.packageVersion)).toEqual([
      "0.2.10",
      "0.2.11",
    ]);
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0]?.code).toBe("one-click-ineligible");
    expect(report.blockers[0]?.message).toContain("starts at 0.2.8");
    expect(report.manualUpdateRequired).toBe(true);
    expect(report.oneClickEligible).toBe(false);
    deps.store.close();
  });

  it("deduplicates cumulative impact bullets and state impact across included versions", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.11" } }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 })) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    expect(report.impact?.entries.map((entry) => entry.packageVersion)).toEqual([
      "0.2.10",
      "0.2.11",
    ]);
    expect(report.impact?.releaseNoteBullets).toEqual([
      "Shared bullet",
      "Workspace reliability improvement",
      "Structured update preflight metadata",
    ]);
    expect(report.impact?.stateImpact).toHaveLength(1);
    expect(report.impact?.affectedStateStores).toEqual(["workspace"]);
    expect(report.impact?.remediations).toEqual(["restart-required", "no-action-required"]);
    expect(report.patchNotes?.bullets).toEqual([
      "Shared bullet",
      "Structured update preflight metadata",
      "Workspace reliability improvement",
    ]);
    expect(report.patchNotes?.details).toEqual([
      "0.2.10: Catalog summary for 0.2.10",
      "0.2.11: Catalog summary for 0.2.11",
    ]);
    deps.store.close();
  });

  it("drops malformed bundled catalog entries and fails closed without throwing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.10" } }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 })) as typeof fetch;
    const deps = depsWith(fetchImpl);
    const catalog = {
      schemaVersion: 1,
      entries: [
        {
          id: "0.2.10-malformed",
          packageName: "@oscharko-dev/keiko",
          packageVersion: "0.2.10",
          distTag: "latest",
          registry: "https://registry.npmjs.org/",
          releaseTag: "v0.2.10",
          releaseNoteCategory: "update-notes",
          releaseNotePriority: "normal",
          userVisibleChange: "observable",
          userVisibleSummary: "Malformed entry should be dropped.",
          affectedStateStores: ["workspace"],
          stateImpact: [
            {
              store: "workspace",
              description: "This malformed shape should never be used.",
              remediation: "restart-required",
              userActionRequired: true,
            },
            7,
          ],
          userActionRequired: false,
          remediation: "no-action-required",
          supportedFrom: ["0.2.0"],
          releaseNoteBullets: ["Valid bullet", 7],
          internalOnly: false,
          observableImpact: true,
          defaultPatchNotes: true,
          oneClickEligible: true,
          publishGates: [
            "version-consistency",
            "publish-manifests",
            "release-impact",
            "package-surface",
            "qi-supply-chain",
          ],
          review: {
            status: "reviewed",
            reviewer: "release-owner",
            reviewedAt: "2026-06-30",
            humanApproved: true,
            approvalReference: APPROVED_RELEASE_REFERENCE,
            rationale: "Reviewed.",
          },
        },
      ],
    } as unknown as ReleaseImpactCatalog;

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: catalog,
    });

    expect(report.releaseMetadataStatus).toBe("unavailable");
    expect(report.release).toBeUndefined();
    expect(report.impact).toBeUndefined();
    expect(report.blockers).toEqual([
      expect.objectContaining({
        code: "release-impact-missing",
        userActionRequired: true,
      }),
    ]);
    expect(report.manualUpdateRequired).toBe(true);
    expect(report.oneClickEligible).toBe(false);
    deps.store.close();
  });

  it("blocks one-click readiness when reviewed target release-impact metadata is missing", async () => {
    const catalog = baseCatalog();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.11" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          tag_name: "v0.2.11",
          name: "Keiko 0.2.11",
          body: "- Public note",
        }),
      ) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.10",
      bundledCatalog: { schemaVersion: 1, entries: catalog.entries.slice(0, 1) },
    });

    expect(report.updateAvailable).toBe(true);
    expect(report.releaseMetadataStatus).toBe("live");
    expect(report.release?.source).toBe("github-release");
    expect(report.impact).toBeUndefined();
    expect(report.oneClickEligible).toBe(false);
    expect(report.manualUpdateRequired).toBe(true);
    expect(report.blockers).toEqual([
      expect.objectContaining({
        code: "release-impact-missing",
        userActionRequired: true,
      }),
    ]);
    deps.store.close();
  });

  it("blocks one-click readiness when runtime metadata only has issue-scoped approval evidence", async () => {
    const catalog = {
      ...baseCatalog(),
      entries: baseCatalog().entries.map((entry) =>
        entry.packageVersion === "0.2.11"
          ? {
              ...entry,
              review: {
                ...entry.review,
                approvalReference: "issue:#1692",
              },
            }
          : entry,
      ),
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.11" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          tag_name: "v0.2.11",
          name: "Keiko 0.2.11",
          body: "- Public note",
        }),
      ) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.10",
      bundledCatalog: catalog,
    });

    expect(report.releaseMetadataStatus).toBe("live");
    expect(report.release?.source).toBe("github-release");
    expect(report.impact).toBeUndefined();
    expect(report.oneClickEligible).toBe(false);
    expect(report.manualUpdateRequired).toBe(true);
    expect(report.blockers).toEqual([
      expect.objectContaining({
        code: "release-impact-missing",
        userActionRequired: true,
      }),
    ]);
    deps.store.close();
  });

  it("compares semver numerically instead of lexically", () => {
    expect(compareSemver("0.2.9", "0.2.10")).toBeLessThan(0);
    expect(compareSemver("0.2.10", "0.2.10")).toBe(0);
    expect(compareSemver("0.3.0", "0.2.99")).toBeGreaterThan(0);
  });

  it("rejects malformed semver comparisons instead of lexically sorting them", () => {
    expect(() => compareSemver("1.10.0", "not-a-version")).toThrow(TypeError);
  });

  it("surfaces malformed registry metadata as a degraded state", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: 7 } })) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    expect(report.status).toBe("degraded");
    expect(report.registryStatus).toBe("malformed");
    expect(report.releaseMetadataStatus).toBe("not-needed");
    deps.store.close();
  });

  it("ignores prerelease latest tags in v1", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ "dist-tags": { latest: "0.2.12-beta.1" } }),
      ) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.11",
      bundledCatalog: baseCatalog(),
    });

    expect(report.status).toBe("current");
    expect(report.updateAvailable).toBe(false);
    expect(report.targetVersion).toBe("0.2.11");
    expect(report.warnings).toContain(
      "The registry latest dist-tag currently points to a prerelease and was ignored.",
    );
    deps.store.close();
  });

  it("caches the startup result per BFF while manual checks always retry", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.10" } }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.11" } }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 })) as typeof fetch;
    const deps = depsWith(fetchImpl);
    const service = createUpdatePreflightService({
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    const startupA = await service.getStartupReport(deps);
    const startupB = await service.getStartupReport(deps);
    const manual = await service.runManualCheck(deps);

    expect(startupA.targetVersion).toBe("0.2.10");
    expect(startupB.targetVersion).toBe("0.2.10");
    expect(manual.targetVersion).toBe("0.2.11");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    deps.store.close();
  });
});

describe("update preflight route handlers", () => {
  it("reuses the startup session on GET and retries on manual POST", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.12" } }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.12" } }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 })) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const first = await handleGetUpdatePreflight(ctx, deps);
    const second = await handleGetUpdatePreflight(ctx, deps);
    const manual = await handlePostUpdatePreflightCheck(ctx, deps);

    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(manual.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    deps.store.close();
  });
});
