import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const matrixPath = resolve(process.cwd(), "docs", "local-knowledge-verification-matrix.md");

function readMatrix(): string {
  return readFileSync(matrixPath, "utf8");
}

function localMarkdownTargets(markdown: string): readonly string[] {
  const matches = markdown.matchAll(/\[[^\]]+\]\((<[^>]+>|[^)]+)\)/g);
  const targets: string[] = [];
  for (const match of matches) {
    const raw = match[1];
    if (raw === undefined) continue;
    const unwrapped =
      raw.startsWith("<") && raw.endsWith(">")
        ? raw.slice(1, -1)
        : raw;
    if (unwrapped.startsWith("https://") || unwrapped.startsWith("http://") || unwrapped.startsWith("#")) {
      continue;
    }
    const withoutAnchor = unwrapped.split("#")[0] ?? unwrapped;
    targets.push(withoutAnchor.replace(/:\\d+$/, ""));
  }
  return targets;
}

describe("Issue #203 verification matrix drift", () => {
  it("keeps every local markdown link resolvable in the repository", () => {
    const markdown = readMatrix();
    const baseDir = dirname(matrixPath);
    const missing = localMarkdownTargets(markdown)
      .map((target) => resolve(baseDir, target))
      .filter((target) => !existsSync(target));

    expect(missing).toStrictEqual([]);
  });

  it("references the current Local Knowledge UI, server, and parser surfaces", () => {
    const markdown = readMatrix();

    expect(markdown).toContain("packages/keiko-ui/src/app/local-knowledge/page.tsx");
    expect(markdown).toContain("packages/keiko-ui/src/app/local-knowledge/connector-graph.tsx");
    expect(markdown).toContain("packages/keiko-server/src/local-knowledge-handlers.ts");
    expect(markdown).toContain("packages/keiko-server/src/local-knowledge-grounded-qa.ts");
    expect(markdown).toContain("packages/keiko-local-knowledge/src/parsers/pdf-parser.test.ts");
    expect(markdown).toContain("packages/keiko-local-knowledge/src/parsers/docx-parser.test.ts");
    expect(markdown).toContain("scripts/installable-package-smoke.mjs");
  });

  it("does not regress to the stale paths and claims from the original PR #318", () => {
    const markdown = readMatrix();
    const forbidden = [
      "packages/keiko-ui/src/app/(keiko)/local-knowledge",
      "packages/keiko-ui/src/app/components/local-knowledge/ConnectorGraphView",
      "packages/keiko-local-knowledge/src/store/index.ts",
      "packages/keiko-local-knowledge/src/schema/index.ts",
      "packages/keiko-local-knowledge/src/composition/index.ts",
      "packages/keiko-local-knowledge/src/chunking/citation.ts",
      "packages/keiko-local-knowledge/src/chunking/citation.test.ts",
      "ADR-0023-local-knowledge-privacy-and-retention",
      "deterministic but production-grade",
    ];

    for (const needle of forbidden) {
      expect(markdown).not.toContain(needle);
    }
  });
});