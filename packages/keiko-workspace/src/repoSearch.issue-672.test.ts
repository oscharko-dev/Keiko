import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import {
  DEFAULT_SEARCH_LIMITS,
  searchText,
  type SearchScope,
} from "./repoSearch.js";
import type { WorkspaceInfo } from "./types.js";

const MEM_ROOT = "/ws";
const FIXED_NOW: () => number = () => 1_700_000_000_000;

function memScope(files: Readonly<Record<string, string>>): {
  scope: SearchScope;
  fs: ReturnType<typeof memFs>;
} {
  const workspace: WorkspaceInfo = {
    root: MEM_ROOT,
    name: "demo",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript", "javascript"],
    ignoreLines: [],
  };
  return {
    scope: {
      workspace,
      scopeId: "scope-1",
      relativePaths: [],
    },
    fs: memFs(MEM_ROOT, files),
  };
}

function nlq(text: string, overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return {
    kind: "natural-language",
    text,
    caseSensitive: false,
    maxResults: 100,
    emittedAtMs: 0,
    ...overrides,
  };
}

function bestScoresByPath(
  atoms: readonly { readonly scopePath: string; readonly score: number }[],
): ReadonlyMap<string, number> {
  const best = new Map<string, number>();
  for (const atom of atoms) {
    best.set(atom.scopePath, Math.max(best.get(atom.scopePath) ?? 0, atom.score));
  }
  return best;
}

describe("repoSearch issue #672 regressions", () => {
  it("prefers the symbol definition file over imports for natural-language definition questions", async () => {
    const { scope, fs } = memScope({
      "src/deps.ts": "// handleGroundedAsk exact file reference only\n",
      "src/grounded-qa.ts": "export async function handleGroundedAsk(): Promise<void> { return; }\n",
      "src/routes.ts": "import { handleGroundedAsk } from './grounded-qa.js';\n",
    });
    const result = await searchText(
      scope,
      nlq("Where is handleGroundedAsk defined? Cite the exact file."),
      DEFAULT_SEARCH_LIMITS,
      { fs, nowMs: FIXED_NOW },
    );
    const best = bestScoresByPath(result.atoms);
    expect(best.get("src/grounded-qa.ts") ?? 0).toBeGreaterThan(best.get("src/routes.ts") ?? 0);
    expect(best.get("src/grounded-qa.ts") ?? 0).toBeGreaterThan(best.get("src/deps.ts") ?? 0);
  });

  it("prefers the route table entry over generic mentions for route implementation questions", async () => {
    const { scope, fs } = memScope({
      "src/files.ts": "// file implements route evidence for grounded chats\n",
      "src/grounded-orchestrator.test.ts": "// POST grounded route evidence\n",
      "src/routes.ts":
        '{ method: "POST", pattern: "/api/chats/messages/grounded", handler: handleGroundedAsk },\n',
    });
    const result = await searchText(
      scope,
      nlq("Which file implements the POST /api/chats/messages/grounded route? Answer briefly and cite evidence."),
      DEFAULT_SEARCH_LIMITS,
      { fs, nowMs: FIXED_NOW },
    );
    const best = bestScoresByPath(result.atoms);
    expect(best.get("src/routes.ts") ?? 0).toBeGreaterThan(best.get("src/files.ts") ?? 0);
    expect(best.get("src/routes.ts") ?? 0).toBeGreaterThan(
      best.get("src/grounded-orchestrator.test.ts") ?? 0,
    );
  });
});
