// Regression guard for release docs drift.
// Keeps the shipped end-user docs aligned with the executable package surface.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readText(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function readPackageJson(): { scripts: Record<string, string> } {
  return JSON.parse(readText("package.json")) as { scripts: Record<string, string> };
}

function readCiJobBlock(): string {
  const workflow = readText(".github/workflows/ci.yml");
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === "  ci:");
  if (start === -1) {
    throw new Error("jobs.ci block not found in .github/workflows/ci.yml");
  }
  const block = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (index > start && /^ {2}[^ ]/u.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

function readWorkflowJobBlock(workflowPath: string, jobName: string): string {
  const workflow = readText(workflowPath);
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start === -1) {
    throw new Error(`jobs.${jobName} block not found in ${workflowPath}`);
  }
  const block = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (index > start && /^ {2}[^ ]/u.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

function expectPruneBeforePackageSurface(jobBlock: string): void {
  const pruneIndex = jobBlock.indexOf("npm run prune:package-native-optionals");
  const surfaceIndex = jobBlock.indexOf("npm run check:package-surface");

  expect(pruneIndex).toBeGreaterThanOrEqual(0);
  expect(surfaceIndex).toBeGreaterThanOrEqual(0);
  expect(pruneIndex).toBeLessThan(surfaceIndex);
}

// Issue #287 extended the chain with `check:qi-supply-chain` (ADR-0023 D5/D11/D12); issue
// #433 (Epic #423) added `check:version-consistency` so the packed artifact cannot ship with
// a manifest/version mismatch; Epic #423 also restores `arch:check` to the real publish path
// so architecture violations cannot bypass the release hook; Epic #423 post-closure audit
// added `arch:check:negative` immediately after `arch:check` so rule deletions are caught in
// the publish path, not only in CI. Release fix #895 adds native optional dependency pruning
// before architecture/package-surface checks so publisher-machine canvas payloads cannot leak
// into the bundled artifact. The pin stays "exact" against the live `package.json`; it does
// not lock the chain to a particular historical length.
const PACKAGE_SURFACE_CHAIN = [
  "npm run clean",
  "npm run build",
  "npm run prepare:bin",
  "npm run build:ui",
  "npm run prune:package-native-optionals",
  "npm run arch:check",
  "npm run arch:check:negative",
  "npm run check:package-surface",
  "npm run check:version-consistency",
  "npm run check:qi-supply-chain",
].join(" && ");

describe("Issue #12 docs drift", () => {
  it("keeps the package-surface chain exact without exposing release engineering docs", () => {
    const pkg = readPackageJson();
    const readme = readText("README.md");

    expect(pkg.scripts.prepack).toBe(PACKAGE_SURFACE_CHAIN);
    expect(pkg.scripts.prepublishOnly).toBe(PACKAGE_SURFACE_CHAIN);
    expect(existsSync(resolve(process.cwd(), "docs", "npm-packaging.md"))).toBe(false);
    expect(readme).not.toContain("npm packaging");
    expect(readme).not.toContain(PACKAGE_SURFACE_CHAIN);
  });

  it("keeps the protected ci workflow and SDK alias contract aligned with issue #433", () => {
    const ciJob = readCiJobBlock();
    const sdkIndex = readText("packages/keiko-sdk/src/index.ts");
    const versionGate = readText("scripts/check-version-consistency.mjs");

    expect(ciJob).toContain("      - run: npm run check:version-consistency");
    expect(sdkIndex).toMatch(
      /^import\s+\{\s*KEIKO_PRODUCT_VERSION\s*\}\s+from\s+"@oscharko-dev\/keiko-contracts";$/m,
    );
    expect(sdkIndex).toMatch(
      /^export\s+const\s+SDK_VERSION(?:\s*:\s*string)?\s*=\s*KEIKO_PRODUCT_VERSION;$/m,
    );
    expect(versionGate).toContain("SDK_VERSION does not directly re-export");
    expect(versionGate).toContain(
      'const APPROVED_ROOT_SRC_FILES = ["src/cli/index.ts", "src/index.ts"];',
    );
    expect(versionGate).toContain("root src/ must stay minimal");
    expect(versionGate).toContain("root facade drifted beyond the approved minimal facade");
  });

  it("prunes publisher-native optional dependencies before manual package-surface gates", () => {
    expectPruneBeforePackageSurface(readWorkflowJobBlock(".github/workflows/ci.yml", "ui"));
    expectPruneBeforePackageSurface(
      readWorkflowJobBlock(".github/workflows/release.yml", "release-verify"),
    );
  });

  it("states that gen-tests and investigate do not persist evidence manifests", () => {
    const readme = readText("README.md");
    const runbook = readText("docs/pilot/runbook.md");

    expect(readme).toContain(
      "`keiko gen-tests` and `keiko investigate` print a reviewable report but do not persist an evidence manifest",
    );
    expect(runbook).toContain(
      "`keiko gen-tests` and `keiko investigate` print a reviewable report to stdout and do not persist a manifest",
    );
  });

  it("keeps the README opening copy free of per-run manifest claims", () => {
    const readme = readText("README.md");
    const topMatter = readme.split(/\n---\n/)[0] ?? "";

    expect(topMatter).toMatch(/manifest-producing surfaces emit redacted evidence for audit/i);
    expect(topMatter).not.toMatch(/\b(?:every|each)\s+run\b.*\bmanifest\b/i);
  });

  it("keeps shipped README repository docs links resolvable outside the tarball", () => {
    const readme = readText("README.md");

    expect(readme).toContain("https://github.com/oscharko-dev/Keiko/blob/dev/docs/ui-runbook.md");
    expect(readme).not.toMatch(/\]\((?:\.\/)?docs\//);
  });

  it("keeps UI runbook config and missing-model errors aligned with the BFF contract", () => {
    const readme = readText("README.md");
    const uiRunbook = readText("docs/ui-runbook.md");

    expect(readme).toContain("The UI can create a local runtime config during first-run setup.");
    expect(readme).toContain("Keiko calls the gateway model list endpoint");
    expect(uiRunbook).toContain(
      "They are not a standalone UI configuration source when the UI needs to discover models",
    );
    expect(uiRunbook).toContain('"code": "NO_MODEL"');
    expect(uiRunbook).toContain('"message": "No model provider is configured."');
    expect(uiRunbook).not.toContain("NO_MODEL_CONFIGURED");
    expect(uiRunbook).not.toContain(
      "Provide a gateway config via --config or environment variables",
    );
  });

  it("keeps UI host documentation aligned with the loopback bind implementation", () => {
    const readme = readText("README.md");
    const uiRunbook = readText("docs/ui-runbook.md");
    const uiCli = readText("packages/keiko-cli/src/ui.ts");
    const uiServer = readText("packages/keiko-server/src/server.ts");
    const hostContract = /validate a loopback host value.*server always binds `127\.0\.0\.1`/i;

    expect(readme).toMatch(hostContract);
    expect(uiRunbook).toMatch(hostContract);
    expect(uiCli).toContain('new Set(["127.0.0.1", "localhost"])');
    expect(uiServer).toContain('export const UI_HOST = "127.0.0.1"');
  });

  it("keeps the shipped default UI port aligned", () => {
    const readme = readText("README.md");
    const uiRunbook = readText("docs/ui-runbook.md");
    const uiServer = readText("packages/keiko-server/src/server.ts");

    expect(uiServer).toContain("export const DEFAULT_UI_PORT = 1983");
    expect(readme).toContain("Port to bind (default: 1983)");
    expect(uiRunbook).toContain("default port is `1983`");
  });

  it("keeps release docs and UI copy free of customer-specific model wording", () => {
    const combined = [
      readText("README.md"),
      readText("docs/pilot/go-no-go.md"),
      readText("docs/pilot/runbook.md"),
      readText("docs/security-and-audit-boundaries.md"),
      readText("docs/ui-runbook.md"),
      readText("packages/keiko-ui/src/app/components/desktop/widgets/panels/SettingsPanel.tsx"),
    ].join("\n");
    const forbiddenPhrases = [
      ["customer", "model"],
      ["candidate", "customer", "model"],
      ["customer", "domain"],
      ["customer's", "codebase"],
      ["deployment", "target"],
      ["internal", "models"],
      ["internal", "base", "URL"],
      ["private", "model", "capabilities"],
      ["customer", "hosts"],
      ["Customer", "pilot"],
      ["model", "capability", "guide"],
    ];
    const removedGuidePath = resolve(
      process.cwd(),
      "docs",
      "pilot",
      `${["model", "capability", "guide"].join("-")}.md`,
    );

    expect(existsSync(removedGuidePath)).toBe(false);
    for (const phrase of forbiddenPhrases) {
      expect(combined).not.toMatch(new RegExp(phrase.join("\\s+"), "i"));
    }
  });

  it("states that UI model choices are limited to callable chat models", () => {
    const runbook = readText("docs/pilot/runbook.md");
    const uiRunbook = readText("docs/ui-runbook.md");

    expect(runbook).toContain(
      "Keiko selects only configured chat models that pass the gateway smoke test.",
    );
    expect(uiRunbook).toContain("Non-chat models are not offered for chat or workflow execution.");
    expect(runbook).toContain("Keep local gateway configs out of version control.");
  });

  it("keeps README surface coverage from claiming full UI parity", () => {
    const readme = readText("README.md");

    expect(readme).toContain("Surface coverage is intentionally not identical.");
    expect(readme).not.toContain("These are reachable from all three surfaces");
  });
});
