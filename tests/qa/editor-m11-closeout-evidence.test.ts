import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface RootPackageJson {
  readonly scripts: Readonly<Record<string, string>>;
}

interface EvidenceRow {
  readonly id: string;
  readonly file: string;
  readonly marker: string;
}

const ADVERSARIAL_ROWS: readonly EvidenceRow[] = [
  {
    id: "TRUST-CORRUPT-RECORD",
    file: "packages/keiko-server/src/workspace-script-trust.test.ts",
    marker: "stays untrusted when the persisted record is corrupt JSON",
  },
  {
    id: "TRUST-STALE-DIGEST",
    file: "packages/keiko-server/src/workspace-script-trust.test.ts",
    marker: "invalidates the grant after a manifest change",
  },
  {
    id: "TRUST-SCHEMA-DOWNGRADE",
    file: "packages/keiko-server/src/workspace-script-trust.test.ts",
    marker: "persisted record fails the contract validator",
  },
  {
    id: "TRUST-PROMPT-BYPASS",
    file: "packages/keiko-ui/src/app/components/desktop/workspace-trust/WorkspaceTrustPanel.test.tsx",
    marker: "rejects a malformed successful response without optimistically unlocking",
  },
  {
    id: "RESTRICTED-LSP-RACE",
    file: "packages/keiko-server/src/editor/languageRoutes.test.ts",
    marker: "rechecks live trust immediately before pool acquisition",
  },
  {
    id: "RESTRICTED-AGENT-EXECUTION",
    file: "packages/keiko-server/src/editor/agentRootBoundary.test.ts",
    marker: "denies execution on restricted root B",
  },
  {
    id: "CROSS-ROOT-PATH-ALIAS",
    file: "packages/keiko-server/src/editor/agentRootBoundary.test.ts",
    marker: "rejects crafted lexical, absolute, and symlink paths",
  },
  {
    id: "CROSS-ROOT-BINDING-REPLAY",
    file: "packages/keiko-server/src/editor/agentRootBoundary.test.ts",
    marker: "rejects forged, replayed, and cross-root action bindings",
  },
  {
    id: "CROSS-ROOT-OVERLAP",
    file: "packages/keiko-contracts/src/workspace-manifest.test.ts",
    marker: "rejects overlapping canonical roots",
  },
  {
    id: "PROFILE-PATH-SECRET-SMUGGLING",
    file: "packages/keiko-server/src/editor/settings/editorProfilePortability.test.ts",
    marker: "strips path and secret classes deterministically",
  },
  {
    id: "PROFILE-FUTURE-DEPTH",
    file: "packages/keiko-server/src/editor/settings/editorProfilePortability.test.ts",
    marker: "refuses future versions and excessive JSON depth",
  },
  {
    id: "HISTORY-PATH-ESCAPE",
    file: "packages/keiko-server/src/editor/localHistory/localHistoryStore.test.ts",
    marker: "refuses a checkpoint whose resolved file escapes",
  },
  {
    id: "HISTORY-PAYLOAD-TAMPER",
    file: "packages/keiko-server/src/editor/localHistory/localHistoryStore.test.ts",
    marker: "encrypted payload content no longer matches its self-binding",
  },
  {
    id: "HISTORY-PLAINTEXT-LEAK",
    file: "packages/keiko-server/src/editor/localHistory/localHistoryStore.test.ts",
    marker: "vaultBytes).not.toContain",
  },
  {
    id: "HISTORY-APP-SESSION-BYPASS",
    file: "packages/keiko-server/src/editor/localHistory/localHistoryRoutes.test.ts",
    marker: "content-free projections before any lookup without an app session",
  },
  {
    id: "EVIDENCE-TRUST-REDACTION",
    file: "packages/keiko-server/src/store/forbidden-fields.test.ts",
    marker: "workspace trust records are content-free",
  },
] as const;

const MIGRATION_ROWS: readonly EvidenceRow[] = [
  {
    id: "MIGRATION-PRE-M11-UPGRADE",
    file: "packages/keiko-server/src/store/workspaceManifests.test.ts",
    marker: "upgrades pre-M11 projects deterministically",
  },
  {
    id: "MIGRATION-DOWNGRADE-GUARD",
    file: "packages/keiko-server/src/store/workspaceManifests.test.ts",
    marker: "typed downgrade reason and no reinterpretation",
  },
  {
    id: "MIGRATION-CORRUPT-TRUST-RECOVERY",
    file: "packages/keiko-server/src/workspace-script-trust.test.ts",
    marker: "stays untrusted when the persisted record is corrupt JSON",
  },
  {
    id: "MIGRATION-TRUST-REGRANT",
    file: "packages/keiko-server/src/workspace-script-trust.test.ts",
    marker: "requires an explicit grant call",
  },
] as const;

const CLOSEOUT_DOCS = [
  "docs/keiko-editor/2285-m11-demo.md",
  "docs/keiko-editor/2285-m11-regression-evidence.md",
  "docs/keiko-editor/2285-m11-security-performance-review.md",
] as const;

function packageScripts(): Readonly<Record<string, string>> {
  const parsed = JSON.parse(readFileSync("package.json", "utf8")) as RootPackageJson;
  return parsed.scripts;
}

function closeoutDocs(): string {
  return CLOSEOUT_DOCS.map((path) => readFileSync(path, "utf8")).join("\n");
}

function expectRows(rows: readonly EvidenceRow[], docs: string): void {
  const command = packageScripts()["test:editor-m11-closeout"] ?? "";
  for (const row of rows) {
    const commandPath = row.file.startsWith("packages/keiko-ui/")
      ? row.file.slice("packages/keiko-ui/".length)
      : row.file;
    expect(readFileSync(row.file, "utf8"), row.id).toContain(row.marker);
    expect(command, row.id).toContain(commandPath);
    expect(docs, row.id).toContain(row.id);
  }
}

describe("editor M11 quality closeout evidence (#2533)", () => {
  it("collects every adversarial and migration row in the focused executable command", () => {
    const docs = closeoutDocs();
    expectRows(ADVERSARIAL_ROWS, docs);
    expectRows(MIGRATION_ROWS, docs);
  });

  it("registers the real mixed-trust multi-root browser journey in the UI lane", () => {
    const scripts = packageScripts();
    expect(scripts["test:e2e:editor-m11-closeout-2533"]).toBeDefined();
    expect(existsSync("tests/e2e/config/playwright.issue-2533-editor-m11-closeout.config.ts")).toBe(
      true,
    );
    expect(existsSync("tests/e2e/editor-m11-closeout-2533.spec.ts")).toBe(true);
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("npm run test:e2e:editor-m11-closeout-2533");
  });

  it("records bounded p50/p95, root memory, history pruning, and D12 disposition", () => {
    const docs = closeoutDocs();
    expect(packageScripts()["check:editor-m11-performance"]).toBeDefined();
    expect(docs).toMatch(/Observed p50/iu);
    expect(docs).toMatch(/Observed p95/iu);
    expect(docs).toMatch(/memory per additional root/iu);
    expect(docs).toMatch(/D12/iu);
  });

  it("keeps clean-checkout and capability-delta claims reproducible", () => {
    const demo = readFileSync(CLOSEOUT_DOCS[0], "utf8");
    const docs = closeoutDocs();
    expect(demo).toContain("Node.js 24.18.0");
    expect(demo).toContain("npm ci");
    expect(docs).toContain("Capability delta against #2088");
    expect(docs).toContain("Linux-authoritative");
    expect(docs).not.toMatch(/unresolved (critical|high)/iu);
  });
});
