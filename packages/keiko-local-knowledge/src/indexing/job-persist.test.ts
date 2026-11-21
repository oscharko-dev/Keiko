import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCapsule } from "../capsule-lifecycle.js";
import { KnowledgeStoreError } from "../errors.js";
import { isKnowledgeCapsuleId, isKnowledgeSourceId, mintedId } from "../knowledge-ids.js";
import { freshStore, sampleCapsuleInput } from "../_support.js";
import type { KnowledgeStore } from "../store.js";

import {
  insertJobRow,
  isJobCancellationRequested,
  rowToIndexingJobRecord,
  rowToResumableIndexingJobRecord,
  selectJobById,
} from "./job-persist.js";

interface Fixture {
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
  readonly capsuleId: KnowledgeCapsuleId;
}

const JOB_ID = "job-persist-1";

function tamper(fixture: Fixture, assignment: string): void {
  fixture.store._internal.db
    .prepare(`UPDATE indexing_jobs SET ${assignment} WHERE id = :id`)
    .run({ id: JOB_ID });
}

describe("indexing job persistence reads", () => {
  let fixture: Fixture;
  beforeEach(() => {
    const { store, cleanup } = freshStore();
    const capsuleId = mintedId("cap-job", isKnowledgeCapsuleId);
    createCapsule(store, sampleCapsuleInput({ id: capsuleId }));
    insertJobRow(store._internal.db, {
      id: JOB_ID,
      capsuleId,
      sourceIds: [mintedId("src-a", isKnowledgeSourceId)],
      startedAt: 10,
    });
    fixture = { store, cleanup, capsuleId };
  });
  afterEach(() => {
    fixture.cleanup();
  });

  it("reads a stored job with its typed ids, resume token and status", () => {
    tamper(fixture, "resume_token = 'doc#ch_1', cancellation_requested = 1");
    const row = selectJobById(fixture.store._internal.db, JOB_ID);
    expect(row).toBeDefined();
    if (row === undefined) return;
    const record = rowToResumableIndexingJobRecord(row);
    expect(record.capsuleId).toBe(fixture.capsuleId);
    expect(record.sourceIds).toEqual(["src-a"]);
    expect(record.status).toBe("running");
    expect(record.resumeToken).toBe("doc#ch_1");
    expect(isJobCancellationRequested(fixture.store._internal.db, JOB_ID)).toBe(true);
    expect(isJobCancellationRequested(fixture.store._internal.db, "missing")).toBe(false);
  });

  it("keeps the lenient status and source-id reads for an unexpected stored value", () => {
    tamper(fixture, "status = 'mystery', source_ids_json = '[\" src-a\"]'");
    const row = selectJobById(fixture.store._internal.db, JOB_ID);
    expect(row).toBeDefined();
    if (row === undefined) return;
    const record = rowToIndexingJobRecord(row);
    expect(record.status).toBe("failed");
    expect(record.sourceIds).toEqual([]);
  });

  it("refuses a blank stored resume token instead of reading it as a chunk id", () => {
    tamper(fixture, "resume_token = '   '");
    expect(() => selectJobById(fixture.store._internal.db, JOB_ID)).toThrow(KnowledgeStoreError);
  });
});
