import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import {
  CAPSULE_STAMP_MEMO_MAX_AGE_MS,
  currentCapsuleStampLookup,
  resetCapsuleStampMemoForTest,
  type CapsuleStampSource,
} from "./local-knowledge-capsule-stamps.js";
import * as local from "@oscharko-dev/keiko-local-knowledge";

const B = "cap-b" as KnowledgeCapsuleId;

let dir: string;
let dbPath: string;
let opens: number;
let clock: number;
let store: ReturnType<typeof local.openKnowledgeStore>;

function source(): CapsuleStampSource {
  return {
    dbPath,
    now: () => clock,
    open: (): ReturnType<CapsuleStampSource["open"]> => {
      opens += 1;
      return { store, close: (): void => undefined };
    },
  };
}

beforeEach(() => {
  resetCapsuleStampMemoForTest();
  dir = mkdtempSync(join(tmpdir(), "keiko-stamps-"));
  dbPath = join(dir, "capsules.db");
  writeFileSync(dbPath, "v1");
  opens = 0;
  clock = 1_000_000;
  store = local.openKnowledgeStore({ dbPath: ":memory:" });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedCapsule(): KnowledgeCapsuleId {
  return local.createCapsule(store, {
    id: "cap-a" as KnowledgeCapsuleId,
    displayName: "Capsule",
    tags: [],
    retrievalEffort: "default",
    outputMode: "snippets",
    answerGroundingPolicy: "require-citations",
    embeddingModelIdentity: {
      provider: "openai",
      modelId: "text-embedding-3-small",
      vectorDimensions: 1536,
      vectorMetric: "cosine",
    },
    lifecycleState: "ready",
    storageReference: "capsules/cap-a",
  }).id;
}

describe("currentCapsuleStampLookup", () => {
  it("opens once, then answers from the memo while nothing moved", () => {
    const id = seedCapsule();
    const first = currentCapsuleStampLookup(source(), [id]);
    expect(first.outcome).toBe("reread-missing");
    for (let i = 0; i < 5; i += 1) {
      const next = currentCapsuleStampLookup(source(), [id]);
      expect(next.outcome).toBe("hit");
      expect(next.lookup(id)).toBe(first.lookup(id));
    }
    expect(opens).toBe(1);
  });

  it("surfaces a metadata failure other than a missing file instead of reading it as absent", () => {
    const id = seedCapsule();
    // A path component longer than any file system allows fails for every user, root included.
    dbPath = join(dir, "x".repeat(300), "capsules.db");
    expect(() => currentCapsuleStampLookup(source(), [id])).toThrow(
      expect.objectContaining({ code: "ENAMETOOLONG" }),
    );
    expect(opens).toBe(0);
  });

  it("flips a stamp after the store file changed", () => {
    const id = seedCapsule();
    const before = currentCapsuleStampLookup(source(), [id]).lookup(id);
    const base = before ?? 0;
    Object.defineProperty(store._internal, "now", { value: (): number => base + 10 });
    local.updateCapsuleState(store, id, "indexing");
    writeFileSync(dbPath, "v2-longer");
    const after = currentCapsuleStampLookup(source(), [id]);
    expect(after.outcome).toBe("reread-token");
    expect(after.lookup(id)).not.toBe(before);
    expect(opens).toBe(2);
  });

  it("reads an additional capsule without trusting a stale one", () => {
    const id = seedCapsule();
    currentCapsuleStampLookup(source(), [id]);
    const next = currentCapsuleStampLookup(source(), [id, B]);
    expect(next.outcome).toBe("reread-missing");
    expect(next.lookup(B)).toBeUndefined();
    expect(opens).toBe(2);
  });

  it("reports a deleted capsule as absent after the file moved", () => {
    const id = seedCapsule();
    expect(currentCapsuleStampLookup(source(), [id]).lookup(id)).toBeDefined();
    store.close();
    store = local.openKnowledgeStore({ dbPath: ":memory:" });
    writeFileSync(dbPath, "v2-longer");
    expect(currentCapsuleStampLookup(source(), [id]).lookup(id)).toBeUndefined();
  });

  it("picks up a write the token cannot show once the memo is old", () => {
    const id = seedCapsule();
    currentCapsuleStampLookup(source(), [id]);
    const stat = { atime: new Date(5_000), mtime: new Date(5_000) };
    utimesSync(dbPath, stat.atime, stat.mtime);
    currentCapsuleStampLookup(source(), [id]);
    const opensBefore = opens;
    // Same size, same timestamp: indistinguishable by token.
    writeFileSync(dbPath, "v3");
    utimesSync(dbPath, stat.atime, stat.mtime);
    clock += CAPSULE_STAMP_MEMO_MAX_AGE_MS;
    const aged = currentCapsuleStampLookup(source(), [id]);
    expect(aged.outcome === "reread-age" || aged.outcome === "reread-token").toBe(true);
    expect(opens).toBe(opensBefore + 1);
  });

  it("does not remember a read that overlapped a write", () => {
    const id = seedCapsule();
    const racing: CapsuleStampSource = {
      ...source(),
      open: (): ReturnType<CapsuleStampSource["open"]> => {
        opens += 1;
        writeFileSync(dbPath, "written-during-the-read");
        return { store, close: (): void => undefined };
      },
    };
    currentCapsuleStampLookup(racing, [id]);
    expect(currentCapsuleStampLookup(source(), [id]).outcome).toBe("reread-missing");
    expect(opens).toBe(2);
  });
});
