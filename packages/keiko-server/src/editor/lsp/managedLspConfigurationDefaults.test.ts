import { describe, expect, it } from "vitest";

import {
  MANAGED_LSP_LANGUAGES,
  parseManagedLspRuntimeConfiguration,
} from "@oscharko-dev/keiko-contracts";

import { managedLspConfigurationDefaults } from "./managedLspConfigurationDefaults.js";

const ETAG = '"lspcfg-7-abcdefghijklmnop"';

describe("managed LSP server-owned configuration defaults", () => {
  it("projects one current, valid, safe default for every managed language", (): void => {
    const defaults = managedLspConfigurationDefaults(7, ETAG, "linux", "x64");

    expect(Object.isFrozen(defaults)).toBe(true);
    expect(defaults.map(({ language }) => language)).toStrictEqual(MANAGED_LSP_LANGUAGES);
    for (const configuration of defaults) {
      expect(parseManagedLspRuntimeConfiguration(configuration)).toMatchObject({ ok: true });
      expect(configuration).toMatchObject({
        revision: 7,
        etag: ETAG,
        activation: "enabled",
        runtime: { kind: "operatorApproved", runtimeId: `${configuration.language}-lsp` },
        provenance: {
          activation: "workspace",
          runtime: "operatorProvisioning",
          settings: "builtInDefault",
        },
        restartRequired: false,
        restartFields: [],
      });
    }
    const rust = defaults.find((configuration) => configuration.language === "rust");
    expect(rust?.language === "rust" ? rust.settings.resourceBudget : undefined).toStrictEqual({
      maxProjectFiles: 20_000,
      maxCargoMetadataBytes: 4_194_304,
      maxMemoryMb: 1_024,
      indexDeadlineMs: 30_000,
    });
  });

  it("contains no browser-selectable execution, environment, download, or capability authority", (): void => {
    const serialized = JSON.stringify(managedLspConfigurationDefaults(7, ETAG));

    for (const forbidden of [
      '"argv"',
      '"command"',
      '"environment"',
      '"executable"',
      '"endpoint"',
      '"credential"',
      '"moduleDownloads":true',
      '"dependencyDownloads":true',
      '"buildScripts":true',
      '"procMacros":true',
      '"buildToolExecution":true',
      '"negotiatedOperations"',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it.each([
    ["darwin", "arm64", "darwin", "arm64"],
    ["win32", "ia32", "windows", "386"],
    ["aix", "ppc64", "linux", "amd64"],
  ] as const)(
    "maps the server platform %s/%s into a closed Go target %s/%s",
    (platform, architecture, goos, goarch): void => {
      const go = managedLspConfigurationDefaults(7, ETAG, platform, architecture).find(
        (configuration) => configuration.language === "go",
      );

      expect(go?.language === "go" ? go.settings.target : undefined).toMatchObject({
        goos,
        goarch,
      });
    },
  );
});
