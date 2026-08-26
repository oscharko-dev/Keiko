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
  Gateway,
  GatewayError,
  resolveCostClass,
  type EnvSource,
  type GatewayRequest,
  type GatewayStreamChunk,
  type GatewayConfig,
  type LiteLLMRerankRequest,
  type ModelProviderConfig,
  type ModelCapability,
  type ModelReasoningEffort,
  type NormalizedResponse,
  type OpenAIEmbeddingBatchOutcome,
  type OpenAIEmbeddingBatchRequest,
  type OpenAIEmbeddingOutcome,
  type OpenAIEmbeddingRequest,
  type RealtimeNegotiationOutcome,
  type RealtimeNegotiationRequest,
  type RerankOutcome,
  type SpeechToTextOutcome,
  type SpeechToTextRequest,
  type TextToSpeechOutcome,
  type TextToSpeechRequest,
  type TextToSpeechStreamOutcome,
} from "@oscharko-dev/keiko-model-gateway";
import { GatewayModelPort, type ModelPort } from "@oscharko-dev/keiko-harness";
import {
  createAuditRedactor,
  DEFAULT_RETENTION,
  writeSideFile,
  deepRedactStrings,
  createNodeEvidenceStore,
  persistEvidenceManifest,
  resolveEvidenceDir,
  type EvidenceStore,
} from "@oscharko-dev/keiko-evidence";
import { keikoApiKeySecretValues, redact } from "@oscharko-dev/keiko-security";
import {
  DEFAULT_CONTEXT_PROFILE,
  isCodingWorkbenchMode,
  UNVERIFIED_GATEWAY,
  type CodingWorkbenchMode,
  type CodingWorkbenchModelSource,
  type CodingWorkbenchRuntimeEvidenceClass,
  type CodingWorkbenchRuntimeUnavailableReason,
  type DebugDeploymentPolicy,
  type DebugProductSupport,
  type DebugProvisioning,
  deriveContextProfileFromCapability,
  type ContextProfile,
  type GatewayUnsupportedDiscoveredModel,
  type GatewayVerificationState,
  type UpdatePreflightReport,
  type WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts";
import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { detectWorkspaceAt, isWithinWorkspace } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import type { RunRegistry } from "./runs.js";
import { gatewayForConfig, gatewayForRuntimeConfig } from "./gateway-instance-cache.js";
import {
  createConversationAttachmentStore,
  type ConversationAttachmentStore,
} from "./conversation-attachment-store.js";
import { createRunRegistry } from "./runs.js";
import {
  createVoiceRecapContentAttestationStore,
  type VoiceRecapContentAttestationStore,
} from "./voice-recap-provenance.js";
import type { ChatTurnSerializer } from "./chat-turn-serializer.js";
import {
  DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
  defaultServerDiagnosticSink,
  evidenceRetentionDiagnosticObserver,
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
  type ServerDiagnosticSummary,
} from "./diagnostics-log.js";
import { processServerLogSink } from "./process-log-sink.js";
import type { CodexSubscriptionProfileCoordinator } from "./coding-codex-subscription.js";
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
  createVerificationRunnerManager,
  type VerificationRunnerManager,
} from "./editor/verificationRunner.js";
import {
  createWorkspaceScriptTrustService,
  type WorkspaceScriptTrustService,
} from "./workspace-script-trust.js";
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
import type { CapturePolicyOptions } from "@oscharko-dev/keiko-memory-capture";
import type { MemoryReviewerId, MemoryScope } from "@oscharko-dev/keiko-contracts/memory";
import { createBffMemoryVault } from "./memory-handlers.js";
import {
  createMemoryAuditDeleteCommitHandler,
  createMemoryAuditHandler,
} from "./memory-audit-handler.js";
import { createEditorHotExitStore, type EditorHotExitStore } from "./editor/hotExitStore.js";
import {
  createEditorLocalHistoryStore,
  type EditorLocalHistoryStore,
} from "./editor/localHistory/localHistoryStore.js";
import {
  createConsolidationJobRegistry,
  type ConsolidationJobRegistry,
} from "./memory-consolidation-registry.js";
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
import { createHash, randomUUID } from "node:crypto";
import {
  resolveGroundingLimits,
  type GroundingLimits,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { EditorLanguageRouteOptions } from "./editor/languageRoutes.js";
import type { DapDebugRouteService } from "./editor/dap/dapDebugRoutes.js";
import { createDapDebugRouteService } from "./editor/dap/dapDebugRoutes.js";
import { createDapOperatorProvisioning } from "./editor/dap/dapOperatorProvisioningFactory.js";
import {
  parseDapOperatorProvisioningDocument,
  type DapOperatorProvisionedArtifact,
  type DapOperatorProvisioningDocument,
} from "./editor/dap/dapOperatorProvisioning.js";
import {
  createDapProductionService,
  type DapProductionProvisioning,
  type DapProductionService,
} from "./editor/dap/dapProductionService.js";
import { inspectDebugWorkspaceIdentity } from "./editor/dap/debugLaunchContext.js";
import {
  createDebugActivationControlService,
  type DebugActivationControlService,
} from "./editor/dap/debugActivationControl.js";
import type { DebugActivationEvidence } from "./editor/dap/debugActivationEvidence.js";
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
  createCodingRuntimeEditorMutationLeaseBroker,
  type CodingRuntimeEditorMutationLeasePort,
} from "./coding-runtime/codingRuntimeEditorMutationLeaseCoordinator.js";
import {
  createCodingRuntimeSnapshotStore,
  type CodingRuntimeSnapshotStore,
} from "./coding-runtime/codingRuntimeSnapshotStore.js";
import {
  createCodingRuntimeEvidenceAggregator,
  type CodingRuntimeEvidenceAggregator,
} from "./coding-runtime/codingRuntimeEvidenceAggregator.js";
import type { CodingRuntimeEventHub } from "./coding-runtime/codingRuntimeEventHub.js";
import type { CodingRuntimeOrchestrator } from "./coding-runtime/codingRuntimeOrchestrator.js";
import type { CodingSafeActivityProjection } from "./coding-runtime/codingSafeActivityProjection.js";
import {
  createCodingRuntimeControlPlane,
  type CodingRuntimeHost,
} from "./coding-runtime/codingRuntimeControlPlane.js";
import {
  createProductionCodingRuntimeHost,
  type ProductionCodingRuntimeResolver,
} from "./coding-runtime/productionCodingRuntimeHost.js";
import {
  createProductionCodingRuntimeResolver,
  type ProductionCodingRuntimeResolverInput,
} from "./coding-runtime/productionCodingRuntimeResolver.js";
import type { CodingRuntimeStartConfirmationConsumer } from "./coding-runtime/codingRuntimeStartConfirmation.js";
import { createAuthenticatedSessionStartConfirmationPlane } from "./coding-runtime/codingRuntimeStartConfirmationPlane.js";
import {
  createCodingAppSessionChannel,
  type CodingAppSessionChannel,
  type CodingAppSessionContentSource,
} from "./coding-app-session/sessionChannel.js";
import { createSessionRegistry } from "./coding-app-session/sessionRegistry.js";
import type { SessionPairingPort } from "./coding-app-session/sessionPairingPort.js";
import { resolveLauncherSessionPairingPort } from "./coding-app-session/launcherSessionPairingPort.js";
import {
  createOpenCodeGatewayReadinessRegistry,
  type OpenCodeGatewayReadinessRegistry,
} from "./coding-sidecar-gateway.js";
import { resolveProductionOpenCodeActivation } from "./coding-runtime/productionOpenCodeActivation.js";
import { readProductionWorkspaceHead } from "./coding-runtime/productionWorkspaceHeadReader.js";
import type { GitHubCodeContextApiPort } from "./coding-context/githubCodeContextConnector.js";
import type { JiraCodeContextHttpPort } from "./coding-context/jiraCodeContextConnector.js";
import { createGitHubCodeContextApiPort } from "./coding-context/githubCodeContextPort.js";
import { createGovernedJiraCodeContextHttpPort } from "./coding-context/jiraCodeContextPort.js";
import {
  createAutonomousDeliveryApprovalStore,
  type AutonomousDeliveryApprovalStore,
} from "./coding-runtime/autonomousDeliveryApprovalStore.js";
import type { AtlassianConnectorCredentialDeps } from "./atlassian/credentialRoutes.js";
import { buildAtlassianConnectorCredentialDeps } from "./atlassian/wiring.js";
// KEIKO-0565: DI-scoped Atlassian connector registries. The classes are imported (not just their
// types) so buildUiHandlerDeps can construct one instance per BFF process without depending on
// the module-level singleton.
import { AtlassianActionApprovalRegistry } from "./atlassian/actionApprovals.js";
import { AtlassianSyncJobRegistry } from "./atlassian/syncService.js";
import { createNodeManagedLspControl } from "./editor/lsp/managedLspControlFactory.js";
import { shutdownHostLspPool } from "./editor/lsp/hostLanguageOperation.js";
import type { ManagedLspControlService } from "./editor/lsp/managedLspControl.js";
import { createNodeEditorSettingsControl } from "./editor/settings/editorSettingsControlFactory.js";
import type { EditorSettingsControlService } from "./editor/settings/editorSettingsControl.js";
import {
  createEditorSettingsEventBus,
  type EditorSettingsEventBus,
} from "./editor/settings/editorSettingsEvents.js";
import {
  createWorkspaceWatchService,
  type WorkspaceWatchService,
} from "./editor/watch/workspaceWatchService.js";
import {
  createWorkspaceSnippetsService,
  type WorkspaceSnippetsService,
} from "./editor/snippets/workspaceSnippetsService.js";

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
  /** Monotonic config generation; bumped by every set(). Probes capture it before running. */
  generation(): number;
  /**
   * F-01: the last live-probe outcome for the CURRENT configuration generation. Config presence is
   * not reachability, so every surface that would otherwise infer readiness from `present()` reads
   * this instead. It lives here, on the owner of the config generation, so that replacing the
   * config through `set()` structurally invalidates a verification that described the old one — a
   * separate ledger would have to remember to do that, and forgetting is exactly the class of bug
   * this fixes.
   */
  verification(): GatewayVerificationState;
  recordVerification(state: GatewayVerificationState, observedGeneration?: number): void;
  verifiedCapability(modelId: string): VerifiedModelCapabilityObservation | undefined;
  recordVerifiedCapability(
    modelId: string,
    fields: VerifiedModelCapabilityFields,
    checkedAt: string,
    observedGeneration?: number,
  ): void;
  readonly clearVerifiedCapability: (modelId: string, observedGeneration?: number) => boolean;
}

export type VerifiedModelCapabilityFields = Partial<
  Pick<
    ModelCapability,
    | "streaming"
    | "toolCalling"
    | "structuredOutput"
    | "supportsImageInput"
    | "supportsDocumentInput"
    | "conversationReady"
  >
>;

export interface VerifiedModelCapabilityObservation {
  readonly modelId: string;
  readonly generation: number;
  readonly checkedAt: string;
  readonly fields: VerifiedModelCapabilityFields;
}

export interface GatewayDiscoveredModels {
  readonly modelIds: readonly string[];
  readonly chatModelIds: readonly string[];
  readonly embeddingModelIds: readonly string[];
  readonly imageInputModelIds?: readonly string[];
  readonly modelMetadata?: Readonly<Record<string, GatewayDiscoveredModelMetadata>>;
  // KEIKO-0325: true when the raw discovery payload contained more distinct model ids
  // than the caller (MAX_DISCOVERED_MODELS) admits. Absent or false when the discovery
  // fit within the cap. Callers should surface this to the operator so the missing
  // models can be added via manual deployment names instead of being silently absent.
  readonly truncated?: boolean;
  // Models the gateway DECLARED as a mode Keiko has no lane for (rerank, audio, image generation,
  // moderation, or an unrecognised value). Recognised, reported, never configured — so the
  // operator learns the model exists and why it was skipped instead of it vanishing silently.
  readonly unsupportedModels?: readonly GatewayUnsupportedDiscoveredModel[];
}

export interface GatewayDiscoveredModelMetadata {
  readonly contextWindow?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly toolCalling?: boolean | undefined;
  readonly reasoningEfforts?: readonly ModelReasoningEffort[] | undefined;
  /**
   * True when the discovery payload explicitly declared a chat-compatible mode for this model
   * (LiteLLM `/model/info` `mode` of chat/completion/responses). Never false — absent means the
   * gateway gave no signal either way. Flows into the persisted capability so the
   * conversation-default preference can rank mode-declared models first (customer field
   * incident: a mode-less OCR model first in the list captured the default for every new chat).
   */
  readonly chatModeDeclared?: boolean | undefined;
}

export interface GatewaySetupTestResult {
  readonly testedModelIds: readonly string[];
  readonly responseFormatModelIds: readonly string[];
}

export type GatewayModelDiscoveryOutput = readonly string[] | GatewayDiscoveredModels;
export type ContextProfileResolver = (modelId: string) => ContextProfile;
export type CodingSidecarGatewayModelSourceResolver = () => CodingWorkbenchModelSource;

export interface UiHandlerDeps {
  // The resolved gateway config, or undefined when no config file was provided / it failed to load.
  readonly config: GatewayConfig | undefined;
  /** Encrypted, bounded local custody for browser-uploaded conversation images. */
  readonly conversationAttachmentStore?: ConversationAttachmentStore | undefined;
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
  readonly codingSidecarGatewayChatStreamFactory?:
    | ((
        config: GatewayConfig,
        modelId: string,
      ) => (request: GatewayRequest) => AsyncIterable<GatewayStreamChunk>)
    | undefined;
  /** Server-private runtime capability validation; never accepts a browser session credential. */
  readonly runtimeCapabilityAuthenticator?:
    | {
        readonly authenticate: (
          capability: string,
          audience: "model-gateway" | "tool-facade",
        ) => unknown;
        readonly reservePromptTokens?:
          ((capability: string, promptTokens: number) => unknown) | undefined;
      }
    | undefined;
  readonly openCodeGatewayReadinessRegistry?:
    | {
        readonly claim: (runId: string) => boolean;
        readonly isVerified: (runId: string) => boolean;
        readonly verifyObserved: (runId: string) => void;
        readonly waitForObservedRequest: (runId: string, signal: AbortSignal) => Promise<boolean>;
        readonly noteAdoptionGapDiagnosed: (runId: string) => boolean;
        readonly clear: (runId: string, preserveVerification?: boolean) => void;
      }
    | undefined;
  readonly codingSidecarGatewayCancellationRegistry?:
    { readonly signalFor: (runId: string) => AbortSignal | undefined } | undefined;
  readonly codingSidecarGatewayEvidenceAggregator?:
    | {
        readonly record: (event: {
          readonly runId: string;
          readonly outcome: "accepted" | "cancelled" | "failed" | "output-limit";
          readonly completionTokens: number;
          readonly outputBytes: number;
        }) => void | Promise<void>;
      }
    | undefined;
  // Issue #1987 — the coding-sidecar gateway must fail closed for subscription-backed model sources
  // even on live routes, so handlers thread this source into the projection helper instead of
  // silently defaulting every request to keiko-model-gateway semantics.
  readonly codingSidecarGatewayModelSource?: CodingWorkbenchModelSource | undefined;
  // Production resolver for the coding-sidecar model source. This keeps the routing seam live when
  // the runtime gateway config changes after first-run setup instead of freezing a test-only value.
  readonly codingSidecarGatewayModelSourceResolver?:
    CodingSidecarGatewayModelSourceResolver | undefined;
  // Server-owned runtime availability gate. #2256 wires verified activated Codex provenance.
  readonly codexRuntimeAvailability?: { readonly isApprovedVerified: () => boolean } | undefined;
  // Optional server-scoped Codex account profile coordinator. Concrete managed-runtime composition
  // injects it only alongside verified runtime provenance; absence preserves the fail-closed profile.
  readonly codexSubscriptionProfileCoordinator?: CodexSubscriptionProfileCoordinator | undefined;
  // Optional server-private final mutation claim for managed-runtime editor changesets. #2256 owns
  // composition; absence preserves the established local editor action path.
  readonly runtimeMutationLease?: CodingRuntimeEditorMutationLeasePort | undefined;
  // Optional dedicated evidence store for coding-workbench records. When absent, coding-sidecar
  // routes keep the root evidence store clean and fall back to diagnostics-only observability.
  readonly codingWorkbenchEvidenceStore?: EvidenceStore | undefined;
  readonly codingRuntimeSnapshotStore?: CodingRuntimeSnapshotStore | undefined;
  readonly codingRuntimeEvidenceAggregator?: CodingRuntimeEvidenceAggregator | undefined;
  /** Optional singleton lifecycle aggregate; runtime routes fail closed when it is not composed. */
  readonly codingRuntimeOrchestrator?: CodingRuntimeOrchestrator | undefined;
  /** Server-owned bounded replay/fan-out source for the runtime SSE route. */
  readonly codingRuntimeEventHub?: CodingRuntimeEventHub | undefined;
  /**
   * Authenticated local app-session channel (ADR-0141). Read authority for content-bearing surfaces;
   * always composed. Its pairing authority is absent unless a launcher secret or an injected port is
   * present, in which case it fails closed to a content-free projection.
   */
  readonly codingAppSessionChannel?: CodingAppSessionChannel | undefined;
  /** Process-memory #2479 feed; never part of persistence or unauthenticated runtime SSE. */
  readonly codingSafeActivityProjection?: CodingSafeActivityProjection | undefined;
  /** Content-free control-plane capability; false/absent means no qualified runtime host. */
  readonly codingRuntimeHostQualified?: boolean | undefined;
  /** Content-free reason naming the first failed activation prerequisite when unqualified. */
  readonly codingRuntimeUnavailableReason?: CodingWorkbenchRuntimeUnavailableReason | undefined;
  /**
   * Available-branch twin of the reason above: how strong the qualified runtime's evidence is.
   * Every default along this path resolves to the WEAK value, so an unthreaded path degrades to
   * "unverified" and never silently to "verified".
   */
  readonly codingRuntimeEvidenceClass?: CodingWorkbenchRuntimeEvidenceClass | undefined;
  // Server-owned deployment ceiling for coding-runtime authority. Undefined fails closed to
  // governed-assist; the readiness projection reports the same ceiling the mint clamp enforces.
  readonly codingRuntimeDeploymentCeiling?: CodingWorkbenchMode | undefined;
  // Optional governed connector mutation seam for Autonomous Delivery. Production may leave this
  // absent; the autonomous executor then fails connector writes closed instead of using provider APIs.
  readonly autonomousDeliveryConnector?: AutonomousDeliveryConnectorExecutor | undefined;
  // Server-owned approval proof store for Autonomous Delivery. The execute route consumes a proof
  // minted by the confirm route instead of trusting a client-supplied digest.
  readonly autonomousDeliveryApprovalStore?: AutonomousDeliveryApprovalStore | undefined;
  // KEIKO-0565: DI-scoped Atlassian connector approval and sync registries. Optional so
  // pre-existing fixture-heavy test wiring stays byte-for-byte compatible; production wiring in
  // buildUiHandlerDeps constructs one instance per BFF process so two independently-built
  // UiHandlerDeps instances no longer share the module-level singleton. Callers that read
  // `deps.atlassianActionApprovalRegistry` / `deps.atlassianSyncJobRegistry` see the injected
  // instance; callers that still import the module-level singleton read the process-wide default
  // that buildUiHandlerDeps points to, preserving current behaviour until every consumer is
  // migrated.
  readonly atlassianActionApprovalRegistry?: AtlassianActionApprovalRegistry | undefined;
  readonly atlassianSyncJobRegistry?: AtlassianSyncJobRegistry | undefined;
  // Server-owned deployment ceiling for Autonomous Delivery requests. Undefined fails closed to the
  // lowest authority posture instead of accepting the request-supplied ceiling.
  readonly autonomousDeliveryDeploymentCeiling?: CodingWorkbenchMode | undefined;
  // Optional server-owned stop-state seam. A client can still stop itself by sending
  // operatorStopped:true, but it cannot hide a server-recorded stop for the run.
  readonly autonomousDeliveryStopState?:
    { readonly isStopped: (runId: string) => boolean } | undefined;
  // Optional injectable ports for the coding-context intake route (#1989 wiring). Production
  // composes real ports from env/workspace when absent; tests inject deterministic fakes.
  readonly codingContextGitHubPort?: GitHubCodeContextApiPort | undefined;
  readonly codingContextJiraPort?: JiraCodeContextHttpPort | undefined;
  // Issue #2241 (Epic #2238, ADR-0128) — Atlassian connector credential custody: the write-only
  // custody surface plus the per-credential outbound HTTP port factory. The decrypted token is
  // intentionally NOT part of redactionSecrets (same rationale as the Figma vault PAT): it never
  // reaches a redactable payload — it is confined to the outbound Authorization header by
  // construction (atlassian/httpPort.ts) and is never returned, logged, or serialized. Optional so
  // legacy tests that do not exercise /api/atlassian-connectors/* keep their fixtures unchanged;
  // the routes degrade to 503 when absent.
  readonly atlassianConnectorCredentials?: AtlassianConnectorCredentialDeps | undefined;
  // Exact secret literals used by evidence persistence in addition to gateway redaction patterns.
  readonly redactionSecrets?: readonly string[] | undefined;
  // Optional deployment replacement for the default mode-independent memory category denylist.
  // Category names and matched bodies remain inside the capture policy boundary.
  readonly memoryDeniedCategoryMatchers?:
    CapturePolicyOptions["deniedCategoryMatchers"] | undefined;
  // UI-local persistence (ADR-0013). Holds projects, chats, and chat messages. Tests inject the
  // in-memory store via createInMemoryUiStore; production wiring resolves a node:sqlite file path.
  readonly store: UiStore;
  // One chat has one canonical execution order across buffered, SSE, and grounded entry points.
  // Tests may inject a deterministic serializer; production falls back to one registry per store.
  readonly chatTurnSerializer?: ChatTurnSerializer | undefined;
  // Resolved UI database file path when known. Project onboarding uses this to prevent the UI DB
  // and selected repositories from overlapping on disk.
  readonly uiDbPath?: string | undefined;
  // Releases process-lifetime resources owned by these deps (today: the shared node:sqlite
  // handle, closed with an explicit WAL checkpoint instead of relying on process exit).
  // Optional and idempotent; hosts call it once the HTTP server has fully shut down.
  readonly dispose?: (() => void | Promise<void>) | undefined;
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
  readonly verificationRunner?: VerificationRunnerManager | undefined;
  readonly workspaceScriptTrust?: WorkspaceScriptTrustService | undefined;
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
  // Server-private, single-use content attestations minted only by a trusted transcript observer.
  // Without this port, recap submissions remain review-gated and can never auto-accept.
  readonly voiceRecapContentAttestations?: VoiceRecapContentAttestationStore | undefined;
  // Server-owned encrypted editor recovery storage. The browser stores only metadata and an opaque
  // reference in IndexedDB.
  readonly editorHotExitStore?: EditorHotExitStore | undefined;
  // ADR-0147 D7 — server-owned encrypted, bounded file checkpoints. This is intentionally
  // independent from hot-exit recovery and from Code-task history.
  readonly editorLocalHistoryStore?: EditorLocalHistoryStore | undefined;
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
    | ((
        config: GatewayConfig,
        candidateModelIds: readonly string[],
      ) => Promise<readonly string[] | GatewaySetupTestResult>)
    | undefined;
  // Test seam for the setup-time embedding probe. Production issues ONE real embedding request per
  // declared embedding candidate, so a model that cannot embed is never persisted as this
  // gateway's embedding model (LiteLLM field incident, 2026-08). Returns the ids that answered.
  readonly gatewayEmbeddingProbe?:
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
  // Epic #2096 / Issue #2345 — route-facing composition over the canonical DAP manager,
  // instrumentation store, browser capability registry, pause references, and SSE bridge. Optional
  // until #2347 replaces the temporary default-off route flag with the production activation gate.
  readonly dapDebug?: DapDebugRouteService | undefined;
  // ADR-0136 D7's derived debug capability gate. The M7 setting remains the durable opt-in.
  readonly debugActivationControl?: DebugActivationControlService | undefined;
  // Epic #2094 / Issue #2272 — canonical server-owned per-workspace managed-LSP control plane.
  // Optional for legacy dependency fixtures; production always wires a state-dir-backed service.
  readonly managedLspControl?: ManagedLspControlService | undefined;
  // Epic #2095 / Issue #2318 — canonical server-owned editor settings control plane.
  // Optional for legacy dependency fixtures; production wires it over the same private state dir.
  readonly editorSettingsControl?: EditorSettingsControlService | undefined;
  readonly editorSettingsEvents?: EditorSettingsEventBus | undefined;
  // Epic #2095 / Issue #2319 — root-scoped workspace watch/reconciliation service.
  readonly workspaceWatchService?: WorkspaceWatchService | undefined;
  // Epic #2095 / Issue #2323 — governed workspace snippets.
  readonly workspaceSnippets?: WorkspaceSnippetsService | undefined;
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
  readonly conversationAttachmentStore?: ConversationAttachmentStore | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  // Optional deployment replacement for the default memory category denylist. Production leaves
  // this unset unless an operator supplies a reviewed, ReDoS-safe policy at composition time.
  readonly memoryDeniedCategoryMatchers?:
    CapturePolicyOptions["deniedCategoryMatchers"] | undefined;
  readonly workspaceScriptTrust?: WorkspaceScriptTrustService | undefined;
  // Optional injected registry (tests); a fresh bounded registry is created otherwise.
  readonly registry?: RunRegistry | undefined;
  // Optional injected ModelPort factory (tests); the GatewayModelPort builder is used otherwise.
  readonly modelPortFactory?: ModelPortFactory | undefined;
  // Optional coding-sidecar model-source override. Production defaults to deriving the source from
  // the selected coding-safe provider profile; tests and future config surfaces may override it.
  readonly codingSidecarGatewayModelSource?: CodingWorkbenchModelSource | undefined;
  /** Qualified runtime host injection. Production remains fail-closed until #2258 supplies it. */
  readonly codingRuntimeHost?: CodingRuntimeHost | undefined;
  /** Server-owned production resolver; a missing or unqualified resolver preserves fail-closed mode. */
  readonly codingRuntimeResolver?: ProductionCodingRuntimeResolver | undefined;
  /**
   * Release-qualified backend and governed tool adapters used by the normal server/CLI composition.
   * They do not activate a runtime without a central start-confirmation consumer.
   */
  readonly codingRuntimeProductionPorts?: ProductionCodingRuntimePorts | undefined;
  /** Central #2377 adapter. Absence is an intentional fail-closed production posture. */
  readonly codingRuntimeStartConfirmationConsumer?:
    CodingRuntimeStartConfirmationConsumer | undefined;
  /**
   * App-session pairing authority (ADR-0141). Injected first (the CI fake); production otherwise
   * resolves the launcher-bound port from the environment. It mints read authority, so production
   * composition must never construct or fall back to the fake — a missing port fails closed.
   */
  readonly sessionPairingPort?: SessionPairingPort | undefined;
  /**
   * Bounded content source the app-session channel projects to a paired session. Absent in this
   * wave's production composition (content routing is W1.5+); tests inject a deterministic payload.
   */
  readonly codingAppSessionContentSource?: CodingAppSessionContentSource | undefined;
  // Explicit deployment ceiling for coding-runtime authority. Precedence: this option, then the
  // KEIKO_CODING_DEPLOYMENT_CEILING environment value, then the governed-assist default. An
  // unrecognized environment value is ignored fail-closed (the narrowest posture wins).
  readonly codingRuntimeDeploymentCeiling?: CodingWorkbenchMode | undefined;
  /**
   * Read-only public research egress (#2387). Enabled by default: this only opens the
   * network-egress ACTION CLASS in the run envelope — every individual fetch still requires an
   * operator-approved, host- and request-line-bound grant, so no approval means no outbound
   * request. Set false to deny the class entirely for deployments that forbid research.
   */
  readonly codingRuntimeResearchEgressEnabled?: boolean | undefined;
  readonly codingRuntimeServerPrincipal?: (() => string | undefined) | undefined;
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
  // KEIKO-0565: injectable Atlassian action-approval and sync-job registries. Production wiring
  // constructs one instance per BFF process; test wiring can inject fresh instances to keep test
  // isolation clean instead of resetting a module-level singleton.
  readonly atlassianActionApprovalRegistry?: AtlassianActionApprovalRegistry | undefined;
  readonly atlassianSyncJobRegistry?: AtlassianSyncJobRegistry | undefined;
  // UI-local SQLite DB path (`keiko ui --ui-db`); resolved via UI-store precedence (explicit →
  // KEIKO_UI_DATA_DIR → homedir/.keiko/keiko-ui.db). Mirrors evidenceDir's shape.
  readonly uiDbPath?: string | undefined;
  // Optional injected UiStore (tests); a node store opened at the resolved path is built otherwise.
  readonly store?: UiStore | undefined;
  // Companion to an injected `store`: the coding-runtime control plane is assembled only when a
  // snapshot store exists, so a composition that injects a UiStore must inject this alongside it
  // or it silently loses the entire coding runtime (the daily real-binary lane refused as
  // `unqualified:undefined` for two weeks after #2835 injected a store without one). Ignored
  // when no store is injected — the UI-database path composes its own over the shared handle.
  readonly codingRuntimeSnapshotStore?: CodingRuntimeSnapshotStore | undefined;
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
  // Optional injected editor local-history store (tests); production creates one dedicated vault
  // namespace under the runtime state directory.
  readonly editorLocalHistoryStore?: EditorLocalHistoryStore | undefined;
  // Optional published DAP service. Activation only uses this bounded revocation seam; it never
  // reaches into adapter transport or launch internals.
  readonly dapDebug?: DapDebugRouteService | undefined;
  /**
   * Operator-owned, workspace-external DAP provisioning. The normal BFF composes this only when
   * all four activation factors below are supplied; absent configuration remains unavailable.
   */
  readonly dapProductionProvisioning?: DapProductionProvisioning | undefined;
  readonly dapProductSupport?: (realRoot: string | undefined) => DebugProductSupport;
  readonly dapDeploymentPolicy?: (realRoot: string | undefined) => DebugDeploymentPolicy;
  readonly dapProvisioning?: (realRoot: string) => DebugProvisioning;
  // Deterministic activation-control seam for route/bootstrap tests.
  readonly managedLspControl?: ManagedLspControlService | undefined;
  // Deterministic debug-activation control seam for route/bootstrap tests.
  readonly debugActivationControl?: DebugActivationControlService | undefined;
  // Deterministic editor-settings control seam for route/bootstrap tests.
  readonly editorSettingsControl?: EditorSettingsControlService | undefined;
  readonly editorSettingsEvents?: EditorSettingsEventBus | undefined;
  readonly workspaceWatchService?: WorkspaceWatchService | undefined;
  readonly workspaceSnippets?: WorkspaceSnippetsService | undefined;
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
    | ((
        config: GatewayConfig,
        candidateModelIds: readonly string[],
      ) => Promise<readonly string[] | GatewaySetupTestResult>)
    | undefined;
  // Optional setup-time embedding probe seam (tests); production issues one real embedding request
  // per declared embedding candidate.
  readonly gatewayEmbeddingProbe?:
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

export type ProductionCodingRuntimePorts = Pick<
  ProductionCodingRuntimeResolverInput,
  "backend" | "editorAgentClient" | "secureWorkspaceTextRead"
>;

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
  return token.length === 0 ? undefined : token.toLowerCase().replaceAll("_", "-");
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
  // A freshly loaded config has never been probed by this process, so it starts unverified. It is
  // never seeded from disk: a probe outcome describes a live endpoint at a point in time, not a
  // stored setting, and reloading one would let a surface claim health nobody observed.
  let verification: GatewayVerificationState = UNVERIFIED_GATEWAY;
  const verifiedCapabilities = new Map<string, VerifiedModelCapabilityObservation>();
  // Bumped on every set(): a probe captures the generation it observed, and a verdict carrying a
  // stale generation is dropped, so a slow probe of the PREVIOUS config can never stamp the
  // replacement config with an outcome nobody measured against it (#2847 review).
  let generation = 0;
  return {
    storagePath,
    current: (): GatewayConfig | undefined => config,
    present: (): boolean => present,
    set(next: GatewayConfig | undefined, nextPresent: boolean): void {
      config = next;
      present = nextPresent;
      verification = UNVERIFIED_GATEWAY;
      verifiedCapabilities.clear();
      generation += 1;
    },
    generation: (): number => generation,
    verification: (): GatewayVerificationState => verification,
    recordVerification(state: GatewayVerificationState, observedGeneration?: number): void {
      if (observedGeneration !== undefined && observedGeneration !== generation) return;
      verification = state;
    },
    verifiedCapability: (modelId): VerifiedModelCapabilityObservation | undefined =>
      verifiedCapabilities.get(modelId),
    recordVerifiedCapability: (modelId, fields, checkedAt, observedGeneration): void => {
      if (observedGeneration !== undefined && observedGeneration !== generation) return;
      verifiedCapabilities.set(modelId, {
        modelId,
        generation,
        checkedAt,
        fields: { ...fields },
      });
    },
    clearVerifiedCapability: (modelId, observedGeneration): boolean => {
      if (observedGeneration !== undefined && observedGeneration !== generation) return false;
      return verifiedCapabilities.delete(modelId);
    },
  };
}

export function currentGatewayConfig(deps: UiHandlerDeps): GatewayConfig | undefined {
  return deps.gatewayConfig?.current() ?? deps.config;
}

/** Resolves the process-shared gateway while honoring live runtime-config generations. */
export function currentGateway(deps: UiHandlerDeps): Gateway | undefined {
  if (deps.gatewayConfig !== undefined) {
    return gatewayForRuntimeConfig(deps.gatewayConfig);
  }
  return deps.config === undefined ? undefined : gatewayForConfig(deps.config);
}

/**
 * F-01: the last live-probe outcome, or `unverified` when this process holds none (including every
 * deps assembly that carries a plain `config` without the runtime holder). Fail closed: a surface
 * that cannot name a probe result must never render a healthy state.
 */
export function currentGatewayVerification(
  deps: Pick<UiHandlerDeps, "gatewayConfig">,
): GatewayVerificationState {
  return deps.gatewayConfig?.verification() ?? UNVERIFIED_GATEWAY;
}

/** Returns true only for a basic-chat observation bound to the holder's current generation. */
export function currentConversationReady(
  deps: Pick<UiHandlerDeps, "gatewayConfig">,
  modelId: string,
): boolean {
  const holder = deps.gatewayConfig;
  if (holder === undefined) return false;
  const observation = holder.verifiedCapability(modelId);
  return (
    observation?.generation === holder.generation() && observation.fields.conversationReady === true
  );
}

/**
 * Tri-state view for the models wire: `true`/`false` only when the CURRENT generation holds an
 * actual basic-chat observation, `undefined` when this process never probed the model since the
 * configuration was (re)loaded. The observation store is process-local by design, so collapsing
 * "unknown" into "not ready" told the UI after every restart that no model was usable until a
 * manual probe plus reload (customer field incident, 0.3.11). Admission guards keep using the
 * strict boolean `currentConversationReady` — unknown never admits, it only defers to the
 * on-demand probe at the conversation entry points.
 */
export function currentConversationReadinessObservation(
  deps: Pick<UiHandlerDeps, "gatewayConfig">,
  modelId: string,
): boolean | undefined {
  const holder = deps.gatewayConfig;
  if (holder === undefined) return undefined;
  const observation = holder.verifiedCapability(modelId);
  if (observation?.generation !== holder.generation()) return undefined;
  return observation.fields.conversationReady;
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

/**
 * The provider model id a #2387 read-only child agent runs on: the coding-safe sidecar profile's
 * resolved alias, i.e. exactly what the sidecar gateway maps the runtime's "coding" alias onto.
 * Undefined when no coding-safe model is available, which keeps the child-agent port unmounted
 * rather than launching a child against an id the gateway cannot resolve.
 */
function codingSafeChildModelId(runtimeConfig: RuntimeGatewayConfig): string | undefined {
  const config = runtimeConfig.current();
  if (config === undefined) return undefined;
  const resolved = resolveCodingSafeSidecarGatewayProfile(config);
  return resolved.status === "available" ? resolved.modelAlias : undefined;
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

/**
 * The string redactor a route hands to the evidence/audit layer: built-in secret SHAPES plus the LIVE
 * gateway-derived literals (a key added through PATCH /api/gateway/config after process start is
 * scrubbed too, which the frozen `deps.redactionSecrets` snapshot would miss).
 *
 * `recordMemoryAudit`/`recordMemoryAudits` require a redactor — the identity default that used to
 * stand in for a forgotten one was a fail-open on the evidence-redaction boundary — so this is the one
 * place a route resolves it from. Do not hand those APIs `(input) => input` or `deps.redactor` cast to
 * a string function; both defeat the boundary.
 */
export function currentAuditRedactString(deps: UiHandlerDeps): (input: string) => string {
  return (input: string): string => redact(input, currentRedactionSecrets(deps));
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
    const gateway = gatewayForRuntimeConfig(runtimeConfig);
    if (gateway === undefined) {
      return undefined;
    }
    return new GatewayModelPort(gateway);
  };
}

function buildTerminalManager(options: {
  readonly store: UiStore;
  readonly evidenceStore: EvidenceStore;
  readonly env: EnvSource;
  readonly liveRedactor: Redactor;
  readonly diagnostics: ServerDiagnosticSink | undefined;
}): TerminalExecutionManager {
  return createTerminalExecutionManager({
    store: options.store,
    evidenceStore: options.evidenceStore,
    processEnv: options.env,
    diagnostics: options.diagnostics,
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
  readonly diagnostics: ServerDiagnosticSink | undefined;
  readonly workspaceScriptTrust: WorkspaceScriptTrustService;
}): CommandRunnerManager {
  return createCommandRunnerManager({
    store: options.store,
    evidenceStore: options.evidenceStore,
    processEnv: options.env,
    diagnostics: options.diagnostics,
    isWorkspaceTrustedForPackageScripts: (projectId, workspace): boolean =>
      options.workspaceScriptTrust.isTrusted(projectId, workspace),
    redactor: (value: string): string => {
      const redacted = options.liveRedactor(value);
      return typeof redacted === "string" ? redacted : value;
    },
  });
}

// The editor verification runner and command runner receive the same server-owned, manifest-bound
// trust service. SSE-event redaction is applied at the route boundary (deps.redactor); the manager's
// own redactor below guards persisted evidence, mirroring buildCommandRunner.
//
// Issue #2211 fix-up (Epic #2092): also wires the SAME evidenceStore + live-redactor construction
// pattern buildCommandRunner uses, so every finished verification run writes a content-free audit
// entry instead of running silently unaudited.
function buildVerificationRunner(options: {
  readonly store: UiStore;
  readonly evidenceStore: EvidenceStore;
  readonly liveRedactor: Redactor;
  readonly diagnostics: ServerDiagnosticSink | undefined;
  readonly workspaceScriptTrust: WorkspaceScriptTrustService;
}): VerificationRunnerManager {
  return createVerificationRunnerManager({
    store: options.store,
    evidenceStore: options.evidenceStore,
    diagnostics: options.diagnostics,
    isWorkspaceTrustedForPackageScripts: (projectId, workspace): boolean =>
      options.workspaceScriptTrust.isTrusted(projectId, workspace),
    redactor: (value: string): string => {
      const redacted = options.liveRedactor(value);
      return typeof redacted === "string" ? redacted : value;
    },
  });
}

function propagateManagedLspRestriction(
  control: ManagedLspControlService | undefined,
  canonicalRoot: string,
  redact: Redactor,
): void {
  const pending = control?.restrict(canonicalRoot);
  if (pending === undefined) return;
  void pending.catch((error: unknown): void => {
    emitServerDiagnostic(
      undefined,
      serverDiagnosticFromError({
        correlationId: "managed-lsp-trust-restriction",
        operation: "managed-lsp.trust.restrict",
        source: "managed-lsp-control",
        error,
        redact: (message): string => {
          const redacted = redact(message);
          return typeof redacted === "string" ? redacted : "[REDACTED]";
        },
      }),
    );
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
  readonly diagnostics: ServerDiagnosticSink | undefined;
}): ContainerRunnerManager {
  return createContainerRunnerManager({
    store: options.store,
    evidenceStore: options.evidenceStore,
    processEnv: options.env,
    diagnostics: options.diagnostics,
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
  readonly diagnostics: ServerDiagnosticSink | undefined;
}): BrowserSessionManager {
  return createBrowserSessionManager({
    evidenceDir: options.evidenceDir,
    evidenceStore: options.evidenceStore,
    redactor: options.redactor,
    evidenceManifestWriter: (manifest) =>
      persistEvidenceManifest(
        manifest,
        options.evidenceStore,
        (value): string => redactEvidenceString(options.redactor, value),
        DEFAULT_RETENTION,
        evidenceRetentionDiagnosticObserver(options.diagnostics, "browser-capture"),
      ).location,
    costClassResolver: resolveCostClass,
    sideFileWriter: (basename, bytes, runId) =>
      writeSideFile(options.evidenceDir, runId, basename, bytes, { fs: nodeWorkspaceFs }),
  });
}

export function redactEvidenceString(redactor: Redactor, value: string): string {
  const redacted = redactor(value);
  if (typeof redacted !== "string") {
    throw new TypeError("Evidence redactor returned a non-string value.");
  }
  return redacted;
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
//
// This scope is PROCESS-WIDE, not per project: every relationship row is written and read under
// the same identifier, so the graph totals and the health findings are installation-wide. There is
// no project-scoped read to narrow to — narrowing the read alone would simply hide every existing
// row. The relationship UI therefore labels those numbers installation-wide instead of letting an
// operator read them as "this project" (RelationshipHealthPanel `scopeNote`). Real per-project
// scope needs a scope-carrying write path plus a migration of existing rows, not a read filter.
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
  // The coding-runtime control plane is only assembled when this store exists, so an injected
  // UiStore MUST be able to bring its own snapshot store along — otherwise the composition
  // silently loses the entire coding runtime (the daily real-binary lane failed exactly this
  // way for two weeks after #2835 injected a store without one).
  readonly codingRuntimeSnapshotStore: CodingRuntimeSnapshotStore | undefined;
}

// A `UiStoreSchemaVersionError` or unrecoverable corruption here crashes startup — correctly: this
// store cannot silently continue without its schema — but that crash must not be a bare,
// undiagnosed exception. `emitCompositionDiagnostic` records it before the throw propagates, so an
// operator sees WHY the process refused to start instead of only an unhandled trace, exactly like
// every other composition-root boundary in this module. `processServerLogSink()` is wired in as
// the store's own `store.opened` activity-log sink so a successful open is recorded too.
function openUiDatabaseForComposition(
  resolvedUiDbPath: string,
  diagnostics: ServerDiagnosticSink | undefined,
): DatabaseSync {
  try {
    return openNodeUiDatabase(resolvedUiDbPath, processServerLogSink());
  } catch (error) {
    emitCompositionDiagnostic(
      diagnostics,
      "deps.composePersistence",
      DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
      error,
    );
    throw error;
  }
}

function composePersistence(
  injected: UiStore | undefined,
  injectedCodingRuntimeSnapshots: CodingRuntimeSnapshotStore | undefined,
  resolvedUiDbPath: string,
  redactString: (value: string) => string,
  env: EnvSource,
  diagnostics: ServerDiagnosticSink | undefined,
): ComposedPersistence {
  if (injected !== undefined) {
    return {
      store: injected,
      dispose: undefined,
      relationship: undefined,
      workspaceInstanceStore: undefined,
      activeWorkspacePointerStore: undefined,
      codingRuntimeSnapshotStore: injectedCodingRuntimeSnapshots,
    };
  }
  const db = openUiDatabaseForComposition(resolvedUiDbPath, diagnostics);
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
    codingRuntimeSnapshotStore: createCodingRuntimeSnapshotStore(db),
  };
}

// The Keiko-owned managed task-workspace root lives alongside the UI database (`<uiDbDir>/
// task-workspaces`), so it inherits the same per-user data directory and 0o700 hardening posture.
function resolveManagedWorktreeRoot(uiDbPath: string): string {
  return join(dirname(uiDbPath), "task-workspaces");
}

function composedManagedWorktreeRoot(
  provisioning: WorkspaceProvisioningService | undefined,
  resolvedUiDbPath: string,
  diagnostics: ServerDiagnosticSink | undefined,
): string | undefined {
  if (provisioning === undefined) return undefined;
  const managedRoot = resolveManagedWorktreeRoot(resolvedUiDbPath);
  // Canonical managed-root classification is a shared Files/Git trust boundary even before the
  // first Coding run. Materialize the directory with the persistence services so an idle/fresh
  // installation can classify ordinary roots without treating an absent boundary as authority.
  if (!materializedManagedRoot(managedRoot, diagnostics)) {
    throw new Error("Managed task-workspace boundary initialization failed.");
  }
  return managedRoot;
}

function managedWorkspaceRootRef(uiStore: UiStore, managedRoot: string): string {
  const rootRef = uiStore
    .findWorkspaceManifestRecordByProject(managedRoot)
    ?.rootProjects.find((root) => root.projectPath === managedRoot)?.rootRef;
  if (rootRef === undefined) {
    throw new Error("Managed workspace manifest identity is unavailable.");
  }
  return rootRef;
}

export function ensureManagedTaskWorkspaceIdentity(input: {
  readonly uiStore: UiStore;
  readonly workspaceScriptTrust: WorkspaceScriptTrustService;
  readonly instance: WorkspaceInstance;
  readonly initializeTrust: boolean;
}): void {
  const projectRegistered = input.uiStore
    .listProjects()
    .some((project) => project.path === input.instance.managedWorktreePath);
  const manifestRegistered =
    input.uiStore.findWorkspaceManifestRecordByProject(input.instance.managedWorktreePath) !==
    undefined;
  if (!projectRegistered || !manifestRegistered) {
    input.uiStore.createProject(
      input.instance.managedWorktreePath,
      `${basename(input.instance.repositoryRoot)} · Coding Workbench`,
    );
  }
  if (!input.initializeTrust) return;
  if (input.workspaceScriptTrust.trustLevelForRoot(input.instance.repositoryRoot) !== "trusted") {
    return;
  }
  const rootRef = managedWorkspaceRootRef(input.uiStore, input.instance.managedWorktreePath);
  // An absent target record may be initialized from this explicit provisioning act. A restricted
  // record is authoritative evidence of revocation or drift and must never be silently overwritten.
  if (input.uiStore.readWorkspaceTrustRecord(rootRef) !== undefined) return;
  input.workspaceScriptTrust.deriveFromTrustedRoot(
    input.instance.managedWorktreePath,
    input.instance.repositoryRoot,
  );
}

function withManagedWorkspaceIdentity(
  provisioning: WorkspaceProvisioningService,
  uiStore: UiStore,
  workspaceScriptTrust: WorkspaceScriptTrustService,
): WorkspaceProvisioningService {
  return {
    provision: async (request): ReturnType<WorkspaceProvisioningService["provision"]> => {
      const result = await provisioning.provision(request);
      ensureManagedTaskWorkspaceIdentity({
        uiStore,
        workspaceScriptTrust,
        instance: result.instance,
        initializeTrust: true,
      });
      return result;
    },
    activate: async (request): ReturnType<WorkspaceProvisioningService["activate"]> => {
      const result = await provisioning.activate(request);
      ensureManagedTaskWorkspaceIdentity({
        uiStore,
        workspaceScriptTrust,
        instance: result.instance,
        initializeTrust: false,
      });
      return result;
    },
    getInstance: (workspaceId): WorkspaceInstance | undefined =>
      provisioning.getInstance(workspaceId),
    ensureIdentity: (instance): void => {
      provisioning.ensureIdentity?.(instance);
      ensureManagedTaskWorkspaceIdentity({
        uiStore,
        workspaceScriptTrust,
        instance,
        initializeTrust: false,
      });
    },
  };
}

interface BuildWorkspaceProvisioningArgs {
  readonly options: BuildHandlerDepsOptions;
  readonly instanceStore: WorkspaceInstanceStore | undefined;
  readonly uiStore: UiStore;
  readonly workspaceScriptTrust: WorkspaceScriptTrustService;
  readonly resolvedUiDbPath: string;
  readonly evidenceStore: EvidenceStore;
  readonly redactString: (value: string) => string;
  readonly mutex: WorkspaceMutexRegistry;
}

function buildWorkspaceProvisioning(
  args: BuildWorkspaceProvisioningArgs,
): WorkspaceProvisioningService | undefined {
  const { options, instanceStore, uiStore, workspaceScriptTrust } = args;
  if (options.workspaceProvisioning !== undefined) {
    return withManagedWorkspaceIdentity(
      options.workspaceProvisioning,
      uiStore,
      workspaceScriptTrust,
    );
  }
  if (instanceStore === undefined) return undefined;
  return createWorkspaceProvisioningService({
    store: instanceStore,
    evidenceStore: args.evidenceStore,
    managedRoot: resolveManagedWorktreeRoot(args.resolvedUiDbPath),
    createAdapter: (workspace) =>
      createNodeGitWorktreeAdapter({ workspace, processEnv: options.env }),
    redactString: args.redactString,
    now: () => Date.now(),
    newId: randomUUID,
    ensureManagedWorkspaceIdentity: (instance, initializeTrust): void => {
      ensureManagedTaskWorkspaceIdentity({
        uiStore,
        workspaceScriptTrust,
        instance,
        initializeTrust,
      });
    },
    mutex: args.mutex,
  });
}

// Issue #446 — the active-binding lifecycle service. It composes the SAME #445 instance store,
// provisioning service, evidence store, and active-pointer store (no second worktree/lock/transition
// engine). Returns undefined whenever any composed dependency is absent (injected UiStore tests), so
// the active-binding routes degrade to 503 exactly like the provisioning routes.
interface BuildWorkspaceLifecycleArgs {
  readonly options: BuildHandlerDepsOptions;
  readonly instanceStore: WorkspaceInstanceStore | undefined;
  readonly activePointerStore: ActiveWorkspacePointerStore | undefined;
  readonly provisioning: WorkspaceProvisioningService | undefined;
  readonly resolvedUiDbPath: string;
  readonly evidenceStore: EvidenceStore;
  readonly redactString: (value: string) => string;
  readonly mutex: WorkspaceMutexRegistry;
}

function buildWorkspaceLifecycle(
  args: BuildWorkspaceLifecycleArgs,
): WorkspaceLifecycleService | undefined {
  if (args.options.workspaceLifecycle !== undefined) return args.options.workspaceLifecycle;
  if (
    args.instanceStore === undefined ||
    args.activePointerStore === undefined ||
    args.provisioning === undefined
  ) {
    return undefined;
  }
  return createWorkspaceLifecycleService({
    store: args.instanceStore,
    activePointerStore: args.activePointerStore,
    managedRoot: resolveManagedWorktreeRoot(args.resolvedUiDbPath),
    provisioning: args.provisioning,
    evidenceStore: args.evidenceStore,
    redactString: args.redactString,
    now: () => Date.now(),
    newId: randomUUID,
    mutex: args.mutex,
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
interface BuildWorkspaceRepairArgs {
  readonly options: BuildHandlerDepsOptions;
  readonly instanceStore: WorkspaceInstanceStore | undefined;
  readonly activePointerStore: ActiveWorkspacePointerStore | undefined;
  readonly provisioning: WorkspaceProvisioningService | undefined;
  readonly resolvedUiDbPath: string;
  readonly evidenceStore: EvidenceStore;
  readonly redactString: (value: string) => string;
  readonly mutex: WorkspaceMutexRegistry;
}

function buildWorkspaceRepair(args: BuildWorkspaceRepairArgs): WorkspaceRepairService | undefined {
  if (args.options.workspaceRepair !== undefined) return args.options.workspaceRepair;
  if (
    args.instanceStore === undefined ||
    args.activePointerStore === undefined ||
    args.provisioning === undefined
  ) {
    return undefined;
  }
  return createWorkspaceRepairService({
    store: args.instanceStore,
    activePointerStore: args.activePointerStore,
    evidenceStore: args.evidenceStore,
    provisioning: args.provisioning,
    managedRoot: resolveManagedWorktreeRoot(args.resolvedUiDbPath),
    createAdapter: (workspace) =>
      createNodeGitWorktreeAdapter({ workspace, processEnv: args.options.env }),
    redactString: args.redactString,
    now: () => Date.now(),
    newId: randomUUID,
    mutex: args.mutex,
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

interface BuildWorkspaceCleanupArgs {
  readonly options: BuildHandlerDepsOptions;
  readonly instanceStore: WorkspaceInstanceStore | undefined;
  readonly activePointerStore: ActiveWorkspacePointerStore | undefined;
  readonly uiStore: UiStore;
  readonly resolvedUiDbPath: string;
  readonly evidenceStore: EvidenceStore;
  readonly redactString: (value: string) => string;
  readonly mutex: WorkspaceMutexRegistry;
}

function buildWorkspaceCleanup(
  args: BuildWorkspaceCleanupArgs,
): WorkspaceCleanupService | undefined {
  if (args.options.workspaceCleanup !== undefined) return args.options.workspaceCleanup;
  if (args.instanceStore === undefined || args.activePointerStore === undefined) return undefined;
  return createWorkspaceCleanupService({
    store: args.instanceStore,
    activePointerStore: args.activePointerStore,
    evidenceStore: args.evidenceStore,
    managedRoot: resolveManagedWorktreeRoot(args.resolvedUiDbPath),
    createAdapter: (workspace) =>
      createNodeGitWorktreeAdapter({ workspace, processEnv: args.options.env }),
    redactString: args.redactString,
    now: () => Date.now(),
    newId: randomUUID,
    removeManagedWorkspaceIdentity: (instance): void => {
      if (
        args.uiStore.listProjects().some((project) => project.path === instance.managedWorktreePath)
      ) {
        args.uiStore.deleteProject(instance.managedWorktreePath);
      }
    },
    mutex: args.mutex,
  });
}

// Best-effort startup reconciliation (Issue #447): mirror the QI-retention startup pass — run once at
// bootstrap, never throw into construction, and never block server start (the reconcile IO is detached
// and self-contained). A failure simply leaves the persisted classification untouched until the next
// pass or an explicit refresh.
/** @internal Exported only for deterministic server tests. */
export function reconcileTaskWorkspacesAtStartup(
  service: WorkspaceReconciliationService | undefined,
): void {
  if (service === undefined) return;
  // Construction must never fail because of reconciliation, so both failure modes are swallowed.
  // Invoking inside `.then` rather than a `try` is what makes that possible with a single handler:
  // a synchronous throw from the call itself (property lookup + invocation), which a non-conforming
  // implementation such as a test double can still raise even though `reconcile()` is typed as
  // always returning a Promise, is converted into a rejection and lands in the same `.catch`. A
  // `try` around a promise-returning call is rejected by typescript:S4822 in either direction —
  // with a `.catch` it asks for the `try` to go, without one it asks for the `.catch`.
  void Promise.resolve()
    .then(() => service.reconcile())
    .catch(() => undefined);
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
  readonly verificationRunner: VerificationRunnerManager;
  readonly workspaceScriptTrust: WorkspaceScriptTrustService;
  // #2628 — invoked from createUiHandlerDispose so the injected-trust-service listener
  // (registered by resolveTrustAndManagedLspControl) is removed at teardown.
  readonly disposeTrustLspBridge: () => void;
  readonly updateSession: UpdateSessionManager;
  readonly updatePreflight: UiHandlerDeps["updatePreflight"];
  readonly updateLocalState: UpdateLocalStateManager;
  readonly updateRemediation: UpdateRemediationManager;
  readonly containerRunner: ContainerRunnerManager;
  readonly browser: BrowserSessionManager;
  readonly memoryVault: MemoryVaultStore;
  readonly editorHotExitStore: EditorHotExitStore;
  readonly editorLocalHistoryStore: EditorLocalHistoryStore;
  readonly managedLspControl: ManagedLspControlService;
  readonly debugActivationControl: DebugActivationControlService;
  readonly editorSettingsControl: EditorSettingsControlService;
  readonly editorSettingsEvents: EditorSettingsEventBus;
  readonly workspaceWatchService: WorkspaceWatchService;
  readonly workspaceSnippets: WorkspaceSnippetsService;
  readonly memoryAuthorization: MemoryAuthorizationContext;
}

interface DapRuntimeReference {
  current: DapDebugRouteService | undefined;
  productionQualified: boolean;
  readonly workspaceRoots: Map<string, string>;
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
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly redactString: (value: string) => string;
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
    diagnostics: options.diagnostics,
    redactString: options.redactString,
  });
}

interface BuildPeripheralsArgs {
  readonly options: BuildHandlerDepsOptions;
  readonly uiStore: UiStore;
  readonly workspaceScriptTrust: WorkspaceScriptTrustService;
  readonly evidenceStore: EvidenceStore;
  readonly redactString: (value: string) => string;
  readonly liveRedactor: Redactor;
  readonly runtimeConfig: RuntimeGatewayConfig;
  readonly localKnowledgeKeyProvider: KnowledgeStoreKeyProvider;
  readonly runtimeStateDir: string;
  readonly dapRuntime: DapRuntimeReference;
}

function unavailableDebugDeploymentPolicy(): DebugDeploymentPolicy {
  return "unavailable";
}

function missingDebugProvisioning(): DebugProvisioning {
  return "notProvisioned";
}

function operatorDapDocument(env: NodeJS.ProcessEnv): DapOperatorProvisioningDocument | undefined {
  const raw = env.KEIKO_DAP_OPERATOR_PROVISIONING_JSON;
  if (raw === undefined) return undefined;
  try {
    const parsed = parseDapOperatorProvisioningDocument(JSON.parse(raw) as unknown);
    return parsed.ok ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

interface DapArtifactQualification {
  readonly executable: boolean;
  readonly empty: boolean;
  readonly allowDirectory: boolean;
}

type DapArtifactContentReader = (hostPath: string) => Uint8Array;

function qualifiedArtifactFile(
  artifact: DapOperatorProvisionedArtifact,
  qualification: DapArtifactQualification,
  contentReader?: DapArtifactContentReader,
): readonly unknown[] {
  const supplied = lstatSync(artifact.hostPath);
  const realPath = realpathSync(artifact.hostPath);
  const approvedRoot = realpathSync(artifact.approvedRoot);
  const stat = lstatSync(realPath);
  const change = lstatSync(realPath, { bigint: true });
  if (
    supplied.isSymbolicLink() ||
    realPath === approvedRoot ||
    !isWithinWorkspace(approvedRoot, realPath) ||
    !stat.isFile() ||
    (qualification.executable && (stat.mode & 0o111) === 0) ||
    (qualification.empty && stat.size !== 0)
  ) {
    throw new Error("INVALID_DAP_PROVISIONING");
  }
  const stableMetadata = [
    artifact.hostPath,
    realPath,
    approvedRoot,
    artifact.capsulePath,
    stat.dev,
    stat.ino,
    stat.size,
    stat.mode,
    stat.uid,
  ];
  return contentReader === undefined
    ? [...stableMetadata, change.mtimeNs.toString(), change.ctimeNs.toString()]
    : [...stableMetadata, createHash("sha256").update(contentReader(realPath)).digest("hex")];
}

interface StatSignature {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface ArtifactWalkCacheEntry extends StatSignature {
  readonly kind: "file" | "directory";
  readonly identity: readonly (readonly unknown[])[];
  readonly children: readonly DapOperatorProvisionedArtifact[];
}

/**
 * `artifacts` holds one entry per `hostPath` already fully validated, populated only by the
 * metadata-only ("signal") walk -- never by the content-hashing identity walk (contentReader is
 * always defined there, so `qualifiedArtifact` never consults or populates this cache in that
 * mode; that expensive path keeps running in full every time it is invoked, unchanged).
 *
 * A hit means this exact filesystem object (same dev/ino/size/mode/uid/mtime/ctime) was already
 * fully validated on
 * a prior call. Reusing it lets an unchanged directory skip `realpathSync` and `readdirSync`
 * entirely and an unchanged file skip re-deriving its identity -- but every cached node is still
 * freshly `lstat`ed on every call, and every cached directory still recurses into its (cached)
 * children so their own mtimes are re-checked. `approvedRoots` mirrors the same freshness check
 * for each distinct approved-root path, because the original (uncached) walk also re-resolves
 * `realpathSync(approvedRoot)` on every call; a cache hit is only safe when *both* the artifact
 * and the approved root it was validated against are still unchanged. Nothing is ever assumed
 * unchanged without a fresh, cheap stat confirming it, so any real content or structure change is
 * still caught on the very next call. This turns the steady-state cost of the per-second watchdog
 * signal from O(files) full validations (readdir + up to 5 stat-family syscalls each) into
 * O(files) single-`lstat` checks with no directory enumeration at all when nothing has changed.
 */
interface ArtifactWalkCache {
  readonly artifacts: Map<string, ArtifactWalkCacheEntry>;
  readonly approvedRoots: Map<string, StatSignature>;
}

function approvedRootUnchanged(cache: ArtifactWalkCache, approvedRoot: string): boolean {
  const current = lstatSync(approvedRoot, { bigint: true });
  const cached = cache.approvedRoots.get(approvedRoot);
  const unchanged =
    cached?.dev === current.dev &&
    cached.ino === current.ino &&
    cached.size === current.size &&
    cached.mode === current.mode &&
    cached.uid === current.uid &&
    cached.mtimeNs === current.mtimeNs &&
    cached.ctimeNs === current.ctimeNs;
  if (!unchanged) {
    cache.approvedRoots.set(approvedRoot, {
      dev: current.dev,
      ino: current.ino,
      size: current.size,
      mode: current.mode,
      uid: current.uid,
      mtimeNs: current.mtimeNs,
      ctimeNs: current.ctimeNs,
    });
  }
  return unchanged;
}

function freshCacheEntry(
  cache: ArtifactWalkCache | undefined,
  artifact: DapOperatorProvisionedArtifact,
  supplied: BigIntStats,
): ArtifactWalkCacheEntry | undefined {
  const cached = cache?.artifacts.get(artifact.hostPath);
  if (cached === undefined || cache === undefined) return undefined;
  const unchanged =
    statSignatureMatches(cached, supplied) && approvedRootUnchanged(cache, artifact.approvedRoot);
  return unchanged ? cached : undefined;
}

function statSignatureMatches(left: StatSignature, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function directoryChildren(
  artifact: DapOperatorProvisionedArtifact,
  realPath: string,
): readonly DapOperatorProvisionedArtifact[] {
  return readdirSync(realPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      hostPath: join(realPath, entry.name),
      approvedRoot: artifact.approvedRoot,
      capsulePath: join(artifact.capsulePath, entry.name),
    }));
}

function rememberArtifact(
  cache: ArtifactWalkCache | undefined,
  hostPath: string,
  supplied: BigIntStats,
  kind: "file" | "directory",
  identity: readonly (readonly unknown[])[],
  children: readonly DapOperatorProvisionedArtifact[],
): void {
  cache?.artifacts.set(hostPath, {
    dev: supplied.dev,
    ino: supplied.ino,
    size: supplied.size,
    mode: supplied.mode,
    uid: supplied.uid,
    mtimeNs: supplied.mtimeNs,
    ctimeNs: supplied.ctimeNs,
    kind,
    identity,
    children,
  });
}

function qualifiedArtifactFresh(
  artifact: DapOperatorProvisionedArtifact,
  qualification: DapArtifactQualification,
  contentReader: DapArtifactContentReader | undefined,
  cache: ArtifactWalkCache | undefined,
  supplied: BigIntStats,
): readonly (readonly unknown[])[] {
  const realPath = realpathSync(artifact.hostPath);
  const stat = lstatSync(realPath);
  if (stat.isFile()) {
    const identity = [qualifiedArtifactFile(artifact, qualification, contentReader)];
    rememberArtifact(cache, artifact.hostPath, supplied, "file", identity, []);
    return identity;
  }
  if (!qualification.allowDirectory || !stat.isDirectory()) {
    throw new Error("INVALID_DAP_PROVISIONING");
  }
  const children = directoryChildren(artifact, realPath);
  const identity = children.flatMap((child) =>
    qualifiedArtifact(child, qualification, contentReader, cache),
  );
  rememberArtifact(cache, artifact.hostPath, supplied, "directory", identity, children);
  return identity;
}

function qualifiedArtifactCached(
  cached: ArtifactWalkCacheEntry,
  artifact: DapOperatorProvisionedArtifact,
  qualification: DapArtifactQualification,
  contentReader: DapArtifactContentReader | undefined,
  cache: ArtifactWalkCache | undefined,
  supplied: BigIntStats,
): readonly (readonly unknown[])[] {
  if (cached.kind === "file") return cached.identity;
  const identity = cached.children.flatMap((child) =>
    qualifiedArtifact(child, qualification, contentReader, cache),
  );
  rememberArtifact(cache, artifact.hostPath, supplied, "directory", identity, cached.children);
  return identity;
}

function qualifiedArtifact(
  artifact: DapOperatorProvisionedArtifact,
  qualification: DapArtifactQualification,
  contentReader?: DapArtifactContentReader,
  cache?: ArtifactWalkCache,
): readonly (readonly unknown[])[] {
  const supplied = lstatSync(artifact.hostPath, { bigint: true });
  if (supplied.isSymbolicLink()) throw new Error("INVALID_DAP_PROVISIONING");
  const useCache = contentReader === undefined && cache !== undefined;
  const cached = useCache ? freshCacheEntry(cache, artifact, supplied) : undefined;
  return cached === undefined
    ? qualifiedArtifactFresh(artifact, qualification, contentReader, cache, supplied)
    : qualifiedArtifactCached(cached, artifact, qualification, contentReader, cache, supplied);
}

function qualifiedAdapterIdentity(
  document: DapOperatorProvisioningDocument,
  contentReader?: DapArtifactContentReader,
): readonly unknown[] {
  const adapter = document.adapter;
  for (const directory of adapter.approvedPath.split(delimiter)) {
    const hostPath = join(directory, adapter.executableName);
    try {
      const identity = qualifiedArtifactFile(
        {
          hostPath,
          approvedRoot: document.launch.adapterApprovedRoot,
          capsulePath: "/opt/keiko-debug/adapter",
        },
        { executable: true, empty: false, allowDirectory: false },
        contentReader,
      );
      const realPath = String(identity[1]);
      if (adapter.trustedRoots.some((root) => isWithinWorkspace(realpathSync(root), realPath))) {
        return identity;
      }
    } catch {
      // Continue through the closed operator-approved PATH only.
    }
  }
  throw new Error("INVALID_DAP_PROVISIONING");
}

function operatorProvisioningIdentity(
  document: DapOperatorProvisioningDocument,
  contentReader?: DapArtifactContentReader,
  cache?: ArtifactWalkCache,
): string | undefined {
  try {
    const launch = document.launch;
    const executable = { executable: true, empty: false, allowDirectory: false } as const;
    const data = { executable: false, empty: false, allowDirectory: true } as const;
    const empty = { executable: false, empty: true, allowDirectory: false } as const;
    const identities = [
      document,
      qualifiedAdapterIdentity(document, contentReader),
      ...qualifiedArtifact(launch.node, executable, contentReader, cache),
      ...qualifiedArtifact(launch.npm, executable, contentReader, cache),
      ...qualifiedArtifact(launch.shell, executable, contentReader, cache),
      ...qualifiedArtifact(launch.backend, executable, contentReader, cache),
      ...qualifiedArtifact(launch.npmUserConfig, empty, contentReader, cache),
      ...qualifiedArtifact(launch.npmGlobalConfig, empty, contentReader, cache),
      ...launch.runtimeClosure.flatMap((artifact) =>
        qualifiedArtifact(artifact, data, contentReader, cache),
      ),
    ];
    return createHash("sha256").update(JSON.stringify(identities)).digest("hex");
  } catch {
    return undefined;
  }
}

interface OperatorProvisioningSnapshot {
  readonly signal: string;
  readonly identity: string;
}

function operatorProvisioningSnapshot(
  document: DapOperatorProvisioningDocument,
  contentReader: DapArtifactContentReader,
  expectedSignal?: string,
  cache?: ArtifactWalkCache,
): OperatorProvisioningSnapshot | undefined {
  const signal = expectedSignal ?? operatorProvisioningIdentity(document, undefined, cache);
  if (signal === undefined) return undefined;
  // The content-hashing identity computation never reads from or writes to `cache` -- it is only
  // ever consulted when `contentReader` is undefined (see `qualifiedArtifact`) -- so this always
  // re-derives the full, uncached, content-verified identity, exactly as before this fix.
  const identity = operatorProvisioningIdentity(document, contentReader);
  const confirmedSignal = operatorProvisioningIdentity(document, undefined, cache);
  if (identity === undefined || confirmedSignal !== signal) return undefined;
  return { signal: confirmedSignal, identity };
}

/** @internal Non-spawning activation preflight; exported only for deterministic server tests. */
export function createOperatorProvisioningQualification(
  env: NodeJS.ProcessEnv,
  contentReader: DapArtifactContentReader = readFileSync,
): () => DebugProvisioning {
  // Persists for the lifetime of the returned closure (one per BFF process), so the per-second
  // watchdog signal check (issue: audit finding, full recursive walk every tick) amortizes to a
  // single `lstat` per known artifact once the tree has been walked once, instead of a fresh
  // `readdirSync` + multi-`stat` walk of the entire operator-configured runtimeClosure every call.
  const cache: ArtifactWalkCache = { artifacts: new Map(), approvedRoots: new Map() };
  const initial = operatorDapDocument(env);
  const approved =
    initial === undefined
      ? undefined
      : operatorProvisioningSnapshot(initial, contentReader, undefined, cache);
  const approvedIdentity = approved?.identity;
  let cachedSignal = approved?.signal;
  let cachedIdentity = approvedIdentity;
  return (): DebugProvisioning => {
    const current = operatorDapDocument(env);
    if (approvedIdentity === undefined || current === undefined) return "notProvisioned";
    const signal = operatorProvisioningIdentity(current, undefined, cache);
    if (signal === undefined) return "notProvisioned";
    if (signal !== cachedSignal) {
      const snapshot = operatorProvisioningSnapshot(current, contentReader, signal, cache);
      if (snapshot === undefined) return "notProvisioned";
      cachedSignal = snapshot.signal;
      cachedIdentity = snapshot.identity;
    }
    return cachedIdentity === approvedIdentity ? "provisioned" : "notProvisioned";
  };
}

function buildDebugActivationControl(args: BuildPeripheralsArgs): DebugActivationControlService {
  const operatorConfigured = operatorDapDocument(args.options.env) !== undefined;
  const operatorProvisioning = createOperatorProvisioningQualification(args.options.env);
  return (
    args.options.debugActivationControl ??
    createDebugActivationControlService({
      mutex: createWorkspaceMutexRegistry(),
      productSupport:
        args.options.dapProductSupport ??
        ((): DebugProductSupport => (process.platform === "linux" ? "supported" : "unsupported")),
      deploymentPolicy:
        args.options.dapDeploymentPolicy ??
        ((): DebugDeploymentPolicy =>
          operatorConfigured ? "allowed" : unavailableDebugDeploymentPolicy()),
      provisioning:
        args.options.dapProvisioning ??
        ((): DebugProvisioning =>
          operatorConfigured && args.dapRuntime.productionQualified
            ? operatorProvisioning()
            : missingDebugProvisioning()),
      projectEvidence: (fingerprint, evidence): void => {
        args.evidenceStore.put(
          `debug-activation-${fingerprint}-${String(evidence.revision)}-${evidence.action}`,
          JSON.stringify(debugActivationEvidenceProjection(evidence)),
        );
      },
      disposeActiveSession: (realRoot): Promise<void> => disposeActiveDebugSession(args, realRoot),
      onSweepFailure: (failure): void => {
        args.evidenceStore.put(
          `debug-activation-sweep-failure-${randomUUID()}`,
          JSON.stringify(failure),
        );
      },
    })
  );
}

async function disposeActiveDebugSession(
  args: BuildPeripheralsArgs,
  realRoot: string,
): Promise<void> {
  const service = args.dapRuntime.current;
  if (service === undefined) return;
  const sessionId = service.manager.workspaceSessionId(
    inspectDebugWorkspaceIdentity(realRoot).identityDigest,
  );
  if (sessionId !== undefined) await service.manager.revoke(sessionId);
}

// #2628 — resolve the trust service and managed-LSP control together, then unconditionally
// wire the revoke-to-restrict propagation. Registering AFTER both are resolved is the only
// way the injection path (BuildHandlerDepsOptions.workspaceScriptTrust) receives the same
// propagation the fallback path always did. Legacy trust-service test doubles that do not
// implement subscribeOnRestricted keep their previous behavior. The returned disposer is
// threaded through PeripheralManagers so createUiHandlerDispose can drop the listener
// during teardown — necessary when an injected trust service outlives this assembly
// (e.g. a shared test double across multiple buildUiHandlerDeps calls) so a later revoke
// cannot fire into an already-disposed managedLspControl or redactor closure.
function resolveTrustAndManagedLspControl(args: BuildPeripheralsArgs): {
  readonly workspaceScriptTrust: WorkspaceScriptTrustService;
  readonly managedLspControl: ManagedLspControlService;
  readonly disposeTrustLspBridge: () => void;
} {
  const workspaceScriptTrust = args.workspaceScriptTrust;
  const managedLspControl =
    args.options.managedLspControl ??
    createNodeManagedLspControl({
      stateDir: args.runtimeStateDir,
      processEnv: args.options.env,
      redact: args.liveRedactor,
      evidenceStore: args.evidenceStore,
      workspaceTrust: (realRoot): "trusted" | "restricted" =>
        workspaceScriptTrust.trustLevelForRoot(realRoot),
    });
  const unsubscribe = workspaceScriptTrust.subscribeOnRestricted?.((canonicalRoot): void => {
    propagateManagedLspRestriction(managedLspControl, canonicalRoot, args.liveRedactor);
  });
  const disposeTrustLspBridge = (): void => {
    unsubscribe?.();
  };
  return { workspaceScriptTrust, managedLspControl, disposeTrustLspBridge };
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
    diagnostics: args.options.diagnostics,
    redactString: args.redactString,
  });
  const memoryVault = buildMemoryVault(args.redactString, args.evidenceStore, args.options.env);
  const { workspaceScriptTrust, managedLspControl, disposeTrustLspBridge } =
    resolveTrustAndManagedLspControl(args);
  const debugActivationControl = buildDebugActivationControl(args);
  return {
    terminal: buildTerminalManager({
      store: args.uiStore,
      evidenceStore: args.evidenceStore,
      env: args.options.env,
      liveRedactor: args.liveRedactor,
      diagnostics: args.options.diagnostics,
    }),
    commandRunner: buildCommandRunner({
      store: args.uiStore,
      evidenceStore: args.evidenceStore,
      env: args.options.env,
      liveRedactor: args.liveRedactor,
      diagnostics: args.options.diagnostics,
      workspaceScriptTrust,
    }),
    verificationRunner: buildVerificationRunner({
      store: args.uiStore,
      evidenceStore: args.evidenceStore,
      liveRedactor: args.liveRedactor,
      diagnostics: args.options.diagnostics,
      workspaceScriptTrust,
    }),
    workspaceScriptTrust,
    disposeTrustLspBridge,
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
      diagnostics: args.options.diagnostics,
    }),
    browser: buildBrowserManager({
      evidenceDir: resolveEvidenceDir(args.options.evidenceDir, args.options.env),
      evidenceStore: args.evidenceStore,
      redactor: args.liveRedactor,
      diagnostics: args.options.diagnostics,
    }),
    memoryVault,
    editorHotExitStore:
      args.options.editorHotExitStore ??
      createEditorHotExitStore({
        stateDir: args.runtimeStateDir,
        env: args.options.env,
        securityLogSink: processServerLogSink(),
      }),
    editorLocalHistoryStore:
      args.options.editorLocalHistoryStore ??
      createEditorLocalHistoryStore({
        stateDir: args.runtimeStateDir,
        env: args.options.env,
        securityLogSink: processServerLogSink(),
      }),
    managedLspControl,
    debugActivationControl,
    editorSettingsControl:
      args.options.editorSettingsControl ??
      createNodeEditorSettingsControl({
        stateDir: args.runtimeStateDir,
        managedLspControl,
        debugActivation: debugActivationControl,
        processEnv: args.options.env,
        // F-01: the AI-assist badge and the inline-completion / test-generation admission checks
        // read this snapshot. Read the config holder on every settings read so a probe that runs
        // after the control was built is reflected without a cache or a poller.
        gatewayStatus: () => ({
          configured: args.runtimeConfig.present(),
          verification: args.runtimeConfig.verification(),
        }),
      }),
    editorSettingsEvents: args.options.editorSettingsEvents ?? createEditorSettingsEventBus(),
    workspaceWatchService: args.options.workspaceWatchService ?? createWorkspaceWatchService(),
    workspaceSnippets:
      args.options.workspaceSnippets ??
      createWorkspaceSnippetsService({
        stateDir: args.runtimeStateDir,
        mutex: createWorkspaceMutexRegistry(),
      }),
    memoryAuthorization: buildLoopbackMemoryAuthorization(memoryVault),
  };
}

function debugActivationEvidenceProjection(
  evidence: DebugActivationEvidence,
): Readonly<Record<string, DebugActivationEvidence>> {
  return { evidence };
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
    securityLogSink: processServerLogSink(),
    diagnostics: options.diagnostics,
  });
  const secretResolver = createProviderSecretResolver({
    configPath: effectiveConfigPath,
    env: options.env,
    securityLogSink: processServerLogSink(),
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
  readonly workspaceScriptTrust: WorkspaceScriptTrustService;
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
  readonly codingRuntimeSnapshotStore: CodingRuntimeSnapshotStore | undefined;
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
  args: ComposeCoreTaskWorkspaceServicesArgs,
): Pick<TaskWorkspaceServices, "workspaceHealth" | "workspaceCleanup"> {
  return {
    workspaceHealth: buildWorkspaceHealth(
      args.options,
      args.workspaceInstanceStore,
      args.activeWorkspacePointerStore,
      args.resolvedUiDbPath,
      args.evidenceStore,
      args.redactString,
    ),
    workspaceCleanup: buildWorkspaceCleanup({
      options: args.options,
      instanceStore: args.workspaceInstanceStore,
      activePointerStore: args.activeWorkspacePointerStore,
      uiStore: args.uiStore,
      resolvedUiDbPath: args.resolvedUiDbPath,
      evidenceStore: args.evidenceStore,
      redactString: args.redactString,
      mutex: args.mutex,
    }),
  };
}

interface ComposeCoreTaskWorkspaceServicesArgs {
  readonly options: BuildHandlerDepsOptions;
  readonly workspaceInstanceStore: WorkspaceInstanceStore | undefined;
  readonly activeWorkspacePointerStore: ActiveWorkspacePointerStore | undefined;
  readonly uiStore: UiStore;
  readonly workspaceScriptTrust: WorkspaceScriptTrustService;
  readonly resolvedUiDbPath: string;
  readonly evidenceStore: EvidenceStore;
  readonly redactString: (value: string) => string;
  readonly mutex: WorkspaceMutexRegistry;
}

// Issue #445/#446/#447 — provisioning + active-binding lifecycle + reconciliation + repair.
function composeCoreTaskWorkspaceServices(
  args: ComposeCoreTaskWorkspaceServicesArgs,
): Omit<TaskWorkspaceServices, "workspaceHealth" | "workspaceCleanup"> {
  const workspaceProvisioning = buildWorkspaceProvisioning({
    options: args.options,
    instanceStore: args.workspaceInstanceStore,
    uiStore: args.uiStore,
    workspaceScriptTrust: args.workspaceScriptTrust,
    resolvedUiDbPath: args.resolvedUiDbPath,
    evidenceStore: args.evidenceStore,
    redactString: args.redactString,
    mutex: args.mutex,
  });
  return {
    workspaceProvisioning,
    workspaceLifecycle: buildWorkspaceLifecycle({
      options: args.options,
      instanceStore: args.workspaceInstanceStore,
      activePointerStore: args.activeWorkspacePointerStore,
      provisioning: workspaceProvisioning,
      resolvedUiDbPath: args.resolvedUiDbPath,
      evidenceStore: args.evidenceStore,
      redactString: args.redactString,
      mutex: args.mutex,
    }),
    workspaceReconciliation: buildWorkspaceReconciliation(
      args.options,
      args.workspaceInstanceStore,
      args.activeWorkspacePointerStore,
      args.resolvedUiDbPath,
      args.evidenceStore,
      args.redactString,
    ),
    workspaceRepair: buildWorkspaceRepair({
      options: args.options,
      instanceStore: args.workspaceInstanceStore,
      activePointerStore: args.activeWorkspacePointerStore,
      provisioning: workspaceProvisioning,
      resolvedUiDbPath: args.resolvedUiDbPath,
      evidenceStore: args.evidenceStore,
      redactString: args.redactString,
      mutex: args.mutex,
    }),
  };
}

type ComposeTaskWorkspaceServicesArgs = Omit<ComposeCoreTaskWorkspaceServicesArgs, "mutex">;

function composeTaskWorkspaceServices(
  args: ComposeTaskWorkspaceServicesArgs,
): TaskWorkspaceServices {
  // One shared in-process mutex registry across ALL mutating task-workspace services (#449, ADR-0093 D1):
  // provisioning, lifecycle, repair, and cleanup must serialize against each other on the same `ws:`
  // keyspace, so they receive the SAME registry instance. Read-only services (reconciliation, health) do
  // not take it.
  const mutex = createWorkspaceMutexRegistry();
  const composedArgs = { ...args, mutex };
  return {
    ...composeCoreTaskWorkspaceServices(composedArgs),
    ...composeHealthAndCleanup(composedArgs),
  };
}

function composePersistenceTaskWorkspaceServices(
  options: BuildHandlerDepsOptions,
  persistence: ComposedPersistence,
  resolvedUiDbPath: string,
  evidenceStore: EvidenceStore,
  redactString: (value: string) => string,
): {
  readonly workspaceScriptTrust: WorkspaceScriptTrustService;
  readonly services: TaskWorkspaceServices;
} {
  const workspaceScriptTrust =
    options.workspaceScriptTrust ?? createWorkspaceScriptTrustService({ store: persistence.store });
  const services = composeTaskWorkspaceServices({
    options,
    workspaceInstanceStore: persistence.workspaceInstanceStore,
    activeWorkspacePointerStore: persistence.activeWorkspacePointerStore,
    uiStore: persistence.store,
    workspaceScriptTrust,
    resolvedUiDbPath,
    evidenceStore,
    redactString,
  });
  return { workspaceScriptTrust, services };
}

function buildPersistenceBundle(
  options: BuildHandlerDepsOptions,
  resolvedUiDbPath: string,
  redactString: (value: string) => string,
  evidenceStore: EvidenceStore,
): PersistenceBundle {
  const persistence = composePersistence(
    options.store,
    options.codingRuntimeSnapshotStore,
    resolvedUiDbPath,
    redactString,
    options.env,
    options.diagnostics,
  );
  const { store, dispose, relationship, codingRuntimeSnapshotStore } = persistence;
  try {
    const { workspaceScriptTrust, services } = composePersistenceTaskWorkspaceServices(
      options,
      persistence,
      resolvedUiDbPath,
      evidenceStore,
      redactString,
    );
    const managedTaskWorkspaceRoot = composedManagedWorktreeRoot(
      services.workspaceProvisioning,
      resolvedUiDbPath,
      options.diagnostics,
    );
    return {
      uiStore: store,
      workspaceScriptTrust,
      dispose,
      relationship,
      codingRuntimeSnapshotStore,
      ...services,
      managedTaskWorkspaceRoot,
      preferredProjectPath: seedInitialProject(store, resolvedUiDbPath, options.initialProjectPath),
    };
  } catch (error) {
    dispose?.();
    throw error;
  }
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
    ...(bundle.codingRuntimeSnapshotStore === undefined
      ? {}
      : { codingRuntimeSnapshotStore: bundle.codingRuntimeSnapshotStore }),
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

// KEIKO-0565: DI-scoped Atlassian action-approval and sync-job registries. buildUiHandlerDeps now
// constructs one instance of each per BFF process so two independently-built handler deps no longer
// share the module-level singleton. Callers migrated to `deps.*` see the injected instance.
function atlassianConnectorRegistryFields(
  options: BuildHandlerDepsOptions,
): Pick<UiHandlerDeps, "atlassianActionApprovalRegistry" | "atlassianSyncJobRegistry"> {
  const approvalRegistry =
    options.atlassianActionApprovalRegistry ?? new AtlassianActionApprovalRegistry();
  const syncRegistry = options.atlassianSyncJobRegistry ?? new AtlassianSyncJobRegistry();
  return {
    atlassianActionApprovalRegistry: approvalRegistry,
    atlassianSyncJobRegistry: syncRegistry,
  };
}

// Issue #2241 — lazy Atlassian custody wiring: no vault key, keychain entry, or metadata file is
// created until the first /api/atlassian-connectors/* custody operation. Egress is resolved per
// outbound request from the live runtime config (first-run onboarding updates are honored).
function atlassianConnectorCredentialFields(
  args: UiHandlerDepsAssemblyArgs,
): Pick<UiHandlerDeps, "atlassianConnectorCredentials"> {
  return {
    atlassianConnectorCredentials: buildAtlassianConnectorCredentialDeps({
      configPath: args.runtimeConfig.storagePath,
      env: args.options.env,
      egress: () => args.runtimeConfig.current()?.egress ?? args.egress,
      securityLogSink: processServerLogSink(),
      // KEIKO-0826 follow-up: shared process activity log so typed custody-error paths surface
      // through the same sink as every other server operation.
      activityLog: processServerLogSink(),
    }),
  };
}

function buildAssemblyPeripherals(
  args: UiHandlerDepsAssemblyArgs,
  dapRuntime: DapRuntimeReference,
): PeripheralManagers {
  return buildPeripherals({
    options: args.options,
    uiStore: args.bundle.uiStore,
    workspaceScriptTrust: args.bundle.workspaceScriptTrust,
    evidenceStore: args.evidenceStore,
    redactString: args.redactString,
    liveRedactor: args.liveRedactor,
    runtimeConfig: args.runtimeConfig,
    localKnowledgeKeyProvider: args.localKnowledgeKeyProvider,
    runtimeStateDir: dirname(args.resolvedUiDbPath),
    dapRuntime,
  });
}

function createComposedDapRouteService(
  args: UiHandlerDepsAssemblyArgs,
  peripherals: PeripheralManagers,
  runtime: DapRuntimeReference,
  production: DapProductionService,
): DapDebugRouteService {
  return createDapDebugRouteService({
    production,
    stateDir: dirname(args.resolvedUiDbPath),
    now: Date.now,
    activation: async (realRoot) => {
      runtime.workspaceRoots.set(inspectDebugWorkspaceIdentity(realRoot).identityDigest, realRoot);
      const snapshot = await peripherals.editorSettingsControl.read(realRoot);
      return snapshot.debugging ?? unavailableDebugActivation(snapshot.revision);
    },
  });
}

function dapActivationCurrent(
  runtime: DapRuntimeReference,
  control: DebugActivationControlService,
  workspacePartitionKey: string,
  expectedRevision: number,
): boolean {
  const root = runtime.workspaceRoots.get(workspacePartitionKey);
  if (root === undefined) return false;
  try {
    const currentPartition = inspectDebugWorkspaceIdentity(root).identityDigest;
    return currentPartition === workspacePartitionKey && control.isCurrent(root, expectedRevision);
  } catch {
    return false;
  }
}

function unavailableDebugActivation(
  revision: number,
): Awaited<ReturnType<DapDebugRouteService["activation"]>> {
  return {
    ok: true,
    schemaVersion: "1",
    adapterId: "node-typescript",
    revision,
    state: "disabled",
    reasonCode: "WORKSPACE_ACTIVATION_UNSET",
    policyResult: "denied",
  };
}

function dapWorkspaceContext(
  peripherals: PeripheralManagers,
  root: string,
): { readonly root: string; readonly projectId: string; readonly trusted: boolean } | undefined {
  try {
    const workspace = detectWorkspaceAt(root, nodeWorkspaceFs);
    const canonicalRoot = nodeWorkspaceFs.realPath(root);
    return {
      root: canonicalRoot,
      projectId: canonicalRoot,
      trusted: peripherals.workspaceScriptTrust.isTrusted(canonicalRoot, workspace),
    };
  } catch {
    return undefined;
  }
}

/**
 * Redacted operator diagnostic for a startup/composition boundary in this module.
 *
 * A composition failure here silently downgrades a capability for the whole process lifetime — the
 * caller only ever sees `undefined`/`false` — so discarding the cause outright left an operator with a
 * missing feature and no reason for it. Content-free: the error class and a machine code only; startup
 * has no request, so a fresh correlation id ties the record together.
 */
function emitCompositionDiagnostic(
  diagnostics: ServerDiagnosticSink | undefined,
  source: string,
  summary: ServerDiagnosticSummary,
  error: unknown,
): void {
  emitServerDiagnostic(
    diagnostics,
    serverDiagnosticFromError({
      correlationId: randomUUID(),
      operation: "server.composition",
      source,
      error,
      summary,
      // Startup has no live gateway config yet; the fixed allowlisted summary is what is emitted, so
      // this callback only has to be total.
      redact: (message): string => message,
    }),
  );
}

function recordDapCompositionFailure(evidenceStore: EvidenceStore): void {
  try {
    evidenceStore.put(
      `debug-runtime-composition-failure-${randomUUID()}`,
      JSON.stringify({ schemaVersion: "1", kind: "debugRuntimeCompositionFailure" }),
    );
  } catch {
    // Production DAP remains unavailable even when its content-free diagnostic cannot persist.
  }
}

function createQualifiedDapProductionService(
  args: UiHandlerDepsAssemblyArgs,
  peripherals: PeripheralManagers,
  runtime: DapRuntimeReference,
  provisioning: DapProductionProvisioning,
): DapProductionService | undefined {
  try {
    return createDapProductionService({
      provisioning,
      evidenceStore: args.evidenceStore,
      appendJournal: (partition, evidence): Promise<void> => {
        args.evidenceStore.put(
          `debug-session-${partition}-${randomUUID()}`,
          JSON.stringify(evidence),
        );
        return Promise.resolve();
      },
      now: Date.now,
      epoch: () => 0,
      activationCurrent: (partition, revision): boolean =>
        dapActivationCurrent(runtime, peripherals.debugActivationControl, partition, revision),
      emitOutputLimit: (): void => undefined,
      onRuntimeFailure: (): void => {
        args.evidenceStore.put(
          `debug-runtime-failure-${randomUUID()}`,
          JSON.stringify({ schemaVersion: "1", kind: "debugRuntimeFailure" }),
        );
      },
      onProjectionFailure: (): void => {
        args.evidenceStore.put(
          `debug-projection-failure-${randomUUID()}`,
          JSON.stringify({ schemaVersion: "1", kind: "debugProjectionFailure" }),
        );
      },
    });
  } catch (error) {
    // The evidence record below is a fixed content-free marker with no error shape at all, and it is
    // itself best-effort. Name the cause on the operator channel too, or "debug never became
    // available" has no diagnosable reason anywhere.
    emitCompositionDiagnostic(
      args.options.diagnostics,
      "deps.dapProduction",
      "Debug production service composition failed.",
      error,
    );
    recordDapCompositionFailure(args.evidenceStore);
    return undefined;
  }
}

function composeDapRuntime(
  args: UiHandlerDepsAssemblyArgs,
  peripherals: PeripheralManagers,
  runtime: DapRuntimeReference,
): DapProductionService | undefined {
  const document = operatorDapDocument(args.options.env);
  const provisioning =
    args.options.dapProductionProvisioning ??
    (document === undefined
      ? undefined
      : createDapOperatorProvisioning({
          document,
          processEnv: args.options.env,
          fs: nodeWorkspaceFs,
          discover: peripherals.commandRunner.discover,
          workspaceForPartition: (partition) => {
            const root = runtime.workspaceRoots.get(partition);
            return root === undefined ? undefined : dapWorkspaceContext(peripherals, root);
          },
          workspaceForRoot: (root) => dapWorkspaceContext(peripherals, root),
        }));
  if (provisioning === undefined) return undefined;
  const production = createQualifiedDapProductionService(args, peripherals, runtime, provisioning);
  if (production === undefined) return undefined;
  runtime.productionQualified = true;
  runtime.current = createComposedDapRouteService(args, peripherals, runtime, production);
  return production;
}

type GatewayEvidenceOutcome = "accepted" | "cancelled" | "failed" | "output-limit";

function gatewayOutcomeState(outcome: GatewayEvidenceOutcome): "running" | "cancelled" | "failed" {
  if (outcome === "accepted") return "running";
  if (outcome === "cancelled") return "cancelled";
  return "failed";
}

function gatewayOutcomeFailureCode(
  outcome: GatewayEvidenceOutcome,
):
  { readonly failureCode: "runtime-failed" | "authority-budget-exceeded" } | Record<string, never> {
  if (outcome === "failed") return { failureCode: "runtime-failed" };
  if (outcome === "output-limit") return { failureCode: "authority-budget-exceeded" };
  return {};
}

function safeActivityContentSource(
  projection: CodingSafeActivityProjection | undefined,
): CodingAppSessionContentSource | undefined {
  return projection === undefined
    ? undefined
    : {
        contentFor: () => projection.currentContent(),
        subscribeContent: (listener) => projection.subscribeContent(listener),
      };
}

function activityAwareWorkspaceLifecycle(
  lifecycle: WorkspaceLifecycleService | undefined,
  projection: CodingSafeActivityProjection | undefined,
): WorkspaceLifecycleService | undefined {
  if (lifecycle === undefined || projection === undefined) return lifecycle;
  const purge = (): void => {
    projection.purgeAll("workspace-switch");
  };
  return {
    list: lifecycle.list,
    getActive: lifecycle.getActive,
    setActive: (request): ReturnType<WorkspaceLifecycleService["setActive"]> => {
      purge();
      return lifecycle.setActive(request);
    },
    clearActive: (): void => {
      purge();
      lifecycle.clearActive();
    },
    pause: (request): ReturnType<WorkspaceLifecycleService["pause"]> => {
      purge();
      return lifecycle.pause(request);
    },
    resume: (request): ReturnType<WorkspaceLifecycleService["resume"]> => {
      purge();
      return lifecycle.resume(request);
    },
    prepareHandoff: (request): ReturnType<WorkspaceLifecycleService["prepareHandoff"]> => {
      purge();
      return lifecycle.prepareHandoff(request);
    },
  };
}

interface UiHandlerRuntimeServices {
  readonly dapRuntime: DapRuntimeReference;
  readonly codingRuntimeEvidenceAggregator: ReturnType<
    typeof createCodingRuntimeEvidenceAggregator
  >;
  readonly peripherals: ReturnType<typeof buildAssemblyPeripherals>;
  readonly dapProduction: ReturnType<typeof composeDapRuntime>;
  readonly codingRuntimeCeiling: ReturnType<typeof resolveCodingRuntimeDeploymentCeiling>;
  readonly runtimeComposition: ReturnType<typeof productionRuntimeResolver>;
  readonly codingRuntimeControlPlane:
    ReturnType<typeof createCodingRuntimeControlPlane> | undefined;
  readonly codingAppSessionChannel: ReturnType<typeof createCodingAppSessionChannel>;
  readonly workspaceLifecycle: WorkspaceLifecycleService | undefined;
}

function assembleUiHandlerDeps(args: UiHandlerDepsAssemblyArgs): UiHandlerDeps {
  const dapRuntime = createDapRuntimeReference(args.options);
  const services = assembleUiHandlerRuntimeServices(args, dapRuntime);
  return {
    ...buildBaseUiHandlerDeps(args),
    ...buildRuntimeUiHandlerDeps(args, services),
    ...buildIntegrationUiHandlerDeps(args),
    ...buildOptionalUiHandlerDeps(args, services),
    dispose: createUiHandlerDispose(args, services),
  };
}

function createDapRuntimeReference(options: BuildHandlerDepsOptions): DapRuntimeReference {
  return {
    current: options.dapDebug,
    productionQualified: options.dapDebug !== undefined,
    workspaceRoots: new Map(),
  };
}

function assembleUiHandlerRuntimeServices(
  args: UiHandlerDepsAssemblyArgs,
  dapRuntime: DapRuntimeReference,
): UiHandlerRuntimeServices {
  const codingRuntimeEvidenceAggregator = createCodingRuntimeEvidenceAggregator(
    args.codingWorkbenchEvidenceStore,
  );
  const peripherals = buildAssemblyPeripherals(args, dapRuntime);
  const dapProduction = composeDapRuntime(args, peripherals, dapRuntime);
  const codingRuntimeCeiling = resolveCodingRuntimeDeploymentCeiling(args.options);
  const runtimeComposition = productionRuntimeResolver(
    args,
    peripherals.commandRunner,
    peripherals.verificationRunner,
    codingRuntimeEvidenceAggregator,
    codingRuntimeCeiling,
  );
  const codingRuntimeHost = resolveAssemblyCodingRuntimeHost(args, runtimeComposition);
  const codingRuntimeControlPlane = buildUiCodingRuntimeControlPlane(
    args,
    codingRuntimeEvidenceAggregator,
    codingRuntimeHost,
  );
  const codingAppSessionChannel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort:
      args.options.sessionPairingPort ?? resolveLauncherSessionPairingPort(args.options.env),
    contentSource:
      args.options.codingAppSessionContentSource ??
      safeActivityContentSource(codingRuntimeControlPlane?.safeActivityProjection),
    // KEIKO-0225: forward the operator diagnostic sink so mid-stream SSE listener failures
    // (bare catch, backpressure `false`) surface as one redacted record per subscriber instead
    // of being silently swallowed.
    // #3099 P2 (KEIKO-0225 follow-up): default to the stderr sink when no custom sink is
    // wired, so the normal `keiko ui` / `dev-bff` composition actually records SSE fan-out
    // failures instead of silently no-op'ing recordSseFailure().
    diagnostics: args.options.diagnostics ?? defaultServerDiagnosticSink,
  });
  const workspaceLifecycle = activityAwareWorkspaceLifecycle(
    args.bundle.workspaceLifecycle,
    codingRuntimeControlPlane?.safeActivityProjection,
  );
  return {
    dapRuntime,
    codingRuntimeEvidenceAggregator,
    peripherals,
    dapProduction,
    codingRuntimeCeiling,
    runtimeComposition,
    codingRuntimeControlPlane,
    codingAppSessionChannel,
    workspaceLifecycle,
  };
}

function resolveAssemblyCodingRuntimeHost(
  args: UiHandlerDepsAssemblyArgs,
  runtimeComposition: ReturnType<typeof productionRuntimeResolver>,
): NonNullable<BuildHandlerDepsOptions["codingRuntimeHost"]> | undefined {
  return (
    args.options.codingRuntimeHost ??
    createProductionCodingRuntimeHost(
      args.options.codingRuntimeResolver ?? runtimeComposition.resolver,
    )
  );
}

function buildUiCodingRuntimeControlPlane(
  args: UiHandlerDepsAssemblyArgs,
  codingRuntimeEvidenceAggregator: ReturnType<typeof createCodingRuntimeEvidenceAggregator>,
  codingRuntimeHost: NonNullable<BuildHandlerDepsOptions["codingRuntimeHost"]> | undefined,
): ReturnType<typeof createCodingRuntimeControlPlane> | undefined {
  if (!args.bundle.codingRuntimeSnapshotStore || !args.bundle.workspaceLifecycle) return undefined;
  return createCodingRuntimeControlPlane({
    snapshots: args.bundle.codingRuntimeSnapshotStore,
    evidence: codingRuntimeEvidenceAggregator,
    workspaceLifecycle: args.bundle.workspaceLifecycle,
    serverPrincipal:
      args.options.codingRuntimeServerPrincipal ??
      ((): string | undefined => DEFAULT_LOOPBACK_MEMORY_REVIEWER_ID),
    ...(codingRuntimeHost ? { runtimeHost: codingRuntimeHost } : {}),
    // KEIKO-0225: forward the operator diagnostic sink so mid-stream SSE fan-out write failures
    // surface as one redacted record per subscriber instead of being silently swallowed.
    // #3099 P2 (KEIKO-0225 follow-up): default to the stderr sink when no custom sink is
    // wired, so the normal `keiko ui` / `dev-bff` composition actually records SSE fan-out
    // failures instead of silently no-op'ing recordSseFailure().
    diagnostics: args.options.diagnostics ?? defaultServerDiagnosticSink,
    activityLog: processServerLogSink(),
  });
}

type BaseUiHandlerDeps = ReturnType<typeof gatewayConfigFields> &
  Pick<
    UiHandlerDeps,
    | "evidenceStore"
    | "evidenceDir"
    | "env"
    | "egress"
    | "redactor"
    | "diagnostics"
    | "store"
    | "uiDbPath"
    | "preferredProjectPath"
    | "conversationAttachmentStore"
  >;

function buildBaseUiHandlerDeps(args: UiHandlerDepsAssemblyArgs): BaseUiHandlerDeps {
  return {
    ...gatewayConfigFields(args.config, args.configPresent),
    evidenceStore: args.evidenceStore,
    evidenceDir: args.resolvedEvidenceDir,
    env: args.options.env,
    egress: args.egress,
    redactor: args.liveRedactor,
    diagnostics: args.options.diagnostics,
    store: args.bundle.uiStore,
    uiDbPath: args.resolvedUiDbPath,
    preferredProjectPath: args.bundle.preferredProjectPath,
    conversationAttachmentStore:
      args.options.conversationAttachmentStore ??
      createConversationAttachmentStore({
        runtimeStateDir: dirname(args.resolvedUiDbPath),
        env: args.options.env,
        securityLogSink: processServerLogSink(),
      }),
  };
}

type RuntimeUiHandlerDeps = ReturnType<typeof codingSidecarGatewayModelSourceFields> &
  ReturnType<typeof buildRuntimeMutationLeaseDependency> &
  CodingRuntimeControlPlaneDeps &
  Pick<
    UiHandlerDeps,
    | "codingAppSessionChannel"
    | "registry"
    | "modelPortFactory"
    | "codingWorkbenchEvidenceStore"
    | "codingRuntimeEvidenceAggregator"
    | "codingRuntimeDeploymentCeiling"
    | "codingSidecarGatewayEvidenceAggregator"
  >;

function buildRuntimeUiHandlerDeps(
  args: UiHandlerDepsAssemblyArgs,
  services: UiHandlerRuntimeServices,
): RuntimeUiHandlerDeps {
  const codingRuntimeControlPlaneDeps = buildCodingRuntimeControlPlaneDeps(
    services.codingRuntimeControlPlane,
    services.runtimeComposition.unavailableReason,
    services.runtimeComposition.evidenceClass,
  );
  return {
    codingAppSessionChannel: services.codingAppSessionChannel,
    registry: args.options.registry ?? createRunRegistry(),
    modelPortFactory: args.options.modelPortFactory ?? defaultModelPortFactory(args.runtimeConfig),
    ...codingSidecarGatewayModelSourceFields(args),
    codingWorkbenchEvidenceStore: args.codingWorkbenchEvidenceStore,
    codingRuntimeEvidenceAggregator: services.codingRuntimeEvidenceAggregator,
    codingRuntimeDeploymentCeiling: services.codingRuntimeCeiling,
    ...buildRuntimeMutationLeaseDependency(args.options, services.runtimeComposition),
    ...codingRuntimeControlPlaneDeps,
    codingSidecarGatewayEvidenceAggregator: {
      record: ({ runId, outcome }): void => {
        services.codingRuntimeEvidenceAggregator.observe(runId, {
          kind: "model-request",
          state: gatewayOutcomeState(outcome),
          ...gatewayOutcomeFailureCode(outcome),
        });
      },
    },
  };
}

type IntegrationUiHandlerDeps = ReturnType<typeof autonomousDeliveryFields> &
  ReturnType<typeof atlassianConnectorCredentialFields> &
  Pick<UiHandlerDeps, "codingContextJiraPort"> &
  Pick<
    UiHandlerDeps,
    | "redactionSecrets"
    | "gatewayConfig"
    | "gatewaySetupTester"
    | "gatewayEmbeddingProbe"
    | "gatewayModelDiscovery"
    | "figmaCredentialTester"
    | "localKnowledgeKeyProvider"
    | "contextProfile"
    | "contextProfileForModel"
    | "workspaceIndexForRoot"
    | "consolidationJobs"
  >;

function buildIntegrationUiHandlerDeps(args: UiHandlerDepsAssemblyArgs): IntegrationUiHandlerDeps {
  const atlassian = atlassianConnectorCredentialFields(args);
  return {
    ...autonomousDeliveryFields(args.options),
    ...atlassianConnectorRegistryFields(args.options),
    ...atlassian,
    ...(atlassian.atlassianConnectorCredentials === undefined
      ? {}
      : {
          codingContextJiraPort: createGovernedJiraCodeContextHttpPort(
            atlassian.atlassianConnectorCredentials,
          ),
        }),
    redactionSecrets: runtimeRedactionSecrets(args.options.env, args.runtimeConfig, args.egress),
    gatewayConfig: args.runtimeConfig,
    gatewaySetupTester: args.options.gatewaySetupTester,
    gatewayEmbeddingProbe: args.options.gatewayEmbeddingProbe,
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
      diagnostics: args.options.diagnostics,
      securityLogSink: processServerLogSink(),
    }),
    consolidationJobs: createConsolidationJobRegistry({ evidenceStore: args.evidenceStore }),
  };
}

type OptionalUiHandlerDeps = ReturnType<typeof buildMemoryDeniedCategoryMatchersDependency> &
  ReturnType<typeof buildCodingContextPortsDependency> &
  ReturnType<typeof buildDapDebugDependency> &
  ReturnType<typeof buildWorkspaceLifecycleDependency> &
  ReturnType<typeof optionalPersistenceServices> &
  ReturnType<typeof buildAssemblyPeripherals>;

function buildOptionalUiHandlerDeps(
  args: UiHandlerDepsAssemblyArgs,
  services: UiHandlerRuntimeServices,
): OptionalUiHandlerDeps {
  return {
    ...buildMemoryDeniedCategoryMatchersDependency(args.options),
    ...buildCodingContextPortsDependency(args),
    ...buildDapDebugDependency(services.dapRuntime),
    ...optionalPersistenceServices(args.bundle),
    ...buildWorkspaceLifecycleDependency(services.workspaceLifecycle),
    ...services.peripherals,
  };
}

function buildCodingContextPortsDependency(
  args: UiHandlerDepsAssemblyArgs,
): Pick<UiHandlerDeps, "codingContextGitHubPort"> {
  const githubPort =
    args.options.env.GITHUB_CONNECTOR_AUTHORIZED !== "true" ||
    args.bundle.preferredProjectPath === undefined
      ? undefined
      : createGitHubCodeContextApiPort({
          workspace: {
            root: args.bundle.preferredProjectPath,
            name: undefined,
            version: undefined,
            testFramework: "unknown",
            sourceDirs: [],
            testDirs: [],
            languages: [],
            ignoreLines: [],
          },
          processEnv: args.options.env,
        });
  return {
    ...(githubPort === undefined ? {} : { codingContextGitHubPort: githubPort }),
  };
}

function createUiHandlerDispose(
  args: UiHandlerDepsAssemblyArgs,
  services: UiHandlerRuntimeServices,
): UiHandlerDeps["dispose"] {
  return async (): Promise<void> => {
    try {
      await services.codingRuntimeControlPlane?.orchestrator.shutdown();
    } finally {
      services.runtimeComposition.dispose?.();
      services.codingRuntimeControlPlane?.safeActivityProjection?.purgeAll("shutdown");
      await shutdownHostLspPool();
      await services.dapProduction?.dispose();
      services.peripherals.disposeTrustLspBridge();
      services.peripherals.debugActivationControl.dispose();
      services.peripherals.workspaceWatchService.disposeAll();
      args.bundle.dispose?.();
    }
  };
}

function buildDapDebugDependency(
  dapRuntime: DapRuntimeReference,
): Pick<UiHandlerDeps, "dapDebug"> | Record<never, never> {
  return dapRuntime.current === undefined ? {} : { dapDebug: dapRuntime.current };
}

function buildWorkspaceLifecycleDependency(
  workspaceLifecycle: WorkspaceLifecycleService | undefined,
): Pick<UiHandlerDeps, "workspaceLifecycle"> | Record<never, never> {
  return workspaceLifecycle === undefined ? {} : { workspaceLifecycle };
}

function buildMemoryDeniedCategoryMatchersDependency(
  options: BuildHandlerDepsOptions,
): Pick<UiHandlerDeps, "memoryDeniedCategoryMatchers"> | Record<never, never> {
  return options.memoryDeniedCategoryMatchers === undefined
    ? {}
    : { memoryDeniedCategoryMatchers: options.memoryDeniedCategoryMatchers };
}

interface CodingRuntimeControlPlaneDeps {
  codingRuntimeOrchestrator?: UiHandlerDeps["codingRuntimeOrchestrator"];
  codingRuntimeEventHub?: UiHandlerDeps["codingRuntimeEventHub"];
  codingRuntimeHostQualified?: UiHandlerDeps["codingRuntimeHostQualified"];
  codingSafeActivityProjection?: UiHandlerDeps["codingSafeActivityProjection"];
  codingRuntimeUnavailableReason?: UiHandlerDeps["codingRuntimeUnavailableReason"];
  codingRuntimeEvidenceClass?: UiHandlerDeps["codingRuntimeEvidenceClass"];
  codingSidecarGatewayCancellationRegistry?: UiHandlerDeps["codingSidecarGatewayCancellationRegistry"];
  runtimeCapabilityAuthenticator?: UiHandlerDeps["runtimeCapabilityAuthenticator"];
  openCodeGatewayReadinessRegistry?: UiHandlerDeps["openCodeGatewayReadinessRegistry"];
}

function buildCodingRuntimeControlPlaneDeps(
  controlPlane: ReturnType<typeof createCodingRuntimeControlPlane> | undefined,
  unavailableReason: CodingWorkbenchRuntimeUnavailableReason | undefined,
  evidenceClass: CodingWorkbenchRuntimeEvidenceClass | undefined,
): CodingRuntimeControlPlaneDeps {
  if (controlPlane === undefined) return {};
  return {
    codingRuntimeOrchestrator: controlPlane.orchestrator,
    codingRuntimeEventHub: controlPlane.eventHub,
    codingRuntimeHostQualified: controlPlane.runtimeHostQualified,
    ...(controlPlane.safeActivityProjection !== undefined
      ? { codingSafeActivityProjection: controlPlane.safeActivityProjection }
      : {}),
    ...(!controlPlane.runtimeHostQualified
      ? { codingRuntimeUnavailableReason: unavailableReason ?? "runtime-unqualified" }
      : { codingRuntimeEvidenceClass: evidenceClass ?? "functional-not-platform-qualified" }),
    ...(controlPlane.cancellationRegistry !== undefined
      ? {
          codingSidecarGatewayCancellationRegistry: controlPlane.cancellationRegistry,
        }
      : {}),
    ...(controlPlane.runtimeCapabilityAuthenticator !== undefined
      ? { runtimeCapabilityAuthenticator: controlPlane.runtimeCapabilityAuthenticator }
      : {}),
    ...(controlPlane.openCodeGatewayReadinessRegistry !== undefined
      ? {
          openCodeGatewayReadinessRegistry: controlPlane.openCodeGatewayReadinessRegistry,
        }
      : {}),
  };
}

function buildRuntimeMutationLeaseDependency(
  options: BuildHandlerDepsOptions,
  runtimeComposition: ReturnType<typeof productionRuntimeResolver>,
): Pick<UiHandlerDeps, "runtimeMutationLease"> | Record<never, never> {
  if (options.codingRuntimeResolver !== undefined) return {};
  if (runtimeComposition.runtimeMutationLease === undefined) return {};
  return { runtimeMutationLease: runtimeComposition.runtimeMutationLease };
}

export const KEIKO_CODING_DEPLOYMENT_CEILING_ENV = "KEIKO_CODING_DEPLOYMENT_CEILING";

/**
 * Option precedence, then explicit deployment configuration, then the governed-assist default.
 * An unrecognized environment value never widens anything: the narrowest posture wins, and the
 * readiness projection makes the effective ceiling visible to the operator.
 */
function resolveCodingRuntimeDeploymentCeiling(
  options: BuildHandlerDepsOptions,
): CodingWorkbenchMode {
  if (options.codingRuntimeDeploymentCeiling !== undefined) {
    return options.codingRuntimeDeploymentCeiling;
  }
  const configured = options.env[KEIKO_CODING_DEPLOYMENT_CEILING_ENV];
  return isCodingWorkbenchMode(configured) ? configured : "governed-assist";
}

interface ProductionRuntimeComposition {
  readonly resolver: ProductionCodingRuntimeResolver | undefined;
  readonly unavailableReason: CodingWorkbenchRuntimeUnavailableReason | undefined;
  readonly evidenceClass: CodingWorkbenchRuntimeEvidenceClass | undefined;
  readonly runtimeMutationLease?: CodingRuntimeEditorMutationLeasePort | undefined;
  readonly dispose?: (() => void) | undefined;
}

interface ProductionRuntimePortResolution {
  readonly ports: ProductionCodingRuntimePorts | undefined;
  readonly unavailableReason: CodingWorkbenchRuntimeUnavailableReason | undefined;
  readonly evidenceClass: CodingWorkbenchRuntimeEvidenceClass | undefined;
  readonly activated: boolean;
}

function unqualifiedComposition(
  unavailableReason: CodingWorkbenchRuntimeUnavailableReason,
): ProductionRuntimeComposition {
  return { resolver: undefined, unavailableReason, evidenceClass: undefined };
}

// The attested-portable activation path supplies Keiko's own confirmation plane; injected
// ports never receive a fallback consumer, so external composition stays fail-closed (#2377).
function resolveProductionRuntimePorts(
  args: UiHandlerDepsAssemblyArgs,
  runtimeEvidence: Pick<CodingRuntimeEvidenceAggregator, "observe">,
  readiness: OpenCodeGatewayReadinessRegistry,
  workspaceLifecycle: WorkspaceLifecycleService,
): ProductionRuntimePortResolution {
  const injectedPorts = args.options.codingRuntimeProductionPorts;
  if (injectedPorts !== undefined) {
    // A composition/test injection has no discovered artifact, so it may never claim platform
    // qualification; it degrades to the weak class exactly as every other default here does.
    return {
      ports: injectedPorts,
      unavailableReason: undefined,
      evidenceClass: "functional-not-platform-qualified",
      activated: false,
    };
  }
  const activation = resolveProductionOpenCodeActivation({
    env: args.options.env,
    runtimeStateDir: dirname(args.resolvedUiDbPath),
    runtimeEvidence,
    gatewayReadiness: readiness,
    resolveWorkspaceRoot: () => workspaceLifecycle.getActive()?.binding.activeRoot,
  });
  return {
    ports: activation.ports,
    unavailableReason: activation.unavailableReason,
    evidenceClass: activation.evidenceClass,
    activated: activation.ports !== undefined,
  };
}

/**
 * On a fresh installation the server-owned managed worktree root does not exist until the first
 * task workspace is provisioned; the resolver's trusted-root check would then keep an otherwise
 * fully activated runtime unqualified. Materialize it at composition time (#2475).
 *
 * The failure is diagnosed, not just returned: both callers turn `false` into a silent capability
 * downgrade (`runtime-unqualified`) or a cause-less `throw new Error(...)`, so a permission or
 * read-only-volume problem on the one directory the Coding runtime cannot work without had no
 * observable reason anywhere. Content-free: the error class only — never the path.
 */
function materializedManagedRoot(
  managedTaskWorkspaceRoot: string,
  diagnostics: ServerDiagnosticSink | undefined,
): boolean {
  try {
    mkdirSync(managedTaskWorkspaceRoot, { recursive: true, mode: 0o700 });
    return true;
  } catch (error) {
    emitCompositionDiagnostic(
      diagnostics,
      "deps.managedTaskWorkspaceRoot",
      "Managed task-workspace boundary materialization failed.",
      error,
    );
    return false;
  }
}

function runtimeWorkspaceAuthority(
  args: UiHandlerDepsAssemblyArgs,
  workspaceLifecycle: NonNullable<UiHandlerDepsAssemblyArgs["bundle"]["workspaceLifecycle"]>,
  managedTaskWorkspaceRoot: string,
  deploymentCeiling: CodingWorkbenchMode,
): Parameters<typeof createProductionCodingRuntimeResolver>[0]["workspaceAuthority"] {
  return {
    workspaceLifecycle,
    managedTaskWorkspaceRoot,
    deploymentCeiling,
    readWorkspaceHead: readProductionWorkspaceHead,
    researchEgressEnabled: args.options.codingRuntimeResearchEgressEnabled ?? true,
    resolveManagedModelProfile: (
      modelId,
      reasoningEffort,
    ): { readonly profileId: string; readonly reasoningEffort?: ModelReasoningEffort } => {
      const config = args.runtimeConfig.current();
      const resolved = resolveCodingSafeSidecarGatewayProfile(config, {
        ...(modelId === undefined ? {} : { modelId }),
      });
      if (resolved.status !== "available" || config === undefined) {
        throw new Error("runtime-model-unavailable");
      }
      const capability = findConfiguredCapability(config, resolved.modelAlias);
      if (
        reasoningEffort !== undefined &&
        capability?.reasoningEfforts?.includes(reasoningEffort) !== true
      ) {
        throw new Error("runtime-reasoning-effort-unavailable");
      }
      return {
        profileId: resolved.modelAlias,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      };
    },
  };
}

function runtimeStartConfirmationConsumer(
  args: UiHandlerDepsAssemblyArgs,
  activated: boolean,
): CodingRuntimeStartConfirmationConsumer | undefined {
  if (args.options.codingRuntimeStartConfirmationConsumer !== undefined) {
    return args.options.codingRuntimeStartConfirmationConsumer;
  }
  return activated ? createAuthenticatedSessionStartConfirmationPlane() : undefined;
}

function productionRuntimeResolver(
  args: UiHandlerDepsAssemblyArgs,
  commandRunner: PeripheralManagers["commandRunner"],
  verificationRunner: PeripheralManagers["verificationRunner"],
  runtimeEvidence: Pick<CodingRuntimeEvidenceAggregator, "observe">,
  deploymentCeiling: CodingWorkbenchMode,
): ProductionRuntimeComposition {
  const workspaceLifecycle = args.bundle.workspaceLifecycle;
  const managedTaskWorkspaceRoot = args.bundle.managedTaskWorkspaceRoot;
  if (workspaceLifecycle === undefined || managedTaskWorkspaceRoot === undefined) {
    return unqualifiedComposition("runtime-unqualified");
  }
  const readiness = createOpenCodeGatewayReadinessRegistry();
  const resolution = resolveProductionRuntimePorts(
    args,
    runtimeEvidence,
    readiness,
    workspaceLifecycle,
  );
  const ports = resolution.ports;
  if (ports === undefined) {
    return unqualifiedComposition(resolution.unavailableReason ?? "runtime-unqualified");
  }
  if (!materializedManagedRoot(managedTaskWorkspaceRoot, args.options.diagnostics)) {
    return unqualifiedComposition("runtime-unqualified");
  }
  const runtimeMutationLeaseBroker = createCodingRuntimeEditorMutationLeaseBroker();
  return qualifiedProductionRuntimeComposition(
    qualifiedRuntimeResolver({
      args,
      deploymentCeiling,
      managedTaskWorkspaceRoot,
      ports,
      activated: resolution.activated,
      runtimeMutationLeaseBroker,
      commandRunner,
      verificationRunner,
      workspaceLifecycle,
    }),
    readiness,
    runtimeMutationLeaseBroker,
    // Fail-closed default: an unthreaded activation degrades to the weak class, never to verified.
    resolution.evidenceClass ?? "functional-not-platform-qualified",
  );
}

interface QualifiedRuntimeResolverInput {
  readonly args: UiHandlerDepsAssemblyArgs;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly managedTaskWorkspaceRoot: string;
  readonly ports: ProductionCodingRuntimePorts;
  readonly activated: boolean;
  readonly runtimeMutationLeaseBroker: ReturnType<
    typeof createCodingRuntimeEditorMutationLeaseBroker
  >;
  readonly commandRunner: PeripheralManagers["commandRunner"];
  readonly verificationRunner: PeripheralManagers["verificationRunner"];
  readonly workspaceLifecycle: WorkspaceLifecycleService;
}

function qualifiedRuntimeResolver(
  input: QualifiedRuntimeResolverInput,
): ProductionCodingRuntimeResolver {
  const { args } = input;
  const confirmationConsumer = runtimeStartConfirmationConsumer(args, input.activated);
  return createProductionCodingRuntimeResolver({
    workspaceAuthority: runtimeWorkspaceAuthority(
      args,
      input.workspaceLifecycle,
      input.managedTaskWorkspaceRoot,
      input.deploymentCeiling,
    ),
    ...input.ports,
    commandRunner: input.commandRunner,
    verificationRunner: input.verificationRunner,
    runtimeMutationLeaseBroker: input.runtimeMutationLeaseBroker,
    gatewayEgress: () => args.runtimeConfig.current()?.egress ?? args.egress,
    childModelPortFactory:
      args.options.modelPortFactory ?? defaultModelPortFactory(args.runtimeConfig),
    // #2387: a read-only child agent calls the gateway directly, so it needs the same resolved
    // coding-safe PROVIDER model id the sidecar gateway maps the runtime's "coding" alias onto.
    // Resolved per call because the gateway config can change while the server is up.
    childModelId: (): string | undefined => codingSafeChildModelId(args.runtimeConfig),
    // #3099 P2 (KEIKO-0225 follow-up): default to the stderr sink when no custom sink is
    // wired, so the normal `keiko ui` / `dev-bff` composition actually records SSE fan-out
    // failures instead of silently no-op'ing recordSseFailure().
    diagnostics: args.options.diagnostics ?? defaultServerDiagnosticSink,
    ...(confirmationConsumer ? { confirmationConsumer } : {}),
  });
}

function qualifiedProductionRuntimeComposition(
  resolver: ProductionCodingRuntimeResolver,
  readiness: OpenCodeGatewayReadinessRegistry,
  runtimeMutationLeaseBroker: ReturnType<typeof createCodingRuntimeEditorMutationLeaseBroker>,
  evidenceClass: CodingWorkbenchRuntimeEvidenceClass,
): ProductionRuntimeComposition {
  return {
    resolver: {
      resolve: (): ReturnType<ProductionCodingRuntimeResolver["resolve"]> => {
        const qualified = resolver.resolve();
        return qualified === undefined
          ? undefined
          : { ...qualified, openCodeGatewayReadinessRegistry: readiness };
      },
    },
    unavailableReason: undefined,
    evidenceClass,
    runtimeMutationLease: runtimeMutationLeaseBroker,
    dispose: (): void => {
      runtimeMutationLeaseBroker.dispose();
    },
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
  const localKnowledgeKeyProvider = createLocalKnowledgeKeyProvider({
    env: options.env,
    securityLogSink: processServerLogSink(),
  });
  const bundle = buildPersistenceBundle(options, resolvedUiDbPath, redactString, evidenceStore);
  const contextProfileForModel = buildContextProfileResolver(() => runtimeConfig.current());
  reconcileNodeStoreAtStartup(options, bundle);
  const deps = assembleUiHandlerDeps({
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
  return {
    ...deps,
    voiceRecapContentAttestations: createVoiceRecapContentAttestationStore(),
  };
}
