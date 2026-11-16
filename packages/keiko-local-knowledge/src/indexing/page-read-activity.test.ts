import { describe, expect, it } from "vitest";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import type { KnowledgeLogEvent } from "../knowledge-log.js";
import { emitPageReadFailure, pageReadDocumentDigest } from "./page-read-activity.js";

const DIGEST = "0123456789abcdef";

describe("emitPageReadFailure", () => {
  it("resolves indexing.document.page-read-failed.stage", () => {
    const events: KnowledgeLogEvent[] = [];
    emitPageReadFailure(
      { write: (event): void => void events.push(event) },
      {
        context: { jobId: "page-read-job", capsuleIdDigest: DIGEST, documentIdDigest: DIGEST },
        stage: "resume",
        pageNumber: 7,
        failureKind: "PDF_BROKEN",
      },
    );

    const persisted = expectActivityLogProof(
      "indexing.document.page-read-failed.stage",
      formatActivityLogProofLine(events[0] ?? {}),
    );
    expect(events).toHaveLength(1);
    expect(persisted).toMatchObject({ stage: "resume", pageNumber: 7, failureKind: "PDF_BROKEN" });
  });

  it("does not put the document's identifier on the line", () => {
    const digest = pageReadDocumentDigest("doc-with-a-readable-name");

    expect(digest).toMatch(/^[a-f0-9]{16}$/u);
    expect(digest).not.toContain("readable");
  });
});
