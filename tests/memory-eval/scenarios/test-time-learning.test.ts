// AC: test-time learning. A memory captured during a run is retrievable on the next call.
//
// Pipeline path: extractCandidatesFromUserText → take the resulting "candidate" proposal →
// transform it into a MemoryRecord (caller's role per #207 docs) → insert into vault →
// retrieval surfaces it.
//
// Mutation-robustness controls:
//  1. POSITIVE: after the capture+insert, retrieval includes the newly-captured memory AND
//     preserves the seeded workflow lesson from the explicitly requested workflow scope.
//  2. NEGATIVE/CONTROL: retrieval BEFORE the insert MUST include the seeded workflow lesson
//     but MUST NOT include the new memory id — proves the second retrieval is honouring
//     fresh storage state rather than caching anywhere upstream.
//
// Composition: real SQLite vault (mkdtemp), capture module, retrieval module. Cleaned up
// in afterEach.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { extractCandidatesFromUserText } from "@oscharko-dev/keiko-memory-capture";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import {
  retrieveMemoryContext,
  type MemoryRetrievalRequest,
} from "@oscharko-dev/keiko-memory-retrieval";
import type {
  MemoryId,
  MemoryProposalId,
  MemoryRecord,
} from "@oscharko-dev/keiko-contracts/memory";

import {
  FIXED_NOW_MS,
  counterIdSource,
  loadFixture,
  makeRecord,
  memoryId,
  userId,
  userScope,
  vaultPort,
  workflowScopeOf,
} from "../_support.js";
import type { Scorecard } from "../scorecard.js";

const SCENARIO_NAME = "test-time-learning";
const NEW_ID = "captured-during-run";

const cleanups: string[] = [];
afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "keiko-eval-tlearn-"));
  cleanups.push(dir);
  return dir;
}

function openVault(dir: string): MemoryVaultStore {
  const ids = counterIdSource("tomb");
  return createMemoryVault({
    memoryDir: dir,
    env: { KEIKO_MEMORY_DIR: dir },
    now: () => FIXED_NOW_MS,
    newTombstoneId: ids,
  });
}

function seedBaselineLessons(vault: MemoryVaultStore): void {
  const fixture = loadFixture("workflow-lessons.json")[0];
  if (fixture === undefined) throw new Error("expected workflow-lessons fixture");
  for (const m of fixture.memories) {
    vault.insertMemory(makeRecord(m));
  }
}

function captureProposal(): { readonly body: string } {
  const text = "remember that the deploy step is gated on the green pipeline status";
  const outcomes = extractCandidatesFromUserText(text, {
    userId: userId("user-alice"),
    nowMs: FIXED_NOW_MS,
    newMemoryId: () => memoryId(NEW_ID),
    newProposalId: () => "prop-1" as MemoryProposalId,
  });
  const first = outcomes[0];
  if (first?.kind !== "candidate") {
    throw new Error(`expected candidate outcome, got ${String(first?.kind)}`);
  }
  return { body: first.proposal.body };
}

function recordFromCapture(body: string): MemoryRecord {
  return makeRecord({
    id: NEW_ID,
    scope: { kind: "user", userId: "user-alice" },
    type: "preference",
    body,
    confidence: 0.9,
    capturedAt: FIXED_NOW_MS,
    validFrom: FIXED_NOW_MS,
    createdAt: FIXED_NOW_MS,
    updatedAt: FIXED_NOW_MS,
  });
}

function retrievalRequest(): MemoryRetrievalRequest {
  return {
    scopes: [userScope("user-alice"), workflowScopeOf("wf-investigate")],
    queryText: "read the failing test before editing source and deploy step pipeline status",
    nowMs: FIXED_NOW_MS,
  };
}

function includedIds(ids: readonly { readonly memoryId: MemoryId }[]): readonly string[] {
  return ids.map((m) => String(m.memoryId));
}

function runTestTimeLearning(): { passed: boolean; evidence: string } {
  const vault = openVault(freshDir());
  try {
    seedBaselineLessons(vault);
    const port = vaultPort(vault);
    const beforeIds = includedIds(retrieveMemoryContext(retrievalRequest(), port).included);
    const { body } = captureProposal();
    vault.insertMemory(recordFromCapture(body));
    const afterIds = includedIds(retrieveMemoryContext(retrievalRequest(), port).included);
    const positivePass =
      afterIds.includes(NEW_ID) && afterIds.includes("lesson-investigate-read-first");
    const controlPass =
      beforeIds.includes("lesson-investigate-read-first") && !beforeIds.includes(NEW_ID);
    return {
      passed: positivePass && controlPass,
      evidence: `before=[${beforeIds.join(",")}] after=[${afterIds.join(",")}]`,
    };
  } finally {
    vault.close();
  }
}

export async function run(scorecard: Scorecard): Promise<void> {
  const { passed, evidence } = runTestTimeLearning();
  scorecard.recordResult(SCENARIO_NAME, passed, evidence);
  await Promise.resolve();
}

describe(SCENARIO_NAME, () => {
  it("keeps the workflow baseline before insert and adds the captured memory after", () => {
    const { passed, evidence } = runTestTimeLearning();
    expect(passed, evidence).toBe(true);
  });
});
