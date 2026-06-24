// ADR-0056 W3 Gate 3 (integration): the grounded persist path carries a redacted
// ContextAssemblyDiagnostics on the regulated EvidenceManifest when a ContextProfile is active,
// and is byte-identical to today's manifest when no profile is threaded. Exercises the SAME
// `groundedContextAssemblyInput` gate the three grounded persist sites use, threaded through the
// real `persistConnectedContextEvidence` -> in-memory store -> `loadEvidence` round trip.

import { describe, expect, it } from "vitest";
import {
  createInMemoryEvidenceStore,
  loadEvidence,
  persistConnectedContextEvidence,
  type ConnectedContextEvidenceInput,
} from "@oscharko-dev/keiko-evidence";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_CONTEXT_PROFILE,
  validateContextAssemblyDiagnostics,
  type ConnectedContextPack,
  type ContextProfile,
} from "@oscharko-dev/keiko-contracts";
import { attachContextBudgetDiagnostics } from "./grounded-context-diagnostics.js";
import { groundedContextAssemblyInput } from "./grounded-qa.js";
import type { UiHandlerDeps } from "./deps.js";

const NOW = 1_700_000_000_000;

function basePack(): ConnectedContextPack {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "pack-w3-gate3",
    scope: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: "cs-test",
      workspaceRoot: "/repo",
      kind: "directory",
      relativePaths: ["src"],
      conversationId: "chat-1",
      connectedAtMs: NOW,
    },
    query: {
      kind: "natural-language",
      text: "How does MyClass work?",
      caseSensitive: false,
      maxResults: 50,
      emittedAtMs: NOW,
    },
    budget: {
      searchCallsMax: 1,
      filesReadMax: 4,
      excerptBytesMax: 1024,
      modelInputTokensMax: 1024,
      modelOutputTokensMax: 256,
      elapsedMsMax: 1000,
      rerankCallsMax: 0,
    },
    usage: {
      searchCalls: 1,
      filesRead: 1,
      excerptBytes: 36,
      modelInputTokens: 0,
      modelOutputTokens: 0,
      elapsedMs: 5,
      rerankCalls: 0,
    },
    files: [
      {
        scopePath: "src/foo.ts",
        role: "read-only",
        selectionReason: "ranked by alpha",
        excerpts: [
          {
            atom: {
              schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
              stableId: "atom-low",
              scopePath: "src/foo.ts",
              lineRange: { startLine: 10, endLine: 20 },
              score: 0.3,
              provenance: {
                kind: "lexical-search",
                tool: "repo.searchText",
                queryFingerprint: "fp-1",
              },
              redactionState: "redacted",
              emittedAtMs: NOW,
              ledgerRef: undefined,
            },
            content: "function MyClass() { return 'foo'; }",
            contentBytes: 36,
          },
        ],
      },
    ],
    omitted: [],
    uncertainty: [],
    emittedAtMs: NOW,
    ledgerRef: undefined,
  };
}

// `groundedContextAssemblyInput` reads ONLY deps.contextProfile (its param is a Pick), so the
// fixture is honest about the exact dependency surface the helper touches — no cast required.
function depsWith(profile: ContextProfile | undefined): Pick<UiHandlerDeps, "contextProfile"> {
  return { contextProfile: profile };
}

function inputFor(
  pack: ConnectedContextPack,
  deps: Pick<UiHandlerDeps, "contextProfile">,
  runId: string,
): ConnectedContextEvidenceInput {
  return {
    runId,
    modelId: "example-chat-model-unstructured",
    workspaceRoot: "/repo",
    chatId: "chat-1",
    pack,
    citationCount: 1,
    elapsedMs: 5,
    startedAt: NOW,
    finishedAt: NOW + 5,
    ...groundedContextAssemblyInput(deps, pack),
  };
}

describe("grounded persist path — contextAssembly evidence (ADR-0056 W3 Gate 3)", () => {
  it("persists a defined, valid contextAssembly when a profile is active and the observer ran", () => {
    const store = createInMemoryEvidenceStore();
    const pack = attachContextBudgetDiagnostics(basePack(), DEFAULT_CONTEXT_PROFILE);
    persistConnectedContextEvidence(
      inputFor(pack, depsWith(DEFAULT_CONTEXT_PROFILE), "grounded-1"),
      {
        store,
        env: {},
      },
    );
    const loaded = loadEvidence(store, "grounded-1");
    if (loaded === undefined) throw new Error("Expected persisted evidence.");
    expect(loaded.contextAssembly).toBeDefined();
    expect(validateContextAssemblyDiagnostics(loaded.contextAssembly).ok).toBe(true);
  });

  it("omits contextAssembly when no profile is threaded — manifest byte-identical to today", () => {
    const store = createInMemoryEvidenceStore();
    const observedPack = attachContextBudgetDiagnostics(basePack(), DEFAULT_CONTEXT_PROFILE);

    persistConnectedContextEvidence(inputFor(observedPack, depsWith(undefined), "no-profile"), {
      store,
      env: {},
    });
    const noProfile = loadEvidence(store, "no-profile");
    if (noProfile === undefined) throw new Error("Expected persisted evidence.");
    expect(noProfile.contextAssembly).toBeUndefined();
    expect("contextAssembly" in noProfile).toBe(false);
  });

  it("omits contextAssembly when the observer did not run (no contextBudget on the pack)", () => {
    const store = createInMemoryEvidenceStore();
    // profile is present but the pack carries NO diagnostics.contextBudget => observer absent.
    persistConnectedContextEvidence(
      inputFor(basePack(), depsWith(DEFAULT_CONTEXT_PROFILE), "no-observer"),
      { store, env: {} },
    );
    const loaded = loadEvidence(store, "no-observer");
    if (loaded === undefined) throw new Error("Expected persisted evidence.");
    expect(loaded.contextAssembly).toBeUndefined();
  });

  it("the persisted contextAssembly carries the active profile's lanes", () => {
    const store = createInMemoryEvidenceStore();
    const pack = attachContextBudgetDiagnostics(basePack(), DEFAULT_CONTEXT_PROFILE);
    persistConnectedContextEvidence(inputFor(pack, depsWith(DEFAULT_CONTEXT_PROFILE), "lanes"), {
      store,
      env: {},
    });
    const loaded = loadEvidence(store, "lanes");
    if (loaded === undefined) throw new Error("Expected persisted evidence.");
    expect(loaded.contextAssembly?.lanes.some((lane) => lane.laneId === "repo-evidence")).toBe(
      true,
    );
  });
});
