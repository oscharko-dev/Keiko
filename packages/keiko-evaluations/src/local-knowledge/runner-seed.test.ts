// Tests for the fixture-seeding helpers (Epic #189, Issue #268). KEIKO-0614: proves
// `addTopicBoost` reads the exported `EVAL_TOPIC_BOOST` constant rather than a second,
// independent hardcoded literal -- so re-tuning the public constant actually changes the
// boost every fixture's chunks/queries receive.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { openKnowledgeStore, type KnowledgeStore } from "@oscharko-dev/keiko-local-knowledge";

const TOPIC_BOOST_SENTINEL = 2.5;

vi.mock("./fixtures.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fixtures.js")>();
  return {
    ...actual,
    EVAL_TOPIC_BOOST: TOPIC_BOOST_SENTINEL,
  };
});

describe("seedFixture — topic boosts", () => {
  it("uses the (mocked) EVAL_TOPIC_BOOST constant, not a hardcoded literal", async () => {
    const { singleTopicFixture } = await import("./fixtures.js");
    const { seedFixture } = await import("./runner-seed.js");
    const dir = mkdtempSync(join(tmpdir(), "keiko-eval-runner-seed-"));
    const store: KnowledgeStore = openKnowledgeStore({ dbPath: join(dir, "eval.db") });
    try {
      const seeded = seedFixture(store, singleTopicFixture);
      expect(seeded.topicBoosts.alpha).toBe(TOPIC_BOOST_SENTINEL);
      expect(seeded.topicBoosts.noise).toBe(TOPIC_BOOST_SENTINEL);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
