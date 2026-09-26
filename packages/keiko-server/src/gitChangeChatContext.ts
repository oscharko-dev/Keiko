import type { WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import { isGitChangeSnapshot } from "@oscharko-dev/keiko-contracts/runtime/git-change-snapshot";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { PrDescription } from "@oscharko-dev/keiko-model-gateway";
import type { ChatGitChangeScope } from "./store/index.js";
import type { UiHandlerDeps } from "./deps.js";
import { resolveChatRepository } from "./gitChangeRepository.js";
import { defaultGitProcessRunner } from "@oscharko-dev/keiko-git";
import { observedGitRunner } from "./gitProcessActivity.js";
import { processServerLogSink } from "./process-log-sink.js";
import {
  authorizeGitDeliveryModelEgress,
  descriptionAuthorityEnvelopeDigest,
  type GitDeliveryDescriptionAuthorityScope,
} from "./gitDelivery/runBoundAuthority.js";

export interface GitChangeChatSnapshotContext {
  readonly reference: string;
  readonly accessScope: object;
  readonly captureInput: import("./gitChangeSnapshotService.js").GitChangeSnapshotCaptureInput;
  readonly snapshot: import("@oscharko-dev/keiko-contracts").GitChangeSnapshot;
  readonly files: readonly import("./gitChangeSnapshotEntries.js").GitSnapshotContentFile[];
}

export interface GitChangeChatHistoryMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}

export type GitChangeChatDescriptionResult =
  | {
      readonly status: "generated";
      readonly context: GitChangeChatSnapshotContext;
      readonly artifact: import("@oscharko-dev/keiko-contracts").PrDescriptionArtifact;
      readonly usage?: PrDescription.PrDescriptionGenerationUsage | undefined;
    }
  | {
      readonly status: "unavailable";
      readonly reason: import("@oscharko-dev/keiko-contracts").PrDescriptionReason;
    };

const REFINEMENT_MAX_BYTES = 4096;

const PR_DESCRIPTION_CHAT_GENERATED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "pr-description.chat.generated",
  category: "process",
  owner: "keiko-server",
  emitter: "gitChangeChatContext.logDescriptionResult",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["complete", "partial", "fallback", "failed"],
    },
    relationshipId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    requestCount: { type: "integer", dataClass: "count", required: true },
    snapshotDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["pr-description-chat-generation"],
  proofIds: ["pr-description.chat.generated.outcome"],
  releaseImpact: "patch",
});

const PR_DESCRIPTION_CHAT_UNAVAILABLE_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "pr-description.chat.unavailable",
  category: "process",
  owner: "keiko-server",
  emitter: "gitChangeChatContext.logDescriptionResult",
  fields: {
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "none",
        "model-unavailable",
        "invalid-model-output",
        "unsafe-model-output",
        "provider-failed",
        "budget-exhausted",
        "cancelled",
        "timeout",
        "snapshot-unavailable",
        "invalid-snapshot",
        "invalid-request",
        "authority-denied",
      ],
    },
    relationshipId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    snapshotDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["pr-description-chat-generation"],
  proofIds: ["pr-description.chat.unavailable.reason"],
  releaseImpact: "patch",
});

type PrDescriptionReason = import("@oscharko-dev/keiko-contracts").PrDescriptionReason;

const DESCRIPTION_ERROR_KINDS: Readonly<Record<PrDescriptionReason, ActivityLogErrorKind>> = {
  "authority-denied": "authority-denied",
  "budget-exhausted": "rate-limited",
  cancelled: "cancelled",
  timeout: "timeout",
  "unsafe-model-output": "unsafe-target",
  "invalid-model-output": "validation-failed",
  "invalid-snapshot": "validation-failed",
  "invalid-request": "validation-failed",
  "model-unavailable": "unavailable",
  "provider-failed": "unavailable",
  "snapshot-unavailable": "unavailable",
  none: "unknown",
};

function descriptionErrorKind(reason: PrDescriptionReason): ActivityLogErrorKind {
  return DESCRIPTION_ERROR_KINDS[reason];
}

function logDescriptionResult(
  input: Parameters<typeof generateGitChangeChatDescription>[0],
  result: GitChangeChatDescriptionResult,
): void {
  const activityLog = input.deps.activityLog ?? processServerLogSink();
  if (result.status === "generated") {
    activityLog.write(
      activityLogEvent(
        PR_DESCRIPTION_CHAT_GENERATED_OPERATION,
        { correlationId: input.correlationId },
        {
          relationshipId: input.scope.relationshipId,
          snapshotDigest: input.scope.snapshotDigest,
          outcome: result.artifact.outcome,
          requestCount: result.usage?.requestCount ?? 0,
        },
      ),
    );
    return;
  }
  activityLog.write(
    activityLogEvent(
      PR_DESCRIPTION_CHAT_UNAVAILABLE_OPERATION,
      {
        level: "warn",
        correlationId: input.correlationId,
        errorKind: descriptionErrorKind(result.reason),
      },
      {
        relationshipId: input.scope.relationshipId,
        snapshotDigest: input.scope.snapshotDigest,
        reason: result.reason,
      },
    ),
  );
}

function recordedDescriptionResult(
  input: Parameters<typeof generateGitChangeChatDescription>[0],
  result: GitChangeChatDescriptionResult,
): GitChangeChatDescriptionResult {
  logDescriptionResult(input, result);
  return result;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let truncated = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
  return truncated;
}

export function gitChangeChatRefinement(
  history: readonly GitChangeChatHistoryMessage[],
  latestIntent: string,
): string {
  const prior = history
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-6)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
  return truncateUtf8(
    `Latest request:\n${latestIntent}\nPrior conversation:\n${prior}`,
    REFINEMENT_MAX_BYTES,
  );
}

function workspace(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

function matchesScope(
  snapshot: import("@oscharko-dev/keiko-contracts").GitChangeSnapshot,
  scope: ChatGitChangeScope,
): boolean {
  return (
    snapshot.remoteDigest === scope.remoteDigest &&
    snapshot.baseRef === scope.baseRef &&
    snapshot.headRef === scope.headRef &&
    snapshot.baseSha === scope.baseSha &&
    snapshot.headSha === scope.headSha &&
    snapshot.mergeBaseSha === scope.mergeBaseSha &&
    snapshot.snapshotDigest === scope.snapshotDigest
  );
}

/** Captures raw comparison evidence only in this request's transient server capability. */
export async function captureGitChangeChatSnapshot(
  deps: UiHandlerDeps,
  projectPath: string,
  scope: ChatGitChangeScope,
  correlationId: string,
  signal: AbortSignal,
): Promise<GitChangeChatSnapshotContext | undefined> {
  const service = deps.gitChangeSnapshotService;
  if (service === undefined) return undefined;
  const runner = observedGitRunner(
    defaultGitProcessRunner,
    deps.activityLog ?? processServerLogSink(),
    correlationId,
  );
  const repository = await resolveChatRepository(projectPath, runner, 30_000);
  if (repository === undefined) return undefined;
  const accessScope = {};
  const captureInput = {
    workspace: workspace(repository.repositoryRoot),
    baseRef: scope.baseRef,
    headRef: scope.headRef,
    expectedHeadSha: scope.headSha,
    accessScope,
    correlationId,
    signal,
  };
  const captured = await service.capture(captureInput);
  if (
    !isGitChangeSnapshot(captured.snapshot) ||
    captured.reference === undefined ||
    !matchesScope(captured.snapshot, scope)
  )
    return undefined;
  const rechecked = await service.recheck(captured.reference, captureInput);
  if (rechecked.state !== "current") return undefined;
  const content = service.read(captured.reference, accessScope, correlationId);
  if (content === undefined || !matchesScope(content.snapshot, scope)) return undefined;
  return {
    reference: captured.reference,
    accessScope,
    captureInput,
    snapshot: content.snapshot,
    files: content.files,
  };
}

export function gitChangeDescriptionAuthorityScopeFor(
  scope: ChatGitChangeScope,
): GitDeliveryDescriptionAuthorityScope {
  return {
    remoteDigest: scope.remoteDigest,
    pr: { baseRef: scope.baseRef, headRef: scope.headRef },
    snapshotDigest: scope.snapshotDigest,
  };
}

async function resolveCapturedSnapshot(
  input: Parameters<typeof generateGitChangeChatDescription>[0],
  context: GitChangeChatSnapshotContext,
  reference: string,
  signal: AbortSignal,
): Promise<PrDescription.PrDescriptionResolvedSnapshot | undefined> {
  if (reference !== context.reference || signal.aborted) return undefined;
  const service = input.deps.gitChangeSnapshotService;
  const rechecked = await service?.recheck(context.reference, context.captureInput);
  if (rechecked?.state !== "current") return undefined;
  const content = service?.read(context.reference, context.accessScope, input.correlationId);
  if (content === undefined || !matchesScope(content.snapshot, input.scope)) return undefined;
  return {
    snapshot: content.snapshot,
    evidence: content.files.map((file) => ({
      evidenceId: file.evidenceId,
      text: JSON.stringify(file),
    })),
  };
}

async function generateFromCapturedSnapshot(
  input: Parameters<typeof generateGitChangeChatDescription>[0],
  generation: NonNullable<UiHandlerDeps["prDescriptionGeneration"]>,
  context: GitChangeChatSnapshotContext,
): Promise<GitChangeChatDescriptionResult> {
  const scope = gitChangeDescriptionAuthorityScopeFor(input.scope);
  const authorityDigest = descriptionAuthorityEnvelopeDigest(scope);
  const result = await PrDescription.generatePrDescription(
    {
      snapshotReference: context.reference,
      language: "en",
      refinement: gitChangeChatRefinement(input.history, input.latestIntent),
      authority: {
        authorityDigest,
        correlationId: input.correlationId,
      },
      signal: input.signal,
    },
    {
      ...generation,
      revalidateAuthority: async (authority, signal) => {
        if (
          authority.authorityDigest !== authorityDigest ||
          authority.correlationId !== input.correlationId ||
          (await resolveCapturedSnapshot(input, context, context.reference, signal)) === undefined
        ) {
          return false;
        }
        const port = input.deps.gitChangeDescriptionAuthorityPort;
        return (
          port !== undefined &&
          authorizeGitDeliveryModelEgress(port, scope, new Date().toISOString()).allowed
        );
      },
      resolveSnapshot: (reference, signal) =>
        resolveCapturedSnapshot(input, context, reference, signal),
    },
  );
  return result.status === "generated"
    ? {
        status: "generated",
        context,
        artifact: result.artifact,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      }
    : result;
}

export async function generateGitChangeChatDescription(input: {
  readonly deps: UiHandlerDeps;
  readonly projectPath: string;
  readonly scope: ChatGitChangeScope;
  readonly correlationId: string;
  readonly signal: AbortSignal;
  readonly history: readonly GitChangeChatHistoryMessage[];
  readonly latestIntent: string;
}): Promise<GitChangeChatDescriptionResult> {
  const generation = input.deps.prDescriptionGeneration;
  if (generation === undefined)
    return recordedDescriptionResult(input, {
      status: "unavailable",
      reason: "model-unavailable",
    });
  const context = await captureGitChangeChatSnapshot(
    input.deps,
    input.projectPath,
    input.scope,
    input.correlationId,
    input.signal,
  );
  if (context === undefined)
    return recordedDescriptionResult(input, {
      status: "unavailable",
      reason: "snapshot-unavailable",
    });
  return recordedDescriptionResult(
    input,
    await generateFromCapturedSnapshot(input, generation, context),
  );
}
