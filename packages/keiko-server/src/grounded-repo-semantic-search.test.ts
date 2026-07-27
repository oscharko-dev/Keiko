import { describe, expect, it, vi } from "vitest";
import { type KnowledgeCapsuleId, type KnowledgeSourceId } from "@oscharko-dev/keiko-contracts";
import {
  createDefaultParserRegistry,
  createRepositoryPodShell,
  listRepositoryChunkLineRanges,
  listCapsules,
  openKnowledgeStore,
  refreshRepositoryPod,
  updateCapsuleState,
  type KnowledgeStore,
} from "@oscharko-dev/keiko-local-knowledge";
import {
  type SemanticSearchMatch,
  type SemanticSearchProvider,
  type WorkspaceDirEntry,
  type WorkspaceFs,
  type WorkspaceInfo,
  type WorkspaceStat,
} from "@oscharko-dev/keiko-workspace";
import {
  EMBEDDING_INSTRUCTION_VERSION,
  verifyEmbeddingCapability,
  type GatewayConfig,
  type OpenAIEmbeddingAdapter,
  type OpenAIEmbeddingOutcome,
  type OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";
import {
  configuredRepoSemanticSearchProviderFor,
  localizeMatchLine,
  type RepositoryPodRetrievalObservation,
} from "./grounded-repo-semantic-search.js";

const ROOT = "/repo";
const EMBEDDING_MODEL = "text-embedding-3-small";
const POD_CAPSULE_ID = "repo-semantic-test" as KnowledgeCapsuleId;
const POD_SOURCE_ID = "repo-semantic-test-source" as KnowledgeSourceId;
const QUERY: RetrievalQuery = {
  kind: "natural-language",
  text: "session renewal",
  caseSensitive: false,
  maxResults: 4,
  emittedAtMs: 1,
};

function absolutePath(rel: string): string {
  return `${ROOT}/${rel}`.replace(/\/+/gu, "/");
}

function childEntries(
  files: Readonly<Record<string, string>>,
  dirAbs: string,
): readonly WorkspaceDirEntry[] {
  const prefix = dirAbs === ROOT ? `${ROOT}/` : `${dirAbs}/`;
  const dirs = new Set<string>();
  const leafs = new Set<string>();
  for (const rel of Object.keys(files)) {
    const full = absolutePath(rel);
    if (!full.startsWith(prefix)) continue;
    const rest = full.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      leafs.add(rest);
    } else {
      dirs.add(rest.slice(0, slash));
    }
  }
  return [
    ...[...dirs].map((name) => ({ name, isDirectory: true, isFile: false, isSymbolicLink: false })),
    ...[...leafs].map((name) => ({
      name,
      isDirectory: false,
      isFile: true,
      isSymbolicLink: false,
    })),
  ];
}

function relativePath(abs: string): string {
  return abs.startsWith(`${ROOT}/`) ? abs.slice(ROOT.length + 1) : abs;
}

function testFs(files: Record<string, string>): WorkspaceFs {
  const keyFor = (abs: string): string | undefined =>
    Object.keys(files).find((rel) => absolutePath(rel) === abs);
  return {
    readFileUtf8: (abs: string): string => {
      const key = keyFor(abs);
      if (key === undefined) throw Object.assign(new Error(`ENOENT: ${abs}`), { code: "ENOENT" });
      return files[key] ?? "";
    },
    stat: (abs: string): WorkspaceStat => {
      const key = keyFor(abs);
      if (key === undefined) {
        return { size: 0, isFile: false, isDirectory: true, isSymbolicLink: false };
      }
      return {
        size: Buffer.byteLength(files[key] ?? "", "utf8"),
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        hardLinkCount: 1,
      };
    },
    readDir: (abs: string): readonly WorkspaceDirEntry[] => childEntries(files, abs),
    realPath: (abs: string): string => abs,
    exists: (abs: string): boolean => abs === ROOT || keyFor(abs) !== undefined,
    makeDir: () => undefined,
    writeFileUtf8: (abs: string, content: string): void => {
      files[relativePath(abs)] = content;
    },
    readFileBytes: (abs: string, maxBytes: number): Promise<Uint8Array> => {
      const key = keyFor(abs);
      if (key === undefined) throw Object.assign(new Error(`ENOENT: ${abs}`), { code: "ENOENT" });
      const bytes = new TextEncoder().encode(files[key] ?? "");
      return Promise.resolve(bytes.subarray(0, Math.max(0, Math.min(bytes.length, maxBytes))));
    },
  };
}

function testWorkspace(): WorkspaceInfo {
  return {
    root: ROOT,
    name: "repository-semantic-test",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: [],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function embeddingCapability(
  contextWindow = 8_191,
): NonNullable<GatewayConfig["capabilities"]>[number] {
  return {
    id: EMBEDDING_MODEL,
    kind: "embedding",
    contextWindow,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "runtime-configured embedding endpoint",
    preferredUseCases: ["Embeddings"],
    knownLimitations: [],
  };
}

function config(withEmbedding: boolean, contextWindow?: number): GatewayConfig {
  return {
    providers: withEmbedding
      ? [
          {
            modelId: EMBEDDING_MODEL,
            baseUrl: "https://embedding.example/v1",
            apiKey: "embedding-key",
            apiKeyHeaderName: "x-api-key",
            timeoutMs: 30_000,
            maxRetries: 0,
            retryBaseDelayMs: 1,
          },
        ]
      : [],
    capabilities: withEmbedding ? [embeddingCapability(contextWindow)] : [],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
  };
}

function depsWith(
  gatewayConfig: GatewayConfig,
  request: (request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome>,
): UiHandlerDeps {
  const env: Record<string, string> = {};
  return {
    config: gatewayConfig,
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env,
    redactor: buildRedactor(env, gatewayConfig),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    localKnowledgeEmbeddingRequest: request,
  };
}

function vectorFor(input: string): Float32Array {
  if (input.includes(QUERY.text)) return new Float32Array([1, 0]);
  if (input.includes("refresh token")) return new Float32Array([0.99, 0.01]);
  if (input.includes("invoice ledger")) return new Float32Array([0, 1]);
  return new Float32Array([0.2, 0.2]);
}

interface SeededRepositoryPod {
  readonly store: KnowledgeStore;
}

async function seedRepositoryPod(
  deps: UiHandlerDeps,
  fs: WorkspaceFs,
  paths: readonly string[],
  tracked = true,
): Promise<SeededRepositoryPod> {
  const store = openKnowledgeStore({ dbPath: ":memory:" });
  const request = deps.localKnowledgeEmbeddingRequest;
  if (request === undefined) throw new Error("expected embedding request stub");
  const adapter: OpenAIEmbeddingAdapter = {
    endpoint: "https://embedding.example/v1",
    apiKey: "embedding-key",
    request,
  };
  const verified = await verifyEmbeddingCapability(adapter, {
    modelId: EMBEDDING_MODEL,
    provider: "openai",
    vectorMetric: "cosine",
    expectedDimensions: 2,
    normalization: "l2",
    instructionVersion: EMBEDDING_INSTRUCTION_VERSION,
    includeSpaceFingerprint: true,
  });
  if (!verified.ok) throw new Error(`embedding verification failed: ${verified.reason}`);
  createRepositoryPodShell(
    { store, capsuleId: POD_CAPSULE_ID, sourceId: POD_SOURCE_ID },
    {
      displayName: "Repository semantic test",
      repositoryRoot: ROOT,
      embeddingModelIdentity: verified.identity,
    },
  );
  await refreshRepositoryPod(
    {
      store,
      capsuleId: POD_CAPSULE_ID,
      sourceId: POD_SOURCE_ID,
      parserRegistry: createDefaultParserRegistry(),
      embeddingAdapter: adapter,
      workspaceFs: fs,
      ...(tracked ? { trackedPaths: new Set(paths) } : {}),
    },
    { runId: "repository-semantic-test-index" },
  );
  return { store };
}

const SEARCH_DOCUMENTS = [
  {
    scopePath: "src/auth.ts",
    text: "export function renewSession() {\n  return refresh token rotation;\n}\n",
  },
  {
    scopePath: "src/billing.ts",
    text: "export function reconcile() {\n  return invoice ledger totals;\n}\n",
  },
] as const;

async function search(provider: SemanticSearchProvider): Promise<readonly SemanticSearchMatch[]> {
  return provider.search({
    query: QUERY,
    documents: SEARCH_DOCUMENTS,
  });
}

async function searchMissingCandidate(
  provider: SemanticSearchProvider,
): Promise<readonly SemanticSearchMatch[]> {
  return provider.search({
    query: QUERY,
    documents: [],
  });
}

describe("localizeMatchLine (GEN-AI-GROUNDING-006, RB-4)", () => {
  it("returns the 1-based line with the most distinct query-term overlap", () => {
    const src =
      "line one has nothing\nsecond line is empty of terms\n" +
      "export function renewSession() { rotate(); }\ntrailing line";
    expect(localizeMatchLine(src, ["session", "renewsession", "rotate"])).toBe(3);
  });

  it("prefers the line matching the MOST distinct terms", () => {
    const src = "alpha session\nbeta\nalpha session rotate token\ngamma";
    expect(localizeMatchLine(src, ["session", "rotate", "token"])).toBe(3);
  });

  it("falls back to line 1 when no line overlaps a query term", () => {
    expect(localizeMatchLine("alpha\nbeta\ngamma", ["nonexistentterm"])).toBe(1);
  });

  it("falls back to line 1 for empty query terms or empty source", () => {
    expect(localizeMatchLine("alpha\nbeta", [])).toBe(1);
    expect(localizeMatchLine("", ["alpha"])).toBe(1);
  });
});

describe("configuredRepoSemanticSearchProviderFor", () => {
  it("returns undefined when no embedding-capable provider is configured", () => {
    const deps = depsWith(config(false), () =>
      Promise.resolve({ ok: false, kind: "unsupported-model" }),
    );

    expect(configuredRepoSemanticSearchProviderFor(deps, undefined)).toBeUndefined();
    deps.store.close();
  });

  it("never embeds whole candidate files when the repository pod is absent", async () => {
    const embeddingRequest = vi.fn(
      (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
        Promise.resolve({
          ok: true,
          value: { vector: vectorFor(request.input), modelId: request.modelId },
        }),
    );
    const deps = depsWith(config(true), embeddingRequest);
    const observations: RepositoryPodRetrievalObservation[] = [];
    const fs = testFs({
      "src/auth.ts": "export function renewSession() {\n  return refresh token rotation;\n}\n",
      "src/billing.ts": "export function reconcile() {\n  return invoice ledger totals;\n}\n",
    });
    const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
      fs,
      maxCandidates: 8,
      observePodRetrieval: (observation) => observations.push(observation),
    });

    expect(provider).toBeDefined();
    if (provider === undefined) throw new Error("expected semantic provider");

    const hits = await search(provider);

    expect(hits).toEqual([]);
    expect(embeddingRequest).not.toHaveBeenCalled();
    expect(observations).toEqual([
      expect.objectContaining({ mode: "pod-absent", referenceCount: 0 }),
    ]);
    deps.store.close();
  });

  it("serves fresh intersected pod vectors with a chunk-refined line and no document embedding", async () => {
    const files: Record<string, string> = {
      "src/auth.ts": [
        "const unrelated = true;",
        "export function renewSession() {",
        "  return refresh token rotation;",
        "}",
      ].join("\n"),
      "src/outside.ts": "export const renewSession = () => refresh token rotation;\n",
    };
    const embeddingRequest = vi.fn(
      (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
        Promise.resolve({
          ok: true,
          value: { vector: vectorFor(request.input), modelId: request.modelId },
        }),
    );
    const deps = depsWith(config(true), embeddingRequest);
    const fs = testFs(files);
    const pod = await seedRepositoryPod(deps, fs, Object.keys(files));
    embeddingRequest.mockClear();
    const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
      fs,
      maxCandidates: 8,
      repositoryPod: { store: pod.store, repositoryRoot: ROOT },
    });
    if (provider === undefined) throw new Error("expected semantic provider");

    const searchRequest = {
      query: QUERY,
      documents: [{ scopePath: "src/auth.ts", text: files["src/auth.ts"] ?? "" }],
    } as const;
    const hits = await provider.search(searchRequest);
    const repeatedHits = await provider.search(searchRequest);
    const inputs = embeddingRequest.mock.calls.map(([request]) => request.input);

    expect(hits, `embedding inputs: ${JSON.stringify(inputs)}`).toEqual([
      expect.objectContaining({ scopePath: "src/auth.ts", line: 2, score: 1 }),
    ]);
    expect(repeatedHits).toEqual(hits);
    expect(hits.some((hit) => hit.scopePath === "src/outside.ts")).toBe(false);
    expect(inputs.filter((input) => input === QUERY.text)).toHaveLength(1);
    expect(inputs.some((input) => input.startsWith("Path:"))).toBe(false);
    pod.store.close();
    deps.store.close();
  });

  it("drives real repository fusion and orchestrator retrieval from the fresh pod index", async () => {
    const files: Record<string, string> = {
      "src/auth.ts": [
        "const unrelated = true;",
        "export function renewSession() {",
        "  return refresh token rotation;",
        "}",
      ].join("\n"),
      "src/billing.ts": "export const reconcile = () => invoice ledger totals;\n",
    };
    const embeddingRequest = vi.fn(
      (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
        Promise.resolve({
          ok: true,
          value: { vector: vectorFor(request.input), modelId: request.modelId },
        }),
    );
    const deps = depsWith(config(true), embeddingRequest);
    const fs = testFs(files);
    const pod = await seedRepositoryPod(deps, fs, Object.keys(files));
    embeddingRequest.mockClear();
    const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
      fs,
      maxCandidates: 8,
      repositoryPod: { store: pod.store, repositoryRoot: ROOT },
    });
    if (provider === undefined) throw new Error("expected semantic provider");

    const output = await retrieveConnectedContextPack(
      {
        scope: {
          schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
          scopeId: "repository-semantic-scope",
          workspaceRoot: ROOT,
          kind: "workspace-root",
          relativePaths: [],
          conversationId: undefined,
          connectedAtMs: 1,
          explicitConnection: true,
        },
        query: { ...QUERY, text: "Investigate session renewal in src/auth.ts" },
        workspaceRoot: ROOT,
      },
      {
        answerer: { answer: () => Promise.resolve("") },
        nowMs: () => 1,
        fs,
        detectWorkspace: () => testWorkspace(),
        repoSemanticSearchProvider: provider,
      },
    );
    const authFile = output.pack.files.find((file) => file.scopePath === "src/auth.ts");
    const semanticAtom = authFile?.excerpts.find((excerpt) =>
      excerpt.atom.provenance.tool.includes("configured-repo-semantic-search"),
    );

    expect(authFile).toBeDefined();
    expect(semanticAtom?.atom.lineRange).toEqual({ startLine: 2, endLine: 2 });
    expect(embeddingRequest.mock.calls.some(([request]) => request.input.startsWith("Path:"))).toBe(
      false,
    );
    pod.store.close();
    deps.store.close();
  });

  it("rejects stale pod state without embedding the changed document", async () => {
    const files: Record<string, string> = {
      "src/auth.ts": "export function renewSession() {\n  return refresh token rotation;\n}\n",
    };
    const embeddingRequest = vi.fn(
      (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
        Promise.resolve({
          ok: true,
          value: { vector: vectorFor(request.input), modelId: request.modelId },
        }),
    );
    const deps = depsWith(config(true), embeddingRequest);
    const fs = testFs(files);
    const pod = await seedRepositoryPod(deps, fs, Object.keys(files));
    files["src/auth.ts"] = [
      "const changedAfterIndexing = true;",
      "export function renewSession() {",
      "  return refresh token rotation;",
      "}",
    ].join("\n");
    embeddingRequest.mockClear();
    const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
      fs,
      maxCandidates: 8,
      repositoryPod: { store: pod.store, repositoryRoot: ROOT },
    });
    if (provider === undefined) throw new Error("expected semantic provider");

    const hits = await provider.search({
      query: QUERY,
      documents: [{ scopePath: "src/auth.ts", text: files["src/auth.ts"] ?? "" }],
    });
    const inputs = embeddingRequest.mock.calls.map(([request]) => request.input);

    expect(hits).toEqual([]);
    expect(inputs).toEqual([]);
    pod.store.close();
    deps.store.close();
  });

  it("hashes bounded live workspace bytes instead of trusting a stale candidate snapshot", async () => {
    const indexedText = "export const sessionState = 'indexed-value';\n";
    const liveText = "export const sessionState = 'changed-value';\n";
    expect(Buffer.byteLength(liveText)).toBe(Buffer.byteLength(indexedText));
    const files: Record<string, string> = { "src/auth.ts": indexedText };
    const embeddingRequest = vi.fn(
      (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
        Promise.resolve({
          ok: true,
          value: { vector: vectorFor(request.input), modelId: request.modelId },
        }),
    );
    const deps = depsWith(config(true), embeddingRequest);
    const baseFs = testFs(files);
    const readFileBytes = vi.fn(baseFs.readFileBytes);
    const fs: WorkspaceFs = { ...baseFs, readFileBytes };
    const pod = await seedRepositoryPod(deps, fs, Object.keys(files));
    files["src/auth.ts"] = liveText;
    embeddingRequest.mockClear();
    readFileBytes.mockClear();
    const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
      fs,
      maxCandidates: 8,
      repositoryPod: { store: pod.store, repositoryRoot: ROOT },
    });
    if (provider === undefined) throw new Error("expected semantic provider");

    const hits = await provider.search({
      query: QUERY,
      documents: [{ scopePath: "src/auth.ts", text: indexedText }],
    });
    const inputs = embeddingRequest.mock.calls.map(([request]) => request.input);

    expect(hits).toEqual([]);
    expect(inputs).toEqual([]);
    expect(readFileBytes).toHaveBeenCalledWith(absolutePath("src/auth.ts"), indexedText.length + 1);
    pod.store.close();
    deps.store.close();
  });

  it("hashes live bytes for non-git file-state fingerprints instead of trusting size and mtime", async () => {
    const indexedText = "export const sessionState = 'indexed-value';\n";
    const liveText = "export const sessionState = 'changed-value';\n";
    expect(Buffer.byteLength(liveText)).toBe(Buffer.byteLength(indexedText));
    const files: Record<string, string> = { "src/auth.ts": indexedText };
    const embeddingRequest = vi.fn(
      (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
        Promise.resolve({
          ok: true,
          value: { vector: vectorFor(request.input), modelId: request.modelId },
        }),
    );
    const deps = depsWith(config(true), embeddingRequest);
    const fs = testFs(files);
    const pod = await seedRepositoryPod(deps, fs, Object.keys(files), false);
    files["src/auth.ts"] = liveText;
    embeddingRequest.mockClear();
    const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
      fs,
      maxCandidates: 8,
      repositoryPod: { store: pod.store, repositoryRoot: ROOT },
    });
    if (provider === undefined) throw new Error("expected semantic provider");

    await expect(
      provider.search({
        query: QUERY,
        documents: [{ scopePath: "src/auth.ts", text: indexedText }],
      }),
    ).resolves.toEqual([]);

    expect(embeddingRequest).not.toHaveBeenCalled();
    pod.store.close();
    deps.store.close();
  });

  it("fails freshness closed when the bounded live workspace read fails", async () => {
    const files: Record<string, string> = {
      "src/auth.ts": "export const sessionState = 'indexed-value';\n",
    };
    const embeddingRequest = vi.fn(
      (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
        Promise.resolve({
          ok: true,
          value: { vector: vectorFor(request.input), modelId: request.modelId },
        }),
    );
    const deps = depsWith(config(true), embeddingRequest);
    const baseFs = testFs(files);
    let readsFail = false;
    const fs: WorkspaceFs = {
      ...baseFs,
      readFileBytes: (path, maxBytes) =>
        readsFail
          ? Promise.reject(new Error("READ_BLOCKED"))
          : (baseFs.readFileBytes?.(path, maxBytes) ?? Promise.reject(new Error("NO_READER"))),
    };
    const pod = await seedRepositoryPod(deps, fs, Object.keys(files));
    readsFail = true;
    embeddingRequest.mockClear();
    const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
      fs,
      maxCandidates: 8,
      repositoryPod: { store: pod.store, repositoryRoot: ROOT },
    });
    if (provider === undefined) throw new Error("expected semantic provider");

    await expect(
      provider.search({
        query: QUERY,
        documents: [{ scopePath: "src/auth.ts", text: files["src/auth.ts"] ?? "" }],
      }),
    ).resolves.toEqual([]);

    expect(embeddingRequest).not.toHaveBeenCalled();
    pod.store.close();
    deps.store.close();
  });

  it("fails freshness closed when the live file resolves outside the repository root", async () => {
    const files: Record<string, string> = {
      "src/auth.ts": "export const sessionState = 'indexed-value';\n",
    };
    const embeddingRequest = vi.fn(
      (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
        Promise.resolve({
          ok: true,
          value: { vector: vectorFor(request.input), modelId: request.modelId },
        }),
    );
    const deps = depsWith(config(true), embeddingRequest);
    const baseFs = testFs(files);
    let escapes = false;
    const fs: WorkspaceFs = {
      ...baseFs,
      realPath: (path) =>
        escapes && path === absolutePath("src/auth.ts") ? "/outside/auth.ts" : path,
    };
    const pod = await seedRepositoryPod(deps, fs, Object.keys(files));
    escapes = true;
    embeddingRequest.mockClear();
    const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
      fs,
      maxCandidates: 8,
      repositoryPod: { store: pod.store, repositoryRoot: ROOT },
    });
    if (provider === undefined) throw new Error("expected semantic provider");

    await expect(
      provider.search({
        query: QUERY,
        documents: [{ scopePath: "src/auth.ts", text: files["src/auth.ts"] ?? "" }],
      }),
    ).resolves.toEqual([]);

    expect(embeddingRequest).not.toHaveBeenCalled();
    pod.store.close();
    deps.store.close();
  });

  it("selects the first code-unit-sorted ready nonempty pod, skipping unusable duplicates", async () => {
    const files: Record<string, string> = {
      "src/auth.ts": "export function renewSession() {\n  return refresh token rotation;\n}\n",
    };
    const embeddingRequest = vi.fn(
      (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
        Promise.resolve({
          ok: true,
          value: { vector: vectorFor(request.input), modelId: request.modelId },
        }),
    );
    const deps = depsWith(config(true), embeddingRequest);
    const fs = testFs(files);
    const pod = await seedRepositoryPod(deps, fs, Object.keys(files));
    const identity = listCapsules(pod.store).find(
      (capsule) => capsule.id === POD_CAPSULE_ID,
    )?.embeddingModelIdentity;
    if (identity === undefined) throw new Error("expected seeded capsule identity");
    createRepositoryPodShell(
      {
        store: pod.store,
        capsuleId: "aaa-unready" as KnowledgeCapsuleId,
        sourceId: "aaa-unready-source" as KnowledgeSourceId,
      },
      {
        displayName: "Unready duplicate",
        repositoryRoot: ROOT,
        embeddingModelIdentity: identity,
      },
    );
    createRepositoryPodShell(
      {
        store: pod.store,
        capsuleId: "aab-empty" as KnowledgeCapsuleId,
        sourceId: "aab-empty-source" as KnowledgeSourceId,
      },
      {
        displayName: "Empty duplicate",
        repositoryRoot: ROOT,
        embeddingModelIdentity: identity,
      },
    );
    updateCapsuleState(pod.store, "aab-empty" as KnowledgeCapsuleId, "ready");
    embeddingRequest.mockClear();
    const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
      fs,
      maxCandidates: 8,
      repositoryPod: { store: pod.store, repositoryRoot: ROOT },
    });
    if (provider === undefined) throw new Error("expected semantic provider");

    const hits = await provider.search({
      query: QUERY,
      documents: [{ scopePath: "src/auth.ts", text: files["src/auth.ts"] ?? "" }],
    });

    expect(hits[0]?.scopePath).toBe("src/auth.ts");
    expect(embeddingRequest.mock.calls.some(([request]) => request.input.startsWith("Path:"))).toBe(
      false,
    );
    pod.store.close();
    deps.store.close();
  });

  it("soft-fails a pod query error without escaping or embedding documents", async () => {
    const files: Record<string, string> = {
      "src/auth.ts": "export function renewSession() {\n  return refresh token rotation;\n}\n",
    };
    const embeddingRequest = vi.fn(
      (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
        Promise.resolve({
          ok: true,
          value: { vector: vectorFor(request.input), modelId: request.modelId },
        }),
    );
    const deps = depsWith(config(true), embeddingRequest);
    const fs = testFs(files);
    const pod = await seedRepositoryPod(deps, fs, Object.keys(files));
    const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
      fs,
      maxCandidates: 8,
      repositoryPod: { store: pod.store, repositoryRoot: ROOT },
    });
    if (provider === undefined) throw new Error("expected semantic provider");
    pod.store.close();
    embeddingRequest.mockClear();

    await expect(
      provider.search({
        query: QUERY,
        documents: [{ scopePath: "src/auth.ts", text: files["src/auth.ts"] ?? "" }],
      }),
    ).resolves.toEqual([]);
    expect(embeddingRequest.mock.calls.some(([request]) => request.input.startsWith("Path:"))).toBe(
      false,
    );
    deps.store.close();
  });

  it("records a content-free observation when a pod query error soft-fails", async () => {
    // Fail-closed on results is deliberate (see the soft-fail test above: the whole-file path would
    // embed document bodies). Fail-SILENT is not: an empty result must stay distinguishable from a
    // genuinely unmatched query, so the degradation is reported through the pod observation seam.
    const files: Record<string, string> = {
      "src/auth.ts": "export function renewSession() {\n  return refresh token rotation;\n}\n",
    };
    const embeddingRequest = vi.fn(
      (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
        Promise.resolve({
          ok: true,
          value: { vector: vectorFor(request.input), modelId: request.modelId },
        }),
    );
    const deps = depsWith(config(true), embeddingRequest);
    const fs = testFs(files);
    const pod = await seedRepositoryPod(deps, fs, Object.keys(files));
    const observations: RepositoryPodRetrievalObservation[] = [];
    const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
      fs,
      maxCandidates: 8,
      repositoryPod: { store: pod.store, repositoryRoot: ROOT },
      observePodRetrieval: (observation) => observations.push(observation),
    });
    if (provider === undefined) throw new Error("expected semantic provider");
    pod.store.close();
    observations.length = 0;

    await expect(
      provider.search({
        query: QUERY,
        documents: [{ scopePath: "src/auth.ts", text: files["src/auth.ts"] ?? "" }],
      }),
    ).resolves.toEqual([]);

    expect(observations).toEqual([
      {
        mode: "pod-query-failed",
        referenceCount: 0,
        denseCandidateCount: 0,
        lexicalCandidateCount: 0,
        lexicalOrFallbackUsed: true,
      },
    ]);
    // The observation carries counts and a mode label only — no path, body, or query text.
    expect(JSON.stringify(observations)).not.toContain("src/auth.ts");
    expect(JSON.stringify(observations)).not.toContain(QUERY.text);
    deps.store.close();
  });

  it("scores every fresh candidate when the pod indexes far more files than the candidate set", async () => {
    // The pod query has no path filter, so its topK is a race across the WHOLE pod index. Sizing it
    // from the candidate count let unrelated-but-higher-scoring files consume the entire budget:
    // both candidates then received no pod reference AND were never handed to the legacy leg, so
    // they disappeared from a successful result (ADR-0152 D3).
    const files: Record<string, string> = {
      "src/alpha.ts": "export const alphaHelper = () => computeTotals();\n",
      "src/beta.ts": "export const betaHelper = () => computeAverages();\n",
    };
    for (let index = 0; index < 40; index += 1) {
      files[`src/noise-${String(index)}.ts`] =
        `export const noise${String(index)} = () => refresh token rotation;\n`;
    }
    const embeddingRequest = vi.fn(
      (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
        Promise.resolve({
          ok: true,
          value: { vector: vectorFor(request.input), modelId: request.modelId },
        }),
    );
    const deps = depsWith(config(true), embeddingRequest);
    const fs = testFs(files);
    const pod = await seedRepositoryPod(deps, fs, Object.keys(files));
    const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
      fs,
      maxCandidates: 8,
      repositoryPod: { store: pod.store, repositoryRoot: ROOT },
    });
    if (provider === undefined) throw new Error("expected semantic provider");

    const hits = await provider.search({
      query: QUERY,
      documents: [
        { scopePath: "src/alpha.ts", text: files["src/alpha.ts"] ?? "" },
        { scopePath: "src/beta.ts", text: files["src/beta.ts"] ?? "" },
      ],
    });

    expect([...hits].map((hit) => hit.scopePath).sort()).toEqual(["src/alpha.ts", "src/beta.ts"]);
    for (const hit of hits) {
      expect(hit.score).toBeGreaterThan(0);
    }
    pod.store.close();
    deps.store.close();
  });

  it("constrains pod retrieval to fresh candidate chunks without whole-file rescue", async () => {
    // A pod-wide topK can be monopolised by a large unrelated file. Both persistent lanes must be
    // constrained to the requested candidate chunks so a fresh candidate is never re-embedded
    // merely because unrelated pod content starved it.
    const dominatingFile = Array.from(
      { length: 400 },
      (_unused, index) =>
        `export const noise${String(index)} = () => session renewal refresh token rotation;`,
    ).join("\n");
    const files: Record<string, string> = {
      "src/alpha.ts": "export const alphaHelper = () => computeTotals();\n",
      "src/dominating.ts": `${dominatingFile}\n`,
    };
    const embeddingRequest = vi.fn(
      (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
        Promise.resolve({
          ok: true,
          value: { vector: vectorFor(request.input), modelId: request.modelId },
        }),
    );
    const deps = depsWith(config(true), embeddingRequest);
    const fs = testFs(files);
    const pod = await seedRepositoryPod(deps, fs, Object.keys(files));
    expect(listRepositoryChunkLineRanges(pod.store, POD_CAPSULE_ID).length).toBeGreaterThan(128);
    embeddingRequest.mockClear();
    const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
      fs,
      maxCandidates: 8,
      repositoryPod: { store: pod.store, repositoryRoot: ROOT },
    });
    if (provider === undefined) throw new Error("expected semantic provider");

    const hits = await provider.search({
      query: QUERY,
      documents: [{ scopePath: "src/alpha.ts", text: files["src/alpha.ts"] ?? "" }],
    });
    const inputs = embeddingRequest.mock.calls.map(([request]) => request.input);

    expect(hits.map((hit) => hit.scopePath)).toEqual(["src/alpha.ts"]);
    expect(hits[0]?.score).toBeGreaterThan(0);
    expect(inputs.filter((input) => input.startsWith("Path: "))).toEqual([]);
    pod.store.close();
    deps.store.close();
  });

  it("does not send the query for embedding when no candidate documents can be read", async () => {
    const embeddingRequest = vi.fn(
      (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
        Promise.resolve({
          ok: true,
          value: { vector: vectorFor(request.input), modelId: request.modelId },
        }),
    );
    const deps = depsWith(config(true), embeddingRequest);
    const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
      fs: testFs({}),
      maxCandidates: 8,
    });
    if (provider === undefined) throw new Error("expected semantic provider");

    await expect(searchMissingCandidate(provider)).resolves.toEqual([]);
    expect(embeddingRequest).not.toHaveBeenCalled();
    deps.store.close();
  });
});
