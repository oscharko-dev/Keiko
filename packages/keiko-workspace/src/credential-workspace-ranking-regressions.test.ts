import { describe, expect, it } from "vitest";

import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";

import { memFs } from "./_memfs.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchScope } from "./repoSearch.js";
import type { WorkspaceInfo } from "./types.js";

const MEM_ROOT = "/ws";
const FIXED_NOW: () => number = () => 1_700_000_000_000;

function scopeWith(files: Readonly<Record<string, string>>): {
  readonly scope: SearchScope;
  readonly fs: ReturnType<typeof memFs>;
} {
  const workspace: WorkspaceInfo = {
    root: MEM_ROOT,
    name: "demo",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
  return {
    scope: { workspace, scopeId: "scope-1", relativePaths: [] },
    fs: memFs(MEM_ROOT, files),
  };
}

function exactSymbol(text: string): RetrievalQuery {
  return {
    kind: "exact-symbol",
    text,
    caseSensitive: false,
    maxResults: 100,
    emittedAtMs: 0,
  };
}

describe("credential-shaped workspace ranking regressions", () => {
  it("keeps semicolonless interface return types searchable as exact symbols", async () => {
    const { scope, fs } = scopeWith({
      "src/auth/TokenProvider.ts": "export interface TokenProvider {\n  token(): SessionToken\n}\n",
      "docs/tokens.md": "SessionToken is described in the authentication glossary.\n",
    });
    const result = await searchText(scope, exactSymbol("SessionToken"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });

    expect(result.atoms[0]?.scopePath).toBe("src/auth/TokenProvider.ts");
  });
});
