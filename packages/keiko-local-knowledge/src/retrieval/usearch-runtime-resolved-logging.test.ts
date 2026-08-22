// Hermetic split-out of the "logs search.native-runtime-resolved" case that used to live in
// usearch-ann-index.test.ts (finding: KEIKO PR #3244, thread contracts-lk-4). That version
// required the real host-native USearch binary (`runtimePath()`, needing `npm run
// provision:usearch`) and mutated the module-level `TARGET_RUNTIME_CACHE` without restoring it,
// making the test both host-dependent and order-dependent.
//
// This file mocks `./usearch-runtime-manifest.js` so `usearchRuntimeApproval` accepts a small,
// fully-owned fixture file instead of the real multi-MB compiled addon. That mock would poison
// every real-binary test in usearch-ann-index.test.ts if it lived in the same file (they assert
// against the REAL approved SHA-256), which is why this is a separate file rather than a
// `vi.doMock` scoped to one `it` there — native-addon search correctness stays proven by that
// file's own tests, unaffected by this one.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EmbeddingModelIdentity } from "@oscharko-dev/keiko-contracts";

import type { KnowledgeLogEvent, KnowledgeLogSink } from "../knowledge-log.js";

import {
  __resetTargetRuntimeCacheForTests,
  clearUsearchAnnCacheForTests,
  searchUsearchAnnIndex,
} from "./usearch-ann-index.js";

// A fixture binary the test owns outright — never the real compiled USearch addon. Its SHA-256
// is precomputed (not re-derived from the production formula: this is INPUT data the mocked
// approval below is built to accept, not a value `verifyRuntimeAt` is expected to compute
// differently). `vi.mock` factories are hoisted above every other top-level statement, so the
// fixture constants themselves are wrapped in `vi.hoisted` to be visible inside the factory
// without a temporal-dead-zone reference error.
const { FIXTURE_BINARY_CONTENT, FIXTURE_BINARY_SHA256, FIXTURE_VERSION } = vi.hoisted(() => ({
  FIXTURE_BINARY_CONTENT: "keiko-usearch-runtime-logging-fixture",
  FIXTURE_BINARY_SHA256: "075f581c1183403f7c20a432fddc5ac84e700f8e39bd518dffcf297b69b5ce08",
  FIXTURE_VERSION: "usearch-runtime-fixture-1.0.0",
}));

vi.mock("./usearch-runtime-manifest.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./usearch-runtime-manifest.js")>();
  return {
    ...original,
    usearchRuntimeApproval: (
      targetKey: string | undefined,
    ): Readonly<Record<string, string>> | undefined =>
      targetKey === undefined
        ? undefined
        : Object.freeze({
            version: FIXTURE_VERSION,
            sourceCommit: "0".repeat(40),
            tarballUrl: "https://example.test/usearch-fixture.tgz",
            tarballSha256: "0".repeat(64),
            licenseSha256: "0".repeat(64),
            archivePath: "fixture/usearch.node",
            binarySha256: FIXTURE_BINARY_SHA256,
          }),
  };
});

const IDENTITY: EmbeddingModelIdentity = {
  provider: "test",
  modelId: "deterministic-64",
  vectorDimensions: 4,
  vectorMetric: "cosine",
  normalization: "l2",
  instructionVersion: "v1",
  embeddingSpaceFingerprint: "space-v1",
};

function twoEntryPartition(): {
  readonly partition: Parameters<typeof searchUsearchAnnIndex>[0]["partition"];
  readonly queryVector: Float32Array;
} {
  const entries = [
    { id: "a", vector: Float32Array.from([1, 0, 0, 0]) },
    { id: "b", vector: Float32Array.from([0, 1, 0, 0]) },
  ];
  return {
    partition: {
      cacheKey: "runtime-logging-partition",
      cacheGroupKey: "runtime-logging-owner",
      revision: "revision-1",
      identity: IDENTITY,
      rowCount: entries.length,
      loadEntries: () => entries,
    },
    queryVector: Float32Array.from([1, 0, 0, 0]),
  };
}

afterEach(() => {
  clearUsearchAnnCacheForTests();
  __resetTargetRuntimeCacheForTests();
});

describe("USearch ANN index — native-runtime-resolved logging (hermetic)", () => {
  it("logs search.native-runtime-resolved on the cold path only, content-free", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "keiko-usearch-runtime-fixture-"));
    const binary = join(fixtureDir, "usearch.node");
    writeFileSync(binary, FIXTURE_BINARY_CONTENT, "utf8");
    // Prove the fixture is what it claims to be, independent of the mocked approval object —
    // if this ever drifted, the "resolved: true" assertions below would silently start
    // exercising the "invalid" branch instead of the success branch they are named for.
    expect(createHash("sha256").update(FIXTURE_BINARY_CONTENT).digest("hex")).toBe(
      FIXTURE_BINARY_SHA256,
    );
    const events: KnowledgeLogEvent[] = [];
    const logSink: KnowledgeLogSink = {
      write: (event): void => {
        events.push(event);
      },
    };
    const { partition, queryVector } = twoEntryPartition();
    const request = {
      partition,
      queryVector,
      candidateLimit: 5,
      exactScanThreshold: 0,
      binaryPath: binary,
      logSink,
    };
    __resetTargetRuntimeCacheForTests();

    try {
      // The fixture verifies successfully (its hash matches the mocked approval), so
      // targetRuntime() logs "resolved: true" before the ANN worker ever starts. The worker
      // then fails to load the fixture as a real native addon — expected and irrelevant here,
      // since this test is about the logging boundary, not ANN search correctness (which the
      // real-binary tests in usearch-ann-index.test.ts already cover).
      await searchUsearchAnnIndex(request);
      const coldLines = events.filter((event) => event.op === "search.native-runtime-resolved");
      // resolvedIndex() and buildSearchIndex() both call targetRuntime() for the same request;
      // the second call is already a warm hit against the cache the first call just populated,
      // so exactly one line — not two — is written for one logical search call.
      expect(coldLines).toHaveLength(1);
      expect(coldLines[0]).toMatchObject({
        level: "info",
        category: "search",
        extra: {
          resolved: true,
          version: FIXTURE_VERSION,
        },
      });
      // Content-free: never the resolved filesystem path or the raw SHA-256 digest.
      expect(JSON.stringify(coldLines[0])).not.toContain(binary);
      expect(JSON.stringify(coldLines[0])).not.toContain(FIXTURE_BINARY_SHA256);

      events.length = 0;
      await searchUsearchAnnIndex(request);
      expect(events.filter((event) => event.op === "search.native-runtime-resolved")).toHaveLength(
        0,
      );
    } finally {
      __resetTargetRuntimeCacheForTests();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
