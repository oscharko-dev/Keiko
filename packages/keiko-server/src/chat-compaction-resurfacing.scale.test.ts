// GEN-PERF-CHAT-005: buildChatCompactionResurfacingContext runs on every chat send and previously
// listed + statted EVERY manifest in the shared, retention-unbounded evidence directory before
// JS-filtering by the per-chat prefix. The fix teaches the resurfacing loader to feature-detect the
// node adapter's prefix-scoped listByPrefix, which filters directory entries by runId prefix BEFORE
// the per-file containment stat. This test injects an EvidenceStore stub that records how it is
// queried and proves the loader uses the prefix-scoped path (and never lists the whole directory)
// when the capability is present, while still falling back to list() when it is absent.
//
// NOTE: the end-to-end fs-stat reduction is exercised in keiko-evidence's own store test
// (listByPrefix.test.ts) because cross-package imports here resolve the compiled dist of
// keiko-evidence; injecting a store stub keeps this test independent of that build state.
import { describe, expect, it, vi } from "vitest";
import {
  CONTEXT_COMPACTION_MODEL_SUMMARY_PROMPT_VERSION,
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  type ContextCompactionRecord,
} from "@oscharko-dev/keiko-contracts";
import {
  createInMemoryEvidenceStore,
  persistCompactionEvidence,
  type EvidenceStore,
} from "@oscharko-dev/keiko-evidence";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import {
  CHAT_COMPACTION_CONTEXT_HEADER,
  buildChatCompactionResurfacingContext,
} from "./chat-compaction-resurfacing.js";

const NOW = 1_700_000_000_000;
const CHAT_ID = "chat-scale-1";

function chatRunId(turn: number): string {
  return `chat-${sha256Hex(CHAT_ID).slice(0, 16)}-t${String(turn)}`;
}

function record(): ContextCompactionRecord {
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    laneId: "history-summary",
    reason: "exceeded effective input budget",
    itemsBefore: 4,
    itemsAfter: 1,
    tokensBefore: 1000,
    tokensAfter: 120,
    preservedFacts: [],
    userConstraints: [],
    decisions: ["use governed evidence manifests"],
    openQuestions: [],
    assumptions: [],
    modelSummary: {
      promptVersion: CONTEXT_COMPACTION_MODEL_SUMMARY_PROMPT_VERSION,
      modelId: "summary-model",
      content: "Continue with the governed evidence manifest plan.",
    },
    sourceSpans: [],
    invalidationKeys: [],
  };
}

interface StubStats {
  listCalls: number;
  listByPrefixCalls: number;
  getRunIds: string[];
}

// Builds an EvidenceStore backed by REAL persisted compaction manifests (so loadEvidence parses them),
// with the chat runIds present plus `unrelatedCount` unrelated runIds injected into the list surface.
// Wraps the backing store to record how it was queried. `list()`/`listByPrefix()` expose the chat and
// unrelated runIds; `get()` delegates to the real store (unrelated runIds return undefined).
function stubStore(
  chatTurns: readonly number[],
  unrelatedCount: number,
  opts: { readonly withPrefix: boolean; readonly persistedTurns?: readonly number[] },
): { store: EvidenceStore; stats: StubStats } {
  const stats: StubStats = { listCalls: 0, listByPrefixCalls: 0, getRunIds: [] };
  const backing = createInMemoryEvidenceStore();
  (opts.persistedTurns ?? chatTurns).forEach((turn) => {
    persistCompactionEvidence(
      {
        runId: chatRunId(turn),
        modelId: "model-a",
        records: [record()],
        startedAt: NOW + turn,
        finishedAt: NOW + turn + 1,
        chatIdHash: sha256Hex(CHAT_ID),
      },
      { store: backing, env: {} },
    );
  });
  const chatRunIds = chatTurns.map((turn) => chatRunId(turn));
  const unrelated = Array.from(
    { length: unrelatedCount },
    (_v, i) => `unrelated-manifest-${String(i)}`,
  );
  const allRunIds = [...chatRunIds, ...unrelated];

  const base: Record<string, unknown> = {
    list: (): readonly string[] => {
      stats.listCalls += 1;
      return allRunIds;
    },
    get: (runId: string): string | undefined => {
      stats.getRunIds.push(runId);
      return backing.get(runId);
    },
    put: () => "",
    update: () => "",
    location: (runId: string) => `${runId}.json`,
    delete: () => undefined,
  };
  if (opts.withPrefix) {
    base.listByPrefix = (prefix: string): readonly string[] => {
      stats.listByPrefixCalls += 1;
      // Realistic adapter behavior: only matching-prefix runIds are ever surfaced.
      return allRunIds.filter((runId) => runId.startsWith(prefix));
    };
  }
  return { store: base as unknown as EvidenceStore, stats };
}

describe("buildChatCompactionResurfacingContext prefix scoping (GEN-PERF-CHAT-005)", () => {
  it("uses prefix-scoped listing and never loads unrelated manifests when the capability is present", () => {
    const { store, stats } = stubStore([1, 2, 3], 10_000, { withPrefix: true });

    const context = buildChatCompactionResurfacingContext(store, CHAT_ID);

    expect(context).toContain(CHAT_COMPACTION_CONTEXT_HEADER);
    expect(context).toContain("Continue with the governed evidence manifest plan.");

    // Prefix-scoped path taken; the unfiltered list() is never used.
    expect(stats.listByPrefixCalls).toBe(1);
    expect(stats.listCalls).toBe(0);
    // Only the 3 matching-prefix manifests are loaded — never the 10k unrelated ones.
    expect(stats.getRunIds).toHaveLength(3);
    expect(stats.getRunIds.every((runId) => runId.startsWith("chat-"))).toBe(true);
  });

  it("loads only the newest matching chat manifests before parsing structured summaries", () => {
    const chatTurns = Array.from({ length: 5_000 }, (_value, index) => index + 1);
    const { store, stats } = stubStore(chatTurns, 0, {
      withPrefix: true,
      persistedTurns: [4_998, 4_999, 5_000],
    });

    const context = buildChatCompactionResurfacingContext(store, CHAT_ID);

    expect(context).toContain(CHAT_COMPACTION_CONTEXT_HEADER);
    expect(context).toContain("Continue with the governed evidence manifest plan.");
    expect(stats.getRunIds).toEqual([chatRunId(5_000), chatRunId(4_999), chatRunId(4_998)]);
  });

  it("falls back to list() with an identical result set when listByPrefix is absent", () => {
    const withPrefix = stubStore([1, 2, 3], 5, { withPrefix: true });
    const withoutPrefix = stubStore([1, 2, 3], 5, { withPrefix: false });

    const a = buildChatCompactionResurfacingContext(withPrefix.store, CHAT_ID);
    const b = buildChatCompactionResurfacingContext(withoutPrefix.store, CHAT_ID);

    expect(b).toBe(a); // identical resurfaced context regardless of listing capability
    expect(withoutPrefix.stats.listCalls).toBe(1);
    expect(withoutPrefix.stats.listByPrefixCalls).toBe(0);
    // Fallback still only loads matching-prefix runIds (the JS filter runs before load).
    expect(withoutPrefix.stats.getRunIds.every((runId) => runId.startsWith("chat-"))).toBe(true);
  });

  it("does not regress: a stat-everything loader would load unrelated manifests", () => {
    // Guard assertion documenting the mechanism: if the loader ever loaded from the unfiltered list,
    // getRunIds would include unrelated-* entries. This asserts it does not.
    const { store, stats } = stubStore([1], 50, { withPrefix: true });
    buildChatCompactionResurfacingContext(store, CHAT_ID);
    expect(stats.getRunIds.some((runId) => runId.startsWith("unrelated-"))).toBe(false);
    vi.clearAllMocks();
  });
});
