import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import type {
  SearchScope,
  WorkspaceDirEntry,
  WorkspaceFs,
  WorkspaceStat,
} from "@oscharko-dev/keiko-workspace";
import type { GitProcessResult, GitProcessRunner } from "./gitRoutes.js";
import { defaultGitFileHistoryEvidenceProvider } from "./grounded-git-history-evidence.js";

const NOW = 1_700_000_000_000;
const RECORD_SEP = "\x1e";

let ROOT = "";

function ok(stdout: string): GitProcessResult {
  return { exitCode: 0, signal: null, stdout, stderr: "", truncated: false };
}

function nodeFs(): WorkspaceFs {
  return {
    readFileUtf8: (absolutePath): string => readFileSync(absolutePath, "utf8"),
    stat: (absolutePath): WorkspaceStat => {
      const stat = statSync(absolutePath);
      return {
        size: stat.size,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        isSymbolicLink: stat.isSymbolicLink(),
        hardLinkCount: stat.nlink,
        mtimeMs: stat.mtimeMs,
      };
    },
    readDir: (absolutePath): readonly WorkspaceDirEntry[] =>
      readdirSync(absolutePath, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymbolicLink: entry.isSymbolicLink(),
      })),
    realPath: (absolutePath): string => realpathSync(absolutePath),
    exists: (absolutePath): boolean => {
      try {
        statSync(absolutePath);
        return true;
      } catch {
        return false;
      }
    },
    readFileBytes: (absolutePath, maxBytes): Promise<Uint8Array> =>
      Promise.resolve(readFileSync(absolutePath).subarray(0, maxBytes)),
  };
}

function scope(relativePaths: readonly string[] = []): SearchScope {
  return {
    scopeId: "scope-1",
    relativePaths,
    workspace: {
      root: ROOT,
      name: "demo",
      version: "0.0.0",
      testFramework: "vitest",
      sourceDirs: ["src"],
      testDirs: [],
      languages: ["typescript"],
      ignoreLines: [],
    },
  };
}

function query(): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "Investigate recent changes",
    caseSensitive: false,
    maxResults: 20,
    emittedAtMs: NOW,
  };
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "keiko-grounded-git-history-"));
  mkdirSync(join(ROOT, "src"), { recursive: true });
  writeFileSync(join(ROOT, "src/recent.ts"), "export const recent = true;\n");
  writeFileSync(join(ROOT, "src/stale.ts"), "export const stale = true;\n");
  writeFileSync(join(ROOT, "src/ignored.md"), "ignored\n");
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("defaultGitFileHistoryEvidenceProvider", () => {
  it("turns bounded git log --name-only output into file-scoped recency/churn atoms", async () => {
    const mutableCalls: string[][] = [];
    const runner: GitProcessRunner = (args) => {
      mutableCalls.push([...args]);
      if (args.includes("rev-parse")) {
        return Promise.resolve(ok(`${ROOT}\n`));
      }
      return Promise.resolve(
        ok(
          [
            `${RECORD_SEP}1700000000`,
            "src/recent.ts",
            "src/deleted.ts",
            `${RECORD_SEP}1692224000`,
            "src/stale.ts",
            "../escape.ts",
            ".git/config",
            "",
          ].join("\n"),
        ),
      );
    };

    const atoms = await defaultGitFileHistoryEvidenceProvider({
      searchScope: scope(),
      query: query(),
      fs: nodeFs(),
      nowMs: () => NOW,
      runner,
      maxFiles: 10,
    });

    expect(atoms.map((atom) => atom.scopePath)).toEqual(["src/recent.ts", "src/stale.ts"]);
    expect(atoms.every((atom) => atom.provenance.kind === "git-history")).toBe(true);
    expect(atoms.every((atom) => atom.provenance.tool === "git-file-history")).toBe(true);
    expect(atoms.every((atom) => atom.metrics?.gitRecency !== undefined)).toBe(true);
    expect(atoms.every((atom) => atom.metrics?.gitChurn !== undefined)).toBe(true);
    expect(atoms[0]?.score).toBeGreaterThan(atoms[1]?.score ?? 0);
    const logArgs = mutableCalls[1] ?? [];
    expect(logArgs).toEqual(expect.arrayContaining(["-c", "core.quotepath=false", "log"]));
    expect(logArgs).toEqual(expect.arrayContaining(["--no-renames", "--name-only"]));
    expect(logArgs.some((arg) => arg.startsWith("--max-count="))).toBe(true);
  });

  it("respects selected relativePaths", async () => {
    const runner: GitProcessRunner = (args) =>
      Promise.resolve(
        args.includes("rev-parse")
          ? ok(`${ROOT}\n`)
          : ok([`${RECORD_SEP}1700000000`, "src/recent.ts", "src/stale.ts", ""].join("\n")),
      );

    const atoms = await defaultGitFileHistoryEvidenceProvider({
      searchScope: scope(["src/stale.ts"]),
      query: query(),
      fs: nodeFs(),
      nowMs: () => NOW,
      runner,
      maxFiles: 10,
    });

    expect(atoms.map((atom) => atom.scopePath)).toEqual(["src/stale.ts"]);
  });
});
