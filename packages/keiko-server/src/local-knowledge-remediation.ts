import { createHash } from "node:crypto";
import type {
  EmbeddingModelIdentity,
  KnowledgeCapsule,
  KnowledgeCapsuleId,
  KnowledgeSource,
} from "@oscharko-dev/keiko-contracts";
import { DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY } from "@oscharko-dev/keiko-contracts";
import {
  createDefaultParserRegistry,
  createSqliteAuditSink,
  getCapsule,
  listCapsuleSources,
  listCapsules,
  runIndexingJob,
  updateCapsuleEmbeddingModelIdentity,
  type KnowledgeStore,
  type KnowledgeStoreKeyProvider,
} from "@oscharko-dev/keiko-local-knowledge";
import {
  findConfiguredCapability,
  requestOpenAIEmbedding,
  requestOpenAIEmbeddingBatch,
  verifyEmbeddingCapability,
  type GatewayConfig,
  type ModelProviderConfig,
  type OpenAIEmbeddingAdapter,
  type OpenAIEmbeddingBatchOutcome,
  type OpenAIEmbeddingBatchRequest,
  type OpenAIEmbeddingOutcome,
  type OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import { isDenied } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { localKnowledgeIndexingRegistry } from "./local-knowledge-indexing-registry.js";
import {
  inspectRemediationStore,
  openRemediationStore,
  type LocalKnowledgeRemediationScope,
} from "./local-knowledge-remediation-store.js";

export type { LocalKnowledgeRemediationScope } from "./local-knowledge-remediation-store.js";

export interface LocalKnowledgeRemediationRunResult {
  readonly status: "completed" | "failed";
  readonly scope: LocalKnowledgeRemediationScope;
  readonly failedCapsules: number;
  readonly message: string;
}

export interface LocalKnowledgeRemediationPort {
  readonly inspect: () => LocalKnowledgeRemediationScope;
  readonly reindexAll: () => Promise<LocalKnowledgeRemediationRunResult>;
}

export interface CreateLocalKnowledgeRemediationPortOptions {
  readonly runtimeStateDir?: string | undefined;
  readonly currentConfig: () => GatewayConfig | undefined;
  readonly keyProvider?: KnowledgeStoreKeyProvider | undefined;
  readonly embeddingRequest?:
    ((request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome>) | undefined;
  readonly embeddingBatchRequest?:
    ((request: OpenAIEmbeddingBatchRequest) => Promise<OpenAIEmbeddingBatchOutcome>) | undefined;
}

function normalizedEndpointFingerprint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function embeddingProviderIdentity(provider: ModelProviderConfig): string {
  return `openai-compatible:${normalizedEndpointFingerprint(provider.baseUrl)}`;
}

function storedProviderMatchesConfiguredProvider(
  storedProvider: string,
  provider: ModelProviderConfig,
): boolean {
  if (!storedProvider.startsWith("openai-compatible:")) return true;
  return storedProvider === embeddingProviderIdentity(provider);
}

function isEmbeddingProvider(config: GatewayConfig, provider: ModelProviderConfig): boolean {
  return findConfiguredCapability(config, provider.modelId)?.kind === "embedding";
}

function configuredProviderForCapsule(
  config: GatewayConfig | undefined,
  capsule: KnowledgeCapsule,
): ModelProviderConfig | undefined {
  if (config === undefined) return undefined;
  const provider = config.providers.find(
    (entry) => entry.modelId === capsule.embeddingModelIdentity.modelId,
  );
  if (provider === undefined || !isEmbeddingProvider(config, provider)) return undefined;
  return storedProviderMatchesConfiguredProvider(capsule.embeddingModelIdentity.provider, provider)
    ? provider
    : undefined;
}

function embeddingIdentityMatchesCapsuleAlias(
  stored: EmbeddingModelIdentity,
  current: EmbeddingModelIdentity,
): boolean {
  if (
    stored.provider !== current.provider ||
    stored.vectorDimensions !== current.vectorDimensions ||
    stored.vectorMetric !== current.vectorMetric
  ) {
    return false;
  }
  return stored.modelId === current.modelId || stored.modelId === current.modelRevision;
}

async function resolveProviderForCapsule(
  options: CreateLocalKnowledgeRemediationPortOptions,
  store: KnowledgeStore,
  capsule: KnowledgeCapsule,
): Promise<
  { readonly capsule: KnowledgeCapsule; readonly provider: ModelProviderConfig } | undefined
> {
  const config = options.currentConfig();
  const exact = configuredProviderForCapsule(config, capsule);
  if (exact !== undefined) return { capsule, provider: exact };
  if (config === undefined) return undefined;
  for (const provider of config.providers) {
    if (!isEmbeddingProvider(config, provider)) continue;
    if (
      !storedProviderMatchesConfiguredProvider(capsule.embeddingModelIdentity.provider, provider)
    ) {
      continue;
    }
    const identity = await probeProvider(options, provider, capsule);
    if (
      identity !== undefined &&
      embeddingIdentityMatchesCapsuleAlias(capsule.embeddingModelIdentity, identity)
    ) {
      return {
        capsule: updateCapsuleEmbeddingModelIdentity(store, capsule.id, identity),
        provider,
      };
    }
  }
  return undefined;
}

async function probeProvider(
  options: CreateLocalKnowledgeRemediationPortOptions,
  provider: ModelProviderConfig,
  capsule: KnowledgeCapsule,
): Promise<EmbeddingModelIdentity | undefined> {
  try {
    const result = await verifyEmbeddingCapability(createEmbeddingAdapter(options, provider), {
      modelId: provider.modelId,
      provider: embeddingProviderIdentity(provider),
      vectorMetric: capsule.embeddingModelIdentity.vectorMetric,
      expectedDimensions: capsule.embeddingModelIdentity.vectorDimensions,
      timeoutMs: provider.timeoutMs,
    });
    return result.ok ? result.identity : undefined;
  } catch {
    return undefined;
  }
}

function createEmbeddingAdapter(
  options: CreateLocalKnowledgeRemediationPortOptions,
  provider: ModelProviderConfig,
): OpenAIEmbeddingAdapter {
  const providerCreds = {
    endpoint: provider.baseUrl,
    apiKey: provider.apiKey,
    ...(provider.apiKeyHeaderName === undefined
      ? {}
      : { apiKeyHeaderName: provider.apiKeyHeaderName }),
    ...(provider.egress === undefined ? {} : { egress: provider.egress }),
  };
  const requestImpl = options.embeddingRequest ?? requestOpenAIEmbedding;
  const batchImpl = options.embeddingBatchRequest ?? requestOpenAIEmbeddingBatch;
  return {
    ...providerCreds,
    request: (request) => requestImpl({ ...request, ...providerCreds }),
    requestBatch: (request) => batchImpl({ ...request, ...providerCreds }),
  };
}

function sourceRoot(scope: KnowledgeSource["scope"]): string {
  return scope.kind === "folder" || scope.kind === "files" ? scope.rootPath : scope.repositoryRoot;
}

function safeRealPath(path: string): string {
  try {
    return nodeWorkspaceFs.realPath(path);
  } catch {
    return path;
  }
}

function assertSourcesAllowed(store: KnowledgeStore, capsule: KnowledgeCapsule): void {
  for (const source of listCapsuleSources(store, capsule.id)) {
    if (isDenied(safeRealPath(sourceRoot(source.scope)))) {
      throw new Error("A Local Knowledge source path is in a denied location.");
    }
  }
}

function latestRunningJobId(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
): string | undefined {
  const row = store._internal.db
    .prepare(
      [
        "SELECT id",
        "FROM indexing_jobs",
        "WHERE capsule_id = :c AND status = 'running'",
        "ORDER BY started_at DESC, id DESC",
        "LIMIT 1",
      ].join(" "),
    )
    .get({ c: capsuleId }) as { readonly id: string } | undefined;
  return row?.id;
}

async function reindexCapsule(
  options: CreateLocalKnowledgeRemediationPortOptions,
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
): Promise<boolean> {
  const capsule = getCapsule(store, capsuleId);
  if (capsule === undefined || capsule.sourceIds.length === 0) return true;
  if (latestRunningJobId(store, capsule.id) !== undefined) return false;
  const resolved = await resolveProviderForCapsule(options, store, capsule);
  if (resolved === undefined) return false;
  assertSourcesAllowed(store, resolved.capsule);
  const controller = localKnowledgeIndexingRegistry.start(String(resolved.capsule.id));
  let completed = false;
  try {
    for await (const event of runIndexingJob({
      capsuleId: resolved.capsule.id,
      parserRegistry: createDefaultParserRegistry(),
      workspaceFs: nodeWorkspaceFs,
      embeddingAdapter: createEmbeddingAdapter(options, resolved.provider),
      auditSink: createSqliteAuditSink(store),
      store,
      force: true,
      resume: true,
      largeDocumentPolicy: DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY,
      signal: controller.signal,
    })) {
      if (event.kind === "job-started") {
        localKnowledgeIndexingRegistry.attachJobId(String(resolved.capsule.id), event.jobId);
      }
      if (event.kind === "job-completed") completed = true;
      if (event.kind === "job-failed" || event.kind === "job-cancelled") completed = false;
    }
  } finally {
    localKnowledgeIndexingRegistry.complete(String(resolved.capsule.id));
  }
  return completed;
}

export function createLocalKnowledgeRemediationPort(
  options: CreateLocalKnowledgeRemediationPortOptions,
): LocalKnowledgeRemediationPort {
  return {
    inspect: (): LocalKnowledgeRemediationScope => {
      const env = openRemediationStore(options);
      try {
        return inspectRemediationStore(env.store);
      } finally {
        env.close();
      }
    },
    reindexAll: async (): Promise<LocalKnowledgeRemediationRunResult> => {
      const env = openRemediationStore(options);
      try {
        const before = inspectRemediationStore(env.store);
        let failedCapsules = 0;
        for (const capsule of listCapsules(env.store)) {
          const ok = await reindexCapsule(options, env.store, capsule.id);
          failedCapsules += ok ? 0 : 1;
        }
        const scope = inspectRemediationStore(env.store);
        return {
          status: failedCapsules === 0 ? "completed" : "failed",
          scope: before.capsules === 0 ? before : scope,
          failedCapsules,
          message:
            failedCapsules === 0
              ? "Local Knowledge reindex completed."
              : "One or more Local Knowledge capsules could not be reindexed.",
        };
      } finally {
        env.close();
      }
    },
  };
}
