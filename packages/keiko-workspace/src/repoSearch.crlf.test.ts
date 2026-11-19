// Windows line endings in search, excerpts and the Coding projection (#4439).
//
// A file saved with CRLF (or mixed) line endings must yield the same excerpt text, line ranges and
// citations as its LF copy. Excerpts used to split on "\n" only and so carried a trailing "\r" on
// every line, while classification and line selection split on CRLF too. Both content lanes are
// pinned; the evidence lane additionally proves the redaction still applies to the CRLF copy.

import { describe, expect, it } from "vitest";
import type { EvidenceAtom, RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import { codingRepositoryExcerpt } from "./codingRepositorySearchProjection.js";
import type { WorkspaceFs } from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, readExcerpt, searchText, type SearchScope } from "./repoSearch.js";
import type { WorkspaceInfo } from "./types.js";

const MEM_ROOT = "/ws";

const LF_SOURCE = [
  "// Payment routing for the checkout service.",
  'const token = "s3cr3tlookupvalue";',
  "export function routePayment(amount: number): string {",
  "  if (amount > 100) {",
  '    return "manual-review";',
  "  }",
  '  return "automatic";',
  "}",
  "",
].join("\n");

const CRLF_SOURCE = LF_SOURCE.replaceAll("\n", "\r\n");

// Every other terminator CRLF, as a file edited on two platforms ends up.
const MIXED_SOURCE = LF_SOURCE.split("\n")
  .map((line, index, lines) =>
    index === lines.length - 1 ? line : line + (index % 2 === 0 ? "\r\n" : "\n"),
  )
  .join("");

const VARIANTS = [
  ["CRLF", CRLF_SOURCE],
  ["mixed", MIXED_SOURCE],
] as const;

function workspace(): WorkspaceInfo {
  return {
    root: MEM_ROOT,
    selectedRoot: MEM_ROOT,
    name: "demo",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function scopeFor(source: string): { readonly scope: SearchScope; readonly fs: WorkspaceFs } {
  return {
    scope: { workspace: workspace(), scopeId: "scope-crlf", relativePaths: [] },
    fs: memFs(MEM_ROOT, { "src/payment.ts": source }),
  };
}

function query(text: string): RetrievalQuery {
  return { kind: "regex", text, caseSensitive: false, maxResults: 50, emittedAtMs: 0 };
}

function citations(atoms: readonly EvidenceAtom[]): readonly {
  readonly scopePath: string;
  readonly startLine?: number;
  readonly endLine?: number;
}[] {
  return atoms.map((atom) => ({
    scopePath: atom.scopePath,
    ...(atom.lineRange === undefined
      ? {}
      : { startLine: atom.lineRange.startLine, endLine: atom.lineRange.endLine }),
  }));
}

async function excerptOf(
  source: string,
  range: { readonly startLine: number; readonly endLine: number; readonly maxBytes: number },
  contentLane?: "editor",
): Promise<Awaited<ReturnType<typeof readExcerpt>>> {
  const { scope, fs } = scopeFor(source);
  return readExcerpt(
    scope,
    { scopePath: "src/payment.ts", ...range },
    { fs, nowMs: () => 0, ...(contentLane === undefined ? {} : { contentLane }) },
  );
}

describe.each(VARIANTS)("%s line endings read like the LF copy (#4439)", (_label, source) => {
  it("returns the LF excerpt and range on the evidence lane", async () => {
    const range = { startLine: 2, endLine: 6, maxBytes: 4096 };
    const lf = await excerptOf(LF_SOURCE, range);
    const windows = await excerptOf(source, range);

    expect(windows.content).not.toContain("\r");
    expect(windows.content).toBe(lf.content);
    expect(windows.content).toContain("[REDACTED]");
    expect(windows.content).not.toContain("s3cr3tlookupvalue");
    expect(windows.atom.lineRange).toEqual(lf.atom.lineRange);
    expect(windows.truncated).toBe(lf.truncated);
  });

  it("returns the LF excerpt on the editor lane", async () => {
    const range = { startLine: 3, endLine: 8, maxBytes: 4096 };
    const lf = await excerptOf(LF_SOURCE, range, "editor");
    const windows = await excerptOf(source, range, "editor");

    expect(windows.content).toBe(lf.content);
    expect(windows.atom.lineRange).toEqual(lf.atom.lineRange);
  });

  it("clamps a byte-limited excerpt to the same text and end line", async () => {
    const range = { startLine: 3, endLine: 8, maxBytes: 90 };
    const lf = await excerptOf(LF_SOURCE, range);
    const windows = await excerptOf(source, range);

    expect(lf.truncated).toBe(true);
    expect(windows.content).toBe(lf.content);
    expect(windows.atom.lineRange).toEqual(lf.atom.lineRange);
  });

  it("cites the same lines from a search hit", async () => {
    const lf = scopeFor(LF_SOURCE);
    const windows = scopeFor(source);
    const fromLf = await searchText(lf.scope, query("manual-review"), DEFAULT_SEARCH_LIMITS, {
      fs: lf.fs,
      nowMs: () => 0,
    });
    const fromWindows = await searchText(
      windows.scope,
      query("manual-review"),
      DEFAULT_SEARCH_LIMITS,
      { fs: windows.fs, nowMs: () => 0 },
    );

    expect(fromLf.atoms.length).toBeGreaterThan(0);
    expect(citations(fromWindows.atoms)).toEqual(citations(fromLf.atoms));
  });

  it("projects the same Coding excerpt", () => {
    const fromLf = codingRepositoryExcerpt("src/payment.ts", LF_SOURCE, 3, 7, 4096);
    const fromWindows = codingRepositoryExcerpt("src/payment.ts", source, 3, 7, 4096);

    expect(fromWindows.snippet).not.toContain("\r");
    expect(fromWindows).toEqual(fromLf);
  });
});
