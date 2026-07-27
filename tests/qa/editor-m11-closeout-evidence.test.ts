import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface RootPackageJson {
  readonly scripts: Readonly<Record<string, string>>;
}

// A row may make several distinct claims (CROSS-ROOT-OVERLAP names both nesting and
// alias-equivalent identity). Each claim gets its own marker so a reviewer reaches the assertion
// that proves it in one hop, and so a row cannot keep passing on a sibling claim's test (#2626).
interface EvidenceRow {
  readonly id: string;
  readonly file: string;
  readonly markers: readonly string[];
}

const ADVERSARIAL_ROWS: readonly EvidenceRow[] = [
  {
    id: "TRUST-CORRUPT-RECORD",
    file: "packages/keiko-server/src/workspace-script-trust.test.ts",
    markers: ["stays untrusted when the persisted record is corrupt JSON"],
  },
  {
    id: "TRUST-STALE-DIGEST",
    file: "packages/keiko-server/src/workspace-script-trust.test.ts",
    markers: ["invalidates the grant after a manifest change"],
  },
  {
    id: "TRUST-SCHEMA-DOWNGRADE",
    file: "packages/keiko-server/src/workspace-script-trust.test.ts",
    markers: ["persisted record fails the contract validator"],
  },
  {
    id: "TRUST-PROMPT-BYPASS",
    file: "packages/keiko-ui/src/app/components/desktop/workspace-trust/WorkspaceTrustPanel.test.tsx",
    markers: ["rejects a malformed successful response without optimistically unlocking"],
  },
  {
    id: "RESTRICTED-LSP-RACE",
    file: "packages/keiko-server/src/editor/languageRoutes.test.ts",
    markers: ["rechecks live trust immediately before pool acquisition"],
  },
  {
    id: "RESTRICTED-AGENT-EXECUTION",
    file: "packages/keiko-server/src/editor/agentRootBoundary.test.ts",
    markers: ["denies execution on restricted root B"],
  },
  {
    id: "CROSS-ROOT-PATH-ALIAS",
    file: "packages/keiko-server/src/editor/agentRootBoundary.test.ts",
    markers: ["rejects crafted lexical, absolute, and symlink paths"],
  },
  {
    id: "CROSS-ROOT-BINDING-REPLAY",
    file: "packages/keiko-server/src/editor/agentRootBoundary.test.ts",
    markers: ["rejects forged, replayed, and cross-root action bindings"],
  },
  {
    id: "CROSS-ROOT-OVERLAP",
    file: "packages/keiko-contracts/src/workspace-manifest.test.ts",
    // Two claims, two assertions: nesting/duplication AND alias-equivalent identity. The row
    // asserted the second before #2615 case-folded overlap comparison, while only the first had a
    // test — pinning both keeps the alias half from silently reverting to a prose claim.
    markers: [
      "rejects overlapping canonical roots",
      "rejects alias-equivalent POSIX canonical roots differing only in case",
    ],
  },
  {
    id: "PROFILE-PATH-SECRET-SMUGGLING",
    file: "packages/keiko-server/src/editor/settings/editorProfilePortability.test.ts",
    markers: ["strips path and secret classes deterministically"],
  },
  {
    id: "PROFILE-FUTURE-DEPTH",
    file: "packages/keiko-server/src/editor/settings/editorProfilePortability.test.ts",
    markers: ["refuses future versions and excessive JSON depth"],
  },
  {
    id: "HISTORY-PATH-ESCAPE",
    file: "packages/keiko-server/src/editor/localHistory/localHistoryStore.test.ts",
    markers: ["refuses a checkpoint whose resolved file escapes"],
  },
  {
    id: "HISTORY-PAYLOAD-TAMPER",
    file: "packages/keiko-server/src/editor/localHistory/localHistoryStore.test.ts",
    markers: ["encrypted payload content no longer matches its self-binding"],
  },
  {
    id: "HISTORY-PLAINTEXT-LEAK",
    file: "packages/keiko-server/src/editor/localHistory/localHistoryStore.test.ts",
    // Sharding checkpoint bodies (#2616) retired the single `checkpoints.vault` this marker used to
    // name. The proof it pins was widened, not moved: it now walks EVERY file the store writes
    // rather than one, so the marker follows it to the assertion that does the walking. The index
    // is pinned by name as well (#2626) — the row claims it, and a walk that merely happens to
    // include it cannot show a reviewer where that claim is proven. The browser half of this row
    // is pinned by tests/e2e/editor-m11-closeout-2533.static.test.ts.
    markers: [
      "expect(bytes).not.toContain(content.trim())",
      "expect(index).not.toContain(content.trim())",
    ],
  },
  {
    id: "HISTORY-APP-SESSION-BYPASS",
    file: "packages/keiko-server/src/editor/localHistory/localHistoryRoutes.test.ts",
    markers: ["content-free projections before any lookup without an app session"],
  },
  {
    id: "EVIDENCE-TRUST-REDACTION",
    file: "packages/keiko-server/src/store/forbidden-fields.test.ts",
    markers: ["workspace trust records are content-free"],
  },
] as const;

const MIGRATION_ROWS: readonly EvidenceRow[] = [
  {
    id: "MIGRATION-PRE-M11-UPGRADE",
    file: "packages/keiko-server/src/store/workspaceManifests.test.ts",
    markers: ["upgrades pre-M11 projects deterministically"],
  },
  {
    id: "MIGRATION-DOWNGRADE-GUARD",
    file: "packages/keiko-server/src/store/workspaceManifests.test.ts",
    markers: ["typed downgrade reason and no reinterpretation"],
  },
  {
    id: "MIGRATION-CORRUPT-TRUST-RECOVERY",
    file: "packages/keiko-server/src/workspace-script-trust.test.ts",
    markers: ["stays untrusted when the persisted record is corrupt JSON"],
  },
  {
    id: "MIGRATION-TRUST-REGRANT",
    file: "packages/keiko-server/src/workspace-script-trust.test.ts",
    // Retargeted by #2626: the previous marker named a test that grants once on a fresh store and
    // never changes the trust basis, so it performed no part of the re-grant drill this row
    // describes. The named test now runs the whole loop — invalidate, prove the demotion survives
    // a restart, prove restoring the granted bytes does not resurrect it, then re-grant.
    markers: ["keeps an invalidated grant invalid and restores trust only through an explicit"],
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
    const source = readFileSync(row.file, "utf8");
    for (const marker of row.markers) expect(source, row.id).toContain(marker);
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
    // The RSS row must name the store capture it measures, not the manifest-root cost it never
    // measured, and the harness must keep running under --expose-gc — without it the two settle
    // points are no-ops and the recorded number is allocator noise (#2626).
    const perf = packageScripts()["check:editor-m11-performance"] ?? "";
    expect(perf).toContain("--expose-gc");
    expect(docs).toMatch(/Observed p50/iu);
    expect(docs).toMatch(/Observed p95/iu);
    expect(docs).toMatch(/RSS per root admitted to local history/iu);
    expect(docs).not.toMatch(/memory per additional root/iu);
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

  // The assertions above check that the demo SAYS certain things; none of them can notice that the
  // ref it tells a reader to check out no longer exists. It did not: the reproduction pointed at
  // `feat/epic-built-in-editor-2285-M11` long after that branch was squash-merged and deleted, so
  // the one command sequence the epic names as closure evidence failed at `git fetch`. A milestone
  // branch is deleted on merge by design, so any reproduction that names one rots the same way —
  // pin the reproduction to a branch the repository actually maintains.
  it("reproduces from a branch that still exists, not a merged milestone branch", () => {
    const demo = readFileSync(CLOSEOUT_DOCS[0], "utf8");
    const block = /```bash\n(?<script>[\s\S]*?)```/u.exec(demo)?.groups?.script ?? "";
    expect(block, "the demo must carry an executable reproduction block").toContain("git clone");

    const refs = [...block.matchAll(/git (?:checkout|fetch|switch)[^\n]*/gu)].map((m) => m[0]);
    expect(refs.length, "the reproduction must select a revision explicitly").toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref, "reproduction checks out a branch that merge deletes").not.toMatch(
        /feat\/|epic\/|release\//u,
      );
    }
    expect(block).toMatch(/git (?:checkout|switch) dev\b/u);
  });
});
