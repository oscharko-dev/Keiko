import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type KnowledgeCapsuleId, type KnowledgeSourceId } from "@oscharko-dev/keiko-contracts";
import {
  createDefaultParserRegistry,
  createRepositoryPodShell,
  listRepositoryChunkLineRanges,
  listCapsules,
  openKnowledgeStore,
  refreshRepositoryPod,
  readRepositoryFileFingerprints,
  resolveKnowledgeStorePath,
  scoreVector,
  shapeEmbeddingQuery,
  updateCapsuleState,
  type KnowledgeStore,
} from "@oscharko-dev/keiko-local-knowledge";
import {
  searchText,
  type SemanticSearchMatch,
  type SemanticSearchProvider,
  type WorkspaceDirEntry,
  type WorkspaceFs,
  type WorkspaceInfo,
  type WorkspaceStat,
} from "@oscharko-dev/keiko-workspace";
import {
  nodeWorkspaceFs,
  WorkspaceDescriptorReadError,
} from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  EMBEDDING_INSTRUCTION_VERSION,
  l2NormalizeVector,
  verifyEmbeddingCapability,
  type GatewayConfig,
  type OpenAIEmbeddingAdapter,
  type OpenAIEmbeddingOutcome,
  type OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import {
  DEFAULT_EXPLORATION_BUDGET,
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type ExplorationBudget,
  type ExplorationUsage,
  type RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  applyUsage,
  canContinue,
  createExplorationPlan,
  createGovernor,
} from "@oscharko-dev/keiko-workflows";
import { processServerLogSink } from "./process-log-sink.js";
import {
  QUALIFICATION_SPEND_BUDGET_USD_ENV,
  QUALIFICATION_SPEND_LEDGER_PATH_ENV,
} from "./gateway-spend-budget.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";
import {
  configuredRepoSemanticSearchProviderFor,
  configuredRepoSemanticSearchProviderLeaseFor,
  localizeMatchLine,
  type ConfiguredRepoSemanticSearchOptions,
  type RepositoryPodRetrievalObservation,
  type RepositoryPodSemanticSearchContext,
} from "./grounded-repo-semantic-search.js";

import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

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

// Production's `fileIdentity` is `dev:ino`: stable per path, independent of content. The bounded
// reader below re-proves it together with the size, so a mid-read content swap still denies.
function fileStat(
  files: Readonly<Record<string, string>>,
  key: string,
  abs: string,
): WorkspaceStat {
  return {
    size: Buffer.byteLength(files[key] ?? "", "utf8"),
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    hardLinkCount: 1,
    fileIdentity: `repo-semantic-test:${abs}`,
  };
}

// ADR-0005 D1: discovery's read lane uses the bounded same-descriptor primitive when the port
// provides it and reports the read as unavailable when it does not -- the unbounded
// `readFileUtf8` fallback that used to sit beside the byte cap was removed. Without this method
// the orchestrator's excerpt reads fail outright. Mirrors `readFileUtf8SameDescriptor` in
// keiko-workspace's node port: refuse a hard-linked alias, re-prove the caller's expected
// snapshot, and refuse a file that does not fit the cap rather than truncating it.
function descriptorReader(
  files: Readonly<Record<string, string>>,
  keyFor: (abs: string) => string | undefined,
): NonNullable<WorkspaceFs["readFileUtf8SameDescriptor"]> {
  return (abs, maxBytes, hardLinkPolicy, expected) => {
    const key = keyFor(abs);
    if (key === undefined) throw Object.assign(new Error(`ENOENT: ${abs}`), { code: "ENOENT" });
    const observed = fileStat(files, key, abs);
    if (hardLinkPolicy === "reject" && (observed.hardLinkCount ?? 1) > 1) {
      throw new WorkspaceDescriptorReadError("hard-link");
    }
    if (expected.fileIdentity !== observed.fileIdentity || expected.size !== observed.size) {
      throw new WorkspaceDescriptorReadError("changed");
    }
    if (observed.size > Math.max(0, Math.floor(maxBytes))) {
      throw new WorkspaceDescriptorReadError("too-large", observed.size);
    }
    return { rawText: files[key] ?? "", sizeBytes: observed.size, stat: observed };
  };
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
    readFileUtf8SameDescriptor: descriptorReader(files, keyFor),
    stat: (abs: string): WorkspaceStat => {
      const key = keyFor(abs);
      if (key === undefined) {
        return { size: 0, isFile: false, isDirectory: true, isSymbolicLink: false };
      }
      return fileStat(files, key, abs);
    },
    readDir: (abs: string): readonly WorkspaceDirEntry[] => childEntries(files, abs),
    iterateDirectory: async function* (abs): AsyncIterable<WorkspaceDirEntry> {
      for (const item of childEntries(files, abs)) yield await Promise.resolve(item);
    },
    realPath: (abs: string): string => abs,
    exists: (abs: string): boolean => abs === ROOT || keyFor(abs) !== undefined,
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
    selectedRoot: ROOT,
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

function refreshBudgetGrant(overrides: Partial<ExplorationBudget> = {}): {
  readonly reserve: (delta: Readonly<Partial<ExplorationUsage>>) => boolean;
  readonly usage: () => ExplorationUsage;
} {
  const plan = createExplorationPlan({
    scope: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: "semantic-refresh-budget",
      workspaceRoot: ROOT,
      kind: "workspace-root",
      relativePaths: [],
      conversationId: undefined,
      connectedAtMs: 1,
    },
    query: { ...QUERY, text: "Explain src/auth.ts" },
    budget: { ...DEFAULT_EXPLORATION_BUDGET, ...overrides },
  });
  const initial = createGovernor(plan);
  let state = initial;
  return {
    reserve(delta): boolean {
      if (!canContinue(state)) return false;
      const next = applyUsage(state, { ...initial.usage, ...delta });
      if (!canContinue(next)) return false;
      state = next;
      return true;
    },
    usage: (): ExplorationUsage => state.usage,
  };
}

async function seedRepositoryPod(
  deps: UiHandlerDeps,
  fs: WorkspaceFs,
  paths: readonly string[],
  tracked = true,
  dbPath = ":memory:",
  repositoryRoot = ROOT,
): Promise<SeededRepositoryPod> {
  const store = openKnowledgeStore({ dbPath });
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
      repositoryRoot,
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

async function staleFixture(
  extra: ConfiguredRepoSemanticSearchOptions = {},
  fileCount = 2,
): Promise<{
  readonly files: Record<string, string>;
  readonly fs: WorkspaceFs;
  readonly provider: SemanticSearchProvider;
  readonly deps: UiHandlerDeps;
  readonly store: KnowledgeStore;
  readonly embedding: ReturnType<
    typeof vi.fn<(request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome>>
  >;
  readonly observed: ReturnType<typeof vi.fn<(observation: unknown) => void>>;
  readonly close: () => void;
}> {
  const files: Record<string, string> = {
    "src/auth.ts": "export const sessionState = 'indexed';\n",
    "src/peer.ts": "export const peer = 'indexed';\n",
  };
  for (let index = 2; index < fileCount; index += 1)
    files[`src/changed-${String(index)}.ts`] = "export const initial = 'indexed';\n";
  const embedding = vi.fn((request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
    Promise.resolve({
      ok: true,
      value: { vector: vectorFor(request.input), modelId: request.modelId },
    }),
  );
  const deps = depsWith(config(true), embedding);
  const fs = testFs(files);
  const pod = await seedRepositoryPod(deps, fs, Object.keys(files));
  files["src/auth.ts"] = "export const sessionState = 'session renewal changed';\n";
  files["src/peer.ts"] = "export const peer = 'session renewal changed too';\n";
  for (let index = 2; index < fileCount; index += 1)
    files[`src/changed-${String(index)}.ts`] =
      "export const changed = 'session renewal changed';\n";
  const observed = vi.fn((_observation: unknown): void => undefined);
  const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
    fs,
    maxCandidates: 8,
    repositoryPod: { store: pod.store, repositoryRoot: ROOT },
    observeSemanticFreshness: observed,
    tryReserveRefreshUsage: refreshBudgetGrant().reserve,
    ...extra,
  });
  if (provider === undefined) throw new Error("expected semantic provider");
  embedding.mockClear();
  return {
    files,
    fs,
    provider,
    deps,
    store: pod.store,
    embedding,
    observed,
    close: (): void => {
      pod.store.close();
      deps.store.close();
    },
  };
}

type StaleFixture = Awaited<ReturnType<typeof staleFixture>>;

function pricedRefreshFixture(fixture: StaleFixture): StaleFixture {
  return {
    ...fixture,
    deps: {
      ...fixture.deps,
      config: {
        ...fixture.deps.config,
        capabilities: (fixture.deps.config.capabilities ?? []).map((capability) => ({
          ...capability,
          pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 0 },
        })),
      },
    },
  };
}

function pausedRefreshEmbedding(fixture: StaleFixture): {
  readonly entered: Promise<void>;
  readonly finished: Promise<void>;
  readonly finish: () => void;
} {
  let enter: () => void = () => undefined;
  let finish: () => void = () => undefined;
  let done: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const response = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  fixture.embedding.mockImplementation(async (request) => {
    enter();
    await response;
    done();
    return { ok: true, value: { vector: vectorFor(request.input), modelId: request.modelId } };
  });
  return { entered, finished, finish };
}

function expectRefreshSpendRejection(
  log: ReturnType<typeof createBufferedServerLogSink>,
  required: boolean,
): void {
  if (!required) return;
  const rejection = log.events.find((event) => event.op === "gateway.spend.rejected");
  expect(rejection?.extra?.reason).toBe("spend-budget-exceeded");
  expectActivityLogProof(
    "gateway.spend.rejected.line",
    formatActivityLogProofLine(rejection ?? {}),
  );
}

function searchStaleFixture(
  fixture: StaleFixture,
  provider = fixture.provider,
): Promise<readonly SemanticSearchMatch[]> {
  return provider.search({
    query: QUERY,
    documents: Object.entries(fixture.files).map(([scopePath, text]) => ({ scopePath, text })),
  });
}

function refreshProviderFor(
  fixture: StaleFixture,
  options: ConfiguredRepoSemanticSearchOptions,
  env: Readonly<Record<string, string>> = {},
): SemanticSearchProvider {
  const provider = configuredRepoSemanticSearchProviderFor({ ...fixture.deps, env }, undefined, {
    fs: fixture.fs,
    repositoryPod: { store: fixture.store, repositoryRoot: ROOT },
    deadlineAtMs: 1_001,
    nowMs: (): number => 1,
    observeSemanticFreshness: fixture.observed,
    tryReserveRefreshUsage: refreshBudgetGrant().reserve,
    ...options,
  });
  if (provider === undefined) throw new Error("expected configured refresh provider");
  return provider;
}

function invalidRefreshVector(failure: string): Float32Array {
  if (failure === "dimension") return new Float32Array([1]);
  return failure === "nonfinite" ? new Float32Array([Number.NaN, 0]) : new Float32Array([1, 0]);
}

async function leaseFixture(): Promise<{
  readonly fixture: StaleFixture;
  readonly deps: UiHandlerDeps;
  readonly close: () => void;
}> {
  const fixture = await staleFixture();
  const runtimeDir = mkdtempSync(join(tmpdir(), "keiko-semantic-refresh-"));
  const deps = {
    ...fixture.deps,
    uiDbPath: join(runtimeDir, "ui.db"),
    env: { KEIKO_REPO_SEMANTIC_REFRESH_FILES_MAX: "8" },
  };
  fixture.files["src/auth.ts"] = "export const initial = 'indexed';\n";
  const seeded = await seedRepositoryPod(
    deps,
    fixture.fs,
    Object.keys(fixture.files),
    true,
    resolveKnowledgeStorePath({ runtimeStateDir: runtimeDir }),
  );
  seeded.store.close();
  fixture.files["src/auth.ts"] = "export const changed = 'session renewal changed';\n";
  fixture.embedding.mockClear();
  return {
    fixture,
    deps,
    close: (): void => {
      fixture.close();
      rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
}

async function realFingerprintFixture(fileCount = 8): Promise<{
  readonly root: string;
  readonly files: Record<string, string>;
  readonly deps: UiHandlerDeps;
  readonly pod: SeededRepositoryPod;
  readonly close: () => void;
}> {
  const root = mkdtempSync(join(tmpdir(), "keiko-semantic-cancellation-"));
  const files = Object.fromEntries(
    Array.from({ length: fileCount }, (_, index) => [
      `src/file-${String(index)}.ts`,
      `export const sessionRenewal${String(index)} = true;\n`,
    ]),
  );
  mkdirSync(join(root, "src"));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  const deps = depsWith(config(true), (request) =>
    Promise.resolve({
      ok: true,
      value: { vector: vectorFor(request.input), modelId: request.modelId },
    }),
  );
  const pod = await seedRepositoryPod(
    deps,
    nodeWorkspaceFs,
    Object.keys(files),
    true,
    ":memory:",
    root,
  );
  return {
    root,
    files,
    deps,
    pod,
    close: (): void => {
      pod.store.close();
      deps.store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function pausedFingerprintRead(
  fixture: StaleFixture,
  sameSize = true,
): {
  readonly fs: WorkspaceFs;
  readonly entered: Promise<void>;
  readonly finish: () => void;
  readonly stat: ReturnType<typeof vi.fn<WorkspaceFs["stat"]>>;
  readonly realPath: ReturnType<typeof vi.fn<WorkspaceFs["realPath"]>>;
  readonly cleanup: ReturnType<typeof vi.fn>;
} {
  if (sameSize) fixture.files["src/auth.ts"] = "export const sessionState = 'changed';\n";
  let enter: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release: (bytes: Uint8Array) => void = () => undefined;
  const read = new Promise<Uint8Array>((resolve) => {
    release = resolve;
  });
  const cleanup = vi.fn();
  const stat = vi.fn(fixture.fs.stat);
  const realPath = vi.fn(fixture.fs.realPath);
  const fs: WorkspaceFs = {
    ...fixture.fs,
    stat,
    realPath,
    readFileBytes: (): Promise<Uint8Array> => {
      enter();
      return read.finally(cleanup);
    },
  };
  return {
    fs,
    entered,
    cleanup,
    stat,
    realPath,
    finish: (): void => {
      release(new TextEncoder().encode(fixture.files["src/auth.ts"] ?? ""));
    },
  };
}

async function searchMissingCandidate(
  provider: SemanticSearchProvider,
): Promise<readonly SemanticSearchMatch[]> {
  return provider.search({
    query: QUERY,
    documents: [],
  });
}

function unavailablePod(mode: string): RepositoryPodSemanticSearchContext | undefined {
  if (mode === "pod-absent") return undefined;
  const store = openKnowledgeStore({ dbPath: ":memory:" });
  store.close();
  return { store, repositoryRoot: ROOT };
}

function unavailablePodFiles(): Record<string, string> {
  return {
    ...Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        `deep/group-${String(index)}/manual.txt`,
        "Ordinary handbook background.\n".repeat(100),
      ]),
    ),
    "src/auth.ts": "export const note = 'session renewal refresh token';\n",
  };
}

async function retrieveWithOptionalProvider(
  fs: WorkspaceFs,
  provider: SemanticSearchProvider | undefined,
  activityLog: ReturnType<typeof createBufferedServerLogSink>,
): ReturnType<typeof retrieveConnectedContextPack> {
  return retrieveConnectedContextPack(
    {
      workspaceRoot: ROOT,
      scope: {
        schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
        scopeId: "unavailable-pod",
        workspaceRoot: ROOT,
        kind: "workspace-root",
        relativePaths: [],
        conversationId: undefined,
        connectedAtMs: 1,
        explicitConnection: true,
      },
      query: { ...QUERY, text: "Investigate session renewal" },
    },
    {
      correlationId: "unavailable-pod-review-0001",
      activityLog,
      fs,
      nowMs: () => 1,
      detectWorkspace: testWorkspace,
      answerer: { answer: () => Promise.resolve("") },
      ...(provider === undefined ? {} : { repoSemanticSearchProvider: provider }),
    },
  );
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

// #3416: a caller that reranks must be able to disclose WHICH index answered, without resolving the
// pod a second time — a second resolution could name a different pod than the one that searched.
describe("configuredRepoSemanticSearchProviderFor pod identity (#3416)", () => {
  it("reports the identity of the pod that answered", async () => {
    const files = { "src/auth.ts": "// refresh token\nexport const auth = 1;\n" };
    const embeddingRequest = vi.fn(async (request: OpenAIEmbeddingRequest) =>
      Promise.resolve({
        ok: true as const,
        value: { vector: vectorFor(request.input), modelId: request.modelId },
      }),
    );
    const deps = depsWith(config(true), embeddingRequest);
    const fs2 = testFs(files);
    const pod = await seedRepositoryPod(deps, fs2, Object.keys(files));
    const seen: { readonly capsuleId: string; readonly sourceId: string }[] = [];

    const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
      fs: fs2,
      repositoryPod: { store: pod.store, repositoryRoot: ROOT },
      observePodIdentity: (identity): void => void seen.push(identity),
    });

    expect(provider).toBeDefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.capsuleId.length).toBeGreaterThan(0);
    expect(seen[0]?.sourceId.length).toBeGreaterThan(0);
  });

  it("reports no identity when no pod resolves", () => {
    const embeddingRequest = vi.fn(async (request: OpenAIEmbeddingRequest) =>
      Promise.resolve({
        ok: true as const,
        value: { vector: vectorFor(request.input), modelId: request.modelId },
      }),
    );
    const deps = depsWith(config(true), embeddingRequest);
    const seen: unknown[] = [];

    configuredRepoSemanticSearchProviderFor(deps, undefined, {
      observePodIdentity: (identity): void => void seen.push(identity),
    });

    expect(seen).toHaveLength(0);
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

  it.each(["pod-absent", "pod-unavailable"])(
    "keeps full lexical search without a semantic session or document embedding: %s",
    async (mode) => {
      const embeddingRequest = vi.fn((): Promise<OpenAIEmbeddingOutcome> =>
        Promise.resolve({ ok: false, kind: "unsupported-model" }),
      );
      const deps = depsWith(config(true), embeddingRequest);
      const observations: RepositoryPodRetrievalObservation[] = [];
      const fs = testFs(unavailablePodFiles());
      const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
        fs,
        repositoryPod: unavailablePod(mode),
        observePodRetrieval: (observation) => observations.push(observation),
      });
      try {
        // The factory already resolved the pod. The observation must precede any workspace scan.
        expect(observations).toEqual([
          {
            mode,
            referenceCount: 0,
            denseCandidateCount: 0,
            lexicalCandidateCount: 0,
            lexicalOrFallbackUsed: true,
          },
        ]);
        const scope = { scopeId: "unavailable-pod", workspace: testWorkspace(), relativePaths: [] };
        const baseline = await searchText(scope, QUERY, undefined, { fs, nowMs: () => 1 });
        const result = await searchText(scope, QUERY, undefined, {
          fs,
          nowMs: () => 1,
          ...(provider === undefined ? {} : { semanticSearchProvider: provider }),
        });
        expect(result.atoms).toEqual(baseline.atoms);
        expect(result.atoms.map((atom) => atom.scopePath)).toContain("src/auth.ts");
        expect(result.coverage).toMatchObject({ filesScanned: 65, incomplete: false, reasons: [] });
        expect(result.coverage).toEqual(baseline.coverage);
        expect(provider).toBeUndefined();
        expect(embeddingRequest).not.toHaveBeenCalled();
        expect(observations).toHaveLength(1);
      } finally {
        deps.store.close();
      }
    },
  );

  it.each(["pod-absent", "pod-unavailable"])(
    "persists unavailable source decisions from the configured factory: %s",
    async (mode) => {
      const embeddingRequest = vi.fn((): Promise<OpenAIEmbeddingOutcome> =>
        Promise.resolve({ ok: false, kind: "unsupported-model" }),
      );
      const deps = depsWith(config(true), embeddingRequest);
      const fs = testFs(unavailablePodFiles());
      const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
        fs,
        repositoryPod: unavailablePod(mode),
      });
      try {
        const log = createBufferedServerLogSink();
        const result = await retrieveWithOptionalProvider(fs, provider, log);
        expect(result.pack.files.map((file) => file.scopePath)).toContain("src/auth.ts");
        const event = log.events.find(
          (entry) => entry.op === "search.connected-context.source-details",
        );
        expect(event?.extra).toMatchObject({
          semanticProviderDisposition: "unavailable",
          semanticProviderCallCount: 0,
        });
        expect(embeddingRequest).not.toHaveBeenCalled();
        expect(JSON.stringify(event)).not.toContain(ROOT);
        expect(JSON.stringify(event)).not.toContain("session renewal");
        const line = expectActivityLogProof(
          "search.connected-context.source-details.line",
          formatActivityLogProofLine(event ?? {}),
        );
        expect(line).toHaveProperty("correlationId", "unavailable-pod-review-0001");
      } finally {
        deps.store.close();
      }
    },
  );

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
    const windowHits = await provider.search({
      query: QUERY,
      documents: [
        {
          scopePath: "src/auth.ts",
          text: (files["src/auth.ts"] ?? "").split("\n").slice(1).join("\n"),
          startLine: 2,
        },
      ],
    });
    expect(windowHits).toEqual(hits);
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
        correlationId: undefined,
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
    const rawMatches = await provider.search({
      query: { ...QUERY, text: "Investigate session renewal in src/auth.ts" },
      documents: [{ scopePath: "src/auth.ts", text: files["src/auth.ts"] ?? "" }],
    });
    expect(rawMatches.find((match) => match.scopePath === "src/auth.ts")?.line).toBe(2);
    const search = await searchText(
      { workspace: testWorkspace(), scopeId: "repository-semantic-scope", relativePaths: [] },
      { ...QUERY, text: "Investigate session renewal in src/auth.ts" },
      undefined,
      { fs, semanticSearchProvider: provider, nowMs: () => 1 },
    );
    const searchAtom = search.atoms.find(
      (atom) =>
        atom.scopePath === "src/auth.ts" &&
        atom.provenance.tool.includes("configured-repo-semantic-search"),
    );
    // Search owns the precise matched line; assembly owns the subsequently read source window.
    expect(searchAtom?.lineRange).toEqual({ startLine: 2, endLine: 2 });
    expect(semanticAtom?.atom.lineRange).toEqual({ startLine: 1, endLine: 4 });
    expect(semanticAtom?.content).toBe(files["src/auth.ts"]);
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

  it("retains current lexical atoms and reports safe stale paths without reusing stale vectors", async () => {
    const fixture = await staleFixture();
    try {
      const search = await searchText(
        { scopeId: "stale-search", relativePaths: [], workspace: testWorkspace() },
        QUERY,
        undefined,
        {
          fs: fixture.fs,
          semanticSearchProvider: fixture.provider,
          nowMs: (): number => 1,
        },
      );
      expect(
        search.atoms.some(
          (atom) => atom.scopePath === "src/auth.ts" && atom.provenance.kind === "lexical-search",
        ),
      ).toBe(true);
      expect(search.atoms.some((atom) => atom.provenance.kind === "semantic-search")).toBe(false);
      expect(fixture.observed).toHaveBeenLastCalledWith({
        stalePaths: ["src/auth.ts", "src/peer.ts"],
        refreshedPaths: [],
        unavailableFileCount: 0,
      });
      expect(fixture.embedding).not.toHaveBeenCalled();
    } finally {
      fixture.close();
    }
  });

  it("refuses optional refresh without a request-local usage grant", async () => {
    const fixture = await staleFixture();
    const readFileBytes = vi.fn(fixture.fs.readFileBytes);
    try {
      const provider = refreshProviderFor(fixture, {
        fs: { ...fixture.fs, readFileBytes },
        semanticRefreshFilesMax: 1,
        tryReserveRefreshUsage: undefined,
      });
      expect(await searchStaleFixture(fixture, provider)).toEqual([]);
      expect(fixture.embedding).not.toHaveBeenCalled();
      expect(readFileBytes).not.toHaveBeenCalled();
    } finally {
      fixture.close();
    }
  });

  it.each(["query-tokens", "file-count", "bytes", "document-tokens"])(
    "refuses optional refresh before %s exceeds the actual governor",
    async (dimension) => {
      const fixture = await staleFixture();
      const readFileBytes = vi.fn(fixture.fs.readFileBytes);
      const identity = listCapsules(fixture.store)[0]?.embeddingModelIdentity;
      if (identity === undefined) throw new TypeError("Expected the indexed embedding identity");
      const queryBytes = Buffer.byteLength(shapeEmbeddingQuery(identity, QUERY.text), "utf8");
      const budgets: Readonly<Record<string, Partial<ExplorationBudget>>> = {
        "query-tokens": { modelInputTokensMax: 0 },
        "file-count": { filesReadMax: 0 },
        bytes: { excerptBytesMax: 1 },
        "document-tokens": { modelInputTokensMax: queryBytes },
      };
      const grant = refreshBudgetGrant(budgets[dimension]);
      try {
        const provider = refreshProviderFor(fixture, {
          fs: { ...fixture.fs, readFileBytes },
          semanticRefreshFilesMax: 1,
          tryReserveRefreshUsage: grant.reserve,
        });
        expect(await searchStaleFixture(fixture, provider)).toEqual([]);
        expect(fixture.embedding).toHaveBeenCalledTimes(dimension === "query-tokens" ? 0 : 1);
        expect(readFileBytes).toHaveBeenCalledTimes(dimension === "document-tokens" ? 1 : 0);
        expect(grant.usage().modelInputTokens).toBe(dimension === "query-tokens" ? 0 : queryBytes);
        expect(grant.usage().filesRead).toBe(dimension === "document-tokens" ? 1 : 0);
      } finally {
        fixture.close();
      }
    },
  );

  it.each([
    { ceiling: "0", embeddingCalls: 0, reads: 0, hits: 0 },
    { ceiling: "0.01", embeddingCalls: 1, reads: 1, hits: 0 },
    { ceiling: "1", embeddingCalls: 2, reads: 1, hits: 1 },
  ])("uses the actual embedding spend ledger with ceiling $ceiling", async (expected) => {
    const fixture = await staleFixture();
    const root = mkdtempSync(join(tmpdir(), "keiko-semantic-refresh-spend-"));
    const log = createBufferedServerLogSink();
    const writer = vi.spyOn(processServerLogSink(), "write").mockImplementation(log.write);
    const readFileBytes = vi.fn(fixture.fs.readFileBytes);
    const configured = pricedRefreshFixture(fixture);
    try {
      const provider = refreshProviderFor(
        configured,
        {
          fs: { ...fixture.fs, readFileBytes },
          semanticRefreshFilesMax: 1,
          correlationId: "semantic-refresh-spend-control",
        },
        {
          [QUALIFICATION_SPEND_BUDGET_USD_ENV]: expected.ceiling,
          [QUALIFICATION_SPEND_LEDGER_PATH_ENV]: join(root, "spend.db"),
        },
      );
      expect(await searchStaleFixture(fixture, provider)).toHaveLength(expected.hits);
      expect(fixture.embedding).toHaveBeenCalledTimes(expected.embeddingCalls);
      expect(readFileBytes).toHaveBeenCalledTimes(expected.reads);
      const reserved = log.events.filter((event) => event.op === "gateway.spend.reserved");
      const settled = log.events.filter((event) => event.op === "gateway.spend.settled");
      expect(reserved).toHaveLength(expected.embeddingCalls);
      expect(settled).toHaveLength(expected.embeddingCalls);
      for (const [index, event] of settled.entries()) {
        expect(event.extra?.measured).toBe(false);
        expect(event.extra?.chargedNanoUsd).toBeGreaterThan(0);
        expect(event.extra?.chargedNanoUsd).toBe(reserved[index]?.extra?.reservedNanoUsd);
        expectActivityLogProof("gateway.spend.settled.line", formatActivityLogProofLine(event));
      }
      expectRefreshSpendRejection(log, expected.hits === 0);
      const logged = JSON.stringify(log.events);
      expect(logged).not.toContain("session renewal");
      expect(logged).not.toContain("Path: ");
      expect(logged).not.toContain("https://embedding.example");
      expect(logged).not.toContain("embedding-key");
    } finally {
      writer.mockRestore();
      fixture.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("settles an aborted refresh embedding once without late reads or observation resurrection", async () => {
    const fixture = await staleFixture();
    const pending = pausedRefreshEmbedding(fixture);
    const root = mkdtempSync(join(tmpdir(), "keiko-semantic-refresh-abort-"));
    const log = createBufferedServerLogSink();
    const writer = vi.spyOn(processServerLogSink(), "write").mockImplementation(log.write);
    const readFileBytes = vi.fn(fixture.fs.readFileBytes);
    const controller = new AbortController();
    try {
      const provider = refreshProviderFor(
        pricedRefreshFixture(fixture),
        {
          fs: { ...fixture.fs, readFileBytes },
          semanticRefreshFilesMax: 1,
        },
        {
          [QUALIFICATION_SPEND_BUDGET_USD_ENV]: "1",
          [QUALIFICATION_SPEND_LEDGER_PATH_ENV]: join(root, "spend.db"),
        },
      );
      const work = provider.search({
        query: QUERY,
        signal: controller.signal,
        documents: Object.entries(fixture.files).map(([scopePath, text]) => ({ scopePath, text })),
      });
      await pending.entered;
      controller.abort();
      expect(await work).toEqual([]);
      expect(log.events.filter((event) => event.op === "gateway.spend.settled")).toHaveLength(1);
      expect(readFileBytes).not.toHaveBeenCalled();
      const observation = structuredClone(fixture.observed.mock.lastCall?.[0]);
      expect(observation).toMatchObject({
        refreshUsage: { embeddingCallCount: 1, readFileCount: 0 },
      });
      pending.finish();
      await pending.finished;
      await Promise.resolve();
      expect(fixture.observed).toHaveBeenCalledTimes(1);
      expect(fixture.observed.mock.lastCall?.[0]).toEqual(observation);
      expect(log.events.filter((event) => event.op === "gateway.spend.settled")).toHaveLength(1);
      expect(readFileBytes).not.toHaveBeenCalled();
    } finally {
      pending.finish();
      writer.mockRestore();
      fixture.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes only explicitly enabled bounded live fragments", async () => {
    const fixture = await staleFixture({
      semanticRefreshFilesMax: 1,
      deadlineAtMs: 1_001,
      nowMs: (): number => 1,
    });
    try {
      const hits = await fixture.provider.search({
        query: QUERY,
        documents: Object.entries(fixture.files).map(([scopePath, text]) => ({ scopePath, text })),
      });
      expect(hits.map((hit) => hit.scopePath)).toEqual(["src/auth.ts"]);
      expect(fixture.observed).toHaveBeenLastCalledWith({
        stalePaths: ["src/auth.ts", "src/peer.ts"],
        refreshedPaths: ["src/auth.ts"],
        unavailableFileCount: 0,
        refreshUsage: {
          embeddingCallCount: fixture.embedding.mock.calls.length,
          readFileCount: 1,
          readBytes: Buffer.byteLength(fixture.files["src/auth.ts"] ?? "", "utf8"),
          inputTokens: fixture.embedding.mock.calls.reduce(
            (total, [request]) => total + Buffer.byteLength(request.input, "utf8"),
            0,
          ),
        },
      });
      const fragments = fixture.embedding.mock.calls.filter(([request]) =>
        request.input.startsWith("Path: "),
      );
      expect(fragments).toHaveLength(1);
      expect(fragments[0]?.[0].input).toContain("session renewal changed");
      const identity = listCapsules(fixture.store)[0]?.embeddingModelIdentity;
      if (identity === undefined) throw new Error("expected seeded embedding identity");
      expect(hits[0]?.score).toBeCloseTo(
        scoreVector(
          identity.vectorMetric,
          l2NormalizeVector(vectorFor(shapeEmbeddingQuery(identity, QUERY.text))),
          l2NormalizeVector(vectorFor(fragments[0]?.[0].input ?? "")),
        ),
      );
    } finally {
      fixture.close();
    }
  });

  it.each([-1, Number.NaN, Infinity, 1.5])(
    "does not embed documents for an invalid explicit refresh cap %s",
    async (semanticRefreshFilesMax) => {
      const fixture = await staleFixture({
        semanticRefreshFilesMax,
        deadlineAtMs: 1_001,
        nowMs: (): number => 1,
      });
      try {
        expect(await searchStaleFixture(fixture)).toEqual([]);
        expect(fixture.embedding).not.toHaveBeenCalled();
      } finally {
        fixture.close();
      }
    },
  );

  it.each(["-1", "1.5", "Infinity", "eight"])(
    "keeps a malformed environment refresh opt-in %s disabled",
    async (value) => {
      const fixture = await staleFixture();
      try {
        const provider = refreshProviderFor(
          fixture,
          {},
          {
            KEIKO_REPO_SEMANTIC_REFRESH_FILES_MAX: value,
          },
        );
        expect(await searchStaleFixture(fixture, provider)).toEqual([]);
        expect(fixture.embedding).not.toHaveBeenCalled();
      } finally {
        fixture.close();
      }
    },
  );

  it("lets an explicit zero refresh cap override an environment opt-in", async () => {
    const fixture = await staleFixture();
    try {
      const provider = refreshProviderFor(
        fixture,
        { semanticRefreshFilesMax: 0 },
        {
          KEIKO_REPO_SEMANTIC_REFRESH_FILES_MAX: "8",
        },
      );
      expect(await searchStaleFixture(fixture, provider)).toEqual([]);
      expect(fixture.embedding).not.toHaveBeenCalled();
    } finally {
      fixture.close();
    }
  });

  it("caps enabled refreshes at eight files and leaves persisted fingerprints untouched", async () => {
    const fixture = await staleFixture({ maxCandidates: 32 }, 10);
    try {
      const fingerprints = readRepositoryFileFingerprints(
        fixture.store,
        POD_CAPSULE_ID,
        POD_SOURCE_ID,
      );
      const provider = refreshProviderFor(fixture, { semanticRefreshFilesMax: 100 });
      const hits = await searchStaleFixture(fixture, provider);
      expect(hits).toHaveLength(4);
      expect(
        fixture.embedding.mock.calls.filter(([request]) => request.input.startsWith("Path: ")),
      ).toHaveLength(8);
      expect(fixture.observed.mock.lastCall?.[0]).toMatchObject({
        stalePaths: Object.keys(fixture.files),
        refreshedPaths: Object.keys(fixture.files).slice(0, 8),
      });
      expect(readRepositoryFileFingerprints(fixture.store, POD_CAPSULE_ID, POD_SOURCE_ID)).toEqual(
        fingerprints,
      );
    } finally {
      fixture.close();
    }
  });

  it("falls back if a refreshed file changes while document embedding is awaited", async () => {
    const fixture = await staleFixture({
      semanticRefreshFilesMax: 1,
      deadlineAtMs: 1_001,
      nowMs: (): number => 1,
    });
    try {
      fixture.embedding.mockImplementation((request) => {
        if (request.input.startsWith("Path: ")) fixture.files["src/auth.ts"] = "changed again";
        return Promise.resolve({
          ok: true,
          value: { modelId: request.modelId, vector: vectorFor(request.input) },
        });
      });
      expect(await searchStaleFixture(fixture)).toEqual([]);
      expect(fixture.observed.mock.lastCall?.[0]).toMatchObject({ refreshedPaths: [] });
    } finally {
      fixture.close();
    }
  });

  it.each(["model", "dimension", "nonfinite"])(
    "rejects an incompatible %s document vector without a stale semantic hit",
    async (failure) => {
      const fixture = await staleFixture({
        semanticRefreshFilesMax: 1,
        deadlineAtMs: 1_001,
        nowMs: (): number => 1,
      });
      try {
        fixture.embedding.mockImplementation((request) =>
          Promise.resolve({
            ok: true,
            value: {
              modelId:
                request.input.startsWith("Path: ") && failure === "model"
                  ? "other-model"
                  : request.modelId,
              vector: request.input.startsWith("Path: ")
                ? invalidRefreshVector(failure)
                : vectorFor(request.input),
            },
          }),
        );
        expect(await searchStaleFixture(fixture)).toEqual([]);
        expect(fixture.observed.mock.lastCall?.[0]).toMatchObject({ refreshedPaths: [] });
      } finally {
        fixture.close();
      }
    },
  );

  it("does not send an oversized or binary changed file for embedding", async () => {
    const fixture = await staleFixture();
    try {
      fixture.files["src/auth.ts"] = "x".repeat(16_385);
      fixture.files["src/peer.ts"] = "session renewal\u0000binary";
      const readFileBytes = fixture.fs.readFileBytes;
      const fs = { ...fixture.fs, readFileBytes: vi.fn(readFileBytes) };
      const provider = refreshProviderFor(fixture, { fs, semanticRefreshFilesMax: 8 });
      expect(await searchStaleFixture(fixture, provider)).toEqual([]);
      expect(
        fixture.embedding.mock.calls.some(([request]) => request.input.startsWith("Path: ")),
      ).toBe(false);
      expect(
        fs.readFileBytes.mock.calls.some(([path]) => path === absolutePath("src/auth.ts")),
      ).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it("uses the real configured lease for explicit environment-enabled live refresh", async () => {
    const { fixture, deps, close } = await leaseFixture();
    const observePodIdentity = vi.fn();
    const lease = configuredRepoSemanticSearchProviderLeaseFor(deps, undefined, ROOT, {
      fs: fixture.fs,
      nowMs: (): number => 1,
      deadlineAtMs: 1_001,
      observePodIdentity,
      observeSemanticFreshness: fixture.observed,
      tryReserveRefreshUsage: refreshBudgetGrant().reserve,
    });
    try {
      if (lease.provider === undefined) throw new Error("expected configured lease provider");
      const hits = await searchStaleFixture(fixture, lease.provider);
      expect(hits.map((hit) => hit.scopePath)).toContain("src/auth.ts");
      expect(lease.indexIdentityDigest).toMatch(/^[a-f\d]{64}$/u);
      expect(observePodIdentity).toHaveBeenCalledWith({
        capsuleId: POD_CAPSULE_ID,
        sourceId: POD_SOURCE_ID,
      });
      expect(fixture.observed.mock.lastCall?.[0]).toMatchObject({
        stalePaths: ["src/auth.ts"],
        refreshedPaths: ["src/auth.ts"],
      });
      const calls = fixture.embedding.mock.calls.map(([request]) => request);
      expect(calls.some((request) => request.input.startsWith("Path: src/auth.ts\n"))).toBe(true);
      expect(calls.every((request) => request.apiKeyHeaderName === "x-api-key")).toBe(true);
    } finally {
      lease.close();
      close();
    }
  });

  it.each(["/outside/auth.ts", `${ROOT}/.env`])(
    "does not read or refresh an unsafe canonical alias %s",
    async (alias) => {
      const fixture = await staleFixture();
      try {
        const readFileBytes = vi.fn(fixture.fs.readFileBytes);
        const fs = {
          ...fixture.fs,
          readFileBytes,
          realPath: (path: string): string => (path === absolutePath("src/auth.ts") ? alias : path),
        };
        const provider = refreshProviderFor(fixture, { fs, semanticRefreshFilesMax: 8 });
        expect(
          await provider.search({
            query: QUERY,
            documents: [{ scopePath: "src/auth.ts", text: fixture.files["src/auth.ts"] ?? "" }],
          }),
        ).toEqual([]);
        expect(readFileBytes).not.toHaveBeenCalled();
        expect(fixture.embedding).not.toHaveBeenCalled();
        expect(fixture.observed.mock.lastCall?.[0]).toMatchObject({ unavailableFileCount: 1 });
      } finally {
        fixture.close();
      }
    },
  );

  it("does not send invalid UTF-8 bytes for document embedding", async () => {
    const fixture = await staleFixture();
    try {
      const fs = {
        ...fixture.fs,
        readFileBytes: (path: string): Promise<Uint8Array> =>
          Promise.resolve(new Uint8Array(fixture.fs.stat(path).size).fill(255)),
      };
      const provider = refreshProviderFor(fixture, { fs, semanticRefreshFilesMax: 8 });
      expect(await searchStaleFixture(fixture, provider)).toEqual([]);
      expect(
        fixture.embedding.mock.calls.some(([request]) => request.input.startsWith("Path: ")),
      ).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it("redacts live document input through the configured dependency redactor", async () => {
    const fixture = await staleFixture();
    try {
      fixture.files["src/auth.ts"] = "export const secret = 'embedding-key'; // session renewal\n";
      const provider = refreshProviderFor(fixture, { semanticRefreshFilesMax: 1 });
      expect(await searchStaleFixture(fixture, provider)).toHaveLength(1);
      const fragment = fixture.embedding.mock.calls.find(([request]) =>
        request.input.startsWith("Path: "),
      );
      expect(fragment?.[0].input).not.toContain("embedding-key");
      expect(fragment?.[0].input).toContain("session renewal");
    } finally {
      fixture.close();
    }
  });

  it("stops before live refresh reads when the query embedding consumes the remaining deadline", async () => {
    const fixture = await staleFixture();
    let now = 1;
    try {
      const readFileBytes = vi.fn(fixture.fs.readFileBytes);
      const provider = refreshProviderFor(fixture, {
        fs: { ...fixture.fs, readFileBytes },
        semanticRefreshFilesMax: 8,
        nowMs: (): number => now,
        deadlineAtMs: 100,
      });
      fixture.embedding.mockImplementation((request) => {
        now = 100;
        return Promise.resolve({
          ok: true,
          value: {
            vector: vectorFor(request.input),
            modelId: request.modelId,
          },
        });
      });
      expect(await searchStaleFixture(fixture, provider)).toEqual([]);
      expect(fixture.embedding).toHaveBeenCalledTimes(1);
      expect(readFileBytes).not.toHaveBeenCalled();
    } finally {
      fixture.close();
    }
  });

  it("reuses a validated freshness preflight with bounded pre/post-read metadata checks", async () => {
    const fixture = await realFingerprintFixture(32);
    const read = nodeWorkspaceFs.readFileBytes;
    if (read === undefined) throw new TypeError("Expected the bounded node reader");
    const readFileBytes = vi.fn(read);
    const stat = vi.fn(nodeWorkspaceFs.stat);
    const realPath = vi.fn(nodeWorkspaceFs.realPath);
    try {
      const provider = configuredRepoSemanticSearchProviderFor(fixture.deps, undefined, {
        fs: { ...nodeWorkspaceFs, readFileBytes, stat, realPath },
        repositoryPod: { store: fixture.pod.store, repositoryRoot: fixture.root },
      });
      if (provider === undefined) throw new TypeError("Expected the configured provider");
      stat.mockClear();
      realPath.mockClear();
      const documents = Object.entries(fixture.files).map(([scopePath, text]) => ({
        scopePath,
        text,
      }));
      const result = await provider.search({ query: { ...QUERY, maxResults: 32 }, documents });
      expect(result).toHaveLength(documents.length);
      expect(readFileBytes).toHaveBeenCalledTimes(documents.length);
      expect.soft(realPath.mock.calls.length).toBeLessThanOrEqual(128);
      expect.soft(stat.mock.calls.length).toBeLessThanOrEqual(96);
      for (const call of readFileBytes.mock.calls) {
        expect(call[2]).toBe("reject");
        expect(call[3].fileIdentity).toBeDefined();
        expect(call[3].size).toBeGreaterThan(0);
      }
    } finally {
      fixture.close();
    }
  });

  it.each(["healthy", "pre-aborted", "first-read-aborted"])(
    "bounds real eight-file pod fingerprint reads when %s",
    async (state) => {
      const fixture = await realFingerprintFixture();
      const controller = new AbortController();
      let completedReads = 0;
      const readFileBytes = vi.fn<NonNullable<WorkspaceFs["readFileBytes"]>>(async (...args) => {
        const bytes = await nodeWorkspaceFs.readFileBytes?.(...args);
        if (bytes === undefined) throw new Error("expected bounded node reader");
        completedReads += 1;
        if (state === "first-read-aborted" && completedReads === 1) controller.abort();
        return bytes;
      });
      const provider = configuredRepoSemanticSearchProviderFor(fixture.deps, undefined, {
        fs: { ...nodeWorkspaceFs, readFileBytes },
        repositoryPod: { store: fixture.pod.store, repositoryRoot: fixture.root },
      });
      if (provider === undefined) throw new Error("expected configured provider");
      try {
        if (state === "pre-aborted") controller.abort();
        const result = await provider.search({
          query: QUERY,
          signal: controller.signal,
          documents: Object.entries(fixture.files).map(([scopePath, text]) => ({
            scopePath,
            text,
          })),
        });
        expect(readFileBytes).toHaveBeenCalledTimes(
          state === "healthy" ? 8 : state === "pre-aborted" ? 0 : 1,
        );
        if (state !== "healthy") expect(result).toEqual([]);
      } finally {
        fixture.close();
      }
    },
  );

  it.each(["elapsed", "aborted"])(
    "stops freshness I/O after a deferred fingerprint read is %s",
    async (stop) => {
      const fixture = await staleFixture();
      const paused = pausedFingerprintRead(fixture);
      const controller = new AbortController();
      let now = 1;
      const provider = refreshProviderFor(fixture, {
        fs: paused.fs,
        nowMs: (): number => now,
        deadlineAtMs: 100,
        semanticRefreshFilesMax: 8,
      });
      let settled = false;
      const search = provider
        .search({
          query: QUERY,
          signal: controller.signal,
          documents: Object.entries(fixture.files).map(([scopePath, text]) => ({
            scopePath,
            text,
          })),
        })
        .finally(() => {
          settled = true;
        });
      try {
        await paused.entered;
        paused.stat.mockClear();
        paused.realPath.mockClear();
        if (stop === "elapsed") {
          now = 100;
          paused.finish();
        } else controller.abort();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled).toBe(true);
        expect(await search).toEqual([]);
        expect(paused.stat).not.toHaveBeenCalled();
        expect(paused.realPath).not.toHaveBeenCalled();
        expect(fixture.embedding).not.toHaveBeenCalled();
        const observationCount = fixture.observed.mock.calls.length;
        paused.finish();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(fixture.observed).toHaveBeenCalledTimes(observationCount);
        expect(paused.stat).not.toHaveBeenCalled();
        expect(paused.realPath).not.toHaveBeenCalled();
        expect(fixture.embedding).not.toHaveBeenCalled();
      } finally {
        paused.finish();
        await search;
        expect(paused.cleanup).toHaveBeenCalledTimes(1);
        fixture.close();
      }
    },
  );

  it("cancels a deferred live refresh read before document embedding or later metadata", async () => {
    const fixture = await staleFixture();
    const paused = pausedFingerprintRead(fixture, false);
    const controller = new AbortController();
    const provider = refreshProviderFor(fixture, {
      fs: paused.fs,
      nowMs: (): number => 1,
      deadlineAtMs: 100,
      semanticRefreshFilesMax: 8,
    });
    let settled = false;
    const search = provider
      .search({
        query: QUERY,
        signal: controller.signal,
        documents: Object.entries(fixture.files).map(([scopePath, text]) => ({ scopePath, text })),
      })
      .finally(() => {
        settled = true;
      });
    try {
      await paused.entered;
      paused.stat.mockClear();
      paused.realPath.mockClear();
      controller.abort();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(true);
      expect(await search).toEqual([]);
      expect(fixture.embedding).toHaveBeenCalledTimes(1);
      paused.finish();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(paused.stat).not.toHaveBeenCalled();
      expect(paused.realPath).not.toHaveBeenCalled();
      expect(fixture.embedding).toHaveBeenCalledTimes(1);
    } finally {
      paused.finish();
      await search;
      expect(paused.cleanup).toHaveBeenCalledTimes(1);
      fixture.close();
    }
  });

  it("keeps freshness unknown and performs no I/O after the explicit request deadline", async () => {
    const fixture = await staleFixture({
      semanticRefreshFilesMax: 8,
      deadlineAtMs: 1,
      nowMs: (): number => 1,
    });
    const stat = vi.spyOn(fixture.fs, "stat");
    const realPath = vi.spyOn(fixture.fs, "realPath");
    const read = vi.spyOn(fixture.fs, "readFileBytes");
    try {
      await expect(
        fixture.provider.search({
          query: QUERY,
          documents: Object.entries(fixture.files).map(([scopePath, text]) => ({
            scopePath,
            text,
          })),
        }),
      ).resolves.toEqual([]);
      expect(fixture.embedding).not.toHaveBeenCalled();
      expect(fixture.observed).not.toHaveBeenCalled();
      expect(stat).not.toHaveBeenCalled();
      expect(realPath).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally {
      fixture.close();
    }
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
    expect(readFileBytes).toHaveBeenCalledWith(
      absolutePath("src/auth.ts"),
      indexedText.length + 1,
      "reject",
      expect.objectContaining({
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        size: Buffer.byteLength(liveText),
      }),
    );
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
      readFileBytes: (path, maxBytes, hardLinkPolicy, expected) =>
        readsFail
          ? Promise.reject(new Error("READ_BLOCKED"))
          : (baseFs.readFileBytes?.(path, maxBytes, hardLinkPolicy, expected) ??
            Promise.reject(new Error("NO_READER"))),
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
    const fs = testFs({ "src/auth.ts": "export const note = 'session renewal';\n" });
    const pod = await seedRepositoryPod(deps, fs, ["src/auth.ts"]);
    embeddingRequest.mockClear();
    const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
      fs,
      maxCandidates: 8,
      repositoryPod: { store: pod.store, repositoryRoot: ROOT },
    });
    if (provider === undefined) throw new Error("expected semantic provider");

    await expect(searchMissingCandidate(provider)).resolves.toEqual([]);
    expect(embeddingRequest).not.toHaveBeenCalled();
    pod.store.close();
    deps.store.close();
  });
});
