// GEN-PERF-LK-001 — capsule metadata is loaded ONCE per capsule-set query and
// THREADED through scope resolution → policy → vector search. Before the fix the
// three stages each re-fetched every member (composition, strictestPolicy and the
// search's loadCapsules: ≥3 getCapsule calls per capsule, ≈7 SQL round-trips of
// pure metadata refetch per chat turn on a 10-capsule set). This test counts real
// getCapsule invocations across one full capsule-set retrieval and pins the
// threaded budget: at most ONE call per member. It fails on the pre-threading
// code (9 calls for 3 members) and passes with threading (3).
//
// The mock lives in its own file so the counter cannot bleed into the behavioural
// retrieval-runner tests; behaviour itself is re-asserted below (references from
// every member, no-evidence false) so the count never passes on a broken search.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CapsuleSetId, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { standardPodModelUsePolicy } from "@oscharko-dev/keiko-contracts";

const getCapsuleCalls: string[] = [];

vi.mock("../capsule-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../capsule-lifecycle.js")>();
  return {
    ...actual,
    getCapsule: (
      ...args: Parameters<typeof actual.getCapsule>
    ): ReturnType<typeof actual.getCapsule> => {
      getCapsuleCalls.push(String(args[1]));
      return actual.getCapsule(...args);
    },
  };
});

// Imported AFTER the mock so every module in the retrieval pipeline resolves the
// counting wrapper (composition, retrieval-runner and scoped-vector-search all
// import the same capsule-lifecycle module).
import { createCapsuleSet } from "../capsule-set-lifecycle.js";
import { freshStore, sampleCapsuleInput, sampleSourceInput } from "../_support.js";
import { createCapsule } from "../capsule-lifecycle.js";
import { addSourceToCapsule } from "../source-lifecycle.js";
import { runLocalKnowledgeRetrieval } from "./retrieval-runner.js";
import { scriptedAdapter, seedCapsuleWithVectors } from "./_support.js";
import type { KnowledgeStore } from "../store.js";

interface Fixture {
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
}

let fixture: Fixture | undefined;

beforeEach(() => {
  fixture = freshStore();
  getCapsuleCalls.length = 0;
});

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

function getFixture(): Fixture {
  if (fixture === undefined) throw new Error("fixture not initialised");
  return fixture;
}

async function seedMember(store: KnowledgeStore, index: number): Promise<KnowledgeCapsuleId> {
  const capsuleId = `cap-${String(index)}` as KnowledgeCapsuleId;
  const sourceId = `src-${String(index)}`;
  createCapsule(
    store,
    sampleCapsuleInput({
      id: capsuleId,
      answerGroundingPolicy: "best-effort",
      modelUsePolicy: standardPodModelUsePolicy(),
    }),
  );
  addSourceToCapsule(store, capsuleId, sampleSourceInput(sourceId));
  await seedCapsuleWithVectors(store, {
    capsuleId: String(capsuleId),
    sourceId,
    documentId: `doc-${String(index)}`,
    skipCapsule: true,
    skipSource: true,
  });
  return capsuleId;
}

describe("capsule-set retrieval loads capsule metadata once per member (GEN-PERF-LK-001)", () => {
  it("issues at most one getCapsule per member for a full set query", async () => {
    const { store } = getFixture();
    const members = [
      await seedMember(store, 1),
      await seedMember(store, 2),
      await seedMember(store, 3),
    ];
    const setId = "set-threading" as CapsuleSetId;
    createCapsuleSet(store, {
      id: setId,
      displayName: "Threading Set",
      tags: [],
      capsuleIds: members,
    });

    getCapsuleCalls.length = 0; // count ONLY the retrieval turn, not the seeding
    const result = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: scriptedAdapter() },
      { capsuleSetId: setId, text: "query" },
    );

    // Behaviour first: the query genuinely ran over every member.
    expect(result.noEvidence).toBe(false);
    const referencedCapsules = new Set(result.references.map((r) => String(r.capsuleId)));
    for (const member of members) {
      expect(referencedCapsules.has(String(member))).toBe(true);
    }

    // The threading contract: one metadata load per member, total — not one per
    // pipeline stage. Pre-threading this was 3 stages x 3 members = 9 calls.
    expect(getCapsuleCalls.length).toBeLessThanOrEqual(members.length);
  });
});
