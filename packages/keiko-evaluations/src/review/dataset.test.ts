import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  loadReviewHarvestDataset,
  parseReviewHarvestDataset,
  ReviewDatasetError,
} from "./dataset.js";
import { REVIEW_EVALUATION_MANIFEST } from "./manifest.js";
import { reviewSplitOf } from "./replay.js";
import { dataset, pullRequest, thread } from "./_support.js";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const valid = dataset([
  pullRequest(1, [
    thread(),
    thread({ id: "PRRT_2", fileLevel: true, startLine: null, endLine: null }),
  ]),
  pullRequest(2, [], { reviewedBy: ["qodo"], state: "closed", headCommit: null }),
]);

function mutate(change: (value: Record<string, unknown>) => void): unknown {
  const value = structuredClone(valid) as unknown as Record<string, unknown>;
  change(value);
  return value;
}

function firstThread(value: Record<string, unknown>): Record<string, unknown> {
  const prs = value.pullRequests as { threads: Record<string, unknown>[] }[];
  const first = prs[0]?.threads[0];
  if (first === undefined) throw new Error("fixture has no thread");
  return first;
}

describe("parseReviewHarvestDataset", () => {
  it("accepts a well-formed dataset unchanged", () => {
    expect(parseReviewHarvestDataset(structuredClone(valid))).toEqual(valid);
  });

  it.each([
    [
      "a comment body",
      (value: Record<string, unknown>): void => {
        firstThread(value).body = "text";
      },
      "pullRequests.0.threads.0.body",
    ],
    [
      "an author login",
      (value: Record<string, unknown>): void => {
        firstThread(value).login = "someone";
      },
      "pullRequests.0.threads.0.login",
    ],
    [
      "an unknown producer",
      (value: Record<string, unknown>): void => {
        firstThread(value).producer = "copilot";
      },
      "pullRequests.0.threads.0.producer",
    ],
    [
      "an inconsistent anchor",
      (value: Record<string, unknown>): void => {
        firstThread(value).fileLevel = true;
      },
      "pullRequests.0.threads.0",
    ],
    [
      "an inverted range",
      (value: Record<string, unknown>): void => {
        firstThread(value).startLine = 99;
      },
      "pullRequests.0.threads.0",
    ],
    [
      "an abbreviated commit",
      (value: Record<string, unknown>): void => {
        firstThread(value).reviewedCommit = "abc123";
      },
      "pullRequests.0.threads.0.reviewedCommit",
    ],
    [
      "a malformed body digest",
      (value: Record<string, unknown>): void => {
        firstThread(value).bodyDigest = "md5:1";
      },
      "pullRequests.0.threads.0.bodyDigest",
    ],
    [
      "an unknown reply class",
      (value: Record<string, unknown>): void => {
        firstThread(value).reply = { classification: "maybe", producer: "human" };
      },
      "pullRequests.0.threads.0.reply.classification",
    ],
    [
      "a repeated pull request",
      (value: Record<string, unknown>): void => {
        (value.pullRequests as unknown[]).push((value.pullRequests as unknown[])[0]);
      },
      "pullRequests.2",
    ],
    [
      "a wrong schema version",
      (value: Record<string, unknown>): void => {
        value.schemaVersion = 2;
      },
      "schemaVersion",
    ],
    [
      "a negative notice count",
      (value: Record<string, unknown>): void => {
        (value.excludedNoticeThreads as Record<string, number>).qodo = -1;
      },
      "excludedNoticeThreads.qodo",
    ],
    [
      "a non-scalar rule",
      (value: Record<string, unknown>): void => {
        value.rules = { nested: {} };
      },
      "rules.nested",
    ],
  ])("rejects %s and names the field without echoing it", (_name, change, path) => {
    const attempt = (): unknown => parseReviewHarvestDataset(mutate(change));
    expect(attempt).toThrow(ReviewDatasetError);
    try {
      attempt();
    } catch (error) {
      expect(error).toMatchObject({ path });
      expect(String(error)).not.toContain("someone");
    }
  });

  it("rejects a value that is not an object", () => {
    expect(() => parseReviewHarvestDataset([])).toThrow(ReviewDatasetError);
  });
});

describe("loadReviewHarvestDataset", () => {
  it("reads plain and gzip-compressed files", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-dataset-"));
    try {
      writeFileSync(join(dir, "d.json"), JSON.stringify(valid));
      writeFileSync(join(dir, "d.json.gz"), gzipSync(JSON.stringify(valid)));
      expect(loadReviewHarvestDataset(join(dir, "d.json"))).toEqual(valid);
      expect(loadReviewHarvestDataset(join(dir, "d.json.gz"))).toEqual(valid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the committed harvest dataset", () => {
  const committed = loadReviewHarvestDataset(
    join(REPOSITORY_ROOT, REVIEW_EVALUATION_MANIFEST.datasetPath),
  );

  it("is the dataset the manifest pins", () => {
    // The digest is computed by the harvest script that owns it (scripts/review-harvest.mjs
    // --verify); this side only checks that the manifest names the committed file's digest.
    expect(committed.digest).toBe(REVIEW_EVALUATION_MANIFEST.datasetDigest);
    expect(committed.repository).toBe("oscharko-dev/Keiko");
  });

  it("has labeled threads on both sides of the holdout boundary", () => {
    const threadsIn = (split: "development" | "holdout"): number =>
      committed.pullRequests
        .filter((pr) => reviewSplitOf(pr.number) === split)
        .reduce((sum, pr) => sum + pr.threads.length, 0);
    expect(threadsIn("development")).toBeGreaterThan(0);
    expect(threadsIn("holdout")).toBeGreaterThan(0);
  });
});
