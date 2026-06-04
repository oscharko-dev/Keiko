// Tests for the grounded Q&A orchestrator (Issue #185). Verifies the deterministic linear
// composition of the connected-context layers, the clarification-needed escape hatch, and
// the budget-exhaustion → uncertainty-marker propagation produced by #183.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  validateConnectedContextPack,
  type ConnectedContextPack,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  gitHistoryAdapter,
  importGraphAdapter,
  testSourcePairingAdapter,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";

import {
  ClarificationNeededError,
  echoAnswerer,
  runGroundedExploration,
  type GroundedAnswerer,
  type OrchestratorInput,
} from "./grounded-orchestrator.js";

const NOW = 1_700_000_000_000;
let ROOT = "";

function fakeWorkspace(): WorkspaceInfo {
  return {
    root: ROOT,
    name: "demo",
    version: "0.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function seedRepo(): void {
  mkdirSync(join(ROOT, "src"), { recursive: true });
  mkdirSync(join(ROOT, "tests"), { recursive: true });
  writeFileSync(
    join(ROOT, "src/foo.ts"),
    "export function MyClass() {\n  return 'foo body';\n}\n// MyClass call site here\n",
  );
  writeFileSync(
    join(ROOT, "src/bar.ts"),
    "// unrelated content with no MyClass anchor\nexport const bar = 1;\n",
  );
  writeFileSync(
    join(ROOT, "tests/foo.test.ts"),
    "import { MyClass } from '../src/foo';\nMyClass();\nMyClass();\nMyClass();\n",
  );
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "keiko-grounded-orch-"));
  seedRepo();
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function happyScope(overrides: Partial<SelectedScope> = {}): SelectedScope {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: "scope-1",
    workspaceRoot: ROOT,
    kind: "directory",
    relativePaths: ["src"],
    conversationId: undefined,
    connectedAtMs: NOW,
    ...overrides,
  };
}

function happyQuery(overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "Investigate src/foo.ts behaviour of `MyClass`",
    caseSensitive: false,
    maxResults: 50,
    emittedAtMs: NOW,
    ...overrides,
  };
}

function input(overrides: Partial<OrchestratorInput> = {}): OrchestratorInput {
  return {
    scope: happyScope(),
    query: happyQuery(),
    workspaceRoot: ROOT,
    ...overrides,
  };
}

describe("runGroundedExploration", () => {
  it("composes plan → search → rank → excerpts → assemble → answer deterministically", async () => {
    const out = await runGroundedExploration(input(), {
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    expect(out.pack.schemaVersion).toBe(CONNECTED_CONTEXT_SCHEMA_VERSION);
    expect(out.pack.scope.scopeId).toBe("scope-1");
    expect(out.pack.query.text).toBe("Investigate src/foo.ts behaviour of `MyClass`");
    expect(out.assistantContent).toContain("Inspected");
    expect(out.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(out.plan?.state).toBe("ready");
    // The pack must always carry uncertainty + omitted as readonly arrays even when empty.
    expect(Array.isArray(out.pack.uncertainty)).toBe(true);
    expect(Array.isArray(out.pack.omitted)).toBe(true);
  });

  it("records the exploration plan before workspace detection or repository exploration", async () => {
    const events: string[] = [];
    const out = await runGroundedExploration(input(), {
      answerer: echoAnswerer,
      nowMs: () => NOW,
      recordPlan: (plan) => {
        events.push(`record:${plan.planId}`);
      },
      detectWorkspace: () => {
        events.push("detect");
        return fakeWorkspace();
      },
    });
    const plan = out.plan;
    if (plan === undefined) {
      throw new Error("expected orchestrator output to expose the recorded plan");
    }
    expect(events).toEqual([`record:${plan.planId}`, "detect"]);
  });

  it("passes the question and the full pack to the injected answerer", async () => {
    let observedQuestion = "";
    let observedPack: ConnectedContextPack | undefined;
    const recordingAnswerer: GroundedAnswerer = {
      answer: (question, pack) => {
        observedQuestion = question;
        observedPack = pack;
        return Promise.resolve("recorded");
      },
    };
    const out = await runGroundedExploration(input(), {
      answerer: recordingAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    expect(observedQuestion).toBe("Investigate src/foo.ts behaviour of `MyClass`");
    expect(observedPack).toBe(out.pack);
    expect(out.assistantContent).toBe("recorded");
  });

  it("throws ClarificationNeededError when the planner asks for clarification", async () => {
    // A vague single-word query yields zero/low-weight anchors and trips the planner's
    // "no-anchors" / "too-generic" branches. The orchestrator MUST refuse to run any
    // retrieval before the user resolves the prompt.
    const tooGeneric = happyQuery({ text: "help" });
    await expect(
      runGroundedExploration(input({ query: tooGeneric }), {
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      }),
    ).rejects.toBeInstanceOf(ClarificationNeededError);
  });

  it("never invokes the answerer when clarification is needed", async () => {
    let answererCalls = 0;
    const tracking: GroundedAnswerer = {
      answer: () => {
        answererCalls += 1;
        return Promise.resolve("");
      },
    };
    await expect(
      runGroundedExploration(input({ query: happyQuery({ text: "help" }) }), {
        answerer: tracking,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      }),
    ).rejects.toBeInstanceOf(ClarificationNeededError);
    expect(answererCalls).toBe(0);
  });

  it("does not rerun structural adapters through the git-history ring", async () => {
    mkdirSync(join(ROOT, ".git", "logs"), { recursive: true });
    writeFileSync(join(ROOT, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(
      join(ROOT, ".git", "logs", "HEAD"),
      "0000000000000000000000000000000000000000 abc123def456 Alice <alice@example.com> 1700000000 +0000\tcommit: seed\n",
    );
    const pairAdapter = testSourcePairingAdapter as {
      lookup: typeof testSourcePairingAdapter.lookup;
    };
    const importAdapter = importGraphAdapter as { lookup: typeof importGraphAdapter.lookup };
    const gitAdapter = gitHistoryAdapter as { lookup: typeof gitHistoryAdapter.lookup };
    const originalPairLookup = pairAdapter.lookup;
    const originalImportLookup = importAdapter.lookup;
    const originalGitLookup = gitAdapter.lookup;
    let pairCalls = 0;
    let importCalls = 0;
    let gitCalls = 0;
    pairAdapter.lookup = (...args): ReturnType<typeof originalPairLookup> => {
      pairCalls += 1;
      return originalPairLookup(...args);
    };
    importAdapter.lookup = (...args): ReturnType<typeof originalImportLookup> => {
      importCalls += 1;
      return originalImportLookup(...args);
    };
    gitAdapter.lookup = (...args): ReturnType<typeof originalGitLookup> => {
      gitCalls += 1;
      return originalGitLookup(...args);
    };
    try {
      await runGroundedExploration(
        input({
          scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
          query: happyQuery({ text: "Investigate src/foo.ts and tests/foo.test.ts" }),
        }),
        {
          answerer: echoAnswerer,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
        },
      );
    } finally {
      pairAdapter.lookup = originalPairLookup;
      importAdapter.lookup = originalImportLookup;
      gitAdapter.lookup = originalGitLookup;
    }
    expect(pairCalls).toBe(1);
    expect(importCalls).toBe(1);
    expect(gitCalls).toBe(1);
  });

  it("uses the budget governor to stop before an over-budget retrieval ring", async () => {
    const out = await runGroundedExploration(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
        query: happyQuery({ text: "Investigate src/foo.ts and tests/foo.test.ts MyClass" }),
        budget: { ...DEFAULT_EXPLORATION_BUDGET, searchCallsMax: 1 },
      }),
      {
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    expect(out.pack.usage.searchCalls).toBe(1);
    expect(out.pack.uncertainty.some((u) => u.kind === "budget-clipped")).toBe(true);
    expect(out.pack.uncertainty.some((u) => u.claim.includes("searchCalls"))).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });
});

describe("echoAnswerer", () => {
  it("summarises pack file count and paths deterministically", async () => {
    const pack: ConnectedContextPack = {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      stableId: "pack-1",
      scope: happyScope(),
      query: happyQuery(),
      budget: {
        searchCallsMax: 1,
        filesReadMax: 1,
        excerptBytesMax: 1024,
        modelInputTokensMax: 1024,
        modelOutputTokensMax: 256,
        elapsedMsMax: 1000,
        rerankCallsMax: 0,
      },
      usage: {
        searchCalls: 0,
        filesRead: 0,
        excerptBytes: 0,
        modelInputTokens: 0,
        modelOutputTokens: 0,
        elapsedMs: 0,
        rerankCalls: 0,
      },
      files: [
        {
          scopePath: "src/foo.ts",
          role: "read-only",
          selectionReason: "ranked by alpha",
          excerpts: [],
        },
      ],
      omitted: [],
      uncertainty: [],
      emittedAtMs: NOW,
      ledgerRef: undefined,
    };
    const out = await echoAnswerer.answer("what does MyClass do", pack);
    expect(out).toContain("Inspected 1 file(s)");
    expect(out).toContain("what does MyClass do");
    expect(out).toContain("src/foo.ts");
  });

  it("emits a (no evidence) marker when the pack carries no files", async () => {
    const pack: ConnectedContextPack = {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      stableId: "pack-empty",
      scope: happyScope(),
      query: happyQuery(),
      budget: {
        searchCallsMax: 1,
        filesReadMax: 1,
        excerptBytesMax: 1024,
        modelInputTokensMax: 1024,
        modelOutputTokensMax: 256,
        elapsedMsMax: 1000,
        rerankCallsMax: 0,
      },
      usage: {
        searchCalls: 0,
        filesRead: 0,
        excerptBytes: 0,
        modelInputTokens: 0,
        modelOutputTokens: 0,
        elapsedMs: 0,
        rerankCalls: 0,
      },
      files: [],
      omitted: [],
      uncertainty: [],
      emittedAtMs: NOW,
      ledgerRef: undefined,
    };
    const out = await echoAnswerer.answer("anything", pack);
    expect(out).toContain("(no evidence)");
  });
});
