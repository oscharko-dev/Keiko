import { describe, expect, it } from "vitest";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import type { OpenAIEmbeddingRequest } from "@oscharko-dev/keiko-model-gateway";
import { freshStore } from "../_support.js";
import { scriptedAdapter, seedCapsuleWithVectors } from "./_support.js";
import { searchVectorsForScope, type SearchOptions } from "./scoped-vector-search.js";

type Observation = Parameters<NonNullable<SearchOptions["observeQueryEmbedding"]>>[0];

describe("request-private validated query observation", () => {
  it("copies a validated vector without changing the adapter-scoped query cache", async () => {
    const fixture = freshStore();
    try {
      const capsuleId = "query-observation" as KnowledgeCapsuleId;
      await seedCapsuleWithVectors(fixture.store, { capsuleId });
      const requests: OpenAIEmbeddingRequest[] = [];
      const base = scriptedAdapter();
      const adapter = {
        ...base,
        request: (request: OpenAIEmbeddingRequest): ReturnType<typeof base.request> => {
          requests.push(request);
          return base.request(request);
        },
      };
      const observed: Observation[] = [];
      const options: SearchOptions = {
        topK: 2,
        observeQueryEmbedding: (observation): void => {
          expect(observation.vector.every(Number.isFinite)).toBe(true);
          observed.push(observation);
          observation.vector.fill(Number.NaN);
        },
      };
      const scope = { capsuleIds: [capsuleId] };
      const first = await searchVectorsForScope(fixture.store, adapter, scope, "query", options);
      const calls = requests.length;
      const second = await searchVectorsForScope(fixture.store, adapter, scope, "query", options);
      expect(observed).toHaveLength(2);
      expect(observed[0]?.query).toBe("query");
      expect(observed[0]?.identity).toEqual(observed[1]?.identity);
      expect(observed[0]?.vector).not.toBe(observed[1]?.vector);
      expect(first.references.length).toBeGreaterThan(0);
      expect(second.references).toEqual(first.references);
      expect(requests).toHaveLength(calls);
    } finally {
      fixture.cleanup();
    }
  });
});
