// Direct unit tests for manual-source-metadata.ts (Epic #1854 citation-reopen scope boundary).
//
// The existing coverage of this module was entirely incidental — through manual-pod.test.ts,
// docs-browser.test.ts, and local-knowledge-grounded-qa.rescue.test.ts — and only ever exercised
// well-formed fixtures produced by the real crawler. This file exercises
// resolveHtmlManualCitationTarget / httpTarget / localTarget / isWithinApprovedHttpPath directly,
// including adversarial `relativePath` shapes (absolute / protocol-relative URLs) that a future
// or alternate caller could hand to these functions even though the current production crawler
// never produces them.
//
// Fixtures bypass the crawler entirely: a capsule + folder-scope source + a raw `documents` row
// are seeded directly, and `persistHtmlManualSourceMetadata` is called to attach the html-manual
// scope. This lets each test pick the exact `document_path` / origin / pathPrefix combination
// under test without depending on crawl/parse/chunk machinery.

import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DocumentId,
  HtmlManualSource,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/documentation-manual-proposal";

import { createCapsule } from "./capsule-lifecycle.js";
import { computeManualRefreshChangeSummary } from "./manual-refresh-change-summary.js";
import { insertDocumentRow } from "./discovery/persist.js";
import {
  persistHtmlManualSourceMetadata,
  readHtmlManualSourceMetadata,
  resolveHtmlManualCitationTarget,
  updateHtmlManualRefreshState,
  type ResolveHtmlManualCitationTargetInput,
} from "./manual-source-metadata.js";
import { addSourceToCapsule, updateSourceScopeInCapsule } from "./source-lifecycle.js";
import { freshStore, sampleCapsuleInput, DEFAULT_EMBEDDING } from "./_support.js";
import type { KnowledgeStore } from "./store.js";

const CAPSULE_ID = "cap-manual-meta-1" as KnowledgeCapsuleId;
const SOURCE_ID = "src-manual-meta-1" as KnowledgeSourceId;

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

function httpManualSource(overrides: Partial<HtmlManualSource> = {}): HtmlManualSource {
  return {
    schemaVersion: "1",
    scope: { kind: "html-manual-http", origin: "https://docs.internal", pathPrefix: null },
    limits: DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
    sourceFingerprint: "fp-docs-internal",
    proposedPodName: "Handbook",
    ...overrides,
  };
}

function localManualSource(overrides: Partial<HtmlManualSource> = {}): HtmlManualSource {
  return {
    schemaVersion: "1",
    scope: { kind: "html-manual-local", rootPath: "/srv/manuals-root" },
    limits: DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
    sourceFingerprint: "fp-local-manual",
    proposedPodName: "Local Handbook",
    ...overrides,
  };
}

function producerSummaryJson(): string {
  return JSON.stringify(
    computeManualRefreshChangeSummary({
      priorFingerprints: new Map(),
      newPages: [],
      crawl: {
        status: "empty",
        pages: [],
        denied: [],
        stats: { discovered: 0, fetched: 0, accepted: 0, deniedCount: 0, bytesFetched: 0 },
      },
      indexing: undefined,
      sourceKind: "html-manual-http",
      applied: false,
      refreshedAt: 4242,
    }),
  );
}

// Seeds a `documents` row whose `document_path` is `${rootPath}/${relativeSuffix}` so
// `documentRelativePath` strips the folder-scope root prefix and yields `relativeSuffix`
// unmodified as `relativePath` — the exact hand-off point `targetForMetadata` receives.
function seedDocument(
  store: KnowledgeStore,
  documentId: string,
  relativeSuffix: string,
  safeDisplayName = "page.html",
): DocumentId {
  const id = documentId as DocumentId;
  insertDocumentRow(store._internal.db, {
    id,
    capsuleId: CAPSULE_ID,
    sourceId: SOURCE_ID,
    documentPath: `/srv/manuals/${relativeSuffix}`,
    sizeBytes: 128,
    mediaType: "text/html",
    contentHash: `hash-${documentId}`,
    parserId: "html",
    parserVersion: "1.0.0",
    lastExtractedAt: 1000,
    status: "extracted",
    safeDisplayName,
  });
  return id;
}

function resolveInput(
  documentId: DocumentId,
  anchorId?: string,
): ResolveHtmlManualCitationTargetInput {
  return {
    capsuleId: CAPSULE_ID,
    sourceId: SOURCE_ID,
    documentId,
    ...(anchorId !== undefined ? { anchorId } : {}),
  };
}

describe("manual-source-metadata", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  describe("physical manual persistence boundary", () => {
    it.each(["schema", "redirect", "empty-prefix", "mixed-kind", "mixed-fields"])(
      "rejects selected invalid source facts before INSERT (%s)",
      (kind) => {
        persistHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID, localManualSource());
        const before = readHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID);
        const source = httpManualSource({
          limits: { ...DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS },
        });
        if (kind === "schema") Reflect.set(source, "schemaVersion", "2");
        if (kind === "redirect") Reflect.set(source.limits, "followRedirects", true);
        if (kind === "empty-prefix") Reflect.set(source.scope, "pathPrefix", "");
        if (kind === "mixed-kind") {
          let reads = 0;
          Object.defineProperty(source.scope, "kind", {
            get: () => (++reads === 1 ? "html-manual-local" : "html-manual-http"),
          });
        }
        if (kind === "mixed-fields") {
          Reflect.set(source.scope, "rootPath", "/srv/manuals");
          Reflect.set(source.scope, "entryPath", "guide.html");
          let reads = 0;
          Object.defineProperty(source.scope, "kind", {
            get: () => {
              reads += 1;
              return reads === 2 || reads === 3 ? "html-manual-local" : "html-manual-http";
            },
          });
        }
        expect(() => {
          persistHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID, source);
        }).toThrow(
          expect.objectContaining({
            name: "TypeError",
            code: "HTML_MANUAL_SOURCE_INVALID",
            message: "manual-metadata-validation-failed",
          }),
        );
        expect(readHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID)).toStrictEqual(
          before,
        );
      },
    );

    it.each(["invalid-json", "incomplete", "unknown", "duplicate", "noncanonical", "primitive"])(
      "rejects invalid captured summary bytes before UPDATE (%s)",
      (kind) => {
        persistHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID, localManualSource());
        const before = readHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID);
        const healthy = producerSummaryJson();
        let bytes = healthy;
        if (kind === "invalid-json") bytes = "{";
        if (kind === "incomplete") bytes = '{"outcome":"updated"}';
        if (kind === "unknown") bytes = `{"privateField":"body-marker",${healthy.slice(1)}`;
        if (kind === "duplicate") bytes = `{"outcome":"body-marker",${healthy.slice(1)}`;
        if (kind === "noncanonical") bytes = " " + healthy;
        if (kind === "primitive") bytes = "null";
        expect(() => {
          updateHtmlManualRefreshState(fixture.store, CAPSULE_ID, SOURCE_ID, {
            lastRefreshedAt: 4242,
            lastCrawlRunId: "run-xyz",
            changeSummaryJson: bytes,
          });
        }).toThrow(TypeError);
        expect(readHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID)).toStrictEqual(
          before,
        );
      },
    );
  });

  describe("captured writer facts", () => {
    it("binds the checked selected source facts once and preserves ordinary read order", () => {
      const events: string[] = [];
      let fingerprintReads = 0;
      const source: HtmlManualSource = {
        get scope() {
          events.push("scope");
          return scope;
        },
        get limits() {
          events.push("limits");
          return limits;
        },
        get sourceFingerprint() {
          events.push("fingerprint");
          return ++fingerprintReads === 1 ? "fp-captured" : "";
        },
        get schemaVersion(): "1" {
          events.push("schema");
          return "1";
        },
        get proposedPodName() {
          events.push("name");
          return "Captured manual";
        },
      };
      const scope: HtmlManualSource["scope"] = {
        get kind(): "html-manual-http" {
          events.push("kind");
          return "html-manual-http";
        },
        get origin() {
          events.push("origin");
          return "https://docs.internal";
        },
        get pathPrefix() {
          events.push("prefix");
          return null;
        },
      };
      const bounds = DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS;
      const limits = {
        get maxPages(): number {
          events.push("pages");
          return bounds.maxPages;
        },
        get maxDepth(): number {
          events.push("depth");
          return bounds.maxDepth;
        },
        get maxBytes(): number {
          events.push("bytes");
          return bounds.maxBytes;
        },
        get maxLinkSample(): number {
          events.push("sample");
          return bounds.maxLinkSample;
        },
        get timeoutMs(): number {
          events.push("timeout");
          return bounds.timeoutMs;
        },
        get followRedirects(): false {
          events.push("redirects");
          return false;
        },
      };
      const db = fixture.store._internal.db;
      const prepare = db.prepare.bind(db);
      const prepared = vi.spyOn(db, "prepare").mockImplementation((sql) => {
        events.push("prepare");
        return prepare(sql);
      });
      const clock = vi.spyOn(fixture.store._internal, "now").mockImplementation(() => {
        events.push("clock");
        return 4000;
      });
      try {
        persistHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID, source);
      } finally {
        prepared.mockRestore();
        clock.mockRestore();
      }
      expect(events).toStrictEqual([
        "scope",
        "limits",
        "prepare",
        "kind",
        "fingerprint",
        "kind",
        "kind",
        "kind",
        "origin",
        "kind",
        "prefix",
        "clock",
        "pages",
        "depth",
        "bytes",
        "sample",
        "timeout",
        "schema",
        "name",
        "redirects",
      ]);
      expect(fingerprintReads).toBe(1);
      expect(
        readHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID)?.sourceFingerprint,
      ).toBe("fp-captured");
    });

    it("binds healthy captured summary bytes without rereading the original state", () => {
      persistHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID, localManualSource());
      const bytes = producerSummaryJson();
      let reads = 0;
      updateHtmlManualRefreshState(fixture.store, CAPSULE_ID, SOURCE_ID, {
        lastRefreshedAt: 4242,
        lastCrawlRunId: "captured-run",
        get changeSummaryJson() {
          return ++reads === 1 ? bytes : "body-marker";
        },
      });
      expect(reads).toBe(1);
      expect(readHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID)).toMatchObject({
        lastRefreshedAt: 4242,
        lastCrawlRunId: "captured-run",
        lastChangeSummaryJson: bytes,
      });
    });

    it.each([undefined, "guide.html"])(
      "preserves local absolute root and optional entry %s",
      (entryPath) => {
        persistHtmlManualSourceMetadata(
          fixture.store,
          CAPSULE_ID,
          SOURCE_ID,
          localManualSource({
            scope: { kind: "html-manual-local", rootPath: "/srv/manuals-root", entryPath },
          }),
        );
        const metadata = readHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID);
        expect(metadata?.rootPath).toBe("/srv/manuals-root");
        expect(metadata?.entryPath).toBe(entryPath);
      },
    );
  });

  describe("persistHtmlManualSourceMetadata / readHtmlManualSourceMetadata", () => {
    it("round-trips an http manual scope with a non-default port and a path prefix", () => {
      persistHtmlManualSourceMetadata(
        fixture.store,
        CAPSULE_ID,
        SOURCE_ID,
        httpManualSource({
          scope: {
            kind: "html-manual-http",
            origin: "https://manual.internal:8443",
            pathPrefix: "/docs",
          },
        }),
      );

      expect(readHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID)).toStrictEqual({
        capsuleId: CAPSULE_ID,
        sourceId: SOURCE_ID,
        sourceKind: "html-manual-http",
        sourceFingerprint: "fp-docs-internal",
        origin: "https://manual.internal:8443",
        pathPrefix: "/docs",
        limits: DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
        sourceScopeVersion: 1,
      });
    });

    it("persists and reads back the approved crawl limits so a refresh reproduces the exact scope", () => {
      const narrowedLimits = {
        maxPages: 12,
        maxDepth: 2,
        maxBytes: 5_000_000,
        maxLinkSample: 16,
        timeoutMs: 8_000,
        followRedirects: false as const,
      };
      persistHtmlManualSourceMetadata(
        fixture.store,
        CAPSULE_ID,
        SOURCE_ID,
        localManualSource({ limits: narrowedLimits }),
      );

      const metadata = readHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID);
      expect(metadata?.limits).toStrictEqual(narrowedLimits);
      expect(metadata?.sourceScopeVersion).toBe(1);
      expect(metadata?.lastRefreshedAt).toBeUndefined();
      expect(metadata?.lastCrawlRunId).toBeUndefined();
    });

    it("records refresh bookkeeping without mutating the approved scope, fingerprint, or limits", () => {
      persistHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID, localManualSource());

      updateHtmlManualRefreshState(fixture.store, CAPSULE_ID, SOURCE_ID, {
        lastRefreshedAt: 4242,
        lastCrawlRunId: "run-xyz",
        changeSummaryJson: producerSummaryJson(),
      });

      const metadata = readHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID);
      expect(metadata?.lastRefreshedAt).toBe(4242);
      expect(metadata?.lastCrawlRunId).toBe("run-xyz");
      expect(metadata?.lastChangeSummaryJson).toBe(producerSummaryJson());
      // Scope preservation: the approved fingerprint, kind, and limits are untouched by a refresh.
      expect(metadata?.sourceFingerprint).toBe("fp-local-manual");
      expect(metadata?.sourceKind).toBe("html-manual-local");
      expect(metadata?.limits).toStrictEqual(DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS);
      expect(metadata?.sourceScopeVersion).toBe(1);
    });

    it("omits rootPath/entryPath/origin/pathPrefix from the read result when unset for the persisted kind", () => {
      persistHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID, httpManualSource());

      const metadata = readHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID);

      expect(metadata?.rootPath).toBeUndefined();
      expect(metadata?.entryPath).toBeUndefined();
      expect(metadata?.pathPrefix).toBeUndefined();
    });

    it("returns undefined when no metadata row exists for the tuple", () => {
      expect(
        readHtmlManualSourceMetadata(
          fixture.store,
          CAPSULE_ID,
          "no-such-source" as KnowledgeSourceId,
        ),
      ).toBeUndefined();
    });
  });

  describe("resolveHtmlManualCitationTarget", () => {
    it("fails with source-metadata-unavailable when no html-manual metadata was ever persisted", () => {
      const documentId = seedDocument(fixture.store, "doc-no-meta", "guide.html");

      const result = resolveHtmlManualCitationTarget(fixture.store, resolveInput(documentId));

      expect(result).toStrictEqual({
        ok: false,
        reason: "source-metadata-unavailable",
      });
    });

    it("fails with citation-lineage-mismatch when the documentId does not exist for the tuple", () => {
      persistHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID, httpManualSource());

      const result = resolveHtmlManualCitationTarget(
        fixture.store,
        resolveInput("no-such-document" as DocumentId),
      );

      expect(result).toStrictEqual({ ok: false, reason: "citation-lineage-mismatch" });
    });

    it("resolves a well-formed in-scope relative path to the expected http target (happy path)", () => {
      persistHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID, httpManualSource());
      const documentId = seedDocument(fixture.store, "doc-happy", "guide.html", "guide.html");

      const result = resolveHtmlManualCitationTarget(fixture.store, resolveInput(documentId));

      expect(result).toStrictEqual({
        ok: true,
        target: "https://docs.internal/guide.html",
        sourceKind: "html-manual-http",
        pageTitle: "guide.html",
        safePageId: String(documentId),
        relativePath: "guide.html",
      });
    });

    it("appends the anchorId as a URL fragment when provided", () => {
      persistHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID, httpManualSource());
      const documentId = seedDocument(fixture.store, "doc-anchor", "guide.html");

      const result = resolveHtmlManualCitationTarget(
        fixture.store,
        resolveInput(documentId, "steps"),
      );

      expect(result.ok).toBe(true);
      expect(result.ok ? result.target : undefined).toBe("https://docs.internal/guide.html#steps");
    });

    it("resolves against an origin with a non-default port", () => {
      persistHtmlManualSourceMetadata(
        fixture.store,
        CAPSULE_ID,
        SOURCE_ID,
        httpManualSource({
          scope: {
            kind: "html-manual-http",
            origin: "https://manual.internal:8443",
            pathPrefix: null,
          },
        }),
      );
      const documentId = seedDocument(fixture.store, "doc-port", "guide.html");

      const result = resolveHtmlManualCitationTarget(fixture.store, resolveInput(documentId));

      expect(result).toStrictEqual({
        ok: true,
        target: "https://manual.internal:8443/guide.html",
        sourceKind: "html-manual-http",
        pageTitle: "page.html",
        safePageId: String(documentId),
        relativePath: "guide.html",
      });
    });

    describe("pathPrefix join/strip variants", () => {
      it.each([
        { label: "empty string", pathPrefix: "" },
        { label: "root slash", pathPrefix: "/" },
        { label: "trailing slash", pathPrefix: "/docs/" },
        { label: "multiple trailing slashes", pathPrefix: "/docs///" },
        { label: "no trailing slash", pathPrefix: "/docs" },
      ])("accepts an in-scope path under pathPrefix ($label)", ({ pathPrefix }) => {
        const relativeSuffix =
          pathPrefix.replace(/^\/+|\/+$/gu, "").length > 0 ? "docs/guide.html" : "guide.html";
        persistHtmlManualSourceMetadata(
          fixture.store,
          CAPSULE_ID,
          SOURCE_ID,
          httpManualSource({
            scope: {
              kind: "html-manual-http",
              origin: "https://docs.internal",
              pathPrefix: pathPrefix === "" ? null : pathPrefix,
            },
          }),
        );
        if (pathPrefix === "")
          fixture.store._internal.db
            .prepare(
              "UPDATE html_manual_sources SET path_prefix = '' WHERE capsule_id = ? AND source_id = ?",
            )
            .run(CAPSULE_ID, SOURCE_ID);
        const documentId = seedDocument(fixture.store, `doc-prefix-${pathPrefix}`, relativeSuffix);

        const result = resolveHtmlManualCitationTarget(fixture.store, resolveInput(documentId));

        expect(result.ok).toBe(true);
      });

      it("rejects a path that is only a sibling-prefix match, not a true path-segment match", () => {
        // pathPrefix "/docs" must not match "/docsish/guide.html" — string startsWith without a
        // segment boundary would incorrectly allow this.
        persistHtmlManualSourceMetadata(
          fixture.store,
          CAPSULE_ID,
          SOURCE_ID,
          httpManualSource({
            scope: {
              kind: "html-manual-http",
              origin: "https://docs.internal",
              pathPrefix: "/docs",
            },
          }),
        );
        const documentId = seedDocument(fixture.store, "doc-sibling-prefix", "docsish/guide.html");

        const result = resolveHtmlManualCitationTarget(fixture.store, resolveInput(documentId));

        expect(result).toStrictEqual({ ok: false, reason: "target-outside-approved-scope" });
      });
    });

    it("fails with target-unsupported for an html-manual-local source with no persisted rootPath", () => {
      persistHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID, localManualSource());
      fixture.store._internal.db
        .prepare(
          "UPDATE html_manual_sources SET root_path = '' WHERE capsule_id = ? AND source_id = ?",
        )
        .run(CAPSULE_ID, SOURCE_ID);
      const documentId = seedDocument(fixture.store, "doc-local-no-root", "guide.html");

      const result = resolveHtmlManualCitationTarget(fixture.store, resolveInput(documentId));

      expect(result).toStrictEqual({ ok: false, reason: "target-unsupported" });
    });

    it("resolves a well-formed local manual target to a file:// URL", () => {
      persistHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID, localManualSource());
      const documentId = seedDocument(fixture.store, "doc-local-happy", "guide.html");

      const result = resolveHtmlManualCitationTarget(fixture.store, resolveInput(documentId));

      expect(result).toStrictEqual({
        ok: true,
        target: "file:///srv/manuals-root/guide.html",
        sourceKind: "html-manual-local",
        pageTitle: "page.html",
        safePageId: String(documentId),
        relativePath: "guide.html",
      });
    });

    // ── Adversarial relativePath shapes ────────────────────────────────────────────
    //
    // The production crawler's own upstream gate (relativePathForSource / isSafeStorageReference,
    // both in this file) never produces a relativePath shaped like an absolute or
    // protocol-relative URL for a stored document_path. These tests seed a document_path
    // directly (bypassing that upstream gate) to exercise resolveHtmlManualCitationTarget's own
    // defense in depth at the trust boundary, per AGENTS.md section 7 ("fail closed on trust
    // boundaries" — do not rely solely on an upstream caller sanitizing first).

    it("rejects a relativePath shaped like an absolute cross-origin URL, even with a permissive pathPrefix", () => {
      persistHtmlManualSourceMetadata(
        fixture.store,
        CAPSULE_ID,
        SOURCE_ID,
        httpManualSource({
          scope: { kind: "html-manual-http", origin: "https://docs.internal", pathPrefix: null },
        }),
      );
      // document_path ends with an absolute-URL-shaped suffix; isSafeStorageReference does not
      // reject this shape (no leading "/", "\\", "~", and no ".." traversal segment).
      const documentId = seedDocument(fixture.store, "doc-absolute-url", "https://evil.example/x");

      const result = resolveHtmlManualCitationTarget(fixture.store, resolveInput(documentId));

      expect(result).toStrictEqual({ ok: false, reason: "target-outside-approved-scope" });
    });

    it("rejects a relativePath shaped like a protocol-relative URL, even with a permissive pathPrefix", () => {
      persistHtmlManualSourceMetadata(
        fixture.store,
        CAPSULE_ID,
        SOURCE_ID,
        httpManualSource({
          scope: { kind: "html-manual-http", origin: "https://docs.internal", pathPrefix: "/" },
        }),
      );
      const documentId = seedDocument(fixture.store, "doc-protocol-relative", "//evil.example/x");

      const result = resolveHtmlManualCitationTarget(fixture.store, resolveInput(documentId));

      expect(result).toStrictEqual({ ok: false, reason: "target-outside-approved-scope" });
    });

    it("rejects an absolute cross-origin relativePath whose pathname trivially satisfies an empty pathPrefix", () => {
      persistHtmlManualSourceMetadata(
        fixture.store,
        CAPSULE_ID,
        SOURCE_ID,
        httpManualSource({
          scope: { kind: "html-manual-http", origin: "https://docs.internal", pathPrefix: null },
        }),
      );
      fixture.store._internal.db
        .prepare(
          "UPDATE html_manual_sources SET path_prefix = '' WHERE capsule_id = ? AND source_id = ?",
        )
        .run(CAPSULE_ID, SOURCE_ID);
      const documentId = seedDocument(
        fixture.store,
        "doc-empty-prefix-bypass",
        "https://evil.example/x",
      );

      const result = resolveHtmlManualCitationTarget(fixture.store, resolveInput(documentId));

      expect(result).toStrictEqual({ ok: false, reason: "target-outside-approved-scope" });
    });

    it("still resolves a same-origin absolute-shaped relativePath (no foreign origin, no bypass)", () => {
      // Guard against over-hardening: a relativePath that resolves back to the SAME approved
      // origin must still succeed. This proves the origin check is additive, not a blanket
      // rejection of every URL-shaped relativePath.
      persistHtmlManualSourceMetadata(
        fixture.store,
        CAPSULE_ID,
        SOURCE_ID,
        httpManualSource({
          scope: { kind: "html-manual-http", origin: "https://docs.internal", pathPrefix: null },
        }),
      );
      const documentId = seedDocument(
        fixture.store,
        "doc-same-origin-absolute",
        "https://docs.internal/guide.html",
      );

      const result = resolveHtmlManualCitationTarget(fixture.store, resolveInput(documentId));

      expect(result).toStrictEqual({
        ok: true,
        target: "https://docs.internal/guide.html",
        sourceKind: "html-manual-http",
        pageTitle: "page.html",
        safePageId: String(documentId),
        relativePath: "https://docs.internal/guide.html",
      });
    });
  });

  // ── Regression coverage for Sonar S8786 (super-linear regex backtracking) ─────────────
  //
  // `relativePathForSource`, `isWithinApprovedHttpPath`, and `localTarget` used to strip a
  // trailing run of "/" with `value.replace(/\/+$/u, "")`. That pattern is unanchored at the
  // start, so on a string that does NOT end in "/" the engine retries the match at every
  // position inside any long interior run of "/" before giving up — O(n^2) on the run length.
  // All three now use a linear backward scan (`stripTrailingSlashes`) instead. Each test below
  // feeds a value shaped like the pathological case (a long run of "/" that is NOT at the very
  // end of the string) through the real public entry point and asserts both a tight wall-clock
  // budget and the exact same result the old regex would have produced (unchanged, since it
  // does not end in "/").
  //
  // ADVERSARIAL_SLASH_RUN / BUDGET_MS are picked to actually discriminate fixed-vs-vulnerable
  // code, not merely to "look adversarial": measured directly against the pre-fix
  // `value.replace(/\/+$/u, "")` on this exact end-to-end path (readHtmlManualSourceMetadata +
  // SQLite round trip), a 60,000-character run takes ~1.4s (fails a 500ms budget with a ~2.8x
  // margin) while the O(n) `stripTrailingSlashes` fix takes ~15-20ms (passes with a >25x margin)
  // — both comfortably clear of Vitest's 5s default per-test timeout. A smaller run (e.g. the
  // previous 20,000 / 300ms) sits on the wrong side of the old regex's O(n^2) curve for this
  // code path (~175ms, under budget) and silently passes on the vulnerable code, defeating the
  // point of a regression test. Do not shrink these below a size that has been re-verified to
  // fail against a reverted `.replace(/\/+$/u, "")` implementation.
  describe("regex-safety (S8786): unbounded trailing-slash stripping", () => {
    const ADVERSARIAL_SLASH_RUN = "/".repeat(60_000);
    const BUDGET_MS = 500;

    it("computes a folder-scope relativePath quickly when the source rootPath has a long non-trailing slash run", () => {
      const rootPath = `/srv/manuals-adversarial${ADVERSARIAL_SLASH_RUN}root`;
      updateSourceScopeInCapsule(fixture.store, CAPSULE_ID, SOURCE_ID, {
        kind: "folder",
        rootPath,
        recursive: true,
      });
      persistHtmlManualSourceMetadata(fixture.store, CAPSULE_ID, SOURCE_ID, httpManualSource());
      const documentId = "doc-folder-adversarial-root" as DocumentId;
      insertDocumentRow(fixture.store._internal.db, {
        id: documentId,
        capsuleId: CAPSULE_ID,
        sourceId: SOURCE_ID,
        documentPath: `${rootPath}/guide.html`,
        sizeBytes: 128,
        mediaType: "text/html",
        contentHash: "hash-folder-adversarial-root",
        parserId: "html",
        parserVersion: "1.0.0",
        lastExtractedAt: 1000,
        status: "extracted",
        safeDisplayName: "guide.html",
      });

      const startedAt = Date.now();
      const result = resolveHtmlManualCitationTarget(fixture.store, resolveInput(documentId));
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(BUDGET_MS);
      expect(result).toStrictEqual({
        ok: true,
        target: "https://docs.internal/guide.html",
        sourceKind: "html-manual-http",
        pageTitle: "guide.html",
        safePageId: String(documentId),
        relativePath: "guide.html",
      });
    });

    it("resolves an http target quickly when pathPrefix has a long non-trailing slash run", () => {
      const pathPrefix = `/docs${ADVERSARIAL_SLASH_RUN}tail`;
      persistHtmlManualSourceMetadata(
        fixture.store,
        CAPSULE_ID,
        SOURCE_ID,
        httpManualSource({
          scope: { kind: "html-manual-http", origin: "https://docs.internal", pathPrefix },
        }),
      );
      const documentId = seedDocument(fixture.store, "doc-http-adversarial-prefix", "guide.html");

      const startedAt = Date.now();
      const result = resolveHtmlManualCitationTarget(fixture.store, resolveInput(documentId));
      const elapsedMs = Date.now() - startedAt;

      // The huge pathPrefix can never be a real prefix of the short resolved pathname, so this
      // must fail closed — the point of the assertion is that it fails closed FAST, not that it
      // hangs (or, under the old regex, times out the test runner).
      expect(elapsedMs).toBeLessThan(BUDGET_MS);
      expect(result).toStrictEqual({ ok: false, reason: "target-outside-approved-scope" });
    });

    it("resolves a local file:// target quickly when rootPath has a long non-trailing slash run", () => {
      const rootPath = `/srv/manuals-root${ADVERSARIAL_SLASH_RUN}tail`;
      persistHtmlManualSourceMetadata(
        fixture.store,
        CAPSULE_ID,
        SOURCE_ID,
        localManualSource({ scope: { kind: "html-manual-local", rootPath } }),
      );
      const documentId = seedDocument(fixture.store, "doc-local-adversarial-root", "guide.html");

      const startedAt = Date.now();
      const result = resolveHtmlManualCitationTarget(fixture.store, resolveInput(documentId));
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(BUDGET_MS);
      expect(result).toStrictEqual({
        ok: true,
        target: pathToFileURL(`${rootPath}/guide.html`).href,
        sourceKind: "html-manual-local",
        pageTitle: "page.html",
        safePageId: String(documentId),
        relativePath: "guide.html",
      });
    });
  });
});
