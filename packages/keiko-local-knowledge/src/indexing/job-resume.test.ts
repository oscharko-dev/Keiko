// Tests for `findResumableJob` (Epic #189, Issue #196). Verifies that a `running` row in
// `indexing_jobs` is discoverable by capsule and that terminal-state rows are not.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { KnowledgeCapsuleId, KnowledgeSourceId } from "@oscharko-dev/keiko-contracts";

import { createCapsule } from "../capsule-lifecycle.js";
import { addSourceToCapsule } from "../source-lifecycle.js";
import { freshStore, sampleCapsuleInput, sampleSourceInput } from "../_support.js";

import { finalizeJobRow, insertJobRow, type JobCounters } from "./job-persist.js";
import { findResumableJob } from "./job-resume.js";
import type { KnowledgeStore } from "../store.js";

interface Fixture {
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
}

function buildFixture(): Fixture {
  const { store, cleanup } = freshStore();
  const capsuleId = "cap-resume" as KnowledgeCapsuleId;
  const sourceId = "src-resume" as KnowledgeSourceId;
  createCapsule(store, sampleCapsuleInput({ id: capsuleId }));
  addSourceToCapsule(store, capsuleId, sampleSourceInput(sourceId));
  return { store, cleanup, capsuleId, sourceId };
}

const EMPTY_COUNTERS: JobCounters = {
  total: 0,
  processed: 0,
  failed: 0,
  skipped: 0,
  resumeToken: null,
};

describe("findResumableJob", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("returns undefined when no jobs have ever been recorded for the capsule", () => {
    expect(findResumableJob(fixture.store, fixture.capsuleId)).toBeUndefined();
  });

  it("returns the row when an indexing_jobs row is in `running` state", () => {
    insertJobRow(fixture.store._internal.db, {
      id: "job-1",
      capsuleId: fixture.capsuleId,
      sourceIds: [fixture.sourceId],
      startedAt: 1_700_000_000_000,
    });
    const row = findResumableJob(fixture.store, fixture.capsuleId);
    expect(row).toBeDefined();
    expect(row?.id).toBe("job-1");
    expect(row?.status).toBe("running");
    expect(row?.sourceIds).toEqual([fixture.sourceId]);
  });

  it("returns undefined when the only job is terminally finalized", () => {
    insertJobRow(fixture.store._internal.db, {
      id: "job-1",
      capsuleId: fixture.capsuleId,
      sourceIds: [fixture.sourceId],
      startedAt: 1_700_000_000_000,
    });
    finalizeJobRow(fixture.store._internal.db, {
      id: "job-1",
      status: "succeeded",
      finishedAt: 1_700_000_001_000,
      counters: EMPTY_COUNTERS,
    });
    expect(findResumableJob(fixture.store, fixture.capsuleId)).toBeUndefined();
  });

  it("returns the most recent `running` row when multiple exist", () => {
    insertJobRow(fixture.store._internal.db, {
      id: "job-old",
      capsuleId: fixture.capsuleId,
      sourceIds: [fixture.sourceId],
      startedAt: 1_700_000_000_000,
    });
    insertJobRow(fixture.store._internal.db, {
      id: "job-new",
      capsuleId: fixture.capsuleId,
      sourceIds: [fixture.sourceId],
      startedAt: 1_700_000_010_000,
    });
    const row = findResumableJob(fixture.store, fixture.capsuleId);
    expect(row?.id).toBe("job-new");
  });

  it("scopes by capsule — a running job on a different capsule is not returned", () => {
    const otherCapsule = "cap-other" as KnowledgeCapsuleId;
    createCapsule(
      fixture.store,
      sampleCapsuleInput({ id: otherCapsule, storageReference: "other/c" }),
    );
    insertJobRow(fixture.store._internal.db, {
      id: "job-other",
      capsuleId: otherCapsule,
      sourceIds: [],
      startedAt: 1_700_000_000_000,
    });
    expect(findResumableJob(fixture.store, fixture.capsuleId)).toBeUndefined();
    expect(findResumableJob(fixture.store, otherCapsule)?.id).toBe("job-other");
  });

  it("returns the resume_token when one was persisted by a prior progress update", () => {
    insertJobRow(fixture.store._internal.db, {
      id: "job-1",
      capsuleId: fixture.capsuleId,
      sourceIds: [fixture.sourceId],
      startedAt: 1_700_000_000_000,
    });
    // Directly seed the resume_token via a counter update — mirrors what the orchestrator
    // writes via `updateJobCounters` after each successful embedded document.
    fixture.store._internal.db
      .prepare("UPDATE indexing_jobs SET resume_token = :t WHERE id = :id")
      .run({ t: "doc-1#unit-1#c12", id: "job-1" });
    const row = findResumableJob(fixture.store, fixture.capsuleId);
    expect(row).toBeDefined();
    // The IndexingJobRecord contract does not surface resume_token directly; this test
    // pins the SELECT statement's column list so a future schema change cannot drop it
    // silently. The orchestrator's resume path queries the same row separately.
    const raw = fixture.store._internal.db
      .prepare("SELECT resume_token FROM indexing_jobs WHERE id = :id")
      .get({ id: "job-1" }) as { readonly resume_token: string | null };
    expect(raw.resume_token).toBe("doc-1#unit-1#c12");
  });
});
