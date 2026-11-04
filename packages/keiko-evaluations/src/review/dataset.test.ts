import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  loadReviewHarvestDataset,
  parseReviewHarvestDataset,
  ReviewDatasetError,
  reviewHarvestDatasetDigest,
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
      "a schema-1 dataset, which has no head anchors",
      (value: Record<string, unknown>): void => {
        value.schemaVersion = 1;
      },
      "schemaVersion",
    ],
    [
      "a missing head anchor field",
      (value: Record<string, unknown>): void => {
        delete firstThread(value).headEndLine;
      },
      "pullRequests.0.threads.0.headEndLine",
    ],
    [
      "an inverted head range",
      (value: Record<string, unknown>): void => {
        firstThread(value).headStartLine = 99;
      },
      "pullRequests.0.threads.0",
    ],
    [
      "a half head range",
      (value: Record<string, unknown>): void => {
        firstThread(value).headStartLine = null;
      },
      "pullRequests.0.threads.0",
    ],
    [
      "a head range on a base-side anchor",
      (value: Record<string, unknown>): void => {
        firstThread(value).side = "left";
      },
      "pullRequests.0.threads.0",
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

function withTempDir<T>(use: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "review-dataset-"));
  try {
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function digestError(load: () => unknown): unknown {
  try {
    load();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("loadReviewHarvestDataset", () => {
  it("reads plain and gzip-compressed files", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "d.json"), JSON.stringify(valid));
      writeFileSync(join(dir, "d.json.gz"), gzipSync(JSON.stringify(valid)));
      expect(loadReviewHarvestDataset(join(dir, "d.json"))).toEqual(valid);
      expect(loadReviewHarvestDataset(join(dir, "d.json.gz"))).toEqual(valid);
    });
  });

  it("recomputes the content digest independently of key order", () => {
    const { digest, ...content } = valid;
    expect(reviewHarvestDatasetDigest(content)).toBe(digest);
    const reordered = Object.fromEntries(Object.entries(content).reverse());
    expect(reviewHarvestDatasetDigest(reordered)).toBe(digest);
  });

  it("refuses a file whose content no longer matches its stored digest", () => {
    // R4130-010: one changed field with the digest left alone must not load.
    const edited = mutate((value) => {
      firstThread(value).regionChange = "changed";
    });
    withTempDir((dir) => {
      writeFileSync(join(dir, "d.json"), JSON.stringify(edited));
      const error = digestError(() => loadReviewHarvestDataset(join(dir, "d.json")));
      expect(error).toBeInstanceOf(ReviewDatasetError);
      expect(error).toMatchObject({ path: "digest" });
    });
  });
});

describe("the committed harvest dataset", () => {
  const committed = loadReviewHarvestDataset(
    join(REPOSITORY_ROOT, REVIEW_EVALUATION_MANIFEST.datasetPath),
  );

  it("is the dataset the manifest pins, by its recomputed content digest", () => {
    const { digest, ...content } = committed;
    expect(reviewHarvestDatasetDigest(content)).toBe(REVIEW_EVALUATION_MANIFEST.datasetDigest);
    expect(digest).toBe(REVIEW_EVALUATION_MANIFEST.datasetDigest);
    expect(committed.repository).toBe("oscharko-dev/Keiko");
  });

  it("does not load once one field of the committed file changes", () => {
    // R4130-010: the stored digest field alone cannot vouch for edited content.
    const raw = JSON.parse(
      gunzipSync(
        readFileSync(join(REPOSITORY_ROOT, REVIEW_EVALUATION_MANIFEST.datasetPath)),
      ).toString("utf8"),
    ) as Record<string, unknown>;
    const prs = raw.pullRequests as { threads: Record<string, unknown>[] }[];
    const target = prs.find((entry) => entry.threads.length > 0)?.threads[0];
    if (target === undefined) throw new Error("the committed dataset has no thread");
    target.regionChange = target.regionChange === "changed" ? "unchanged" : "changed";
    withTempDir((dir) => {
      writeFileSync(join(dir, "edited.json.gz"), gzipSync(JSON.stringify(raw)));
      const error = digestError(() => loadReviewHarvestDataset(join(dir, "edited.json.gz")));
      expect(error).toMatchObject({ path: "digest" });
    });
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
