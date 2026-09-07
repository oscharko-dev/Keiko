import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseWindowsGenerationBinding,
  portableManifestGenerationSchemaVerified,
  resolveWindowsGenerationLayout,
  verifiedWindowsGenerationManifestBinding,
} from "./update-portable-windows-generation.js";

function fixture(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "scripts", "__tests__", "fixtures", "windows-generation-v2.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

describe("Windows generation staging authority", () => {
  it("parses the frozen producer binding and resolves distinct root and generation paths", () => {
    const manifest = fixture();
    const binding = verifiedWindowsGenerationManifestBinding(manifest, "windows-x64");
    expect(binding).toEqual(manifest.windowsGeneration);
    expect(portableManifestGenerationSchemaVerified(manifest, "windows-x64")).toBe(true);
    if (binding === undefined) throw new Error("fixture binding missing");

    const layout = resolveWindowsGenerationLayout("C:\\Keiko", binding);
    expect(layout.installRoot).toBe("C:\\Keiko");
    expect(layout.rootLauncherPath).toContain("Keiko.exe");
    expect(layout.rootSetupManifestPath).toContain("setup-manifest.json");
    expect(layout.resourceRoot).toContain(binding.treeSha256);
    expect(layout.packageJsonPath).toContain(binding.treeSha256);
    expect(layout.runtimeNodePath).toContain(binding.treeSha256);
    expect(layout.runtimeSupervisorPath).toContain(binding.treeSha256);
  });

  it("rejects extra binding keys, noncanonical resource roots, and rebound copies", () => {
    const manifest = fixture();
    const binding = manifest.windowsGeneration as Record<string, unknown>;
    expect(parseWindowsGenerationBinding({ ...binding, extra: true })).toBeUndefined();
    expect(
      parseWindowsGenerationBinding({
        ...binding,
        resourceRoot: `.portable/generations/${"c".repeat(64)}`,
      }),
    ).toBeUndefined();

    const provenance = manifest.provenance as Record<string, unknown>;
    provenance.windowsGeneration = { ...binding, launcherSha256: "c".repeat(64) };
    expect(verifiedWindowsGenerationManifestBinding(manifest, "windows-x64")).toBeUndefined();
    expect(portableManifestGenerationSchemaVerified(manifest, "windows-x64")).toBe(false);
  });

  it("keeps macOS schema 1 unchanged and rejects Windows-only binding copies", () => {
    const mac = { schemaVersion: 1, provenance: {}, releaseImpact: { reviewedBinding: {} } };
    expect(portableManifestGenerationSchemaVerified(mac, "macos-arm64")).toBe(true);
    expect(
      portableManifestGenerationSchemaVerified(
        { ...mac, windowsGeneration: fixture().windowsGeneration },
        "macos-arm64",
      ),
    ).toBe(false);
  });
});
