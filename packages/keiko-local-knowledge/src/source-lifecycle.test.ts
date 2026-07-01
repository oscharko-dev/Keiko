// source-lifecycle.test.ts — coverage for capsule-scoped source CRUD plus cascade.

import type { KnowledgeCapsuleId, KnowledgeSourceId } from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCapsule } from "./capsule-lifecycle.js";
import { KnowledgeNotFoundError, KnowledgeStoreError } from "./errors.js";
import {
  addSourceToCapsule,
  listCapsuleSources,
  removeSourceFromCapsule,
  updateSourceScopeInCapsule,
} from "./source-lifecycle.js";
import { createSqliteAuditSink } from "./privacy/audit-emitter.js";
import { freshStore, sampleCapsuleInput, sampleSourceInput } from "./_support.js";
import type { KnowledgeStore } from "./store.js";

interface CountRow {
  readonly n: number;
}

let store: KnowledgeStore;
let cleanup: () => void;
let capsuleId: KnowledgeCapsuleId;

beforeEach(() => {
  const fresh = freshStore();
  store = fresh.store;
  cleanup = fresh.cleanup;
  const cap = createCapsule(store, sampleCapsuleInput());
  capsuleId = cap.id;
});

afterEach(() => {
  cleanup();
});

describe("addSourceToCapsule + listCapsuleSources", () => {
  it("round-trips a folder source", () => {
    const source = addSourceToCapsule(store, capsuleId, sampleSourceInput("src-1"));
    expect(source.id).toBe("src-1");
    expect(source.scope.kind).toBe("folder");
    const sources = listCapsuleSources(store, capsuleId);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toStrictEqual(source);
    const independent = store._internal.db
      .prepare("SELECT COUNT(*) AS n FROM knowledge_sources WHERE id = 'src-1'")
      .get() as unknown as CountRow;
    expect(independent.n).toBe(1);
  });

  it("returns an empty array when the capsule has no sources", () => {
    expect(listCapsuleSources(store, capsuleId)).toStrictEqual([]);
  });

  it("supports adding multiple sources and exposes them via the parent capsule", () => {
    addSourceToCapsule(store, capsuleId, sampleSourceInput("src-a"));
    addSourceToCapsule(store, capsuleId, sampleSourceInput("src-b"));
    const sources = listCapsuleSources(store, capsuleId);
    expect(sources.map((s) => s.id)).toStrictEqual(["src-a", "src-b"]);
  });

  it("preserves a repository-scope source", () => {
    addSourceToCapsule(store, capsuleId, {
      id: "src-repo" as KnowledgeSourceId,
      displayName: "repo",
      tags: ["t1"],
      scope: { kind: "repository", repositoryRoot: "/srv/repo" },
    });
    const [source] = listCapsuleSources(store, capsuleId);
    expect(source?.scope.kind).toBe("repository");
    if (source?.scope.kind === "repository") {
      expect(source.scope.repositoryRoot).toBe("/srv/repo");
    }
  });

  it("rejects unsafe scope paths before persistence", () => {
    expect(() =>
      addSourceToCapsule(store, capsuleId, {
        id: "src-bad" as KnowledgeSourceId,
        displayName: "bad",
        tags: [],
        scope: { kind: "folder", rootPath: "../escape", recursive: true },
      }),
    ).toThrow(KnowledgeStoreError);
    const row = store._internal.db
      .prepare("SELECT COUNT(*) AS n FROM knowledge_sources WHERE id = 'src-bad'")
      .get() as unknown as CountRow;
    expect(row.n).toBe(0);
  });
});

describe("updateSourceScopeInCapsule", () => {
  it("updates a source scope without changing the source id", () => {
    addSourceToCapsule(store, capsuleId, sampleSourceInput("src-rebind"));
    const updated = updateSourceScopeInCapsule(
      store,
      capsuleId,
      "src-rebind" as KnowledgeSourceId,
      { kind: "folder", rootPath: "/new/root", recursive: true },
    );
    expect(updated.id).toBe("src-rebind");
    expect(updated.scope).toStrictEqual({
      kind: "folder",
      rootPath: "/new/root",
      recursive: true,
    });
    expect(listCapsuleSources(store, capsuleId)[0]?.scope).toStrictEqual(updated.scope);
  });

  it("emits metadata-only source-rebound audit without membership churn", () => {
    addSourceToCapsule(store, capsuleId, sampleSourceInput("src-audit"));
    updateSourceScopeInCapsule(
      store,
      capsuleId,
      "src-audit" as KnowledgeSourceId,
      { kind: "folder", rootPath: "/new/root", recursive: true },
      createSqliteAuditSink(store),
    );
    const audit = store._internal.db
      .prepare(
        "SELECT kind, source_id, details_json FROM capsule_audit_events WHERE kind = 'source-rebound'",
      )
      .get() as unknown as {
      readonly kind: string;
      readonly source_id: string;
      readonly details_json: string;
    };
    const membership = store._internal.db
      .prepare("SELECT COUNT(*) AS n FROM capsule_membership_changes")
      .get() as unknown as CountRow;
    expect(audit.kind).toBe("source-rebound");
    expect(audit.source_id).toBe("src-audit");
    expect(JSON.parse(audit.details_json)).toStrictEqual({
      currentScopeKind: "folder",
      previousScopeKind: "folder",
    });
    expect(membership.n).toBe(0);
  });

  it("raises KnowledgeNotFoundError when the source does not belong to the capsule", () => {
    addSourceToCapsule(store, capsuleId, sampleSourceInput("src-other"));
    expect(() =>
      updateSourceScopeInCapsule(
        store,
        "other" as KnowledgeCapsuleId,
        "src-other" as KnowledgeSourceId,
        { kind: "folder", rootPath: "/new/root", recursive: true },
      ),
    ).toThrow(KnowledgeNotFoundError);
    expect(listCapsuleSources(store, capsuleId)[0]?.scope).toStrictEqual(
      sampleSourceInput("src-other").scope,
    );
  });
});

describe("removeSourceFromCapsule", () => {
  it("removes the row when both ids match", () => {
    addSourceToCapsule(store, capsuleId, sampleSourceInput("src-x"));
    removeSourceFromCapsule(store, capsuleId, "src-x" as KnowledgeSourceId);
    expect(listCapsuleSources(store, capsuleId)).toStrictEqual([]);
    const independent = store._internal.db
      .prepare("SELECT COUNT(*) AS n FROM knowledge_sources WHERE id = 'src-x'")
      .get() as unknown as CountRow;
    expect(independent.n).toBe(1);
  });

  it("raises KnowledgeNotFoundError when the source does not belong to the capsule", () => {
    addSourceToCapsule(store, capsuleId, sampleSourceInput("src-y"));
    expect(() => {
      removeSourceFromCapsule(store, "other" as KnowledgeCapsuleId, "src-y" as KnowledgeSourceId);
    }).toThrow(KnowledgeNotFoundError);
    // Source still present
    expect(listCapsuleSources(store, capsuleId)).toHaveLength(1);
  });

  it("raises KnowledgeNotFoundError on completely unknown source", () => {
    expect(() => {
      removeSourceFromCapsule(store, capsuleId, "ghost" as KnowledgeSourceId);
    }).toThrow(KnowledgeNotFoundError);
  });

  it("cascades to documents that referenced the source", () => {
    addSourceToCapsule(store, capsuleId, sampleSourceInput("src-z"));
    store._internal.db
      .prepare(
        "INSERT INTO documents (id, capsule_id, source_id, document_path, size_bytes, media_type, content_hash, parser_id, parser_version, last_extracted_at, status, safe_display_name) VALUES ('doc-1', :c, 'src-z', '/a.md', 1, 'text/markdown', 'h', 'p', '1', 1, 'ready', 'a.md')",
      )
      .run({ c: capsuleId });
    removeSourceFromCapsule(store, capsuleId, "src-z" as KnowledgeSourceId);
    const row = store._internal.db
      .prepare("SELECT COUNT(*) AS n FROM documents WHERE source_id = 'src-z'")
      .get() as unknown as CountRow;
    expect(row.n).toBe(0);
  });
});
