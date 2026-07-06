import { describe, expect, it } from "vitest";
import {
  UPDATE_INSTALL_MODE_KINDS,
  UPDATE_PORTABLE_ACTIVATION_STATUSES,
  UPDATE_PORTABLE_ASSET_VERIFICATION_STATUSES,
  UPDATE_PORTABLE_INSTALL_STATUSES,
  UPDATE_PORTABLE_STAGING_STATUSES,
  UPDATE_PORTABLE_TARGET_ASSET_NAMES,
  UPDATE_PORTABLE_TARGETS,
  UPDATE_RECOMMENDED_ACTIONS,
  UPDATE_SESSION_FAILURE_REASONS,
  UPDATE_UNSUPPORTED_REASONS,
  parseUpdateSessionStartRequest,
  type UpdatePortableActivationSummary,
  type UpdatePortableAssetSummary,
  type UpdatePortableInstallSummary,
  type UpdatePortableStagingSummary,
} from "./update-session.js";

describe("update session portable contract", () => {
  it("pins portable install-mode vocabulary", () => {
    expect(UPDATE_PORTABLE_TARGETS).toEqual(["windows-x64", "macos-arm64", "macos-x64"]);
    expect(UPDATE_PORTABLE_TARGET_ASSET_NAMES).toEqual({
      "windows-x64": "keiko-windows-x64.zip",
      "macos-arm64": "keiko-macos-arm64.zip",
      "macos-x64": "keiko-macos-x64.zip",
    });
    expect(UPDATE_INSTALL_MODE_KINDS).toContain("portable-managed");
    expect(UPDATE_PORTABLE_INSTALL_STATUSES).toEqual([
      "managed",
      "bootstrap",
      "setup-failed",
      "it-managed",
    ]);
    expect(UPDATE_RECOMMENDED_ACTIONS).toEqual([
      "package-manager-maintenance",
      "portable-managed-update",
      "portable-bootstrap-setup",
      "manual-download",
    ]);
    expect(UPDATE_UNSUPPORTED_REASONS).toContain("portable-bootstrap");
    expect(UPDATE_UNSUPPORTED_REASONS).toContain("portable-it-managed");
  });

  it("models redacted portable install and asset summaries", () => {
    const install: UpdatePortableInstallSummary = {
      status: "managed",
      target: "macos-x64",
      updateEligible: true,
      packageVersion: "0.2.14",
      stable: true,
      managedRootKind: "home-relative",
      installRootIdentitySha256: "a".repeat(64),
    };
    const asset: UpdatePortableAssetSummary = {
      target: "macos-x64",
      fileName: "keiko-macos-x64.zip",
      packageVersion: "0.2.14",
      sha256: "b".repeat(64),
      verificationStatus: "pending",
    };

    expect(install).not.toHaveProperty("managedRoot");
    expect(asset.fileName).toBe("keiko-macos-x64.zip");
    expect(UPDATE_PORTABLE_ACTIVATION_STATUSES).toEqual(["pending", "activated", "failed"]);
    expect(UPDATE_PORTABLE_ASSET_VERIFICATION_STATUSES).toEqual(["pending", "verified", "failed"]);
    expect(UPDATE_PORTABLE_STAGING_STATUSES).toEqual(["pending", "staged", "failed"]);
    expect(UPDATE_SESSION_FAILURE_REASONS).toContain("portable-staging-failed");
    expect(UPDATE_SESSION_FAILURE_REASONS).toContain("portable-activation-failed");
  });

  it("models content-free portable staging summaries", () => {
    const stage: UpdatePortableStagingSummary = {
      stageId: "stage-1",
      status: "staged",
      target: "windows-x64",
      packageVersion: "0.2.14",
      assetName: "keiko-windows-x64.zip",
      assetId: 123,
      releaseId: 456,
      sizeBytes: 789,
      sha256: "c".repeat(64),
      manifestSha256: "d".repeat(64),
    };

    expect(stage).not.toHaveProperty("stagingPath");
    expect(stage).not.toHaveProperty("downloadUrl");
    expect(stage).not.toHaveProperty("managedRoot");
  });

  it("models content-free portable activation summaries", () => {
    const activation: UpdatePortableActivationSummary = {
      activationId: "activation-1",
      status: "activated",
      stageId: "stage-1",
      target: "macos-arm64",
      packageVersion: "0.2.14",
      registrationRefreshed: true,
      shortcutRefreshed: true,
      relaunchRequested: true,
      versionVerified: true,
    };

    expect(activation).not.toHaveProperty("managedRoot");
    expect(activation).not.toHaveProperty("stagingPath");
    expect(activation).not.toHaveProperty("launcherPath");
  });

  it("keeps session start requests stable-only", () => {
    expect(parseUpdateSessionStartRequest({ targetVersion: "0.2.14" }).ok).toBe(true);
    expect(parseUpdateSessionStartRequest({ targetVersion: "0.2.14-beta.1" }).ok).toBe(false);
  });
});
