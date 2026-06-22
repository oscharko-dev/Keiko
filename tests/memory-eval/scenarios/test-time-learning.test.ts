// AC: test-time learning. A memory captured during a run becomes retrievable only after
// the governed proposal is explicitly accepted.
//
// Pipeline path: extractCandidatesFromUserText → take the resulting "candidate" proposal →
// transform it into a proposed MemoryRecord (caller's role per #207 docs) → insert into vault →
// retrieval suppresses it → explicit acceptance transition → retrieval surfaces it.
//
// Mutation-robustness controls:
//  1. POSITIVE: after explicit acceptance, retrieval includes the newly-captured memory AND
//     preserves the seeded workflow lesson from the explicitly requested workflow scope.
//  2. NEGATIVE/CONTROL: retrieval BEFORE the insert MUST include the seeded workflow lesson
//     but MUST NOT include the new memory id — proves the second retrieval is honouring
//     fresh storage state rather than caching anywhere upstream.
//  3. GOVERNANCE CONTROL: retrieval AFTER inserting the proposed record but BEFORE acceptance
//     MUST still suppress the new memory as `proposed`.
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
import {
  checkStatusTransition,
  validateMemoryAcceptance,
  type MemoryId,
  type MemoryProposal,
  type MemoryProposalId,
  type MemoryRecord,
} from "@oscharko-dev/keiko-contracts/memory";

import {
  FIXED_NOW_MS,
  TEST_VAULT_KEY,
  counterIdSource,
  loadFixture,
  makeRecord,
  memoryId,
  reviewerId,
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
    vaultKey: TEST_VAULT_KEY,
  });
}

function seedBaselineLessons(vault: MemoryVaultStore): void {
  const fixture = loadFixture("workflow-lessons.json")[0];
  if (fixture === undefined) throw new Error("expected workflow-lessons fixture");
  for (const m of fixture.memories) {
    vault.insertMemory(makeRecord(m));
  }
}

function captureProposal(): MemoryProposal {
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
  return first.proposal;
}

function recordFromProposal(proposal: MemoryProposal): MemoryRecord {
  return {
    id: memoryId(NEW_ID),
    schemaVersion: proposal.schemaVersion,
    scope: proposal.scope,
    type: proposal.type,
    body: proposal.body,
    tags: proposal.tags,
    provenance: proposal.provenance,
    validity: proposal.validity,
    status: proposal.initialStatus,
    pinned: false,
    createdAt: proposal.proposedAt,
    updatedAt: proposal.proposedAt,
  };
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

function acceptProposedMemory(vault: MemoryVaultStore, proposal: MemoryProposal): void {
  const id = memoryId(NEW_ID);
  const existing = vault.getMemory(id);
  if (existing === undefined) {
    throw new Error("expected proposed memory to exist before acceptance");
  }
  const transition = checkStatusTransition(existing.status, "accepted");
  if (!transition.ok) {
    throw new Error(transition.reason ?? "proposed memory cannot be accepted");
  }
  const acceptance = {
    schemaVersion: "1" as const,
    proposalId: proposal.proposalId,
    mintedMemoryId: id,
    reviewerId: reviewerId("eval-reviewer"),
    acceptedAt: FIXED_NOW_MS,
  };
  const validation = validateMemoryAcceptance(acceptance);
  if (!validation.ok) {
    throw new Error(`acceptance envelope invalid: ${validation.errors.join(", ")}`);
  }
  vault.updateMemory(id, { status: "accepted" }, FIXED_NOW_MS + 1);
}

function runTestTimeLearning(): { passed: boolean; evidence: string } {
  const vault = openVault(freshDir());
  try {
    seedBaselineLessons(vault);
    const port = vaultPort(vault);
    const beforeIds = includedIds(retrieveMemoryContext(retrievalRequest(), port).included);
    const proposal = captureProposal();
    vault.insertMemory(recordFromProposal(proposal));
    const proposedResult = retrieveMemoryContext(retrievalRequest(), port);
    const proposedIds = includedIds(proposedResult.included);
    const proposedOmission = proposedResult.omitted.find(
      (entry) => String(entry.memoryId) === NEW_ID,
    );
    acceptProposedMemory(vault, proposal);
    const afterIds = includedIds(retrieveMemoryContext(retrievalRequest(), port).included);
    const proposedSuppressed =
      !proposedIds.includes(NEW_ID) &&
      proposedOmission?.reason === "suppressed-by-status" &&
      proposedOmission.suppressionDetail === "proposed";
    const positivePass =
      afterIds.includes(NEW_ID) && afterIds.includes("lesson-investigate-read-first");
    const controlPass =
      beforeIds.includes("lesson-investigate-read-first") && !beforeIds.includes(NEW_ID);
    const proposedDetail = proposedOmission?.suppressionDetail ?? "none";
    return {
      passed: positivePass && controlPass && proposedSuppressed,
      evidence: `before=[${beforeIds.join(",")}] proposed.omitted=${proposedDetail} after=[${afterIds.join(",")}]`,
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
  it("suppresses the proposed capture until explicit acceptance, then retrieves it", () => {
    const { passed, evidence } = runTestTimeLearning();
    expect(passed, evidence).toBe(true);
  });
});
