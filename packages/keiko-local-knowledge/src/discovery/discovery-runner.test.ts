import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  KnowledgeCapsuleId,
  KnowledgeSource,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";

import { addSourceToCapsule } from "../source-lifecycle.js";
import { createCapsule } from "../capsule-lifecycle.js";
import { freshStore, sampleCapsuleInput } from "../_support.js";
import type { KnowledgeStore } from "../store.js";
import { buildParserOptions, createDefaultParserRegistry } from "../parsers/index.js";

import { discoverAndExtract } from "./discovery-runner.js";
import { folderScope, memoryFs } from "./test-support.js";
import type { ExtractionEvent } from "./types.js";

const ROOT = "/srv/docs";

let store: KnowledgeStore;
let cleanup: () => void;
let capsuleId: KnowledgeCapsuleId;
let source: KnowledgeSource;

beforeEach(() => {
  const fresh = freshStore();
  store = fresh.store;
  cleanup = fresh.cleanup;
  const cap = createCapsule(store, sampleCapsuleInput());
  capsuleId = cap.id;
  source = addSourceToCapsule(store, capsuleId, {
    id: "src-1" as KnowledgeSourceId,
    displayName: "docs",
    tags: [],
    scope: folderScope(ROOT),
  });
});

afterEach(() => {
  cleanup();
});

async function collect(iter: AsyncGenerator<ExtractionEvent>): Promise<readonly ExtractionEvent[]> {
  const events: ExtractionEvent[] = [];
  for await (const evt of iter) {
    events.push(evt);
  }
  return events;
}

describe("discoverAndExtract — happy path", () => {
  it("walks every file in scope and emits a terminal completed event", async () => {
    const fs = memoryFs(ROOT, [
      { relativePath: "README.md", content: "# Hello" },
      { relativePath: "src/a.ts", content: "export {};" },
      { relativePath: "src/b.ts", content: "export const b = 1;" },
    ]);
    const registry = createDefaultParserRegistry();
    const events = await collect(
      discoverAndExtract({ fs, store, parserRegistry: registry }, { capsuleId, source }),
    );
    const completed = events.find((e) => e.kind === "completed");
    expect(completed).toBeDefined();
    if (completed?.kind === "completed") {
      expect(completed.totalDiscovered).toBe(3);
      expect(completed.totalExtracted).toBe(3);
      expect(completed.totalSkipped).toBe(0);
      expect(completed.totalFailed).toBe(0);
    }
    expect(events.filter((e) => e.kind === "file-discovered")).toHaveLength(3);
    expect(events.filter((e) => e.kind === "file-extracted")).toHaveLength(3);
  });

  it("classifies an unsupported binary as failed=0/extracted=1 (unsupported is a persisted outcome)", async () => {
    const fs = memoryFs(ROOT, [
      {
        relativePath: "logo.png",
        content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
      },
    ]);
    const registry = createDefaultParserRegistry();
    const events = await collect(
      discoverAndExtract({ fs, store, parserRegistry: registry }, { capsuleId, source }),
    );
    const completed = events.find((e) => e.kind === "completed");
    if (completed?.kind === "completed") {
      expect(completed.totalExtracted).toBe(1);
      expect(completed.totalFailed).toBe(0);
    }
  });
});

describe("discoverAndExtract — re-run idempotence", () => {
  it("classifies the second run entirely as skipped", async () => {
    const fs = memoryFs(ROOT, [{ relativePath: "stable.md", content: "stable" }]);
    const registry = createDefaultParserRegistry();
    const deps = { fs, store, parserRegistry: registry };
    await collect(discoverAndExtract(deps, { capsuleId, source }));
    const events = await collect(discoverAndExtract(deps, { capsuleId, source }));
    const completed = events.find((e) => e.kind === "completed");
    if (completed?.kind === "completed") {
      expect(completed.totalDiscovered).toBe(1);
      expect(completed.totalSkipped).toBe(1);
      expect(completed.totalExtracted).toBe(0);
    }
  });
});

describe("discoverAndExtract — scope errors", () => {
  it("emits scope-error for PATH_ESCAPE entries without aborting the run", async () => {
    const fs = memoryFs(ROOT, [
      { relativePath: "ok.md", content: "ok" },
      {
        relativePath: "shady.txt",
        content: "secret",
        realPathOverride: "/etc/passwd",
      },
    ]);
    const registry = createDefaultParserRegistry();
    const events = await collect(
      discoverAndExtract({ fs, store, parserRegistry: registry }, { capsuleId, source }),
    );
    const scopeErrors = events.filter((e) => e.kind === "scope-error");
    expect(scopeErrors).toHaveLength(1);
    if (scopeErrors[0]?.kind === "scope-error") {
      expect(scopeErrors[0].error.code).toBe("PATH_ESCAPE");
    }
    const completed = events.find((e) => e.kind === "completed");
    if (completed?.kind === "completed") {
      expect(completed.totalDiscovered).toBe(1);
      expect(completed.totalExtracted).toBe(1);
    }
  });
});

describe("discoverAndExtract — cancellation", () => {
  it("emits a terminal cancelled event when the signal fires before iteration", async () => {
    const fs = memoryFs(ROOT, [{ relativePath: "a.md", content: "x" }]);
    const registry = createDefaultParserRegistry();
    const ctrl = new AbortController();
    ctrl.abort();
    const events = await collect(
      discoverAndExtract(
        { fs, store, parserRegistry: registry },
        {
          capsuleId,
          source,
          discovery: { maxDepth: 12, maxFiles: 100, signal: ctrl.signal },
          parserOptions: buildParserOptions({ signal: ctrl.signal }),
        },
      ),
    );
    expect(events.some((e) => e.kind === "cancelled")).toBe(true);
    expect(events.some((e) => e.kind === "completed")).toBe(false);
  });
});
