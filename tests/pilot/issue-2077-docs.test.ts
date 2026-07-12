import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const docs = [
  "docs/feedback-intake/2077-verification-matrix.md",
  "docs/troubleshooting/feedback-flow.md",
  "docs/troubleshooting/README.md",
] as const;

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function markdownLinkDestinations(source: string): readonly string[] {
  return [...source.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)].map((match) => {
    const destination = match[1];
    if (destination === undefined) {
      throw new Error("Markdown link destination capture is unexpectedly missing.");
    }
    return destination;
  });
}

function withoutFragment(link: string): string {
  const target = link.split("#", 1)[0];
  if (target === undefined) {
    throw new Error("Markdown link target is unexpectedly missing.");
  }
  return target;
}

describe("issue #2077 documentation", () => {
  it("contains the verification matrix and four template-shaped troubleshooting entries", () => {
    const matrix = read(docs[0]);
    const troubleshooting = read(docs[1]);
    const index = read(docs[2]);

    expect(matrix).toContain("# Issue #2077");
    expect(matrix).toContain("## Verification scope");
    expect(matrix).toContain("## Release-review checklist");
    expect(matrix).toContain("## Out-of-scope claims");
    expect(troubleshooting).toContain("## Intake is unavailable");
    expect(troubleshooting).toContain("## Intake is rate limited");
    expect(troubleshooting).toContain("## GitHub publication permission failed");
    expect(troubleshooting).toContain("## Unsafe payload is blocked");
    for (const heading of [
      "**Symptom**",
      "**Root Cause**",
      "**Diagnostic Steps**",
      "**Resolution**",
    ]) {
      expect(
        troubleshooting.match(new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu")),
      ).toHaveLength(4);
    }
    expect(index).toContain("[Feedback Flow Troubleshooting](feedback-flow.md)");
    expect(index).not.toContain("Keiko is a local-only tool");
    expect(troubleshooting).not.toMatch(/keiko feedback(?:\s|`)/u);
    expect(troubleshooting).not.toMatch(/(?:wait|retry)[^\n]{0,100}rate-limited/iu);
    expect(troubleshooting).toContain(
      "Publication needs manual remediation. Do not repeat the action.",
    );
  });

  it("keeps relative Markdown links valid and routes security reports to SECURITY.md", () => {
    const markdown = docs.map(read).join("\n");
    for (const relativePath of docs) {
      const source = read(relativePath);
      const links = markdownLinkDestinations(source);
      for (const link of links) {
        if (/^(?:https?:|mailto:|#)/u.test(link)) continue;
        const target = withoutFragment(link);
        expect(existsSync(resolve(repoRoot, dirname(relativePath), target))).toBe(true);
      }
    }
    expect(markdown).toContain("[`SECURITY.md`](../../SECURITY.md)");
    expect(markdown).toMatch(/suspected vulnerabilit(?:y|ies)[\s\S]{0,180}SECURITY\.md/iu);
  });

  it("pins safe stable codes and release wording without sensitive detail", () => {
    const troubleshooting = read(docs[1]);
    for (const code of [
      "unavailable",
      "rate-limited",
      "Publication needs manual remediation. Do not repeat the action.",
      "raw-log-content/unsafe-content/rewrite-required",
    ]) {
      expect(troubleshooting).toContain(`\`${code}\``);
    }

    const catalog = JSON.parse(read("release-impact.catalog.json")) as {
      entries: Record<string, unknown>[];
    };
    const entry = catalog.entries.find(
      (candidate) => candidate.id === "2026-07-12-keiko-0.2.15-governed-feedback-flow-verification",
    );
    expect(entry).toMatchObject({
      packageVersion: "0.2.15",
      userVisibleSummary: "Documentation and verification evidence for the governed feedback flow.",
      review: { status: "reviewed", humanApproved: true },
    });
    expect(entry?.releaseNoteBullets).toContain(
      "Document and verify the governed feedback intake and maintainer-reviewed GitHub Issue flow.",
    );

    const forbidden =
      /(?:api\s*key|customer\s+data|internal\s+(?:ip|endpoint|url)|raw\s+logs?|hmac|\bip\s+address|thresholds?|private\s+key|access\s+token|abuse\s+detail)/iu;
    for (const relativePath of docs.slice(0, 2)) expect(read(relativePath)).not.toMatch(forbidden);
  });
});
