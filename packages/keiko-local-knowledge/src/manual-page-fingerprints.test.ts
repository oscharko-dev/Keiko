// Unit tests for manual-page-fingerprints.ts (Epic #1856, Issue #1890).
//
// A capsule + folder-scope source are seeded directly (the FK chain requires them); fingerprints
// are written and read back without invoking the crawler, so each test controls the exact page set.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { KnowledgeCapsuleId, KnowledgeSourceId } from "@oscharko-dev/keiko-contracts";

import { createCapsule } from "./capsule-lifecycle.js";
import {
  computeManualCrawlRunFingerprint,
  computeManualPageFingerprint,
  readManualPageFingerprints,
  replaceManualPageFingerprints,
  type ManualPageFingerprint,
} from "./manual-page-fingerprints.js";
import { addSourceToCapsule } from "./source-lifecycle.js";
import { freshStore, sampleCapsuleInput, DEFAULT_EMBEDDING } from "./_support.js";
import type { KnowledgeStore } from "./store.js";

const CAPSULE_ID = "cap-fp-1" as KnowledgeCapsuleId;
const SOURCE_ID = "src-fp-1" as KnowledgeSourceId;

interface Fixture {
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
}

function buildFixture(): Fixture {
  const { store, cleanup } = freshStore();
  createCapsule(
    store,
    sampleCapsuleInput({ id: CAPSULE_ID, embeddingModelIdentity: DEFAULT_EMBEDDING }),
  );
  addSourceToCapsule(store, CAPSULE_ID, {
    id: SOURCE_ID,
    displayName: "Manual Source",
    tags: [],
    scope: { kind: "folder", rootPath: "/srv/manuals", recursive: true },
  });
  return { store, cleanup };
}

function fp(relativePath: string, bytes: Uint8Array): ManualPageFingerprint {
  return {
    relativePath,
    contentFingerprint: computeManualPageFingerprint(bytes),
    byteLength: bytes.byteLength,
  };
}

describe("computeManualPageFingerprint", () => {
  it("is deterministic for identical bytes and prefixed sha256:base64url", () => {
    const bytes = new TextEncoder().encode("<html>manual</html>");
    const a = computeManualPageFingerprint(bytes);
    const b = computeManualPageFingerprint(new TextEncoder().encode("<html>manual</html>"));
    expect(a).toBe(b);
    expect(a.startsWith("sha256:")).toBe(true);
  });

  it("differs when a single byte changes", () => {
    const first = computeManualPageFingerprint(new TextEncoder().encode("page-a"));
    const second = computeManualPageFingerprint(new TextEncoder().encode("page-b"));
    expect(first).not.toBe(second);
  });

  it("is redaction-safe: no path, URL, whitespace, or credential markers", () => {
    const digest = computeManualPageFingerprint(new TextEncoder().encode("/Users/secret/x"));
    expect(digest).not.toMatch(/[\s/\\?#@]/u);
  });
});

describe("computeManualCrawlRunFingerprint", () => {
  it("is deterministic and order-independent for the same page set", () => {
    const guide = fp("guide.html", new TextEncoder().encode("guide"));
    const reference = fp("reference.html", new TextEncoder().encode("reference"));
    const a = computeManualCrawlRunFingerprint([guide, reference]);
    const b = computeManualCrawlRunFingerprint([reference, guide]);
    expect(a).toBe(b);
    expect(a.startsWith("sha256:")).toBe(true);
  });

  it("differs when a page's content changes", () => {
    const before = [fp("guide.html", new TextEncoder().encode("guide v1"))];
    const after = [fp("guide.html", new TextEncoder().encode("guide v2"))];
    expect(computeManualCrawlRunFingerprint(before)).not.toBe(
      computeManualCrawlRunFingerprint(after),
    );
  });

  it("differs when the page set changes shape (added/removed page)", () => {
    const guide = fp("guide.html", new TextEncoder().encode("guide"));
    const reference = fp("reference.html", new TextEncoder().encode("reference"));
    expect(computeManualCrawlRunFingerprint([guide])).not.toBe(
      computeManualCrawlRunFingerprint([guide, reference]),
    );
  });
});

describe("readManualPageFingerprints / replaceManualPageFingerprints", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("returns an empty map before any crawl run has persisted fingerprints", () => {
    expect(readManualPageFingerprints(fixture.store, CAPSULE_ID, SOURCE_ID).size).toBe(0);
  });

  it("round-trips a crawl run's page set keyed by relative path", () => {
    const pages = [
      fp("index.html", new TextEncoder().encode("home")),
      fp("guide.html", new TextEncoder().encode("guide")),
    ];
    replaceManualPageFingerprints(fixture.store, CAPSULE_ID, SOURCE_ID, pages, "run-1");

    const read = readManualPageFingerprints(fixture.store, CAPSULE_ID, SOURCE_ID);
    expect(read.size).toBe(2);
    expect(read.get("index.html")).toStrictEqual(pages[0]);
    expect(read.get("guide.html")).toStrictEqual(pages[1]);
  });

  it("replaces the whole set so removed pages drop out and changed pages update", () => {
    replaceManualPageFingerprints(
      fixture.store,
      CAPSULE_ID,
      SOURCE_ID,
      [
        fp("index.html", new TextEncoder().encode("home")),
        fp("old.html", new TextEncoder().encode("legacy")),
      ],
      "run-1",
    );

    // Second crawl: index.html changed, old.html removed, new.html added.
    const secondRun = [
      fp("index.html", new TextEncoder().encode("home-v2")),
      fp("new.html", new TextEncoder().encode("fresh")),
    ];
    replaceManualPageFingerprints(fixture.store, CAPSULE_ID, SOURCE_ID, secondRun, "run-2");

    const read = readManualPageFingerprints(fixture.store, CAPSULE_ID, SOURCE_ID);
    expect([...read.keys()].sort()).toStrictEqual(["index.html", "new.html"]);
    expect(read.has("old.html")).toBe(false);
    expect(read.get("index.html")?.contentFingerprint).toBe(secondRun[0]?.contentFingerprint);
  });

  it("isolates fingerprints per source tuple", () => {
    const other = "src-fp-2" as KnowledgeSourceId;
    addSourceToCapsule(fixture.store, CAPSULE_ID, {
      id: other,
      displayName: "Other",
      tags: [],
      scope: { kind: "folder", rootPath: "/srv/other", recursive: true },
    });
    replaceManualPageFingerprints(
      fixture.store,
      CAPSULE_ID,
      SOURCE_ID,
      [fp("index.html", new TextEncoder().encode("a"))],
      "run-1",
    );
    expect(readManualPageFingerprints(fixture.store, CAPSULE_ID, other).size).toBe(0);
  });
});
