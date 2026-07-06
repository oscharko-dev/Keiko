import { describe, expect, it } from "vitest";
import {
  UPDATE_INSTALL_MODE_KINDS,
  UPDATE_PORTABLE_ASSET_VERIFICATION_STATUSES,
  UPDATE_PORTABLE_INSTALL_STATUSES,
  UPDATE_PORTABLE_TARGETS,
  UPDATE_RECOMMENDED_ACTIONS,
  UPDATE_UNSUPPORTED_REASONS,
  parseUpdateSessionStartRequest,
  type UpdatePortableAssetSummary,
  type UpdatePortableInstallSummary,
} from "./update-session.js";

describe("update session portable contract", () => {
  it("pins portable install-mode vocabulary", () => {
    expect(UPDATE_PORTABLE_TARGETS).toEqual(["windows-x64", "macos-arm64", "macos-x64"]);
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
    expect(UPDATE_PORTABLE_ASSET_VERIFICATION_STATUSES).toEqual(["pending", "verified", "failed"]);
  });

  it("keeps session start requests stable-only", () => {
    expect(parseUpdateSessionStartRequest({ targetVersion: "0.2.14" }).ok).toBe(true);
    expect(parseUpdateSessionStartRequest({ targetVersion: "0.2.14-beta.1" }).ok).toBe(false);
  });
});
