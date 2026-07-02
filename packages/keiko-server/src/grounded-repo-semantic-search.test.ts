import { describe, expect, it, vi } from "vitest";
import { maxUtf8BytesForTokenBudget } from "@oscharko-dev/keiko-contracts";
import {
  DEFAULT_SEARCH_LIMITS,
  type SemanticSearchMatch,
  type SemanticSearchProvider,
  type WorkspaceDirEntry,
  type WorkspaceFs,
  type WorkspaceInfo,
  type WorkspaceStat,
} from "@oscharko-dev/keiko-workspace";
import type {
  GatewayConfig,
  OpenAIEmbeddingOutcome,
  OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import { configuredRepoSemanticSearchProviderFor } from "./grounded-repo-semantic-search.js";

const ROOT = "/repo";
const EMBEDDING_MODEL = "text-embedding-3-small";
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

function childEntries(files: Readonly<Record<string, string>>, dirAbs: string): readonly WorkspaceDirEntry[] {
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
    ...[...leafs].map((name) => ({ name, isDirectory: false, isFile: true, isSymbolicLink: false })),
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

function workspace(): WorkspaceInfo {
  return {
    root: ROOT,
    name: "repo",
    version: undefined,
    testFramework: "unknown",
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
  if (input === QUERY.text) return new Float32Array([1, 0]);
  if (input.includes("refresh token")) return new Float32Array([0.99, 0.01]);
  if (input.includes("invoice ledger")) return new Float32Array([0, 1]);
  return new Float32Array([0.2, 0.2]);
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

describe("configuredRepoSemanticSearchProviderFor", () => {
  it("returns undefined when no embedding-capable provider is configured", () => {
    const deps = depsWith(config(false), () =>
      Promise.resolve({ ok: false, kind: "unsupported-model" }),
    );

    expect(configuredRepoSemanticSearchProviderFor(deps, undefined)).toBeUndefined();
    deps.store.close();
  });

  it("uses configured embedding credentials and ranks scoped candidates by cosine similarity", async () => {
    const embeddingRequest = vi.fn((request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
      Promise.resolve({
        ok: true,
        value: { vector: vectorFor(request.input), modelId: request.modelId },
      }),
    );
    const deps = depsWith(config(true), embeddingRequest);
    const fs = testFs({
      "src/auth.ts": "export function renewSession() {\n  return refresh token rotation;\n}\n",
      "src/billing.ts": "export function reconcile() {\n  return invoice ledger totals;\n}\n",
    });
    const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, { fs, maxCandidates: 8 });

    expect(provider).toBeDefined();
    if (provider === undefined) throw new Error("expected semantic provider");

    const hits = await search(provider);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      scopePath: "src/auth.ts",
      line: 1,
    });
    expect(hits[0]?.score).toBeGreaterThan(0.99);
    expect(embeddingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "https://embedding.example/v1",
        apiKey: "embedding-key",
        apiKeyHeaderName: "x-api-key",
        modelId: EMBEDDING_MODEL,
      }),
    );
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

  it("reuses candidate document vectors within a provider instance", async () => {
    const files: Record<string, string> = {
      "src/auth.ts": "export function renewSession() {\n  return refresh token rotation;\n}\n",
      "src/billing.ts": "export function reconcile() {\n  return invoice ledger totals;\n}\n",
    };
    const fs = testFs(files);
    const firstEmbeddingRequest = vi.fn(
      (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
        Promise.resolve({
          ok: true,
          value: { vector: vectorFor(request.input), modelId: request.modelId },
        }),
    );
    const firstDeps = depsWith(config(true), firstEmbeddingRequest);
    const firstProvider = configuredRepoSemanticSearchProviderFor(firstDeps, undefined, {
      fs,
      maxCandidates: 8,
    });
    if (firstProvider === undefined) throw new Error("expected first semantic provider");

    const firstHits = await search(firstProvider);

    expect(firstHits[0]?.scopePath).toBe("src/auth.ts");
    const secondHits = await search(firstProvider);
    const secondInputs = firstEmbeddingRequest.mock.calls
      .slice(3)
      .map(([request]) => request.input);

    expect(secondHits).toEqual(firstHits);
    expect(secondInputs).toEqual([QUERY.text]);
    expect(secondInputs.some((input) => input.includes("Path:"))).toBe(false);
    firstDeps.store.close();
  });

  it("clamps query and candidate document inputs to the embedding model context window", async () => {
    const contextWindow = 64;
    const maxBytes = maxUtf8BytesForTokenBudget(contextWindow - 16);
    const capturedInputs: string[] = [];
    const embeddingRequest = vi.fn(
      (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> => {
        capturedInputs.push(request.input);
        return Promise.resolve({
          ok: true,
          value: { vector: new Float32Array([1, 0]), modelId: request.modelId },
        });
      },
    );
    const deps = depsWith(config(true, contextWindow), embeddingRequest);
    const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
      fs: testFs({
        "src/long.ts": `export const value = "${"document ".repeat(2_000)}";`,
      }),
      maxCandidates: 8,
    });
    if (provider === undefined) throw new Error("expected semantic provider");

    await provider.search({
      query: { ...QUERY, text: `session renewal ${"query ".repeat(2_000)}` },
      documents: [
        {
          scopePath: "src/long.ts",
          text: `export const value = "${"document ".repeat(2_000)}";`,
        },
      ],
    });

    expect(capturedInputs).toHaveLength(2);
    for (const input of capturedInputs) {
      expect(Buffer.byteLength(input, "utf8")).toBeLessThanOrEqual(maxBytes);
    }
    expect(capturedInputs[0]).toContain("session renewal");
    expect(capturedInputs[0]).not.toContain("query ".repeat(100));
    expect(capturedInputs[1]).toContain("Path: src/long.ts");
    deps.store.close();
  });
});
