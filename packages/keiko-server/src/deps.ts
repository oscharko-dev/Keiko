// Wave 2 BFF handler dependencies (ADR-0011 D5/D8/D9). The Wave 1 skeleton's `UiServerDeps` carried
// only the static-serving + CSP + port fields; the JSON/SSE handlers additionally need the resolved
// gateway config (for the config inspector and for building a ModelPort), an evidence store, a live
// redactor, the process env, and the in-memory run registry. Every field here is OPTIONAL so the
// 3-arg `createUiServer({ staticRoot, csp, port })` form still compiles and the Wave 1 server tests
// pass unchanged; the handlers degrade gracefully (no config → 400 NO_MODEL on a run, null config on
// the inspector; no store → an empty evidence list).

import {
  createDefaultChatCapability,
  findConfiguredCapability,
  loadConfigFromFile,
  loadEgressConfigFromFile,
  parseGatewayConfig,
  resolveCodingSafeSidecarGatewayProfile,
  resolveOutboundHttpEgressConfig,
  selectConfiguredModel,
  type EnvSource,
  type GatewayConfig,
  type ModelProviderConfig,
} from "@oscharko-dev/keiko-model-gateway";
import { GatewayError, Gateway } from "@oscharko-dev/keiko-model-gateway";
import { GatewayModelPort } from "@oscharko-dev/keiko-harness";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { createAuditRedactor } from "@oscharko-dev/keiko-evidence";
import { resolveCostClass } from "@oscharko-dev/keiko-model-gateway";
import { writeSideFile } from "@oscharko-dev/keiko-evidence";
import { deepRedactStrings } from "@oscharko-dev/keiko-evidence";
import { keikoApiKeySecretValues } from "@oscharko-dev/keiko-security";
import {
  DEFAULT_CONTEXT_PROFILE,
  type CodingWorkbenchMode,
  type CodingWorkbenchModelSource,
  deriveContextProfileFromCapability,
  type ContextProfile,
  type UpdatePreflightReport,
} from "@oscharko-dev/keiko-contracts";
import type { IncomingMessage } from "node:http";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { createNodeEvidenceStore, resolveEvidenceDir } from "@oscharko-dev/keiko-evidence";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { RunRegistry } from "./runs.js";
import { createRunRegistry } from "./runs.js";
import type { ServerDiagnosticSink } from "./diagnostics-log.js";
import {
  assertUiDbOutsideProject,
  buildUiStoreOverDatabase,
  openNodeUiDatabase,
  resolveUiDbPath,
  validateProjectPath,
  type UiStore,
} from "./store/index.js";
import { createTerminalExecutionManager, type TerminalExecutionManager } from "./terminal.js";
import { createCommandRunnerManager, type CommandRunnerManager } from "./command-runner.js";
import {
  createUpdateSessionManager,
  type UpdateCompletionGate,
  type UpdateSessionManager,
} from "./update-session.js";
import { createStateDirUpdateSessionLock } from "./update-session-lock.js";
import {
  createUpdateLocalStateManager,
  type UpdateLocalStateManager,
} from "./update-local-state.js";
import { createPortableUpdateStager } from "./update-portable-staging.js";
import { createPortableUpdateActivator } from "./update-portable-activation.js";
import {
  createUpdateRemediationManager,
  type UpdateRemediationManager,
} from "./update-remediation.js";
import {
  createLocalKnowledgeRemediationPort,
  type LocalKnowledgeRemediationPort,
} from "./local-knowledge-remediation.js";
import {
  createContainerRunnerManager,
  type ContainerRunnerManager,
} from "./runtime/containerRunner.js";
import { createBrowserSessionManager, type BrowserSessionManager } from "@oscharko-dev/keiko-tools";
import { type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { MemoryReviewerId, MemoryScope } from "@oscharko-dev/keiko-contracts/memory";
import { createBffMemoryVault } from "./memory-handlers.js";
import {
  createMemoryAuditDeleteCommitHandler,
  createMemoryAuditHandler,
} from "./memory-audit-handler.js";
import { createEditorHotExitStore, type EditorHotExitStore } from "./editor/hotExitStore.js";
import {
  createConsolidationJobRegistry,
  type ConsolidationJobRegistry,
} from "./memory-consolidation-registry.js";
import type {
  OpenAIEmbeddingBatchOutcome,
  OpenAIEmbeddingBatchRequest,
  OpenAIEmbeddingOutcome,
  OpenAIEmbeddingRequest,
  RealtimeNegotiationOutcome,
  RealtimeNegotiationRequest,
  RerankOutcome,
  LiteLLMRerankRequest,
  SpeechToTextOutcome,
  SpeechToTextRequest,
  TextToSpeechOutcome,
  TextToSpeechRequest,
  TextToSpeechStreamOutcome,
} from "@oscharko-dev/keiko-model-gateway";
import {
  createRelationshipStorePort,
  type RelationshipHandlerDeps,
} from "./relationship-handlers.js";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import {
  buildWorkspaceInstanceStoreOverDatabase,
  type WorkspaceInstanceStore,
} from "./task-workspace/store.js";
import {
  buildActiveWorkspacePointerStoreOverDatabase,
  type ActiveWorkspacePointerStore,
} from "./task-workspace/active-store.js";
import { createWorkspaceProvisioningService } from "./task-workspace/provisioning.js";
import { createWorkspaceLifecycleService } from "./task-workspace/lifecycle.js";
import {
  createWorkspaceMutexRegistry,
  type WorkspaceMutexRegistry,
} from "./task-workspace/mutex.js";
import { createWorkspaceReconciliationService } from "./task-workspace/reconciliation.js";
import { createWorkspaceRepairService } from "./task-workspace/repair.js";
import { createWorkspaceHealthService } from "./task-workspace/health.js";
import { createWorkspaceCleanupService } from "./task-workspace/cleanup.js";
import type {
  WorkspaceCleanupService,
  WorkspaceHealthService,
  WorkspaceLifecycleService,
  WorkspaceProvisioningService,
  WorkspaceReconciliationService,
  WorkspaceRepairService,
} from "./task-workspace/types.js";
import { randomUUID } from "node:crypto";
import {
  resolveGroundingLimits,
  type GroundingLimits,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { EditorLanguageRouteOptions } from "./editor/languageRoutes.js";
import type { RuntimeCapabilityRouteOptions } from "./runtime/capabilityRoutes.js";
import type { GitRouteOptions } from "./gitRoutes.js";
import type { NativeFileDialogRouteOptions } from "./native-file-dialog/route.js";
import { createProviderSecretResolver, type ProviderSecretResolver } from "./credentialVault.js";
import { createLocalKnowledgeKeyProvider } from "./localKnowledgeKeyProvider.js";
import type {
  ContextualRetrievalChatGateway,
  KnowledgeStoreKeyProvider,
  OcrAdapter,
} from "@oscharko-dev/keiko-local-knowledge";
import type { GatewayRequest, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import { migrateLocalConfigCredentials } from "./credentialPersistence.js";
import {
  enforceQiRetentionAtStartup,
  type QiRetentionAuditSink,
} from "./qualityIntelligence/retentionEnforcement.js";
import type { PdfCitationPreviewSessionManager } from "./local-knowledge-preview-session-manager.js";
import {
  createServerWorkspaceIndexProvider,
  type WorkspaceIndexProvider,
} from "./workspace-index-provider.js";
import type { AutonomousDeliveryConnectorExecutor } from "./coding-runtime/autonomousDeliveryPolicy.js";
import {
  createAutonomousDeliveryApprovalStore,
  type AutonomousDeliveryApprovalStore,
} from "./coding-runtime/autonomousDeliveryApprovalStore.js";

// A redactor applied to every LIVE (non-manifest) payload before it reaches the browser (D9). It is
// `deepRedactStrings` composed with the audit redactor; reused, never a new regex.
export type Redactor = (value: unknown) => unknown;

// Builds a ModelPort for a run. The default builds a `GatewayModelPort` from the resolved config
// (mirroring the CLI); tests inject a deterministic fake so runs are offline. Throws/returns when no
// model can be built so the run route maps it to a 400 NO_MODEL — the BFF never calls a model
// directly, only through the harness/workflow entry points the port feeds.
export type ModelPortFactory = (modelId: string) => ModelPort | undefined;
export type CodingSidecarGatewayChatFactory = (
  config: GatewayConfig,
  modelId: string,
) => (request: GatewayRequest) => Promise<NormalizedResponse>;
type GatewayEgressConfig = NonNullable<GatewayConfig["egress"]>;

export interface MemoryAuthorizationContext {
  readonly reviewerId: MemoryReviewerId;
  readonly authorizedScopes: () => readonly MemoryScope[];
}

export interface QualityIntelligenceReviewPrincipal {
  readonly actorId: string;
  readonly displayLabel: string;
  readonly source?: string;
  readonly kind?: "human" | "system";
}

export type QualityIntelligenceReviewPrincipalResolver = (
  req: IncomingMessage,
) => QualityIntelligenceReviewPrincipal;

export interface RuntimeGatewayConfig {
  readonly storagePath: string;
  current(): GatewayConfig | undefined;
  present(): boolean;
  set(config: GatewayConfig | undefined, present: boolean): void;
}

export interface GatewayDiscoveredModels {
  readonly modelIds: readonly string[];
  readonly chatModelIds: readonly string[];
  readonly embeddingModelIds: readonly string[];
  readonly imageInputModelIds?: readonly string[];
}

export type GatewayModelDiscoveryOutput = readonly string[] | GatewayDiscoveredModels;
export type ContextProfileResolver = (modelId: string) => ContextProfile;
export type CodingSidecarGatewayModelSourceResolver = () => CodingWorkbenchModelSource;

export interface UiHandlerDeps {
  // The resolved gateway config, or undefined when no config file was provided / it failed to load.
  readonly config: GatewayConfig | undefined;
  // True when a config file path was supplied AND parsed successfully.
  readonly configPresent: boolean;
  // The evidence store the evidence routes read from.
  readonly evidenceStore: EvidenceStore;
  // Process environment for redaction (env-value scrubbing) and config resolution.
  readonly env: EnvSource;
  // Resolved outbound HTTP egress policy, including config-file-only Figma egress.
  readonly egress?: GatewayEgressConfig | undefined;
  // Live-payload redactor (D9). Applied to run reports, projections, and SSE event data.
  readonly redactor: Redactor;
  // RB-6 (GEN-OBS-DIAGNOSTICS-901/602/603) — operator diagnostic sink for server-side error causes.
  // Optional: when undefined the server falls back to the default stderr sink. Tests inject a
  // capturing sink to assert that a handler throw / mid-stream failure emits a correlation-keyed,
  // redacted diagnostic record. Never receives raw content that reaches the browser.
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  // The in-memory, bounded run registry. Injectable so tests never share global state.
  readonly registry: RunRegistry;
  // Builds the ModelPort a run uses. Default = GatewayModelPort from config; tests inject a fake.
  readonly modelPortFactory: ModelPortFactory;
  // Injectable OpenAI-compatible chat seam for the coding-sidecar gateway route.
  readonly codingSidecarGatewayChatFactory?: CodingSidecarGatewayChatFactory | undefined;
  // Issue #1987 — the coding-sidecar gateway must fail closed for subscription-backed model sources
  // even on live routes, so handlers thread this source into the projection helper instead of
  // silently defaulting every request to keiko-model-gateway semantics.
  readonly codingSidecarGatewayModelSource?: CodingWorkbenchModelSource | undefined;
  // Production resolver for the coding-sidecar model source. This keeps the routing seam live when
  // the runtime gateway config changes after first-run setup instead of freezing a test-only value.
  readonly codingSidecarGatewayModelSourceResolver?:
    CodingSidecarGatewayModelSourceResolver | undefined;
  // Optional dedicated evidence store for coding-workbench records. When absent, coding-sidecar
  // routes keep the root evidence store clean and fall back to diagnostics-only observability.
  readonly codingWorkbenchEvidenceStore?: EvidenceStore | undefined;
  // Optional governed connector mutation seam for Autonomous Delivery. Production may leave this
  // absent; the autonomous executor then fails connector writes closed instead of using provider APIs.
  readonly autonomousDeliveryConnector?: AutonomousDeliveryConnectorExecutor | undefined;
  // Server-owned approval proof store for Autonomous Delivery. The execute route consumes a proof
  // minted by the confirm route instead of trusting a client-supplied digest.
  readonly autonomousDeliveryApprovalStore?: AutonomousDeliveryApprovalStore | undefined;
  // Server-owned deployment ceiling for Autonomous Delivery requests. Undefined fails closed to the
  // lowest authority posture instead of accepting the request-supplied ceiling.
  readonly autonomousDeliveryDeploymentCeiling?: CodingWorkbenchMode | undefined;
  // Optional server-owned stop-state seam. A client can still stop itself by sending
  // operatorStopped:true, but it cannot hide a server-recorded stop for the run.
  readonly autonomousDeliveryStopState?:
    { readonly isStopped: (runId: string) => boolean } | undefined;
  // Exact secret literals used by evidence persistence in addition to gateway redaction patterns.
  readonly redactionSecrets?: readonly string[] | undefined;
  // UI-local persistence (ADR-0013). Holds projects, chats, and chat messages. Tests inject the
  // in-memory store via createInMemoryUiStore; production wiring resolves a node:sqlite file path.
  readonly store: UiStore;
  // Resolved UI database file path when known. Project onboarding uses this to prevent the UI DB
  // and selected repositories from overlapping on disk.
  readonly uiDbPath?: string | undefined;
  // Releases process-lifetime resources owned by these deps (today: the shared node:sqlite
  // handle, closed with an explicit WAL checkpoint instead of relying on process exit).
  // Optional and idempotent; hosts call it once the HTTP server has fully shut down.
  readonly dispose?: (() => void) | undefined;
  // Project path selected by the process that launched this loopback UI. When set, /api/projects
  // reports this project first so first-run UI state cannot drift to stale persisted rows.
  readonly preferredProjectPath?: string | undefined;
  // ADR-0018 — bounded permitted-command execution manager. Optional for legacy tests; production
  // wiring creates one per BFF and injects the UI store for the projectId → workspaceRoot lookup.
  readonly terminal?: TerminalExecutionManager | undefined;
  // Issue #1387 — controlled test/build/run command executor. Optional so existing tests that do not
  // exercise /api/commands/* keep their fixtures unchanged; production wiring creates one per BFF and
  // injects the UI store for the projectId → workspaceRoot lookup plus package-script discovery.
  readonly commandRunner?: CommandRunnerManager | undefined;
  // Issue #1693 — governed self-update session runner. Optional so legacy tests that do not exercise
  // /api/update/session keep their fixtures unchanged; production wiring creates one per BFF.
  readonly updateSession?: UpdateSessionManager | undefined;
  // Issue #1687 — deterministic update preflight seam for integration tests. Production leaves this
  // undefined so each BFF uses the default registry/GitHub-backed preflight service.
  readonly updatePreflight?:
    | {
        getStartupReport(deps: UiHandlerDeps): Promise<UpdatePreflightReport>;
        runManualCheck(deps: UiHandlerDeps): Promise<UpdatePreflightReport>;
      }
    | undefined;
  // Issue #1694 — content-free update compatibility, recovery snapshot, and audit state. Optional so
  // tests can inject a deterministic store; production wiring resolves KEIKO_STATE_DIR.
  readonly updateLocalState?: UpdateLocalStateManager | undefined;
  // Issue #1695 — in-app update remediation action/status orchestration. Optional so legacy route
  // fixtures stay minimal; production composes it over updateLocalState and Local Knowledge.
  readonly updateRemediation?: UpdateRemediationManager | undefined;
  // Issue #1388 (ADR-0070) — governed container engine detection + execution pilot. Optional so
  // existing tests that do not exercise /api/containers/* keep their fixtures unchanged; production
  // wiring creates one per BFF and injects the UI store for the projectId → workspaceRoot lookup.
  readonly containerRunner?: ContainerRunnerManager | undefined;
  // ADR-0017 — browser tool session manager (BYO Chrome over CDP). Optional so existing tests
  // that do not exercise /api/browser/* keep their fixtures unchanged.
  readonly browser?: BrowserSessionManager | undefined;
  // Issue #211 — MemoriaViva vault. Optional so legacy tests that do not exercise /api/memory/*
  // keep their fixtures unchanged. Production wiring creates one at buildUiHandlerDeps time.
  readonly memoryVault?: MemoryVaultStore | undefined;
  // Server-owned encrypted editor recovery storage. The browser stores only metadata and an opaque
  // reference in IndexedDB.
  readonly editorHotExitStore?: EditorHotExitStore | undefined;
  // Server-authoritative identity and scope bounds for privacy-critical MemoriaViva mutations.
  // Loopback production wiring resolves this from the single local operator; hosted/auth-aware
  // deployments must inject the authenticated principal's reviewer id and authorized scopes.
  readonly memoryAuthorization?: MemoryAuthorizationContext | undefined;
  // Server-authoritative principal for Quality Intelligence review governance. The browser may send
  // a display label, but review identity is resolved here (or by the local loopback fallback).
  readonly qualityIntelligenceReviewPrincipal?:
    QualityIntelligenceReviewPrincipalResolver | undefined;
  // Issue #208 — explicit, bounded in-memory consolidation job registry for MemoriaViva polling.
  readonly consolidationJobs?: ConsolidationJobRegistry | undefined;
  // Runtime gateway config supports first-run UI onboarding. It starts from the CLI/env/local config
  // and can be updated after a successful credential test without restarting the loopback server.
  readonly gatewayConfig?: RuntimeGatewayConfig | undefined;
  // Test seam for first-run setup. Production uses the real OpenAI-compatible gateway call.
  readonly gatewaySetupTester?:
    | ((config: GatewayConfig, candidateModelIds: readonly string[]) => Promise<readonly string[]>)
    | undefined;
  // Test seam for model discovery. Production calls the OpenAI-compatible /models endpoint.
  readonly gatewayModelDiscovery?:
    | ((
        baseUrl: string,
        apiKey: string,
        apiKeyHeaderName?: string,
        egress?: GatewayEgressConfig,
      ) => Promise<GatewayModelDiscoveryOutput>)
    | undefined;
  // Test seam for the non-mutating gateway readiness probes. Production uses globalThis.fetch via
  // the existing gateway HTTP transport; route tests inject a deterministic fetch implementation.
  readonly gatewayReadinessFetch?: typeof fetch | undefined;
  // Test seam for Figma PAT setup. Production performs a bounded Figma /v1/me request.
  readonly figmaCredentialTester?:
    ((accessToken: string, egress?: GatewayEgressConfig) => Promise<void>) | undefined;
  // Test-only deterministic editor language route options. Production leaves this undefined so the
  // language service keeps the default deadline and real clock.
  readonly editorLanguageRouteOptions?: EditorLanguageRouteOptions | undefined;
  // Test-only runtime detector seams. Production leaves this undefined so detection uses
  // metadata-only PATH scanning plus contained manifest reads.
  readonly runtimeCapabilityRouteOptions?: RuntimeCapabilityRouteOptions | undefined;
  // Test-only Git BFF seams. Production leaves this undefined so repository status/diff use the
  // fixed native Git runner and conservative caps.
  readonly gitRouteOptions?: GitRouteOptions | undefined;
  // Epic #1941 — native OS file/folder dialog seam. Tests inject a fake adapter, platform, or
  // single-flight state; production leaves this undefined so the route lazily selects the real
  // platform adapter and the module-level single-flight instance.
  readonly nativeFileDialog?: NativeFileDialogRouteOptions | undefined;
  // Issue #198 audit seam: lets local-knowledge route tests stub embedding requests without
  // touching global fetch. Production leaves this undefined and uses requestOpenAIEmbedding.
  readonly localKnowledgeEmbeddingRequest?:
    ((request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome>) | undefined;
  // #189 GRD-004 array-batch embedding seam. Production leaves this undefined and uses
  // requestOpenAIEmbeddingBatch; tests that set localKnowledgeEmbeddingRequest only get the
  // batch path when they also provide a batch stub, so existing scalar-stub tests are unchanged.
  readonly localKnowledgeEmbeddingBatchRequest?:
    ((request: OpenAIEmbeddingBatchRequest) => Promise<OpenAIEmbeddingBatchOutcome>) | undefined;
  // RAG audit 2026-06: opt-in Anthropic-style Contextual Retrieval for Local Knowledge indexing.
  // Production builds this over the configured Gateway; tests inject a deterministic chat gateway
  // so the normal indexing route can prove contextual text reaches embedding/FTS without network IO.
  readonly localKnowledgeContextualRetrievalChatGateway?:
    ContextualRetrievalChatGateway | undefined;
  // Optional production OCR seam for Local Knowledge extraction. Production resolves from env when
  // absent; tests inject a deterministic adapter without requiring Tesseract or a local OCR service.
  readonly localKnowledgeOcrAdapter?: OcrAdapter | undefined;
  // Work Package 2 — optional LiteLLM/Cohere-compatible reranker seam. Production leaves this
  // undefined and uses requestLiteLLMRerank with config.reranker; tests inject deterministic
  // structural outcomes without touching global fetch.
  readonly rerankRequest?: ((request: LiteLLMRerankRequest) => Promise<RerankOutcome>) | undefined;
  // Issue #539 (Epic #532) — relationship engine handler deps. Optional so legacy tests
  // that do not exercise /api/relationships/* keep their fixtures unchanged. Production
  // wiring composes a sqlite-backed RelationshipStore inside buildUiHandlerDeps.
  readonly relationship?: RelationshipHandlerDeps | undefined;
  // Issue #445 (Epic #443) — managed task-workspace provisioning + activation service. Optional so
  // legacy tests that do not exercise /api/task-workspaces/* keep their fixtures unchanged; production
  // wiring composes a sqlite-backed WorkspaceInstanceStore + worktree adapter in buildUiHandlerDeps.
  readonly workspaceProvisioning?: WorkspaceProvisioningService | undefined;
  // The Keiko-owned managed worktree root that backs workspaceProvisioning. Routes that accept a
  // task-bound activeRoot as their execution root use this to re-prove containment before authorizing.
  readonly managedTaskWorkspaceRoot?: string | undefined;
  // Issue #446 (Epic #443, ADR-0090) — active task-workspace binding + lifecycle service. Owns the
  // singleton active pointer and the switch/pause/resume/handoff actions surfaces consume. Optional so
  // legacy tests that do not exercise the active-binding routes keep their fixtures unchanged;
  // production wiring composes it over the same DatabaseSync handle as the #445 instance store.
  readonly workspaceLifecycle?: WorkspaceLifecycleService | undefined;
  // Issue #447 (Epic #443, ADR-0091) — startup reconciliation + controlled repair services. Optional
  // so legacy tests that do not exercise the reconciliation/repair routes keep their fixtures
  // unchanged; production composes them over the same store/pointer/adapter as #445/#446.
  readonly workspaceReconciliation?: WorkspaceReconciliationService | undefined;
  readonly workspaceRepair?: WorkspaceRepairService | undefined;
  // Issue #448 (Epic #443, ADR-0092) — read-only health/drift/orphan report service and the governed,
  // operator-approval-gated cleanup service. Optional so legacy tests that do not exercise the
  // health/cleanup routes keep their fixtures unchanged; production composes them over the same
  // store/pointer/adapter/managed-root as #445–#447.
  readonly workspaceHealth?: WorkspaceHealthService | undefined;
  readonly workspaceCleanup?: WorkspaceCleanupService | undefined;
  // Resolved evidence directory path (same precedence as the CLI: explicit → KEIKO_EVIDENCE_DIR →
  // default). Consumed by QI read routes that pass evidenceDir to listQualityIntelligenceRuns /
  // loadQualityIntelligenceRun (which require either options.store or options.evidenceDir).
  readonly evidenceDir?: string | undefined;
  // Issue #1322 — Local Knowledge content encryption at rest (ADR-0047). When set, capsule stores are
  // opened encrypted: extracted text and vector content are sealed with the key this provider resolves.
  // Optional so legacy tests that build deps manually keep their plaintext fixtures unchanged;
  // buildUiHandlerDeps creates one so production stores encrypt by default.
  readonly localKnowledgeKeyProvider?: KnowledgeStoreKeyProvider | undefined;
  // Issue #1633 (Epic #1631) — ephemeral, non-durable PDF preview session registry. Optional so tests
  // can inject a deterministic clock/TTL; production falls back to a per-BFF in-memory registry.
  readonly pdfCitationPreviewSessions?: PdfCitationPreviewSessionManager | undefined;
  // ADR-0055 D5 (PR4-W1) / Issue #1722 — deterministic context-engineering profile. buildUiHandlerDeps
  // provisions the selected chat model's derived profile when capability metadata is available,
  // otherwise falls back to DEFAULT_CONTEXT_PROFILE so the grounded diagnostics observer is active
  // by default (non-mutating, additive `diagnostics.contextBudget?`). Optional + test seam:
  // injecting `undefined` pins the legacy no-profile code path (observer not invoked, pack
  // byte-identical).
  readonly contextProfile?: ContextProfile | undefined;
  // Issue #1722 — single model-keyed context-profile source. buildUiHandlerDeps resolves this from
  // configured chat capabilities so later prompt assembly / compaction wiring can ask for the
  // exact profile of the selected model without inventing a second budget path.
  readonly contextProfileForModel?: ContextProfileResolver | undefined;
  // Issue #1736 — file-backed, runtime-state workspace index provider for production repository
  // search paths. Tests may omit it; search falls back to the existing live scan.
  readonly workspaceIndexForRoot?: WorkspaceIndexProvider | undefined;
  // Issue #494 (Epic #491) — voice speech-to-text dictation seam (ADR-0100 D4). Lets the BFF
  // dictation route call the provider-neutral STT adapter without touching global fetch in tests.
  // Production leaves this undefined and uses requestSpeechToText, so the audio is forwarded once to
  // the configured provider through the Model Gateway egress seam (gatewayFetch) and never persisted.
  readonly voiceTranscriptionRequest?:
    ((request: SpeechToTextRequest) => Promise<SpeechToTextOutcome>) | undefined;
  // Issue #1558 (Epic #1556) — voice speech-output synthesis seam (ADR-0095). Lets the BFF synthesis
  // route call the provider-neutral text-to-speech adapter without touching global fetch in tests.
  // Production leaves this undefined and uses requestTextToSpeech, so the answer text is forwarded
  // once to the configured provider through the Model Gateway egress seam (gatewayFetch) and the
  // synthesized audio is held only in memory for the response, never persisted.
  readonly voiceSpeechRequest?:
    ((request: TextToSpeechRequest) => Promise<TextToSpeechOutcome>) | undefined;
  // Streaming counterpart of voiceSpeechRequest (Issue #1556). Lets the /api/voice/speak/stream route
  // forward provider PCM chunk-by-chunk in tests without touching global fetch. Production leaves it
  // undefined and uses requestTextToSpeechStream; raw audio is streamed through, never persisted.
  readonly voiceSpeechStreamRequest?:
    ((request: TextToSpeechRequest) => Promise<TextToSpeechStreamOutcome>) | undefined;
  // Issue #497 (Epic #491) — realtime voice proxied-SDP negotiation seam (ADR-0100 D3/D6). Lets the
  // WebSocket control plane perform the browser↔provider SDP exchange through the provider-neutral
  // realtime adapter without touching global fetch in tests. Production leaves this undefined and
  // uses requestRealtimeNegotiation, so the offer is forwarded once to the configured provider
  // through the Model Gateway egress seam (gatewayFetch); the long-lived credential never reaches the
  // browser and no SDP is persisted.
  readonly voiceRealtimeNegotiationRequest?:
    ((request: RealtimeNegotiationRequest) => Promise<RealtimeNegotiationOutcome>) | undefined;
}

export interface BuildHandlerDepsOptions {
  // Path to a gateway config file (`keiko ui --config`); undefined → no config inspector data.
  readonly configPath: string | undefined;
  // Evidence directory (`keiko ui --evidence-dir`); resolved via the audit precedence rules.
  readonly evidenceDir: string | undefined;
  readonly env: EnvSource;
  // Optional injected registry (tests); a fresh bounded registry is created otherwise.
  readonly registry?: RunRegistry | undefined;
  // Optional injected ModelPort factory (tests); the GatewayModelPort builder is used otherwise.
  readonly modelPortFactory?: ModelPortFactory | undefined;
  // Optional coding-sidecar model-source override. Production defaults to deriving the source from
  // the selected coding-safe provider profile; tests and future config surfaces may override it.
  readonly codingSidecarGatewayModelSource?: CodingWorkbenchModelSource | undefined;
  // Optional dedicated evidence store for content-free Coding Workbench routing records. Production
  // otherwise creates an isolated default store under <evidenceDir>/coding-workbench so /api/evidence
  // stays clean while sidecar routing evidence still persists.
  readonly codingWorkbenchEvidenceStore?: EvidenceStore | undefined;
  // Optional server-owned Autonomous Delivery approval store. Production creates one per BFF deps
  // assembly so client-supplied Authority Envelope fields cannot mint or replay confirmations.
  readonly autonomousDeliveryApprovalStore?: AutonomousDeliveryApprovalStore | undefined;
  // Optional server-owned Autonomous Delivery ceiling. When absent, autonomous confirmation and
  // execution fail closed to governed-assist.
  readonly autonomousDeliveryDeploymentCeiling?: CodingWorkbenchMode | undefined;
  readonly autonomousDeliveryStopState?: UiHandlerDeps["autonomousDeliveryStopState"] | undefined;
  // UI-local SQLite DB path (`keiko ui --ui-db`); resolved via UI-store precedence (explicit →
  // KEIKO_UI_DATA_DIR → homedir/.keiko/keiko-ui.db). Mirrors evidenceDir's shape.
  readonly uiDbPath?: string | undefined;
  // Optional injected UiStore (tests); a node store opened at the resolved path is built otherwise.
  readonly store?: UiStore | undefined;
  // Optional injected governed update session manager (tests); production creates the real
  // state-dir-backed updater session manager.
  readonly updateSession?: UpdateSessionManager | undefined;
  // Optional injected governed update preflight service (tests); production uses the default
  // registry + GitHub-backed runtime service.
  readonly updatePreflight?: UiHandlerDeps["updatePreflight"];
  // Optional injected governed update local-state manager (tests); production resolves it from
  // KEIKO_STATE_DIR or <cwd>/.keiko without importing the CLI package.
  readonly updateLocalState?: UpdateLocalStateManager | undefined;
  // Optional injected editor hot-exit store (tests); production creates an encrypted local vault
  // under the UI state directory.
  readonly editorHotExitStore?: EditorHotExitStore | undefined;
  // Optional injected governed update remediation manager (tests); production composes one over
  // updateLocalState and the Local Knowledge reindex port.
  readonly updateRemediation?: UpdateRemediationManager | undefined;
  // Optional injected task-workspace provisioning service (tests); production composes one over the
  // sqlite WorkspaceInstanceStore + node worktree adapter when a node store is built.
  readonly workspaceProvisioning?: WorkspaceProvisioningService | undefined;
  // Optional injected task-workspace lifecycle service (tests); production composes one over the
  // sqlite WorkspaceInstanceStore + active-pointer store + the provisioning service.
  readonly workspaceLifecycle?: WorkspaceLifecycleService | undefined;
  // Optional injected task-workspace reconciliation/repair services (tests); production composes them
  // over the same store/pointer/worktree-adapter as #445/#446 (Issue #447).
  readonly workspaceReconciliation?: WorkspaceReconciliationService | undefined;
  readonly workspaceRepair?: WorkspaceRepairService | undefined;
  // Optional injected task-workspace health/cleanup services (tests); production composes them over the
  // same store/pointer/worktree-adapter/managed-root as #445–#447 (Issue #448).
  readonly workspaceHealth?: WorkspaceHealthService | undefined;
  readonly workspaceCleanup?: WorkspaceCleanupService | undefined;
  // The working directory from which `keiko ui` was launched. Production seeds it into the UI store
  // so first-run project selection is deterministic even when an older UI DB already has rows.
  readonly initialProjectPath?: string | undefined;
  // Optional setup tester (tests); production performs a real gateway call.
  readonly gatewaySetupTester?:
    | ((config: GatewayConfig, candidateModelIds: readonly string[]) => Promise<readonly string[]>)
    | undefined;
  // Optional setup discovery seam (tests); production calls the model-list endpoint.
  readonly gatewayModelDiscovery?:
    | ((
        baseUrl: string,
        apiKey: string,
        apiKeyHeaderName?: string,
        egress?: GatewayEgressConfig,
      ) => Promise<GatewayModelDiscoveryOutput>)
    | undefined;
  // Optional Figma credential-test seam (tests); production calls Figma /v1/me.
  readonly figmaCredentialTester?:
    ((accessToken: string, egress?: GatewayEgressConfig) => Promise<void>) | undefined;
  // Issue #1323 AC4 — QI retention runs once at bootstrap. These optional seams let tests assert
  // the forwarded deletion-audit events and inject a deterministic clock; production leaves them
  // undefined (default no-op sink + wall-clock). See qualityIntelligence/retentionEnforcement.ts.
  readonly qiRetentionAuditSink?: QiRetentionAuditSink | undefined;
  readonly qiRetentionNow?: (() => number) | undefined;
}

function envModelToken(modelId: string): string {
  return modelId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

function envModelIdFromApiKeyName(name: string): string | undefined {
  const prefix = "KEIKO_MODEL_";
  const suffix = "_API_KEY";
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) {
    return undefined;
  }
  const token = name.slice(prefix.length, -suffix.length);
  return token.length === 0 ? undefined : token.toLowerCase().replace(/_/g, "-");
}

function hasEnvProvider(modelId: string, env: EnvSource): boolean {
  const token = envModelToken(modelId);
  const baseUrl = env[`KEIKO_MODEL_${token}_BASE_URL`];
  const apiKey = env[`KEIKO_MODEL_${token}_API_KEY`];
  return baseUrl !== undefined && baseUrl.length > 0 && apiKey !== undefined && apiKey.length > 0;
}

function envModelIds(env: EnvSource): readonly string[] {
  const modelIds: string[] = [];
  for (const key of Object.keys(env)) {
    const modelId = envModelIdFromApiKeyName(key);
    if (modelId !== undefined && hasEnvProvider(modelId, env)) {
      modelIds.push(modelId);
    }
  }
  return Array.from(new Set(modelIds));
}

function resolveEnvOnlyConfig(env: EnvSource): GatewayConfig | undefined {
  const providers = envModelIds(env).map((modelId) => ({
    modelId,
    baseUrl: "",
    apiKey: "",
    capability: createDefaultChatCapability(modelId),
  }));
  if (providers.length === 0) {
    return undefined;
  }
  try {
    return parseGatewayConfig({ providers }, env);
  } catch (error) {
    if (error instanceof GatewayError) {
      return undefined;
    }
    throw error;
  }
}

function localGatewayConfigPath(uiDbPath: string): string {
  return join(dirname(uiDbPath), "keiko.config.json");
}

// Loads the config without leaking the path or any secret on failure: a missing/invalid config file
// falls back to KEIKO_MODEL_* env wiring when present, otherwise it is a normal "no config" state.
function resolveConfig(
  configPath: string | undefined,
  env: EnvSource,
  localConfigPath: string,
  secretResolver: ProviderSecretResolver,
): { config: GatewayConfig | undefined; configPresent: boolean } {
  if (configPath === undefined) {
    let config: GatewayConfig | undefined;
    try {
      config = loadConfigFromFile(localConfigPath, env, { secretResolver });
    } catch (error) {
      if (error instanceof GatewayError) {
        config = resolveEnvOnlyConfig(env);
      } else {
        throw error;
      }
    }
    return { config, configPresent: config !== undefined };
  }
  try {
    return { config: loadConfigFromFile(configPath, env, { secretResolver }), configPresent: true };
  } catch (error) {
    if (error instanceof GatewayError) {
      const config = resolveEnvOnlyConfig(env);
      return { config, configPresent: config !== undefined };
    }
    throw error;
  }
}

function resolveConfiguredEgress(
  configPath: string | undefined,
  env: EnvSource,
  localConfigPath: string,
): GatewayEgressConfig | undefined {
  try {
    return loadEgressConfigFromFile(configPath ?? localConfigPath, env);
  } catch (error) {
    if (error instanceof GatewayError) {
      return resolveOutboundHttpEgressConfig(undefined, env);
    }
    throw error;
  }
}

function createRuntimeGatewayConfig(
  initial: GatewayConfig | undefined,
  initialPresent: boolean,
  storagePath: string,
): RuntimeGatewayConfig {
  let config = initial;
  let present = initialPresent;
  return {
    storagePath,
    current: (): GatewayConfig | undefined => config,
    present: (): boolean => present,
    set(next: GatewayConfig | undefined, nextPresent: boolean): void {
      config = next;
      present = nextPresent;
    },
  };
}

export function currentGatewayConfig(deps: UiHandlerDeps): GatewayConfig | undefined {
  return deps.gatewayConfig?.current() ?? deps.config;
}

function configuredChatContextProfile(
  config: GatewayConfig,
  modelId: string,
): ContextProfile | undefined {
  const capability = findConfiguredCapability(config, modelId);
  return capability?.kind === "chat" ? deriveContextProfileFromCapability(capability) : undefined;
}

function buildContextProfileResolver(
  currentConfig: () => GatewayConfig | undefined,
): ContextProfileResolver {
  const cache = new WeakMap<GatewayConfig, Map<string, ContextProfile>>();
  return (modelId: string): ContextProfile => {
    const config = currentConfig();
    if (config === undefined) {
      return DEFAULT_CONTEXT_PROFILE;
    }
    let modelProfiles = cache.get(config);
    if (modelProfiles === undefined) {
      modelProfiles = new Map<string, ContextProfile>();
      cache.set(config, modelProfiles);
    }
    const cached = modelProfiles.get(modelId);
    if (cached !== undefined) {
      return cached;
    }
    const profile = configuredChatContextProfile(config, modelId);
    if (profile === undefined) {
      return DEFAULT_CONTEXT_PROFILE;
    }
    modelProfiles.set(modelId, profile);
    return profile;
  };
}

function defaultContextProfile(
  config: GatewayConfig | undefined,
  resolveProfile: ContextProfileResolver,
): ContextProfile {
  if (config === undefined) {
    return DEFAULT_CONTEXT_PROFILE;
  }
  const modelId = selectConfiguredModel(config, { kind: "chat" });
  return modelId === undefined ? DEFAULT_CONTEXT_PROFILE : resolveProfile(modelId);
}

function codingSafeSidecarProvider(config: GatewayConfig): ModelProviderConfig | undefined {
  const resolved = resolveCodingSafeSidecarGatewayProfile(config);
  if (resolved.status !== "available") {
    return undefined;
  }
  return config.providers.find((provider) => provider.modelId === resolved.modelAlias);
}

function isOpenAiPlatformGatewayProvider(provider: ModelProviderConfig): boolean {
  try {
    const url = new URL(provider.baseUrl);
    return url.protocol === "https:" && url.hostname === "api.openai.com";
  } catch {
    return false;
  }
}

function deriveCodingSidecarGatewayModelSource(
  currentConfig: () => GatewayConfig | undefined,
  explicit: CodingWorkbenchModelSource | undefined,
): CodingSidecarGatewayModelSourceResolver {
  return (): CodingWorkbenchModelSource => {
    if (explicit !== undefined) {
      return explicit;
    }
    const config = currentConfig();
    if (config === undefined) {
      return "keiko-model-gateway";
    }
    const provider = codingSafeSidecarProvider(config);
    return provider !== undefined && isOpenAiPlatformGatewayProvider(provider)
      ? "openai-api-key-through-gateway"
      : "keiko-model-gateway";
  };
}

export function currentGatewayConfigPresent(deps: UiHandlerDeps): boolean {
  return deps.gatewayConfig?.present() ?? deps.configPresent;
}

export function currentContextProfileForModel(
  deps: Pick<UiHandlerDeps, "contextProfile" | "contextProfileForModel">,
  modelId: string | undefined,
): ContextProfile | undefined {
  if (modelId !== undefined) {
    const profile = deps.contextProfileForModel?.(modelId);
    if (profile !== undefined) {
      return profile;
    }
  }
  return deps.contextProfile;
}

export function currentGatewayEgressConfig(
  deps: Pick<UiHandlerDeps, "config" | "gatewayConfig" | "env" | "egress">,
): GatewayEgressConfig | undefined {
  return (
    deps.gatewayConfig?.current()?.egress ??
    deps.egress ??
    deps.config?.egress ??
    resolveOutboundHttpEgressConfig(undefined, deps.env)
  );
}

// Module-level: read KEIKO_GROUNDING_* env overrides ONCE at load (mirrors KEIKO_MODEL_* env
// reads). Each value is parsed as a positive integer; unparseable values are silently ignored so
// misconfigured env does not prevent the server from starting.
function parseEnvPositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  // GRD-037: strict parse so a typo'd value is genuinely ignored (as the comment promises) rather
  // than silently coerced — Number.parseInt("16abc")→16 and ("4.9")→4. Mirrors the loud
  // config-file validator's all-digits rule, but here a bad env var falls back to the default.
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

const ENV_GROUNDING_OVERRIDES: Partial<GroundingLimits> = ((): Partial<GroundingLimits> => {
  const env = process.env;
  const partial: { -readonly [K in keyof GroundingLimits]?: GroundingLimits[K] } = {};
  const maxConnectedSources = parseEnvPositiveInt(env.KEIKO_GROUNDING_MAX_CONNECTED_SOURCES);
  if (maxConnectedSources !== undefined) partial.maxConnectedSources = maxConnectedSources;
  const maxLocalKnowledgeSources = parseEnvPositiveInt(
    env.KEIKO_GROUNDING_MAX_LOCAL_KNOWLEDGE_SOURCES,
  );
  if (maxLocalKnowledgeSources !== undefined)
    partial.maxLocalKnowledgeSources = maxLocalKnowledgeSources;
  const maxPromptReferences = parseEnvPositiveInt(env.KEIKO_GROUNDING_MAX_PROMPT_REFERENCES);
  if (maxPromptReferences !== undefined) partial.maxPromptReferences = maxPromptReferences;
  const maxExcerptChars = parseEnvPositiveInt(env.KEIKO_GROUNDING_MAX_EXCERPT_CHARS);
  if (maxExcerptChars !== undefined) partial.maxExcerptChars = maxExcerptChars;
  const referenceBudget = parseEnvPositiveInt(env.KEIKO_GROUNDING_REFERENCE_BUDGET);
  if (referenceBudget !== undefined) partial.referenceBudget = referenceBudget;
  const hybridMaxCandidates = parseEnvPositiveInt(env.KEIKO_GROUNDING_HYBRID_MAX_CANDIDATES);
  if (hybridMaxCandidates !== undefined) partial.hybridMaxCandidates = hybridMaxCandidates;
  const hybridMaxExcerptBytes = parseEnvPositiveInt(env.KEIKO_GROUNDING_HYBRID_MAX_EXCERPT_BYTES);
  if (hybridMaxExcerptBytes !== undefined) partial.hybridMaxExcerptBytes = hybridMaxExcerptBytes;
  return partial;
})();

// Resolves the effective grounding limits at call time: file config → env overrides → ceilings.
// Env overrides win over file config. Re-reads currentGatewayConfig each call so runtime config
// updates (e.g. first-run UI onboarding) are honored immediately. Never stored as a frozen field.
export function currentGroundingLimits(deps: UiHandlerDeps): GroundingLimits {
  const fileGrounding = currentGatewayConfig(deps)?.grounding;
  return resolveGroundingLimits({ ...fileGrounding, ...ENV_GROUNDING_OVERRIDES });
}

// Re-export GroundingLimits so callers (read-handlers, store-handlers) only need one import.
export type { GroundingLimits };

function configTopologyValues(config: GatewayConfig | undefined): readonly string[] {
  // Epic #177 audit: redact provider URLs and egress settings because backend topology gives an
  // attacker a place to direct probes. Credentials are collected separately as opaque secrets for
  // evidence hashing.
  if (config === undefined) return [];
  const out: string[] = [];
  const addEgressTopology = (egress: GatewayConfig["egress"]): void => {
    if (egress === undefined) return;
    if (egress.httpProxy !== undefined) out.push(egress.httpProxy);
    if (egress.httpsProxy !== undefined) out.push(egress.httpsProxy);
    if (egress.caBundlePath !== undefined) out.push(egress.caBundlePath);
  };
  addEgressTopology(config.egress);
  for (const provider of config.providers) {
    out.push(provider.baseUrl);
    addEgressTopology(provider.egress);
  }
  if (config.reranker !== undefined) {
    out.push(config.reranker.baseUrl);
    addEgressTopology(config.reranker.egress);
  }
  return out;
}

function configOpaqueSecretValues(config: GatewayConfig | undefined): readonly string[] {
  if (config === undefined) return [];
  const out: string[] = [];
  if (config.figma?.accessToken !== undefined) {
    out.push(config.figma.accessToken);
  }
  for (const provider of config.providers) {
    out.push(provider.apiKey);
  }
  if (config.reranker !== undefined) {
    out.push(config.reranker.apiKey);
  }
  return out;
}

function configSecretValues(config: GatewayConfig | undefined): readonly string[] {
  return [...configTopologyValues(config), ...configOpaqueSecretValues(config)];
}

function figmaEnvSecretValues(env: EnvSource): readonly string[] {
  const token = env.FIGMA_ACCESS_TOKEN;
  return token !== undefined && token.length > 0 ? [token] : [];
}

function egressSecretValues(egress: GatewayConfig["egress"]): readonly string[] {
  if (egress === undefined) return [];
  return [egress.httpProxy, egress.httpsProxy, egress.caBundlePath].filter(
    (value): value is string => value !== undefined,
  );
}

// The Figma PAT is redacted via its config (`config.figma.accessToken`) and env
// (`FIGMA_ACCESS_TOKEN`) literals. The decrypted ENCRYPTED-VAULT token (#758) is intentionally NOT
// added here: it never reaches a redactable payload — it is confined to the outbound `X-Figma-Token`
// request header by construction (figmaConnector.ts) and is never returned, logged, or serialized.
// Adding it would require decrypting the vault at redactor-build time, widening exposure for no gain.
function redactionSecrets(
  env: EnvSource,
  config: GatewayConfig | undefined,
  egress: GatewayConfig["egress"] = config?.egress,
): readonly string[] {
  return Array.from(
    new Set([
      ...keikoApiKeySecretValues(env),
      ...figmaEnvSecretValues(env),
      ...configSecretValues(config),
      ...egressSecretValues(egress),
    ]),
  );
}

function runtimeRedactionSecrets(
  env: EnvSource,
  runtimeConfig: RuntimeGatewayConfig,
  egress: GatewayConfig["egress"],
): readonly string[] {
  const config = runtimeConfig.current();
  return redactionSecrets(env, config, config?.egress ?? egress);
}

function runtimeRedactString(
  env: EnvSource,
  runtimeConfig: RuntimeGatewayConfig,
  egress: GatewayConfig["egress"],
): (value: string) => string {
  let cachedSecretsKey: string | undefined;
  let cachedRedactor: ((value: string) => string) | undefined;
  return (value: string): string => {
    const secrets = runtimeRedactionSecrets(env, runtimeConfig, egress);
    const secretsKey = JSON.stringify(secrets);
    if (cachedRedactor === undefined || cachedSecretsKey !== secretsKey) {
      cachedSecretsKey = secretsKey;
      cachedRedactor = createAuditRedactor({ additionalSecrets: secrets }, env);
    }
    return cachedRedactor(value);
  };
}

// Builds the live-payload redactor from the configured redaction settings + env. No new regex: this
// reuses `createAuditRedactor` (escaped literals + audited gateway patterns) wrapped by
// `deepRedactStrings` so every string leaf of a serialized payload is scrubbed.
export function buildRedactor(env: EnvSource, config?: GatewayConfig): Redactor {
  const egress = config?.egress ?? resolveOutboundHttpEgressConfig(undefined, env);
  const redactString = createAuditRedactor(
    {
      additionalSecrets: redactionSecrets(env, config, egress),
    },
    env,
  );
  return (value: unknown): unknown => deepRedactStrings(value, redactString);
}

export function currentRedactionSecrets(deps: UiHandlerDeps): readonly string[] {
  return redactionSecrets(deps.env, currentGatewayConfig(deps), currentGatewayEgressConfig(deps));
}

export function currentEvidenceTopologyRedactionSecrets(deps: UiHandlerDeps): readonly string[] {
  return Array.from(
    new Set([
      ...configTopologyValues(currentGatewayConfig(deps)),
      ...egressSecretValues(currentGatewayEgressConfig(deps)),
    ]),
  );
}

export function currentEvidenceRequiresFullStringRedaction(deps: UiHandlerDeps): boolean {
  return (
    keikoApiKeySecretValues(deps.env).length > 0 ||
    figmaEnvSecretValues(deps.env).length > 0 ||
    configOpaqueSecretValues(currentGatewayConfig(deps)).length > 0
  );
}

// The production ModelPort factory: a GatewayModelPort over a Gateway built from the resolved
// config (mirrors the CLI's `new GatewayModelPort(new Gateway(config))`). Returns undefined when no
// config was resolved so the run route answers 400 NO_MODEL rather than constructing a broken port.
function defaultModelPortFactory(runtimeConfig: RuntimeGatewayConfig): ModelPortFactory {
  return (): ModelPort | undefined => {
    const config = runtimeConfig.current();
    if (config === undefined) {
      return undefined;
    }
    return new GatewayModelPort(new Gateway(config));
  };
}

function buildTerminalManager(options: {
  readonly store: UiStore;
  readonly evidenceStore: EvidenceStore;
  readonly env: EnvSource;
  readonly liveRedactor: Redactor;
}): TerminalExecutionManager {
  return createTerminalExecutionManager({
    store: options.store,
    evidenceStore: options.evidenceStore,
    processEnv: options.env,
    redactor: (value: string): string => {
      const redacted = options.liveRedactor(value);
      return typeof redacted === "string" ? redacted : value;
    },
  });
}

// Issue #1387 — the command runner reuses the same store + evidence + live-redactor wiring as the
// terminal manager so discovered test/build/run tasks inherit the identical workspace containment,
// secret-shape scrubbing, and content-free audit trail.
function buildCommandRunner(options: {
  readonly store: UiStore;
  readonly evidenceStore: EvidenceStore;
  readonly env: EnvSource;
  readonly liveRedactor: Redactor;
}): CommandRunnerManager {
  return createCommandRunnerManager({
    store: options.store,
    evidenceStore: options.evidenceStore,
    processEnv: options.env,
    redactor: (value: string): string => {
      const redacted = options.liveRedactor(value);
      return typeof redacted === "string" ? redacted : value;
    },
  });
}

function buildUpdateSession(options: {
  readonly injected?: UpdateSessionManager | undefined;
  readonly env: EnvSource;
  readonly liveRedactor: Redactor;
  readonly updateLocalState: UpdateLocalStateManager;
  readonly updateRemediation: UpdateRemediationManager;
  readonly runtimeConfig: RuntimeGatewayConfig;
}): UpdateSessionManager {
  if (options.injected !== undefined) return options.injected;
  return createUpdateSessionManager({
    processEnv: options.env,
    lock: createStateDirUpdateSessionLock(resolveUpdateStateDir(options.env)),
    portableStager: createPortableUpdateStager({
      env: options.env,
      localState: options.updateLocalState,
      egress: () =>
        options.runtimeConfig.current()?.egress ??
        resolveOutboundHttpEgressConfig(undefined, options.env),
    }),
    portableActivator: createPortableUpdateActivator({
      env: options.env,
      localState: options.updateLocalState,
    }),
    portableCompletionGate: portableCompletionGate(options.updateRemediation),
    redactor: (value: string): string => {
      const redacted = options.liveRedactor(value);
      return typeof redacted === "string" ? redacted : value;
    },
  });
}

function portableCompletionGate(updateRemediation: UpdateRemediationManager): UpdateCompletionGate {
  return (session): boolean => {
    updateRemediation.completeRestart(session.targetVersion);
    return updateRemediation.updateCanComplete(session.targetVersion);
  };
}

function resolveUpdateStateDir(env: EnvSource): string {
  const value = env.KEIKO_STATE_DIR ?? ".keiko";
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function buildUpdateLocalState(env: EnvSource): UpdateLocalStateManager {
  return createUpdateLocalStateManager({ stateDir: resolveUpdateStateDir(env) });
}

// Issue #1388 — the container runner reuses the same store + evidence + live-redactor wiring as the
// command runner so its content-free run audit inherits the identical secret-shape scrubbing. The
// active engine probe and the frozen-argv container run both compose the single runCommand boundary.
function buildContainerRunner(options: {
  readonly store: UiStore;
  readonly evidenceStore: EvidenceStore;
  readonly env: EnvSource;
  readonly liveRedactor: Redactor;
}): ContainerRunnerManager {
  return createContainerRunnerManager({
    store: options.store,
    evidenceStore: options.evidenceStore,
    processEnv: options.env,
    redactor: (value: string): string => {
      const redacted = options.liveRedactor(value);
      return typeof redacted === "string" ? redacted : value;
    },
  });
}

// ADR-0019 direction rule 3c: the tools package cannot import src/audit. The BFF injects the
// cost-class resolver and a side-file writer that closes over the resolved evidenceDir + the
// nodeWorkspaceFs realpath-containment port, so the browser session manager stays self-contained
// against contracts + security + workspace only.
function buildBrowserManager(options: {
  readonly evidenceDir: string;
  readonly evidenceStore: EvidenceStore;
  readonly redactor: Redactor;
}): BrowserSessionManager {
  return createBrowserSessionManager({
    evidenceDir: options.evidenceDir,
    evidenceStore: options.evidenceStore,
    redactor: options.redactor,
    costClassResolver: resolveCostClass,
    sideFileWriter: (basename, bytes, runId) =>
      writeSideFile(options.evidenceDir, runId, basename, bytes, { fs: nodeWorkspaceFs }),
  });
}

function buildMemoryVault(
  redactString: (value: string) => string,
  evidenceStore: EvidenceStore,
  env: EnvSource,
): MemoryVaultStore {
  const postCommitAudit = createMemoryAuditHandler({ evidenceStore, redactString });
  return createBffMemoryVault(
    redactString,
    // #214 — wire every successful vault mutation into the audit ledger. The handler
    // shares the same redactString closure as the live-payload redactor so audit
    // summaries inherit the same secret-shape scrubbing as wire traffic.
    (event) => {
      if (event.kind === "memory:deleted" || event.kind === "memory:tombstoned") {
        return;
      }
      postCommitAudit(event);
    },
    createMemoryAuditDeleteCommitHandler({ evidenceStore, redactString }),
    env,
  );
}

// Issue #539: the relationship engine runs server-authoritative scope checks on every route.
// In the loopback `keiko ui` BFF there is exactly one workspace per process; the resolver
// returns that workspace identifier from `KEIKO_WORKSPACE_ID` (set), or a stable default
// otherwise. The constant matches the empty-but-non-zero-length contract of `scope()` so
// every route resolves a workspaceId instead of returning 403.
const DEFAULT_LOOPBACK_WORKSPACE_ID = "local";
const DEFAULT_LOOPBACK_MEMORY_REVIEWER_ID = "local-operator" as MemoryReviewerId;

function buildLoopbackMemoryAuthorization(
  memoryVault: MemoryVaultStore,
): MemoryAuthorizationContext {
  return {
    reviewerId: DEFAULT_LOOPBACK_MEMORY_REVIEWER_ID,
    authorizedScopes: () => memoryVault.listMemoryScopes(),
  };
}

function resolveLoopbackWorkspaceId(env: EnvSource): string {
  const explicit = env.KEIKO_WORKSPACE_ID;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  return DEFAULT_LOOPBACK_WORKSPACE_ID;
}

// When no UiStore is injected, open one DatabaseSync against the resolved UI-DB and share it
// with the relationship-engine store so V5 sibling tables share the UI-store transaction model
// (issue #539, storage.md §3.1). When tests inject a UiStore we leave `relationship` undefined;
// relationship-engine tests inject their own deps.
interface ComposedPersistence {
  readonly store: UiStore;
  // Closes the underlying node:sqlite handle (WAL checkpoint) on graceful shutdown.
  // Undefined when a UiStore is injected (tests own their store's lifecycle).
  readonly dispose: (() => void) | undefined;
  readonly relationship: RelationshipHandlerDeps | undefined;
  // Issue #445: the durable task-workspace instance store, composed over the SAME DatabaseSync handle
  // (schema.ts §V7) so the V7 sibling table shares the single-writer transaction model. Undefined when
  // a UiStore is injected (tests supply their own workspace store/service).
  readonly workspaceInstanceStore: WorkspaceInstanceStore | undefined;
  // Issue #446: the singleton active-workspace pointer store, composed over the SAME handle (schema.ts
  // §V8). Undefined when a UiStore is injected (tests supply their own lifecycle service).
  readonly activeWorkspacePointerStore: ActiveWorkspacePointerStore | undefined;
}

function composePersistence(
  injected: UiStore | undefined,
  resolvedUiDbPath: string,
  redactString: (value: string) => string,
  env: EnvSource,
): ComposedPersistence {
  if (injected !== undefined) {
    return {
      store: injected,
      dispose: undefined,
      relationship: undefined,
      workspaceInstanceStore: undefined,
      activeWorkspacePointerStore: undefined,
    };
  }
  const db = openNodeUiDatabase(resolvedUiDbPath);
  const store = buildUiStoreOverDatabase(db, { redactString });
  const relationship: RelationshipHandlerDeps = {
    scopeResolver: (): { readonly workspaceId: string } => ({
      workspaceId: resolveLoopbackWorkspaceId(env),
    }),
    store: createRelationshipStorePort({ db, redactString }),
  };
  // Idempotent: SIGTERM/SIGINT and the runUiCli finally block may both reach it.
  let closed = false;
  const dispose = (): void => {
    if (closed) return;
    closed = true;
    try {
      db.close();
    } catch {
      // Already closed by the runtime — nothing to release.
    }
  };
  return {
    store,
    dispose,
    relationship,
    workspaceInstanceStore: buildWorkspaceInstanceStoreOverDatabase(db),
    activeWorkspacePointerStore: buildActiveWorkspacePointerStoreOverDatabase(db),
  };
}

// The Keiko-owned managed task-workspace root lives alongside the UI database (`<uiDbDir>/
// task-workspaces`), so it inherits the same per-user data directory and 0o700 hardening posture.
function resolveManagedWorktreeRoot(uiDbPath: string): string {
  return join(dirname(uiDbPath), "task-workspaces");
}

function buildWorkspaceProvisioning(
  options: BuildHandlerDepsOptions,
  store: WorkspaceInstanceStore | undefined,
  resolvedUiDbPath: string,
  evidenceStore: EvidenceStore,
  redactString: (value: string) => string,
  mutex: WorkspaceMutexRegistry,
): WorkspaceProvisioningService | undefined {
  if (options.workspaceProvisioning !== undefined) return options.workspaceProvisioning;
  if (store === undefined) return undefined;
  return createWorkspaceProvisioningService({
    store,
    evidenceStore,
    managedRoot: resolveManagedWorktreeRoot(resolvedUiDbPath),
    createAdapter: (workspace) =>
      createNodeGitWorktreeAdapter({ workspace, processEnv: options.env }),
    redactString,
    now: () => Date.now(),
    newId: randomUUID,
    mutex,
  });
}

// Issue #446 — the active-binding lifecycle service. It composes the SAME #445 instance store,
// provisioning service, evidence store, and active-pointer store (no second worktree/lock/transition
// engine). Returns undefined whenever any composed dependency is absent (injected UiStore tests), so
// the active-binding routes degrade to 503 exactly like the provisioning routes.
function buildWorkspaceLifecycle(
  options: BuildHandlerDepsOptions,
  instanceStore: WorkspaceInstanceStore | undefined,
  activePointerStore: ActiveWorkspacePointerStore | undefined,
  provisioning: WorkspaceProvisioningService | undefined,
  resolvedUiDbPath: string,
  evidenceStore: EvidenceStore,
  redactString: (value: string) => string,
  mutex: WorkspaceMutexRegistry,
): WorkspaceLifecycleService | undefined {
  if (options.workspaceLifecycle !== undefined) return options.workspaceLifecycle;
  if (
    instanceStore === undefined ||
    activePointerStore === undefined ||
    provisioning === undefined
  ) {
    return undefined;
  }
  return createWorkspaceLifecycleService({
    store: instanceStore,
    activePointerStore,
    managedRoot: resolveManagedWorktreeRoot(resolvedUiDbPath),
    provisioning,
    evidenceStore,
    redactString,
    now: () => Date.now(),
    newId: randomUUID,
    mutex,
  });
}

// Issue #447 — the startup reconciliation service. It composes the SAME #445 instance store, #446
// active pointer, evidence store, managed root, and node worktree adapter (no second engine). Returns
// undefined whenever a composed dependency is absent (injected UiStore tests) so the reconciliation
// routes degrade to 503 exactly like the provisioning routes.
function buildWorkspaceReconciliation(
  options: BuildHandlerDepsOptions,
  instanceStore: WorkspaceInstanceStore | undefined,
  activePointerStore: ActiveWorkspacePointerStore | undefined,
  resolvedUiDbPath: string,
  evidenceStore: EvidenceStore,
  redactString: (value: string) => string,
): WorkspaceReconciliationService | undefined {
  if (options.workspaceReconciliation !== undefined) return options.workspaceReconciliation;
  if (instanceStore === undefined || activePointerStore === undefined) return undefined;
  return createWorkspaceReconciliationService({
    store: instanceStore,
    activePointerStore,
    evidenceStore,
    managedRoot: resolveManagedWorktreeRoot(resolvedUiDbPath),
    createAdapter: (workspace) =>
      createNodeGitWorktreeAdapter({ workspace, processEnv: options.env }),
    redactString,
    now: () => Date.now(),
    newId: randomUUID,
  });
}

// Issue #447 — the controlled repair service. It reuses the #445 provisioning service for the
// worktree-recreating strategies and the same store/pointer/adapter for the rest (no second engine).
function buildWorkspaceRepair(
  options: BuildHandlerDepsOptions,
  instanceStore: WorkspaceInstanceStore | undefined,
  activePointerStore: ActiveWorkspacePointerStore | undefined,
  provisioning: WorkspaceProvisioningService | undefined,
  resolvedUiDbPath: string,
  evidenceStore: EvidenceStore,
  redactString: (value: string) => string,
  mutex: WorkspaceMutexRegistry,
): WorkspaceRepairService | undefined {
  if (options.workspaceRepair !== undefined) return options.workspaceRepair;
  if (
    instanceStore === undefined ||
    activePointerStore === undefined ||
    provisioning === undefined
  ) {
    return undefined;
  }
  return createWorkspaceRepairService({
    store: instanceStore,
    activePointerStore,
    evidenceStore,
    provisioning,
    managedRoot: resolveManagedWorktreeRoot(resolvedUiDbPath),
    createAdapter: (workspace) =>
      createNodeGitWorktreeAdapter({ workspace, processEnv: options.env }),
    redactString,
    now: () => Date.now(),
    newId: randomUUID,
    mutex,
  });
}

// Issue #448 — the read-only health/drift/orphan report service and the governed cleanup service. Both
// reuse the SAME #445 instance store, #446 active pointer, evidence store, managed root, and node
// worktree adapter (no second engine). Return undefined whenever a composed dependency is absent so the
// health/cleanup routes degrade to 503 exactly like the provisioning routes.
function buildWorkspaceHealth(
  options: BuildHandlerDepsOptions,
  instanceStore: WorkspaceInstanceStore | undefined,
  activePointerStore: ActiveWorkspacePointerStore | undefined,
  resolvedUiDbPath: string,
  evidenceStore: EvidenceStore,
  redactString: (value: string) => string,
): WorkspaceHealthService | undefined {
  if (options.workspaceHealth !== undefined) return options.workspaceHealth;
  if (instanceStore === undefined || activePointerStore === undefined) return undefined;
  return createWorkspaceHealthService({
    store: instanceStore,
    activePointerStore,
    evidenceStore,
    managedRoot: resolveManagedWorktreeRoot(resolvedUiDbPath),
    createAdapter: (workspace) =>
      createNodeGitWorktreeAdapter({ workspace, processEnv: options.env }),
    redactString,
    now: () => Date.now(),
    newId: randomUUID,
  });
}

function buildWorkspaceCleanup(
  options: BuildHandlerDepsOptions,
  instanceStore: WorkspaceInstanceStore | undefined,
  activePointerStore: ActiveWorkspacePointerStore | undefined,
  resolvedUiDbPath: string,
  evidenceStore: EvidenceStore,
  redactString: (value: string) => string,
  mutex: WorkspaceMutexRegistry,
): WorkspaceCleanupService | undefined {
  if (options.workspaceCleanup !== undefined) return options.workspaceCleanup;
  if (instanceStore === undefined || activePointerStore === undefined) return undefined;
  return createWorkspaceCleanupService({
    store: instanceStore,
    activePointerStore,
    evidenceStore,
    managedRoot: resolveManagedWorktreeRoot(resolvedUiDbPath),
    createAdapter: (workspace) =>
      createNodeGitWorktreeAdapter({ workspace, processEnv: options.env }),
    redactString,
    now: () => Date.now(),
    newId: randomUUID,
    mutex,
  });
}

// Best-effort startup reconciliation (Issue #447): mirror the QI-retention startup pass — run once at
// bootstrap, never throw into construction, and never block server start (the reconcile IO is detached
// and self-contained). A failure simply leaves the persisted classification untouched until the next
// pass or an explicit refresh.
function reconcileTaskWorkspacesAtStartup(
  service: WorkspaceReconciliationService | undefined,
): void {
  if (service === undefined) return;
  try {
    void service.reconcile().catch(() => undefined);
  } catch {
    // construction must never fail because of reconciliation.
  }
}

function seedInitialProject(
  store: UiStore,
  uiDbPath: string,
  initialProjectPath: string | undefined,
): string | undefined {
  if (initialProjectPath === undefined || initialProjectPath.trim().length === 0) {
    return undefined;
  }
  const normalizedPath = validateProjectPath(initialProjectPath, { mustExist: true });
  assertUiDbOutsideProject(uiDbPath, normalizedPath);
  return store.createProject(normalizedPath).path;
}

interface PeripheralManagers {
  readonly terminal: TerminalExecutionManager;
  readonly commandRunner: CommandRunnerManager;
  readonly updateSession: UpdateSessionManager;
  readonly updatePreflight: UiHandlerDeps["updatePreflight"];
  readonly updateLocalState: UpdateLocalStateManager;
  readonly updateRemediation: UpdateRemediationManager;
  readonly containerRunner: ContainerRunnerManager;
  readonly browser: BrowserSessionManager;
  readonly memoryVault: MemoryVaultStore;
  readonly editorHotExitStore: EditorHotExitStore;
  readonly memoryAuthorization: MemoryAuthorizationContext;
}

function buildLocalKnowledgeRemediation(options: {
  readonly runtimeStateDir: string;
  readonly runtimeConfig: RuntimeGatewayConfig;
  readonly keyProvider: KnowledgeStoreKeyProvider;
}): LocalKnowledgeRemediationPort {
  return createLocalKnowledgeRemediationPort({
    runtimeStateDir: options.runtimeStateDir,
    currentConfig: () => options.runtimeConfig.current(),
    keyProvider: options.keyProvider,
  });
}

function buildUpdateRemediation(options: {
  readonly injected: UpdateRemediationManager | undefined;
  readonly updateLocalState: UpdateLocalStateManager;
  readonly runtimeStateDir: string;
  readonly runtimeConfig: RuntimeGatewayConfig;
  readonly localKnowledgeKeyProvider: KnowledgeStoreKeyProvider;
}): UpdateRemediationManager {
  if (options.injected !== undefined) return options.injected;
  const localKnowledge = buildLocalKnowledgeRemediation({
    runtimeStateDir: options.runtimeStateDir,
    runtimeConfig: options.runtimeConfig,
    keyProvider: options.localKnowledgeKeyProvider,
  });
  return createUpdateRemediationManager({
    localState: options.updateLocalState,
    localKnowledge,
  });
}

interface BuildPeripheralsArgs {
  readonly options: BuildHandlerDepsOptions;
  readonly uiStore: UiStore;
  readonly evidenceStore: EvidenceStore;
  readonly redactString: (value: string) => string;
  readonly liveRedactor: Redactor;
  readonly runtimeConfig: RuntimeGatewayConfig;
  readonly localKnowledgeKeyProvider: KnowledgeStoreKeyProvider;
  readonly runtimeStateDir: string;
}

// eslint-disable-next-line max-lines-per-function -- central runtime wiring stays together so dependency authority is visible.
function buildPeripherals(args: BuildPeripheralsArgs): PeripheralManagers {
  const updateLocalState = args.options.updateLocalState ?? buildUpdateLocalState(args.options.env);
  const updateRemediation = buildUpdateRemediation({
    injected: args.options.updateRemediation,
    updateLocalState,
    runtimeStateDir: args.runtimeStateDir,
    runtimeConfig: args.runtimeConfig,
    localKnowledgeKeyProvider: args.localKnowledgeKeyProvider,
  });
  const memoryVault = buildMemoryVault(args.redactString, args.evidenceStore, args.options.env);
  return {
    terminal: buildTerminalManager({
      store: args.uiStore,
      evidenceStore: args.evidenceStore,
      env: args.options.env,
      liveRedactor: args.liveRedactor,
    }),
    commandRunner: buildCommandRunner({
      store: args.uiStore,
      evidenceStore: args.evidenceStore,
      env: args.options.env,
      liveRedactor: args.liveRedactor,
    }),
    updateSession: buildUpdateSession({
      injected: args.options.updateSession,
      env: args.options.env,
      liveRedactor: args.liveRedactor,
      updateLocalState,
      updateRemediation,
      runtimeConfig: args.runtimeConfig,
    }),
    updatePreflight: args.options.updatePreflight,
    updateLocalState,
    updateRemediation,
    containerRunner: buildContainerRunner({
      store: args.uiStore,
      evidenceStore: args.evidenceStore,
      env: args.options.env,
      liveRedactor: args.liveRedactor,
    }),
    browser: buildBrowserManager({
      evidenceDir: resolveEvidenceDir(args.options.evidenceDir, args.options.env),
      evidenceStore: args.evidenceStore,
      redactor: args.liveRedactor,
    }),
    memoryVault,
    editorHotExitStore:
      args.options.editorHotExitStore ??
      createEditorHotExitStore({
        stateDir: args.runtimeStateDir,
        env: args.options.env,
      }),
    memoryAuthorization: buildLoopbackMemoryAuthorization(memoryVault),
  };
}

// Assembles the handler deps for the real `keiko ui` process, mirroring the CLI config/evidence
// wiring (loadConfigFromFile / resolveEvidenceDir / createNodeEvidenceStore). The UI store is
// created at the resolved UI-DB path (explicit → KEIKO_UI_DATA_DIR → ~/.keiko/keiko-ui.db) unless
// an injected store is supplied (tests).
// One-time, idempotent migration of any pre-existing plaintext credentials in the local config
// (Issue #1320), then resolution of the (now reference-only) config through a vault-backed resolver.
// Migration is best-effort and crash-aware: it never throws into bootstrap, so a partial state simply
// re-runs next start and is surfaced by `keiko repair`. It runs before the config is read so the
// resolver turns the rewritten secret references back into live credentials.
function loadRuntimeGatewayConfig(
  options: BuildHandlerDepsOptions,
  runtimeConfigPath: string,
  resolvedEvidenceDir: string,
): { config: GatewayConfig | undefined; configPresent: boolean; storagePath: string } {
  const effectiveConfigPath = options.configPath ?? runtimeConfigPath;
  migrateLocalConfigCredentials({
    configPath: effectiveConfigPath,
    env: options.env,
    evidenceDir: resolvedEvidenceDir,
  });
  const secretResolver = createProviderSecretResolver({
    configPath: effectiveConfigPath,
    env: options.env,
  });
  const resolved = resolveConfig(
    options.configPath,
    options.env,
    runtimeConfigPath,
    secretResolver,
  );
  return { ...resolved, storagePath: effectiveConfigPath };
}

// Resolve the evidence dir AND run QI run-retention ONCE per server instance at bootstrap (Issue
// #1323 AC4). Lazy, no timer (a setInterval would race the filesystem-backed store). Best-effort:
// retention never throws into construction (mirrors migrateLocalConfigCredentials). Short-lived runs
// past their retention policy are purged deterministically rather than the policy id staying passive.
function resolveEvidenceDirAndEnforceRetention(options: BuildHandlerDepsOptions): string {
  const evidenceDir = resolveEvidenceDir(options.evidenceDir, options.env);
  enforceQiRetentionAtStartup({
    evidenceDir,
    now: options.qiRetentionNow,
    auditSink: options.qiRetentionAuditSink,
  });
  return evidenceDir;
}

interface PersistenceBundle {
  readonly uiStore: UiStore;
  // Passthrough of ComposedPersistence.dispose (closes the shared sqlite handle).
  readonly dispose: (() => void) | undefined;
  readonly relationship: RelationshipHandlerDeps | undefined;
  readonly workspaceProvisioning: WorkspaceProvisioningService | undefined;
  readonly workspaceLifecycle: WorkspaceLifecycleService | undefined;
  readonly workspaceReconciliation: WorkspaceReconciliationService | undefined;
  readonly workspaceRepair: WorkspaceRepairService | undefined;
  readonly workspaceHealth: WorkspaceHealthService | undefined;
  readonly workspaceCleanup: WorkspaceCleanupService | undefined;
  readonly managedTaskWorkspaceRoot: string | undefined;
  readonly preferredProjectPath: string | undefined;
}

// The #445–#448 task-workspace services, composed over the shared instance/active-pointer stores. Each
// returns undefined when a dependency is absent (injected-store tests) so its routes degrade to 503.
interface TaskWorkspaceServices {
  readonly workspaceProvisioning: WorkspaceProvisioningService | undefined;
  readonly workspaceLifecycle: WorkspaceLifecycleService | undefined;
  readonly workspaceReconciliation: WorkspaceReconciliationService | undefined;
  readonly workspaceRepair: WorkspaceRepairService | undefined;
  readonly workspaceHealth: WorkspaceHealthService | undefined;
  readonly workspaceCleanup: WorkspaceCleanupService | undefined;
}

// Issue #448 — the health + cleanup pair, split out to keep composeTaskWorkspaceServices small.
function composeHealthAndCleanup(
  options: BuildHandlerDepsOptions,
  workspaceInstanceStore: WorkspaceInstanceStore | undefined,
  activeWorkspacePointerStore: ActiveWorkspacePointerStore | undefined,
  resolvedUiDbPath: string,
  evidenceStore: EvidenceStore,
  redactString: (value: string) => string,
  mutex: WorkspaceMutexRegistry,
): Pick<TaskWorkspaceServices, "workspaceHealth" | "workspaceCleanup"> {
  return {
    workspaceHealth: buildWorkspaceHealth(
      options,
      workspaceInstanceStore,
      activeWorkspacePointerStore,
      resolvedUiDbPath,
      evidenceStore,
      redactString,
    ),
    workspaceCleanup: buildWorkspaceCleanup(
      options,
      workspaceInstanceStore,
      activeWorkspacePointerStore,
      resolvedUiDbPath,
      evidenceStore,
      redactString,
      mutex,
    ),
  };
}

// Issue #445/#446/#447 — provisioning + active-binding lifecycle + reconciliation + repair.
function composeCoreTaskWorkspaceServices(
  options: BuildHandlerDepsOptions,
  workspaceInstanceStore: WorkspaceInstanceStore | undefined,
  activeWorkspacePointerStore: ActiveWorkspacePointerStore | undefined,
  resolvedUiDbPath: string,
  evidenceStore: EvidenceStore,
  redactString: (value: string) => string,
  mutex: WorkspaceMutexRegistry,
): Omit<TaskWorkspaceServices, "workspaceHealth" | "workspaceCleanup"> {
  const workspaceProvisioning = buildWorkspaceProvisioning(
    options,
    workspaceInstanceStore,
    resolvedUiDbPath,
    evidenceStore,
    redactString,
    mutex,
  );
  return {
    workspaceProvisioning,
    workspaceLifecycle: buildWorkspaceLifecycle(
      options,
      workspaceInstanceStore,
      activeWorkspacePointerStore,
      workspaceProvisioning,
      resolvedUiDbPath,
      evidenceStore,
      redactString,
      mutex,
    ),
    workspaceReconciliation: buildWorkspaceReconciliation(
      options,
      workspaceInstanceStore,
      activeWorkspacePointerStore,
      resolvedUiDbPath,
      evidenceStore,
      redactString,
    ),
    workspaceRepair: buildWorkspaceRepair(
      options,
      workspaceInstanceStore,
      activeWorkspacePointerStore,
      workspaceProvisioning,
      resolvedUiDbPath,
      evidenceStore,
      redactString,
      mutex,
    ),
  };
}

function composeTaskWorkspaceServices(
  options: BuildHandlerDepsOptions,
  workspaceInstanceStore: WorkspaceInstanceStore | undefined,
  activeWorkspacePointerStore: ActiveWorkspacePointerStore | undefined,
  resolvedUiDbPath: string,
  evidenceStore: EvidenceStore,
  redactString: (value: string) => string,
): TaskWorkspaceServices {
  // One shared in-process mutex registry across ALL mutating task-workspace services (#449, ADR-0093 D1):
  // provisioning, lifecycle, repair, and cleanup must serialize against each other on the same `ws:`
  // keyspace, so they receive the SAME registry instance. Read-only services (reconciliation, health) do
  // not take it.
  const mutex = createWorkspaceMutexRegistry();
  const args = [
    options,
    workspaceInstanceStore,
    activeWorkspacePointerStore,
    resolvedUiDbPath,
    evidenceStore,
    redactString,
    mutex,
  ] as const;
  return {
    ...composeCoreTaskWorkspaceServices(...args),
    ...composeHealthAndCleanup(...args),
  };
}

function buildPersistenceBundle(
  options: BuildHandlerDepsOptions,
  resolvedUiDbPath: string,
  redactString: (value: string) => string,
  evidenceStore: EvidenceStore,
): PersistenceBundle {
  const { store, dispose, relationship, workspaceInstanceStore, activeWorkspacePointerStore } =
    composePersistence(options.store, resolvedUiDbPath, redactString, options.env);
  const services = composeTaskWorkspaceServices(
    options,
    workspaceInstanceStore,
    activeWorkspacePointerStore,
    resolvedUiDbPath,
    evidenceStore,
    redactString,
  );
  return {
    uiStore: store,
    dispose,
    relationship,
    ...services,
    managedTaskWorkspaceRoot:
      services.workspaceProvisioning === undefined
        ? undefined
        : resolveManagedWorktreeRoot(resolvedUiDbPath),
    preferredProjectPath: seedInitialProject(store, resolvedUiDbPath, options.initialProjectPath),
  };
}

// The optional persistence services (relationship engine + the #445/#446/#447 task-workspace
// services) spread onto the handler deps only when they were composed (production) — absent ones leave
// the corresponding routes to degrade to 503, exactly as before.
function optionalPersistenceServices(bundle: PersistenceBundle): Partial<UiHandlerDeps> {
  return {
    ...(bundle.relationship === undefined ? {} : { relationship: bundle.relationship }),
    ...(bundle.workspaceProvisioning === undefined
      ? {}
      : { workspaceProvisioning: bundle.workspaceProvisioning }),
    ...(bundle.managedTaskWorkspaceRoot === undefined
      ? {}
      : { managedTaskWorkspaceRoot: bundle.managedTaskWorkspaceRoot }),
    ...(bundle.workspaceLifecycle === undefined
      ? {}
      : { workspaceLifecycle: bundle.workspaceLifecycle }),
    ...(bundle.workspaceReconciliation === undefined
      ? {}
      : { workspaceReconciliation: bundle.workspaceReconciliation }),
    ...(bundle.workspaceRepair === undefined ? {} : { workspaceRepair: bundle.workspaceRepair }),
    ...(bundle.workspaceHealth === undefined ? {} : { workspaceHealth: bundle.workspaceHealth }),
    ...(bundle.workspaceCleanup === undefined ? {} : { workspaceCleanup: bundle.workspaceCleanup }),
  };
}

function reconcileNodeStoreAtStartup(
  options: BuildHandlerDepsOptions,
  bundle: PersistenceBundle,
): void {
  if (options.store !== undefined) return;
  reconcileTaskWorkspacesAtStartup(bundle.workspaceReconciliation);
}

function gatewayConfigFields(
  config: GatewayConfig | undefined,
  configPresent: boolean,
): Pick<UiHandlerDeps, "config" | "configPresent"> {
  return { config, configPresent };
}

function runtimePathFields(options: BuildHandlerDepsOptions): {
  readonly resolvedUiDbPath: string;
  readonly runtimeConfigPath: string;
} {
  const resolvedUiDbPath = resolveUiDbPath(options.uiDbPath, options.env);
  return { resolvedUiDbPath, runtimeConfigPath: localGatewayConfigPath(resolvedUiDbPath) };
}

interface UiHandlerDepsAssemblyArgs {
  readonly options: BuildHandlerDepsOptions;
  readonly resolvedUiDbPath: string;
  readonly resolvedEvidenceDir: string;
  readonly config: GatewayConfig | undefined;
  readonly configPresent: boolean;
  readonly runtimeConfig: RuntimeGatewayConfig;
  readonly egress: GatewayEgressConfig | undefined;
  readonly evidenceStore: EvidenceStore;
  readonly codingWorkbenchEvidenceStore: EvidenceStore;
  readonly redactString: (value: string) => string;
  readonly liveRedactor: Redactor;
  readonly localKnowledgeKeyProvider: KnowledgeStoreKeyProvider;
  readonly bundle: PersistenceBundle;
  readonly contextProfileForModel: ContextProfileResolver;
}

function codingSidecarGatewayModelSourceFields(
  args: UiHandlerDepsAssemblyArgs,
): Pick<
  UiHandlerDeps,
  "codingSidecarGatewayModelSourceResolver" | "codingSidecarGatewayModelSource"
> {
  const codingSidecarGatewayModelSourceResolver = deriveCodingSidecarGatewayModelSource(
    () => args.runtimeConfig.current(),
    args.options.codingSidecarGatewayModelSource,
  );
  return {
    codingSidecarGatewayModelSourceResolver,
    ...(args.options.codingSidecarGatewayModelSource === undefined
      ? {}
      : { codingSidecarGatewayModelSource: args.options.codingSidecarGatewayModelSource }),
  };
}

function autonomousDeliveryFields(
  options: BuildHandlerDepsOptions,
): Pick<
  UiHandlerDeps,
  | "autonomousDeliveryApprovalStore"
  | "autonomousDeliveryDeploymentCeiling"
  | "autonomousDeliveryStopState"
> {
  return {
    autonomousDeliveryApprovalStore:
      options.autonomousDeliveryApprovalStore ?? createAutonomousDeliveryApprovalStore(),
    ...(options.autonomousDeliveryDeploymentCeiling === undefined
      ? {}
      : { autonomousDeliveryDeploymentCeiling: options.autonomousDeliveryDeploymentCeiling }),
    ...(options.autonomousDeliveryStopState === undefined
      ? {}
      : { autonomousDeliveryStopState: options.autonomousDeliveryStopState }),
  };
}

function assembleUiHandlerDeps(args: UiHandlerDepsAssemblyArgs): UiHandlerDeps {
  return {
    ...gatewayConfigFields(args.config, args.configPresent),
    evidenceStore: args.evidenceStore,
    evidenceDir: args.resolvedEvidenceDir,
    env: args.options.env,
    egress: args.egress,
    redactor: args.liveRedactor,
    registry: args.options.registry ?? createRunRegistry(),
    modelPortFactory: args.options.modelPortFactory ?? defaultModelPortFactory(args.runtimeConfig),
    ...codingSidecarGatewayModelSourceFields(args),
    codingWorkbenchEvidenceStore: args.codingWorkbenchEvidenceStore,
    ...autonomousDeliveryFields(args.options),
    redactionSecrets: runtimeRedactionSecrets(args.options.env, args.runtimeConfig, args.egress),
    store: args.bundle.uiStore,
    uiDbPath: args.resolvedUiDbPath,
    preferredProjectPath: args.bundle.preferredProjectPath,
    gatewayConfig: args.runtimeConfig,
    gatewaySetupTester: args.options.gatewaySetupTester,
    gatewayModelDiscovery: args.options.gatewayModelDiscovery,
    figmaCredentialTester: args.options.figmaCredentialTester,
    localKnowledgeKeyProvider: args.localKnowledgeKeyProvider,
    contextProfile: defaultContextProfile(
      args.runtimeConfig.current(),
      args.contextProfileForModel,
    ),
    contextProfileForModel: args.contextProfileForModel,
    workspaceIndexForRoot: createServerWorkspaceIndexProvider({
      runtimeStateDir: dirname(args.resolvedUiDbPath),
      env: args.options.env,
    }),
    ...buildPeripherals({
      options: args.options,
      uiStore: args.bundle.uiStore,
      evidenceStore: args.evidenceStore,
      redactString: args.redactString,
      liveRedactor: args.liveRedactor,
      runtimeConfig: args.runtimeConfig,
      localKnowledgeKeyProvider: args.localKnowledgeKeyProvider,
      runtimeStateDir: dirname(args.resolvedUiDbPath),
    }),
    consolidationJobs: createConsolidationJobRegistry({ evidenceStore: args.evidenceStore }),
    ...optionalPersistenceServices(args.bundle),
    ...(args.bundle.dispose !== undefined ? { dispose: args.bundle.dispose } : {}),
  };
}

export function buildUiHandlerDeps(options: BuildHandlerDepsOptions): UiHandlerDeps {
  const { resolvedUiDbPath, runtimeConfigPath } = runtimePathFields(options);
  const resolvedEvidenceDir = resolveEvidenceDirAndEnforceRetention(options);
  const { config, configPresent, storagePath } = loadRuntimeGatewayConfig(
    options,
    runtimeConfigPath,
    resolvedEvidenceDir,
  );
  const egress = resolveConfiguredEgress(options.configPath, options.env, runtimeConfigPath);
  const runtimeConfig = createRuntimeGatewayConfig(config, configPresent, storagePath);
  const evidenceStore = createNodeEvidenceStore(resolvedEvidenceDir);
  const codingWorkbenchEvidenceStore =
    options.codingWorkbenchEvidenceStore ??
    createNodeEvidenceStore(join(resolvedEvidenceDir, "coding-workbench"));
  const redactString = runtimeRedactString(options.env, runtimeConfig, egress);
  const liveRedactor = (value: unknown): unknown => deepRedactStrings(value, redactString);
  const localKnowledgeKeyProvider = createLocalKnowledgeKeyProvider({ env: options.env });
  const bundle = buildPersistenceBundle(options, resolvedUiDbPath, redactString, evidenceStore);
  const contextProfileForModel = buildContextProfileResolver(() => runtimeConfig.current());
  reconcileNodeStoreAtStartup(options, bundle);
  return assembleUiHandlerDeps({
    options,
    resolvedUiDbPath,
    resolvedEvidenceDir,
    config,
    configPresent,
    runtimeConfig,
    egress,
    evidenceStore,
    codingWorkbenchEvidenceStore,
    redactString,
    liveRedactor,
    localKnowledgeKeyProvider,
    bundle,
    contextProfileForModel,
  });
}
