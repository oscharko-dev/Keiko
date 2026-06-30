import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import {
  createCapsule,
  openKnowledgeStore,
  resolveKnowledgeStorePath,
} from "@oscharko-dev/keiko-local-knowledge";
import { buildRedactor, createInMemoryUiStore } from "../index.js";
import type { RouteContext, UiHandlerDeps } from "../index.js";
import type { UiStore } from "../store/index.js";
import {
  handleEditorContext,
  handleEditorLocalKnowledgeRetrieve,
  handleEditorRepoSearch,
} from "./contextRoutes.js";

function rawPostContext(raw: string, path: string): RouteContext {
  const req = Readable.from([Buffer.from(raw, "utf8")]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  return {
    req,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL(`http://localhost${path}`),
  };
}

function postContext(body: unknown, path = "/api/editor/context"): RouteContext {
  return rawPostContext(JSON.stringify(body), path);
}

let root: string;
let stateRoot: string;
let store: UiStore;

function deps(): UiHandlerDeps {
  return {
    store,
    redactor: buildRedactor({}),
    evidenceStore: createInMemoryEvidenceStore(),
  } as unknown as UiHandlerDeps;
}

function depsWithLocalKnowledge(): UiHandlerDeps {
  return {
    ...deps(),
    uiDbPath: join(stateRoot, "keiko-ui.db"),
  };
}

function capsuleId(value: string): KnowledgeCapsuleId {
  return value as KnowledgeCapsuleId;
}

function seedIndexingCapsule(): KnowledgeCapsuleId {
  const capId = capsuleId("cap-indexing");
  const knowledgeStore = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: stateRoot }),
  });
  try {
    createCapsule(knowledgeStore, {
      id: capId,
      displayName: "Indexing Capsule",
      tags: ["docs"],
      retrievalEffort: "default",
      outputMode: "snippets",
      answerGroundingPolicy: "require-citations",
      embeddingModelIdentity: {
        provider: "openai",
        modelId: "text-embedding-3-small",
        vectorDimensions: 1536,
        vectorMetric: "cosine",
      },
      lifecycleState: "indexing",
      storageReference: "capsules/cap-indexing",
    });
  } finally {
    knowledgeStore.close();
  }
  return capId;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "keiko-cc-route-")));
  stateRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-cc-state-")));
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "src", "a.ts"),
    "export function parseConfig(value: string): string {\n  return value.trim();\n}\n",
    "utf8",
  );
  store = createInMemoryUiStore();
  store.createProject(root, "fixture");
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
  await rm(stateRoot, { recursive: true, force: true });
});

describe("POST /api/editor/context", () => {
  it("returns a content-free pack with provenance and an audit-linkage run id", async () => {
    const d = deps();
    const result = await handleEditorContext(
      postContext({
        schemaVersion: "1",
        purpose: "completion",
        root,
        documentPath: "src/a.ts",
        symbol: "parseConfig",
      }),
      d,
    );
    expect(result.status).toBe(200);
    const body = result.body as {
      pack: { entries: { sourceKind: string; sourceTier: string }[] };
      evidenceRunId: string;
    };
    expect(body.evidenceRunId).toMatch(/^coding-context-/);
    expect(body.pack.entries.length).toBeGreaterThan(0);
    expect(body.pack.entries.some((e) => e.sourceKind === "files-focus")).toBe(true);
    // content-free: no excerpt text reaches the wire
    expect(JSON.stringify(body.pack)).not.toContain("value.trim");
    // audit record persisted
    expect(d.evidenceStore.get(body.evidenceRunId)).toBeDefined();
  });

  it("rejects an invalid request body with 400 INVALID_REQUEST", async () => {
    const result = await handleEditorContext(
      postContext({ schemaVersion: "1", documentPath: "src/a.ts" }),
      deps(),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("denies a document path that escapes the workspace root", async () => {
    const result = await handleEditorContext(
      postContext({
        schemaVersion: "1",
        purpose: "completion",
        root,
        documentPath: "../escape.ts",
      }),
      deps(),
    );
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: "DENIED" } });
  });

  it("rejects ambiguous Local Knowledge selectors", async () => {
    const result = await handleEditorContext(
      postContext({
        schemaVersion: "1",
        purpose: "completion",
        root,
        documentPath: "src/a.ts",
        capsuleId: "cap-1",
        capsuleSetId: "set-1",
      }),
      deps(),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("rejects invalid changed-file path shapes before repo-search", async () => {
    const result = await handleEditorContext(
      postContext({
        schemaVersion: "1",
        purpose: "completion",
        root,
        documentPath: "src/a.ts",
        changedFiles: ["src/../src/a.ts"],
      }),
      deps(),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("rejects changed-file lists above the route cap", async () => {
    const result = await handleEditorContext(
      postContext({
        schemaVersion: "1",
        purpose: "completion",
        root,
        documentPath: "src/a.ts",
        changedFiles: Array.from({ length: 65 }, (_, index) => `src/f${index.toString()}.ts`),
      }),
      deps(),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("rejects a body that is not valid JSON with 400 BAD_REQUEST", async () => {
    const result = await handleEditorContext(
      rawPostContext("{ not json", "/api/editor/context"),
      deps(),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });
});

describe("POST /api/editor/repo-search", () => {
  it("returns content-free EvidenceAtoms with stable ids", async () => {
    const result = await handleEditorRepoSearch(
      postContext(
        { root, queryText: "parseConfig", paths: ["src/a.ts"] },
        "/api/editor/repo-search",
      ),
      deps(),
    );
    expect(result.status).toBe(200);
    const body = result.body as { atoms: { stableId: string; redactionState: string }[] };
    expect(Array.isArray(body.atoms)).toBe(true);
    expect(body.atoms.every((a) => typeof a.stableId === "string")).toBe(true);
    expect(JSON.stringify(body.atoms)).not.toContain("value.trim");
  });

  it("rejects a request without queryText with 400", async () => {
    const result = await handleEditorRepoSearch(
      postContext({ root, paths: [] }, "/api/editor/repo-search"),
      deps(),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("denies a search path that escapes the workspace root", async () => {
    const result = await handleEditorRepoSearch(
      postContext({ root, queryText: "x", paths: ["../escape.ts"] }, "/api/editor/repo-search"),
      deps(),
    );
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: "DENIED" } });
  });

  it("rejects a contained but invalid search path shape", async () => {
    const result = await handleEditorRepoSearch(
      postContext({ root, queryText: "x", paths: ["src/../src/a.ts"] }, "/api/editor/repo-search"),
      deps(),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("rejects repo-search path lists above the route cap", async () => {
    const result = await handleEditorRepoSearch(
      postContext(
        {
          root,
          queryText: "x",
          paths: Array.from({ length: 65 }, (_, index) => `src/f${index.toString()}.ts`),
        },
        "/api/editor/repo-search",
      ),
      deps(),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("exposes governed findFiles through the repo-search route", async () => {
    const result = await handleEditorRepoSearch(
      postContext(
        { root, operation: "findFiles", queryText: "**/*.ts", paths: ["src"] },
        "/api/editor/repo-search",
      ),
      deps(),
    );
    expect(result.status).toBe(200);
    const body = result.body as { atoms: { provenance: { tool: string }; scopePath: string }[] };
    expect(body.atoms.map((atom) => atom.scopePath)).toEqual(["src/a.ts"]);
    expect(body.atoms[0]?.provenance.tool).toBe("repo.findFiles");
  });

  it("exposes content-free readExcerpt provenance through the repo-search route", async () => {
    const result = await handleEditorRepoSearch(
      postContext(
        {
          root,
          operation: "readExcerpt",
          paths: ["src"],
          scopePath: "src/a.ts",
          startLine: 1,
          endLine: 1,
          maxBytes: 64,
        },
        "/api/editor/repo-search",
      ),
      deps(),
    );
    expect(result.status).toBe(200);
    const body = result.body as { atom: { provenance: { tool: string } }; atoms: unknown[] };
    expect(body.atom.provenance.tool).toBe("repo.readExcerpt");
    expect(body.atoms).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("parseConfig");
  });
});

describe("POST /api/editor/local-knowledge/retrieve", () => {
  it("requires exactly one of capsuleId or capsuleSetId", async () => {
    const result = await handleEditorLocalKnowledgeRetrieve(
      postContext(
        { queryText: "q", capsuleId: "c1", capsuleSetId: "s1" },
        "/api/editor/local-knowledge/retrieve",
      ),
      deps(),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("returns 503 when local knowledge storage is unavailable", async () => {
    const result = await handleEditorLocalKnowledgeRetrieve(
      postContext({ queryText: "q", capsuleId: "c1" }, "/api/editor/local-knowledge/retrieve"),
      deps(),
    );
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: { code: "LOCAL_KNOWLEDGE_UNAVAILABLE" } });
  });

  it("rejects a not-ready capsule before query-only retrieval", async () => {
    const capsuleId = seedIndexingCapsule();
    const result = await handleEditorLocalKnowledgeRetrieve(
      postContext({ queryText: "q", capsuleId }, "/api/editor/local-knowledge/retrieve"),
      depsWithLocalKnowledge(),
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: { code: "LOCAL_KNOWLEDGE_CONFLICT" } });
    expect(JSON.stringify(result.body)).toContain("still being prepared");
  });
});
