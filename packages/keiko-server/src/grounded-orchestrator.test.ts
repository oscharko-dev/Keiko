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
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import type { MicroIndex } from "@oscharko-dev/keiko-workflows";

import { CancelledError } from "@oscharko-dev/keiko-model-gateway";

import {
  ClarificationNeededError,
  echoAnswerer,
  retrieveConnectedContextPack,
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

function seedIssue672Repo(): void {
  mkdirSync(join(ROOT, "packages/keiko-server/src"), { recursive: true });
  writeFileSync(
    join(ROOT, "packages/keiko-server/src/deps.ts"),
    "// handleGroundedAsk exact file reference only\n",
  );
  writeFileSync(
    join(ROOT, "packages/keiko-server/src/files.ts"),
    "// file implements route evidence for grounded chats\n",
  );
  writeFileSync(
    join(ROOT, "packages/keiko-server/src/grounded-orchestrator.test.ts"),
    "// POST grounded route evidence\n",
  );
  writeFileSync(
    join(ROOT, "packages/keiko-server/src/grounded-qa.ts"),
    "export async function handleGroundedAsk(): Promise<void> { return; }\n",
  );
  writeFileSync(
    join(ROOT, "packages/keiko-server/src/routes.ts"),
    "import { handleGroundedAsk } from './grounded-qa.js';\n" +
      '{ method: "POST", pattern: "/api/chats/messages/grounded", handler: handleGroundedAsk },\n',
  );
}

function seedIssue876Repo(): void {
  mkdirSync(join(ROOT, "src"), { recursive: true });
  mkdirSync(join(ROOT, ".keiko/evidence/qi"), { recursive: true });
  writeFileSync(
    join(ROOT, "src/grounded-qa.ts"),
    "export async function handleGroundedAsk() {\n" +
      "  return 'real route handler';\n" +
      "}\n" +
      "export const GROUNDED_HANDLER_NAME = 'handleGroundedAsk';\n",
  );
  writeFileSync(
    join(ROOT, "src/zod-config.ts"),
    "import { z } from 'zod';\n" +
      "export const ZodConfigSchema = z.object({ PORT: z.string() });\n" +
      "export function parseZodConfig(input: unknown) {\n" +
      "  return ZodConfigSchema.parse(input);\n" +
      "}\n",
  );
  writeFileSync(
    join(ROOT, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n" +
      "packages:\n" +
      "  zod@3.23.8:\n" +
      "    resolution: {integrity: sha512-zod}\n" +
      "importers:\n" +
      "  .:\n" +
      "    dependencies:\n" +
      "      zod:\n" +
      "        specifier: ^3.23.8\n" +
      "        version: 3.23.8\n",
  );
  writeFileSync(
    join(ROOT, ".keiko/evidence/qi/run.candidates.json"),
    JSON.stringify({
      finding: "handleGroundedAsk grounded route handler",
      summary: "handleGroundedAsk appears in cached evidence only",
      packageName: "zod",
    }) + "\n",
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

function issue672Workspace(): WorkspaceInfo {
  return {
    ...fakeWorkspace(),
    sourceDirs: ["packages/keiko-server/src"],
    testDirs: ["packages/keiko-server/src"],
  };
}

function issue672Scope(): SelectedScope {
  return happyScope({
    kind: "directory",
    relativePaths: ["packages/keiko-server/src"],
  });
}

function issue672Input(text: string): OrchestratorInput {
  return input({
    scope: issue672Scope(),
    query: happyQuery({ text }),
  });
}

function input(overrides: Partial<OrchestratorInput> = {}): OrchestratorInput {
  return {
    scope: happyScope(),
    query: happyQuery(),
    workspaceRoot: ROOT,
    ...overrides,
  };
}

function throwingReadFs(): WorkspaceFs {
  return {
    readFileUtf8: (): never => {
      throw new Error("readFileUtf8 should not be called");
    },
    stat: (): never => {
      throw new Error("stat should not be called");
    },
    readDir: (): never => {
      throw new Error("readDir should not be called");
    },
    realPath: (path): string => path,
    exists: (): boolean => true,
    readFileBytes: (): Promise<Uint8Array> =>
      Promise.reject(new Error("readFileBytes should not be called")),
  };
}

function recordingMicroIndex(): { index: MicroIndex; gets: () => number; sets: () => number } {
  const entries = new Map<string, ConnectedContextPack>();
  let getCalls = 0;
  let setCalls = 0;
  return {
    index: {
      get: (key): ConnectedContextPack | undefined => {
        getCalls += 1;
        return entries.get(key);
      },
      set: (key, pack): void => {
        setCalls += 1;
        entries.set(key, pack);
      },
      delete: (key): void => {
        entries.delete(key);
      },
      clear: (): void => {
        entries.clear();
      },
      size: (): number => entries.size,
    },
    gets: (): number => getCalls,
    sets: (): number => setCalls,
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

  it("runs structural adapters over planner anchors instead of the full natural-language prompt", async () => {
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
      }),
      {
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    expect(out.pack.files.some((file) => file.scopePath === "tests/foo.test.ts")).toBe(true);
    expect(
      out.pack.files
        .find((file) => file.scopePath === "tests/foo.test.ts")
        ?.excerpts.some((excerpt) => excerpt.content.includes("MyClass")),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("surfaces structural adapter unavailability through sanitized uncertainty", async () => {
    const adapter = importGraphAdapter as {
      isAvailable: typeof importGraphAdapter.isAvailable;
    };
    const originalIsAvailable = adapter.isAvailable;
    adapter.isAvailable = (): Promise<boolean> => Promise.resolve(false);
    try {
      const out = await retrieveConnectedContextPack(input(), {
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      });
      const marker = out.pack.uncertainty.find(
        (entry) => entry.kind === "tool-unavailable" && entry.claim.includes("import-graph"),
      );
      expect(marker?.claim).toBe("structural adapter unavailable: import-graph");
      expect(marker?.claim).not.toContain(ROOT);
      expect(validateConnectedContextPack(out.pack).ok).toBe(true);
    } finally {
      adapter.isAvailable = originalIsAvailable;
    }
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
    expect(observedPack).toStrictEqual(out.pack);
    expect(out.assistantContent).toBe("recorded");
  });

  it("prefers grounded-qa.ts for exact symbol-definition questions from issue #672", async () => {
    seedIssue672Repo();
    const out = await retrieveConnectedContextPack(
      issue672Input("Where is handleGroundedAsk defined? Cite the exact file."),
      {
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => issue672Workspace(),
      },
    );
    expect(out.pack.files[0]?.scopePath).toBe("packages/keiko-server/src/grounded-qa.ts");
    expect(
      out.pack.files[0]?.excerpts.some((excerpt) => excerpt.content.includes("handleGroundedAsk")),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("prefers routes.ts for exact route-implementation questions from issue #672", async () => {
    seedIssue672Repo();
    const out = await retrieveConnectedContextPack(
      issue672Input(
        "Which file implements the POST /api/chats/messages/grounded route? Answer briefly and cite evidence.",
      ),
      {
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => issue672Workspace(),
      },
    );
    expect(out.pack.files[0]?.scopePath).toBe("packages/keiko-server/src/routes.ts");
    expect(
      out.pack.files[0]?.excerpts.some((excerpt) =>
        excerpt.content.includes("/api/chats/messages/grounded"),
      ),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("grounds direct package.json metadata requests without leaking internal .keiko evidence", async () => {
    writeFileSync(join(ROOT, "package.json"), '{\n  "packageManager": "npm@10.9.8"\n}\n');
    mkdirSync(join(ROOT, ".keiko/evidence/qi"), { recursive: true });
    writeFileSync(
      join(ROOT, ".keiko/evidence/qi/run.candidates.json"),
      '{"packageManager":"stale-internal-value","connected":"repository","context":"evidence"}\n',
    );

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "Using only the connected repository context, what is the exact packageManager value in package.json? Reply with the exact value only.",
        }),
      }),
      {
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    expect(out.pack.files[0]?.scopePath).toBe("package.json");
    expect(out.pack.files.every((file) => !file.scopePath.startsWith(".keiko/"))).toBe(true);
    expect(
      out.pack.files[0]?.excerpts.some((excerpt) =>
        excerpt.content.includes('"packageManager": "npm@10.9.8"'),
      ),
    ).toBe(true);
    expect(JSON.stringify(out.pack)).not.toContain(".keiko/evidence");
    expect(JSON.stringify(out.pack)).not.toContain("stale-internal-value");
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("omits .keiko evidence artifacts when real source files answer a normal repository question", async () => {
    seedIssue876Repo();

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "Where is handleGroundedAsk implemented? Cite the source file.",
        }),
      }),
      {
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    expect(out.pack.files[0]?.scopePath).toBe("src/grounded-qa.ts");
    expect(out.pack.files.every((file) => !file.scopePath.startsWith(".keiko/evidence/"))).toBe(
      true,
    );
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("demotes lockfiles behind ordinary repository files for code-usage questions", async () => {
    seedIssue876Repo();

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "How is ZodConfigSchema used in this repository? Cite the relevant code.",
        }),
      }),
      {
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    expect(out.pack.files[0]?.scopePath).toBe("src/zod-config.ts");
    const lockfileIndex = out.pack.files.findIndex((file) => file.scopePath === "pnpm-lock.yaml");
    expect(lockfileIndex).not.toBe(0);
    expect(
      out.pack.files[0]?.excerpts.some((excerpt) => excerpt.content.includes("ZodConfigSchema")),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("adds a no-evidence uncertainty marker when retrieval finds no matching atoms", async () => {
    const out = await runGroundedExploration(
      input({
        scope: happyScope({ kind: "files", relativePaths: ["src/bar.ts"] }),
        query: happyQuery({ text: "Investigate `CompletelyMissingSymbol`" }),
      }),
      {
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    expect(out.pack.files).toEqual([]);
    expect(out.pack.uncertainty.some((marker) => marker.kind === "no-evidence")).toBe(true);
    expect(out.pack.uncertainty.some((marker) => marker.claim.includes("matched"))).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
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
    expect(pairCalls).toBeGreaterThan(0);
    expect(importCalls).toBeGreaterThan(0);
    expect(gitCalls).toBe(1);
  });

  it("does not send git-history metadata paths into excerpt selection", async () => {
    mkdirSync(join(ROOT, ".git", "logs"), { recursive: true });
    writeFileSync(join(ROOT, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(
      join(ROOT, ".git", "logs", "HEAD"),
      "0000000000000000000000000000000000000000 abc123def456 Alice <alice@example.com> 1700000000 +0000\tcommit: seed\n",
    );
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
        query: happyQuery({ text: "Investigate src/foo.ts and recent git history" }),
      }),
      {
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    expect(out.pack.files.every((file) => !file.scopePath.startsWith(".git/"))).toBe(true);
    expect(out.pack.uncertainty.every((marker) => !marker.claim.includes(".git/HEAD"))).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
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

  it("charges structural fan-out before running adapters", async () => {
    const pairAdapter = testSourcePairingAdapter as {
      lookup: typeof testSourcePairingAdapter.lookup;
    };
    const importAdapter = importGraphAdapter as { lookup: typeof importGraphAdapter.lookup };
    const originalPairLookup = pairAdapter.lookup;
    const originalImportLookup = importAdapter.lookup;
    let pairCalls = 0;
    let importCalls = 0;
    pairAdapter.lookup = (...args): ReturnType<typeof originalPairLookup> => {
      pairCalls += 1;
      return originalPairLookup(...args);
    };
    importAdapter.lookup = (...args): ReturnType<typeof originalImportLookup> => {
      importCalls += 1;
      return originalImportLookup(...args);
    };
    try {
      const out = await retrieveConnectedContextPack(
        input({
          query: happyQuery({
            text: "Investigate src/foo.ts tests/foo.test.ts `MyClass`",
          }),
          budget: { ...DEFAULT_EXPLORATION_BUDGET, searchCallsMax: 2 },
        }),
        {
          answerer: echoAnswerer,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
        },
      );
      expect(out.pack.usage.searchCalls).toBe(2);
      expect(out.pack.uncertainty.some((u) => u.claim.includes("searchCalls"))).toBe(true);
      expect(validateConnectedContextPack(out.pack).ok).toBe(true);
    } finally {
      pairAdapter.lookup = originalPairLookup;
      importAdapter.lookup = originalImportLookup;
    }
    expect(pairCalls).toBe(0);
    expect(importCalls).toBe(0);
  });

  it("clips answer-phase budget overages into a valid pack", async () => {
    let now = NOW;
    const budget: OrchestratorInput["budget"] = {
      ...DEFAULT_EXPLORATION_BUDGET,
      modelInputTokensMax: 10,
      modelOutputTokensMax: 5,
      elapsedMsMax: 100,
    };
    const answerer: GroundedAnswerer = {
      answer: () => {
        now += 250;
        return Promise.resolve({
          content: "answer",
          usage: { promptTokens: 999, completionTokens: 777 },
        });
      },
    };
    const out = await runGroundedExploration(input({ budget }), {
      answerer,
      nowMs: () => now,
      detectWorkspace: () => fakeWorkspace(),
    });
    expect(out.elapsedMs).toBe(250);
    expect(out.pack.usage.modelInputTokens).toBe(10);
    expect(out.pack.usage.modelOutputTokens).toBe(5);
    expect(out.pack.usage.elapsedMs).toBe(100);
    expect(out.pack.uncertainty.some((u) => u.claim.includes("modelInputTokens"))).toBe(true);
    expect(out.pack.uncertainty.some((u) => u.claim.includes("modelOutputTokens"))).toBe(true);
    expect(out.pack.uncertainty.some((u) => u.claim.includes("elapsedMs"))).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("preserves repository-search omission reasons in the context pack", async () => {
    writeFileSync(join(ROOT, "src/asset.png"), "\x89PNG\r\n\x1a\n\0binary");
    const out = await runGroundedExploration(input(), {
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    expect(
      out.pack.omitted.some(
        (entry) => entry.scopePath === "src/asset.png" && entry.reason === "binary",
      ),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("reads excerpt windows around late-line evidence instead of only the file header", async () => {
    const filler = Array.from({ length: 239 }, (_, i) => `// filler ${String(i + 1)}`).join("\n");
    writeFileSync(
      join(ROOT, "src/late.ts"),
      `${filler}\nexport const late = 'MyClass late target';\n`,
    );
    const out = await runGroundedExploration(
      input({ query: happyQuery({ text: "Investigate src/late.ts MyClass late target" }) }),
      {
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    const lateFile = out.pack.files.find((file) => file.scopePath === "src/late.ts");
    expect(
      lateFile?.excerpts.some((excerpt) => excerpt.content.includes("MyClass late target")),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("reuses an injected micro-index for repeated context-pack assembly", async () => {
    const microIndex = recordingMicroIndex();
    const first = await runGroundedExploration(input(), {
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
      microIndex: microIndex.index,
    });
    const second = await runGroundedExploration(input(), {
      answerer: echoAnswerer,
      nowMs: () => NOW + 1_000,
      detectWorkspace: () => fakeWorkspace(),
      microIndex: microIndex.index,
    });
    expect(microIndex.sets()).toBe(1);
    expect(microIndex.gets()).toBe(2);
    expect(second.pack).toStrictEqual(first.pack);
  });

  it("does not touch workspace file IO when read budgets are zero", async () => {
    const out = await runGroundedExploration(
      input({
        budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 0, excerptBytesMax: 0 },
      }),
      {
        answerer: echoAnswerer,
        nowMs: () => NOW,
        fs: throwingReadFs(),
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    expect(out.pack.files).toEqual([]);
    expect(out.pack.usage.filesRead).toBe(0);
    expect(out.pack.usage.excerptBytes).toBe(0);
    expect(out.pack.uncertainty.some((u) => u.claim.includes("filesRead"))).toBe(true);
  });

  it("rejects with CancelledError before the answerer is called when the signal is already aborted", async () => {
    // Mutation guard: removing the throwIfCancelled call at the orchestrator entry point
    // must fail this test because the answerer would be invoked instead.
    const controller = new AbortController();
    controller.abort();
    let answererCalls = 0;
    const trackingAnswerer: GroundedAnswerer = {
      answer: () => {
        answererCalls += 1;
        return Promise.resolve("should not reach here");
      },
    };
    await expect(
      runGroundedExploration(input(), {
        answerer: trackingAnswerer,
        signal: controller.signal,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(answererCalls).toBe(0);
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

describe("retrieveConnectedContextPack (Epic #532 M1)", () => {
  it("produces the same pack runGroundedExploration produces for the same input+deps", async () => {
    const retrieved = await retrieveConnectedContextPack(input(), {
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    const explored = await runGroundedExploration(input(), {
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    expect(retrieved.pack).toStrictEqual(explored.pack);
    expect(retrieved.plan).toStrictEqual(explored.plan);
    expect(retrieved.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("does NOT invoke the answerer (retrieval-only contract)", async () => {
    let answerCalls = 0;
    const countingAnswerer: GroundedAnswerer = {
      answer: (): Promise<string> => {
        answerCalls += 1;
        return Promise.resolve("should not run");
      },
    };
    await retrieveConnectedContextPack(input(), {
      answerer: countingAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    expect(answerCalls).toBe(0);
  });

  it("AC5: runGroundedExploration still returns identical pack and assistantContent", async () => {
    // Two independent runs over the same deterministic fixture must agree byte-for-byte on the
    // wire-observable fields, proving the retrieval/answer split did not perturb the single path.
    const first = await runGroundedExploration(input(), {
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    const second = await runGroundedExploration(input(), {
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    expect(first.pack).toStrictEqual(second.pack);
    expect(first.assistantContent).toBe(second.assistantContent);
    expect(first.plan).toStrictEqual(second.plan);
  });

  it("propagates a cancelled signal without answering", async () => {
    const controller = new AbortController();
    controller.abort();
    let answerCalls = 0;
    const countingAnswerer: GroundedAnswerer = {
      answer: (): Promise<string> => {
        answerCalls += 1;
        return Promise.resolve("nope");
      },
    };
    await expect(
      retrieveConnectedContextPack(input(), {
        answerer: countingAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(answerCalls).toBe(0);
  });
});
