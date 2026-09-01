// Regression tests for the search facade's content-read lane (editor search & replace P1).
//
// The scan loop used to match on text that `redact()` had already rewritten. Two consequences:
// a term that only exists inside a redacted region could never be found, and — because redaction
// collapses a multi-line PEM block into a single token — every reported line number after such a
// block addressed the wrong line of the real file. Both are fatal for the editor, whose search
// coordinates drive a WRITE.
//
// The evidence lane must keep redacting: the assertions below that pin the "evidence" behaviour are
// the guard that this fix did not widen disclosure.

import { describe, expect, it } from "vitest";
import type { EvidenceAtom, RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import type { WorkspaceFs } from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, readExcerpt, searchText, type SearchScope } from "./repoSearch.js";
import {
  scanFile,
  type LimitsShape,
  type RunState,
  type SearchTextRunner,
} from "./repoSearchScan.js";
import { resolveSearchPolicy } from "./repoSearchPolicy.js";
import type { SemanticSearchProvider } from "./repoSearchSemantic.js";
import { buildMatcher, fingerprintFor } from "./repoSearchMatchers.js";
import { buildWorkspaceIndexLexicalRecord, type WorkspaceIndexRecord } from "./workspaceIndex.js";
import type { WorkspaceInfo } from "./types.js";

const MEM_ROOT = "/ws";

// A secret-shaped assignment of exactly the shape that is everywhere in real source. `redact()`
// rewrites the VALUE (SECRET_KEY_VALUE_PATTERN), so the term is invisible to a redacted scan.
const SECRET_ASSIGNMENT = 'const token = "s3cr3tlookupvalue";';

const SECRET_FILE = [
  SECRET_ASSIGNMENT,
  "export function marker(): string {",
  '  return "needleaftersecret";',
  "}",
  "",
].join("\n");

// Same-line redaction PRECEDING a match: "[REDACTED]" is wider than the value it replaces, so the
// column of `needlesameline` moves in the redacted view even though the line number does not.
const SAME_LINE_FILE = ['const token = "abc"; const label = "needlesameline";', ""].join("\n");

const PEM_FILE = [
  "-----BEGIN PRIVATE KEY-----",
  "AAAAB3NzaC1yc2EAAAADAQABAAABgQ",
  "CqGKukO1De7zhZj6H0qtjTkVxwTCpv",
  "-----END PRIVATE KEY-----",
  'export const marker = "needleafterpem";',
  "",
].join("\n");

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

function scopeFor(files: Readonly<Record<string, string>>): {
  readonly scope: SearchScope;
  readonly fs: WorkspaceFs;
} {
  return {
    scope: { workspace: workspace(), scopeId: "scope-lane", relativePaths: [] },
    fs: memFs(MEM_ROOT, files),
  };
}

function query(text: string): RetrievalQuery {
  return { kind: "regex", text, caseSensitive: false, maxResults: 50, emittedAtMs: 0 };
}

// A semantic session is only opened for a non-regex query kind (`createSemanticSearchSession`), so
// the egress guard has to be exercised with a natural-language query.
function naturalQuery(text: string): RetrievalQuery {
  return { kind: "natural-language", text, caseSensitive: false, maxResults: 50, emittedAtMs: 0 };
}

function rangesFor(
  atoms: readonly EvidenceAtom[],
  scopePath: string,
): readonly { readonly startLine: number; readonly endLine: number }[] {
  return atoms
    .filter((atom) => atom.scopePath === scopePath && atom.lineRange !== undefined)
    .map((atom) => ({
      startLine: atom.lineRange?.startLine ?? 0,
      endLine: atom.lineRange?.endLine ?? 0,
    }));
}

// `collectBestLines` reports the enclosing block range for a matched line, not the bare line, so a
// coordinate assertion has to ask whether a reported range addresses the real file line.
function coversLine(atoms: readonly EvidenceAtom[], scopePath: string, line: number): boolean {
  return rangesFor(atoms, scopePath).some(
    (range) => range.startLine <= line && line <= range.endLine,
  );
}

// ─── searchText: matching on raw vs redacted bytes ──────────────────────────────────────────────

describe("searchText content lane – a term that only exists inside a redacted region", () => {
  it("finds it on the editor lane and reports the real line", async () => {
    const { scope, fs } = scopeFor({ "src/app.ts": SECRET_FILE });

    const result = await searchText(scope, query("s3cr3tlookupvalue"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: () => 0,
      contentLane: "editor",
    });

    expect(coversLine(result.atoms, "src/app.ts", 1)).toBe(true);
  });

  it("does NOT find it on the evidence lane – redaction stays in force there", async () => {
    const { scope, fs } = scopeFor({ "src/app.ts": SECRET_FILE });

    const result = await searchText(scope, query("s3cr3tlookupvalue"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: () => 0,
    });

    expect(rangesFor(result.atoms, "src/app.ts")).toEqual([]);
  });

  it("defaults to the evidence lane when no lane is stated", async () => {
    const { scope, fs } = scopeFor({ "src/app.ts": SECRET_FILE });

    const result = await searchText(scope, query("s3cr3tlookupvalue"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: () => 0,
    });

    expect(result.atoms).toEqual([]);
  });
});

describe("searchText content lane – a match AFTER a secret-shaped line", () => {
  it("is reported at the same real line on both lanes when the redaction is same-line", async () => {
    const { scope, fs } = scopeFor({ "src/app.ts": SECRET_FILE });
    const deps = { fs, nowMs: (): number => 0 };

    const editor = await searchText(scope, query("needleaftersecret"), DEFAULT_SEARCH_LIMITS, {
      ...deps,
      contentLane: "editor" as const,
    });
    const evidence = await searchText(scope, query("needleaftersecret"), DEFAULT_SEARCH_LIMITS, {
      ...deps,
    });

    expect(coversLine(editor.atoms, "src/app.ts", 3)).toBe(true);
    expect(coversLine(evidence.atoms, "src/app.ts", 3)).toBe(true);
  });

  it("finds a match preceded on the SAME line by a redacted value", async () => {
    const { scope, fs } = scopeFor({ "src/same.ts": SAME_LINE_FILE });

    const result = await searchText(scope, query("needlesameline"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: () => 0,
      contentLane: "editor",
    });

    expect(coversLine(result.atoms, "src/same.ts", 1)).toBe(true);
  });
});

describe("searchText content lane – multi-line PEM block shifts every later line", () => {
  it("reports the real file line on the editor lane and the shifted one on the evidence lane", async () => {
    const { scope, fs } = scopeFor({ "src/key.ts": PEM_FILE });
    const deps = { fs, nowMs: (): number => 0 };

    const editor = await searchText(scope, query("needleafterpem"), DEFAULT_SEARCH_LIMITS, {
      ...deps,
      contentLane: "editor" as const,
    });
    const evidence = await searchText(scope, query("needleafterpem"), DEFAULT_SEARCH_LIMITS, {
      ...deps,
    });

    // Raw: line 5. Redacted: the 4-line PEM block became one token, so the evidence lane sees line 2.
    expect(coversLine(editor.atoms, "src/key.ts", 5)).toBe(true);
    expect(coversLine(evidence.atoms, "src/key.ts", 5)).toBe(false);
    expect(coversLine(evidence.atoms, "src/key.ts", 2)).toBe(true);
  });
});

describe("searchText content lane – workspace without a raw-byte read port", () => {
  // probeBinary's binary-detection probe requires the bounded readFileBytes primitive; when it is
  // absent, the probe is unavailable rather than falling back to an unbounded readFileUtf8 read
  // capped after the fact. The candidate degrades the same way a transient EACCES/ENOENT does
  // (isIoError), so the file is a "tool-unavailable" skip, never silently scanned unbounded.
  it("skips the file as tool-unavailable instead of an unbounded binary probe", async () => {
    const { scope, fs } = scopeFor({ "src/app.ts": SECRET_FILE });
    const withoutBytePort: WorkspaceFs = { ...fs };
    delete (withoutBytePort as { readFileBytes?: unknown }).readFileBytes;

    const result = await searchText(scope, query("s3cr3tlookupvalue"), DEFAULT_SEARCH_LIMITS, {
      fs: withoutBytePort,
      nowMs: () => 0,
      contentLane: "editor",
    });

    expect(coversLine(result.atoms, "src/app.ts", 1)).toBe(false);
    expect(
      result.candidates.some(
        (candidate) =>
          candidate.scopePath === "src/app.ts" && candidate.omitted === "tool-unavailable",
      ),
    ).toBe(true);
  });
});

describe("searchText content lane – semantic egress", () => {
  it("never opens a semantic session on the editor lane, so raw bytes cannot be embedded", async () => {
    const { scope, fs } = scopeFor({ "src/app.ts": SECRET_FILE });
    const seen: string[] = [];
    const provider: SemanticSearchProvider = {
      name: "stub",
      search: (input) => {
        seen.push(...input.documents.map((document) => document.text));
        return Promise.resolve([]);
      },
    };

    const editor = await searchText(scope, naturalQuery("marker"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: () => 0,
      semanticSearchProvider: provider,
      contentLane: "editor",
    });

    expect(seen).toEqual([]);
    expect(coversLine(editor.atoms, "src/app.ts", 2)).toBe(true);
  });

  it("still embeds redacted text on the evidence lane (positive control)", async () => {
    const { scope, fs } = scopeFor({ "src/app.ts": SECRET_FILE });
    const seen: string[] = [];
    const provider: SemanticSearchProvider = {
      name: "stub",
      search: (input) => {
        seen.push(...input.documents.map((document) => document.text));
        return Promise.resolve([]);
      },
    };

    await searchText(scope, naturalQuery("marker"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: () => 0,
      semanticSearchProvider: provider,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain("s3cr3tlookupvalue");
  });
});

// ─── readExcerpt: the snippet must agree with the coordinates that produced it ───────────────────

describe("readExcerpt content lane", () => {
  it("returns the real file lines on the editor lane after a PEM block", async () => {
    const { scope, fs } = scopeFor({ "src/key.ts": PEM_FILE });

    const excerpt = await readExcerpt(
      scope,
      { scopePath: "src/key.ts", startLine: 5, endLine: 5, maxBytes: 4096 },
      { fs, nowMs: () => 0, contentLane: "editor" },
    );

    expect(excerpt.content).toContain("needleafterpem");
  });

  it("keeps redacting on the evidence lane", async () => {
    const { scope, fs } = scopeFor({ "src/key.ts": PEM_FILE });

    const excerpt = await readExcerpt(
      scope,
      { scopePath: "src/key.ts", startLine: 1, endLine: 1, maxBytes: 4096 },
      { fs, nowMs: () => 0 },
    );

    expect(excerpt.content).toBe("[REDACTED]");
  });
});

// ─── The persisted workspace index stays an evidence-lane artifact ───────────────────────────────

function limits(): LimitsShape {
  return {
    maxFilesScanned: 100,
    maxMatchesReturned: 50,
    maxBytesPerFileScanned: 524_288,
    elapsedMsMax: 5_000,
  };
}

function runnerFor(fs: WorkspaceFs, lane: SearchTextRunner["contentLane"]): SearchTextRunner {
  const scanQuery = query("s3cr3tlookupvalue");
  return {
    scope: { workspace: workspace(), scopeId: "scope-lane", relativePaths: [] },
    limits: limits(),
    fs,
    nowMs: (): number => 0,
    startMs: 0,
    matcher: buildMatcher(scanQuery),
    fingerprint: fingerprintFor(scanQuery),
    policy: resolveSearchPolicy(false, undefined),
    query: scanQuery,
    contentLane: lane,
  };
}

function freshState(): RunState {
  return { filesScanned: 0, matchesReturned: 0, truncated: false };
}

describe("workspace index and the editor lane", () => {
  it("never writes a raw-derived record into the shared index", async () => {
    const fs = memFs(MEM_ROOT, { "src/app.ts": SECRET_FILE });
    const persisted: WorkspaceIndexRecord[] = [];
    const runner: SearchTextRunner = {
      ...runnerFor(fs, "editor"),
      workspaceIndex: {
        entries: new Map(),
        onRecord: (record) => persisted.push(record),
        onStale: () => undefined,
      },
    };

    await scanFile(
      runner,
      { relativePath: "src/app.ts", sizeBytes: SECRET_FILE.length },
      freshState(),
      [],
      [],
    );

    expect(persisted).toEqual([]);
  });

  it("persists a redacted record on the evidence lane (positive control)", async () => {
    const fs = memFs(MEM_ROOT, { "src/app.ts": SECRET_FILE });
    const persisted: WorkspaceIndexRecord[] = [];
    const runner: SearchTextRunner = {
      ...runnerFor(fs, "evidence"),
      workspaceIndex: {
        entries: new Map(),
        onRecord: (record) => persisted.push(record),
        onStale: () => undefined,
      },
    };

    await scanFile(
      runner,
      { relativePath: "src/app.ts", sizeBytes: SECRET_FILE.length },
      freshState(),
      [],
      [],
    );

    expect(persisted).toHaveLength(1);
  });

  it("ignores a cached redacted record instead of matching against it", async () => {
    const fs = memFs(MEM_ROOT, { "src/app.ts": SECRET_FILE });
    const atoms: EvidenceAtom[] = [];
    const runner: SearchTextRunner = {
      ...runnerFor(fs, "editor"),
      workspaceIndex: {
        entries: new Map([
          [
            "src/app.ts",
            {
              scopePath: "src/app.ts",
              absolutePath: `${MEM_ROOT}/src/app.ts`,
              file: { relativePath: "src/app.ts", sizeBytes: SECRET_FILE.length },
              record: {
                scopePath: "src/app.ts",
                sizeBytes: SECRET_FILE.length,
                kind: "text",
                // Built from REDACTED text, exactly as the evidence lane stores it.
                lexical: buildWorkspaceIndexLexicalRecord(
                  SECRET_FILE.replace("s3cr3tlookupvalue", "[REDACTED]"),
                  "src/app.ts",
                ),
              },
              stale: false,
            },
          ],
        ]),
        onRecord: () => undefined,
        onStale: () => undefined,
      },
    };

    await scanFile(
      runner,
      { relativePath: "src/app.ts", sizeBytes: SECRET_FILE.length },
      freshState(),
      atoms,
      [],
    );

    expect(coversLine(atoms, "src/app.ts", 1)).toBe(true);
  });
});
