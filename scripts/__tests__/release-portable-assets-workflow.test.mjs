import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  resolvePortableAssetsManifest,
  writeGithubOutput,
} from "../resolve-release-portable-assets.mjs";

const portableWorkflow = readFileSync(".github/workflows/portable-assets.yml", "utf8");
const windowsVerifier = readFileSync("scripts/verify-windows-portable-signing.ps1", "utf8");

let currentRoot;

function root() {
  currentRoot = mkdtempSync(join(tmpdir(), "keiko-release-portable-assets-"));
  return currentRoot;
}

function writeBundleManifest(cwd, name = "portable-assets.json") {
  const bundleRoot = join(cwd, ".portable-release-assets");
  mkdirSync(bundleRoot, { recursive: true });
  const manifestPath = join(bundleRoot, name);
  writeFileSync(manifestPath, '{"schemaVersion":1,"artifacts":[]}\n');
  return manifestPath;
}

function latestEnv(overrides = {}) {
  return {
    NPM_DIST_TAG: "latest",
    PORTABLE_ASSETS_ARTIFACT_NAME: "portable-release-assets",
    PORTABLE_ASSETS_MANIFEST: "",
    PORTABLE_ASSETS_RUN_ID: "123456789",
    ...overrides,
  };
}

describe("release workflow portable asset manifest resolution", () => {
  afterEach(() => {
    if (currentRoot !== undefined) {
      rmSync(currentRoot, { recursive: true, force: true });
      currentRoot = undefined;
    }
  });

  it("requires a reviewed artifact bundle for stable latest publishes", () => {
    expect(() =>
      resolvePortableAssetsManifest(
        {
          NPM_DIST_TAG: "latest",
          PORTABLE_ASSETS_ARTIFACT_NAME: "",
          PORTABLE_ASSETS_MANIFEST: "portable-assets.json",
          PORTABLE_ASSETS_RUN_ID: "",
        },
        root(),
      ),
    ).toThrow("stable latest publishes require a reviewed portable asset bundle");
  });

  it("rejects incomplete reviewed artifact bundle inputs", () => {
    expect(() =>
      resolvePortableAssetsManifest(
        latestEnv({ PORTABLE_ASSETS_ARTIFACT_NAME: "", PORTABLE_ASSETS_RUN_ID: "123456789" }),
        root(),
      ),
    ).toThrow("portable_assets_run_id and portable_assets_artifact_name must be provided together");
  });

  it("returns the canonical manifest path inside the downloaded artifact bundle", () => {
    const cwd = root();
    const manifestPath = writeBundleManifest(cwd);

    expect(resolvePortableAssetsManifest(latestEnv(), cwd)).toBe(realpathSync(manifestPath));
  });

  it("rejects parent traversal in bundle-relative manifest input", () => {
    const cwd = root();
    writeBundleManifest(cwd);

    expect(() =>
      resolvePortableAssetsManifest(latestEnv({ PORTABLE_ASSETS_MANIFEST: "../x.json" }), cwd),
    ).toThrow("portable_assets_manifest must not escape the downloaded artifact");
  });

  it("rejects absolute manifest input for downloaded bundles", () => {
    const cwd = root();
    const manifestPath = writeBundleManifest(cwd);

    expect(() =>
      resolvePortableAssetsManifest(latestEnv({ PORTABLE_ASSETS_MANIFEST: manifestPath }), cwd),
    ).toThrow("portable_assets_manifest must be relative to the downloaded artifact");
  });

  it("rejects directory manifest input before publish", () => {
    const cwd = root();
    mkdirSync(join(cwd, ".portable-release-assets", "portable-assets.json"), { recursive: true });

    expect(() => resolvePortableAssetsManifest(latestEnv(), cwd)).toThrow(
      "portable_assets_manifest must point to a regular file",
    );
  });

  it("rejects symlinked manifest input before publish", () => {
    const cwd = root();
    const bundleRoot = join(cwd, ".portable-release-assets");
    mkdirSync(bundleRoot, { recursive: true });
    const outsideManifest = join(cwd, "outside-portable-assets.json");
    writeFileSync(outsideManifest, '{"schemaVersion":1,"artifacts":[]}\n');
    symlinkSync(outsideManifest, join(bundleRoot, "portable-assets.json"));

    expect(() => resolvePortableAssetsManifest(latestEnv(), cwd)).toThrow(
      "portable_assets_manifest must not be a symbolic link",
    );
  });

  it("preserves explicit non-latest local manifest inputs", () => {
    expect(
      resolvePortableAssetsManifest(
        {
          NPM_DIST_TAG: "beta",
          PORTABLE_ASSETS_ARTIFACT_NAME: "",
          PORTABLE_ASSETS_MANIFEST: "local-portable-assets.json",
          PORTABLE_ASSETS_RUN_ID: "",
        },
        root(),
      ),
    ).toBe("local-portable-assets.json");
  });

  it("writes the resolved manifest to GITHUB_OUTPUT", () => {
    const cwd = root();
    const outputPath = join(cwd, "github-output.txt");

    writeGithubOutput("portable-assets.json", { GITHUB_OUTPUT: outputPath });

    expect(readFileSync(outputPath, "utf8")).toBe("manifest=portable-assets.json\n");
  });
});

describe("Windows portable production signing workflow", () => {
  it("keeps manual staging outside the protected Windows production job", () => {
    expect(portableWorkflow).toContain("windows-signing-preflight:");
    expect(portableWorkflow).toContain("stage-windows-production:");
    expect(portableWorkflow).toContain("environment: portable-release-signing");
    expect(portableWorkflow).toContain("github.event_name == 'push'");
    expect(portableWorkflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(portableWorkflow).toContain("Manual runs remain unsigned staging");
    expect(portableWorkflow).toContain("stage-target ${{ matrix.platform_target }}");
  });

  it("confines OIDC to the protected job and pins the official Azure actions", () => {
    expect(portableWorkflow).toContain("permissions: {}");
    expect(portableWorkflow.match(/id-token: write/gu)).toHaveLength(1);
    expect(portableWorkflow).toContain("Azure/login@532459ea530d8321f2fb9bb10d1e0bcf23869a43");
    expect(portableWorkflow).toContain(
      "Azure/artifact-signing-action@c7ab2a863ab5f9a846ddb8265964877ef296ee82",
    );
    expect(portableWorkflow).toContain("audience: api://AzureADTokenExchange");
    expect(portableWorkflow).toContain("exclude-azure-cli-credential: false");
    expect(portableWorkflow).toContain("exclude-environment-credential: true");
  });

  it("signs the exact catalog and verifies before rebuilding and uploading", () => {
    const inventory = portableWorkflow.indexOf("Inventory the bounded PE signing set");
    const signing = portableWorkflow.indexOf("Sign the exact inventoried PE set");
    const nativeVerification = portableWorkflow.indexOf(
      "Verify Authenticode chain, identity, and RFC3161 timestamp",
    );
    const finalization = portableWorkflow.indexOf(
      "Rebuild, bind, and verify the production archive",
    );
    const upload = portableWorkflow.indexOf("Upload verified Windows target artifact");
    expect(inventory).toBeLessThan(signing);
    expect(signing).toBeLessThan(nativeVerification);
    expect(nativeVerification).toBeLessThan(finalization);
    expect(finalization).toBeLessThan(upload);
    expect(portableWorkflow).toContain("files-catalog:");
    expect(portableWorkflow).toContain("file-digest: SHA256");
    expect(portableWorkflow).toContain("timestamp-digest: SHA256");
  });

  it("requires native chain, subscriber identity, and timestamp verification without raw output", () => {
    expect(windowsVerifier).toContain("signtool.exe verify /pa /all /tw /v");
    expect(windowsVerifier).toContain("Get-AuthenticodeSignature");
    expect(windowsVerifier).toContain('Test-Eku $signer "1.3.6.1.5.5.7.3.3"');
    expect(windowsVerifier).toContain("Test-Eku $signer $ExpectedIdentityEku");
    expect(windowsVerifier).toContain('Test-Eku $timestamp "1.3.6.1.5.5.7.3.8"');
    expect(windowsVerifier).toContain("*> $null");
    expect(windowsVerifier).not.toMatch(/thumbprint|subject/iu);
  });
});
