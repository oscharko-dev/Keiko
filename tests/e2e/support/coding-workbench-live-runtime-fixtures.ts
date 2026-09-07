import { expect, type Route } from "@playwright/test";
import type {
  CodingWorkbenchCodexAuthMethod,
  CodingWorkbenchCodexAuthSetupPlan,
  CodingWorkbenchCodexSubscriptionProfile,
  CodingWorkbenchRuntimeApprovalReviewChannelPayload,
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeSseEvent,
  CodingWorkbenchRuntimeStateName,
  CodingWorkbenchSidecarGatewayResult,
  WorkspaceBinding,
  WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import {
  validateCodingWorkbenchCodexAuthSetupPlan,
  validateCodingWorkbenchCodexSubscriptionProfile,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-codex-auth";
import { validateCodingWorkbenchRuntimeApprovalReviewChannelPayload } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-approval-review";
import {
  validateCodingWorkbenchRuntimeSnapshot,
  validateCodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import type { LiveRuntimeFixtureOptions } from "./coding-workbench-live-runtime.js";

/** Binds `snapshot()`'s hardcoded `awaiting-approval` permission to its authenticated review. */
export const FIXTURE_APPROVAL_REQUEST_ID = "permission-2257";

export type FixtureAuthStatus = Extract<
  CodingWorkbenchCodexSubscriptionProfile["status"],
  "connected" | "missing" | "expired" | "redistribution-unapproved"
>;

const AT = "2026-07-13T12:00:00.000Z";
export const FIXTURE_RUN_ID = "run-2257";
/** A well-formed sha256 hex digest; this fixture never has real content to hash. */
const FIXTURE_DIGEST = "a".repeat(64);

export interface RuntimeFixtureState {
  state: CodingWorkbenchRuntimeStateName;
  revision: number;
  recoveryAcknowledged: boolean;
  streamConnections: number;
  readonly validationErrors: string[];
}

interface ActiveWorkspaceFixture {
  readonly instance: WorkspaceInstance;
  readonly binding: WorkspaceBinding;
  readonly pointer: {
    readonly workspaceId: string;
    readonly setBy: string;
    readonly setAt: string;
    readonly updatedAt: string;
  };
}

export function fulfillJson(route: Route, body: unknown): Promise<void> {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function workspace(): ActiveWorkspaceFixture {
  const instance: WorkspaceInstance = {
    schemaVersion: "1",
    workspaceId: "workspace-2257",
    taskId: "task-2257",
    repositoryId: "repository-2257",
    repositoryRoot: "/workspace",
    baseBranch: "dev",
    taskBranch: "issue/2257-live-runtime",
    managedWorktreePath: "/workspace/.keiko/worktrees/task-2257",
    gitdirIdentity: "gitdir-2257",
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: AT,
    updatedAt: AT,
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: "correlation-2257",
  };
  const binding: WorkspaceBinding = {
    schemaVersion: "1",
    workspaceId: "workspace-2257",
    taskId: "task-2257",
    activeRoot: "/workspace/.keiko/worktrees/task-2257",
    boundSurfaces: ["editor", "terminal", "git-delivery"],
    gitDeliveryRoot: "/workspace/.keiko/worktrees/task-2257",
    editorProjectRoot: "/workspace/.keiko/worktrees/task-2257",
  };
  return {
    instance,
    binding,
    pointer: { workspaceId: "workspace-2257", setBy: "e2e", setAt: AT, updatedAt: AT },
  };
}

export function sourceProfile(): CodingWorkbenchSidecarGatewayResult {
  return {
    status: "available",
    profileId: "gateway-2257",
    modelAlias: "keiko-model-gateway",
    localEndpointPath: "/api/coding-sidecar/gateway/chat/completions",
    supportsStreaming: true,
    supportsToolCalling: true,
    runMetadata: {
      maxPromptTokens: 200_000,
      maxOutputTokens: 16_000,
      maxInputMessages: 64,
      maxRequestBytes: 1_000_000,
    },
    // F-01: the live-runtime scenario drives a run to completion, which the Workbench only permits
    // against a source a probe actually confirmed. A fixture that left this unverified would be
    // asserting the demoted path, not the happy one.
    verification: "verified",
  };
}

export function codexProfile(status: FixtureAuthStatus): CodingWorkbenchCodexSubscriptionProfile {
  const redistributionUnapproved = status === "redistribution-unapproved";
  const profile: CodingWorkbenchCodexSubscriptionProfile = {
    schemaVersion: "1",
    profileId: "codex-subscription",
    modelSource: "chatgpt-codex-subscription-profile",
    runtimeSource: "codex-cli-adapter",
    status,
    ...(status === "connected" ? { authMethod: "chatgpt-device-code" } : {}),
    credentialStore: redistributionUnapproved ? "file" : "keyring",
    stateScope: redistributionUnapproved ? "keiko-owned-state" : "os-credential-store",
    stateRoot: redistributionUnapproved ? "keiko-codex-runtime-state" : "os-credential-store",
    usesGlobalCodexHome: false,
    runtimeBinarySources: redistributionUnapproved ? [] : ["managed-sidecar-runtime"],
    supportsBrowserLogin: !redistributionUnapproved,
    supportsDeviceCode: !redistributionUnapproved,
    supportsAccessToken: !redistributionUnapproved,
    deploymentPolicyDisabled: false,
    headless: false,
  };
  expect(validateCodingWorkbenchCodexSubscriptionProfile(profile).ok).toBe(true);
  return profile;
}

export function codexSetupPlan(
  method: CodingWorkbenchCodexAuthMethod,
): CodingWorkbenchCodexAuthSetupPlan {
  const commandLabel =
    method === "chatgpt-browser-login"
      ? "codex-login"
      : method === "chatgpt-device-code"
        ? "codex-login-device-auth"
        : "codex-login-with-access-token";
  const accessToken = method === "codex-access-token";
  const plan: CodingWorkbenchCodexAuthSetupPlan = {
    schemaVersion: "1" as const,
    profileId: "codex-subscription",
    method,
    modelSource: "chatgpt-codex-subscription-profile" as const,
    runtimeSource: "codex-cli-adapter" as const,
    credentialStore: "keyring" as const,
    stateScope: "os-credential-store" as const,
    stateRoot: "os-credential-store" as const,
    usesGlobalCodexHome: false,
    commandLabel,
    requiresSecretInput: accessToken,
    ...(accessToken ? { credentialTransport: "stdin" as const } : {}),
  };
  expect(validateCodingWorkbenchCodexAuthSetupPlan(plan).ok).toBe(true);
  return plan;
}

export function eventStream(count: number, retryMs = 60_000): string {
  const events = Array.from({ length: count }, (_, index) => {
    const sequence = index + 1;
    const event: CodingWorkbenchRuntimeSseEvent = {
      schemaVersion: "1",
      cursor: `cursor-${String(sequence)}`,
      sequence,
      occurredAt: AT,
      kind: "runtime-event",
      runId: FIXTURE_RUN_ID,
      state: "running",
      revision: sequence,
      eventKind: "observation-streamed",
    };
    expect(validateCodingWorkbenchRuntimeSseEvent(event).ok).toBe(true);
    return `event: runtime-event\ndata: ${JSON.stringify(event)}\n\n`;
  }).join("");
  return `retry: ${String(retryMs)}\n\n${events}`;
}

export function snapshot(fixture: RuntimeFixtureState): CodingWorkbenchRuntimeSnapshot {
  const { state, revision } = fixture;
  const value: CodingWorkbenchRuntimeSnapshot = {
    schemaVersion: "1",
    state,
    revision,
    updatedAt: AT,
    ...(state === "idle"
      ? {}
      : {
          runId: FIXTURE_RUN_ID,
          requestedMode: "governed-assist",
          // Bound identically to `pushDeliveryRecord()`'s binding below: the client cross-checks a
          // pending push/PR delivery review against this snapshot field
          // (`deliveryMatchesPermission` in CodingWorkbenchCommitReview.tsx) before it will treat
          // the review as bound to the on-screen request, so the two must always agree.
          issueBinding: {
            schemaVersion: "1",
            repositoryId: "repository-2257",
            remoteDigest: FIXTURE_DIGEST,
            issueIdDigest: FIXTURE_DIGEST,
            issueNumber: 2257,
            defaultBaseRef: "dev",
            contentRevisionDigest: FIXTURE_DIGEST,
            bindingDigest: FIXTURE_DIGEST,
          },
        }),
    ...(state === "awaiting-approval"
      ? {
          pendingPermission: {
            requestId: FIXTURE_APPROVAL_REQUEST_ID,
            kind: "delivery-substrate",
            actionClass: "delivery-substrate",
            reasonCode: "approval-required",
            actionKind: "push",
            scopeLabel: "workspace-scope",
            risk: "high",
            policyReason: "approval-required",
            expiresAt: "2026-07-13T12:05:00.000Z",
          },
        }
      : {}),
    ...(state === "recovery-required" ? { failureCode: "recovery-required" } : {}),
    ...(state === "recovery-required" && fixture.recoveryAcknowledged
      ? { recoveryAcknowledged: true }
      : {}),
  };
  expect(validateCodingWorkbenchRuntimeSnapshot(value).ok).toBe(true);
  return value;
}

/**
 * The authenticated review the real server would serve for `snapshot()`'s hardcoded
 * `awaiting-approval` push permission. The real `/approval-review` route (#2802) resolves the
 * pending approval from the actual orchestrator's run state; this fixture drives the run entirely
 * through mocked snapshots, so no such run ever exists server-side and the route would otherwise
 * 404 forever, leaving `evidenceBound` (CodingWorkbenchWindow.tsx) permanently false and the
 * Approve control permanently disabled (release-smoke failure on coding-workbench-1992.spec.ts:
 * locator.click timed out waiting for "Approve once" to become enabled).
 */
function pushDeliveryRecord(): DraftDeliveryRecord {
  return {
    schemaVersion: "1",
    revision: 1,
    phase: "push-proposed",
    reason: "approval-required",
    proposalId: FIXTURE_APPROVAL_REQUEST_ID,
    proposalDigest: FIXTURE_DIGEST,
    recordedAt: AT,
    binding: {
      runId: FIXTURE_RUN_ID,
      workspaceDigest: FIXTURE_DIGEST,
      runtimeAuthorityDigest: FIXTURE_DIGEST,
      envelopeDigest: FIXTURE_DIGEST,
      remoteDigest: FIXTURE_DIGEST,
      issueBindingDigest: FIXTURE_DIGEST,
      issueIdDigest: FIXTURE_DIGEST,
      issueNumber: 2257,
      repository: "oscharko-dev/keiko",
      remoteAlias: "origin",
      baseRef: "dev",
      baseSha: "1".repeat(40),
      headRef: "issue/2257-live-runtime",
      headSha: "3".repeat(40),
      verifiedCommitProposalId: "commit-2257",
      recoveryId: "delivery-2257",
    },
  };
}

export function approvalReview(
  fixture: RuntimeFixtureState,
): CodingWorkbenchRuntimeApprovalReviewChannelPayload {
  const payload: CodingWorkbenchRuntimeApprovalReviewChannelPayload = {
    session: "active",
    ...(fixture.state === "awaiting-approval"
      ? {
          pending: {
            requestId: FIXTURE_APPROVAL_REQUEST_ID,
            paths: [],
            pathsTruncated: false,
            fileCount: 0,
            addedLines: 0,
            deletedLines: 0,
            draftDelivery: { record: pushDeliveryRecord() },
          },
        }
      : {}),
  };
  expect(validateCodingWorkbenchRuntimeApprovalReviewChannelPayload(payload).ok).toBe(true);
  return payload;
}

export function activeWorkspace(): ActiveWorkspaceFixture {
  return workspace();
}

export function createRuntimeFixture(options: LiveRuntimeFixtureOptions): RuntimeFixtureState {
  // KEIKO-0539: the FSM state must never encode host qualification — no orchestrator code path
  // can produce an "unavailable" state. Unavailability is modelled where the product actually
  // reports it: through readiness (`runtimeAvailable` / `runtimeUnavailableReason`), wired at
  // coding-workbench-live-runtime-routes.ts:221-226.
  return {
    state: options.initialState ?? "idle",
    revision: 1,
    recoveryAcknowledged: false,
    streamConnections: 0,
    validationErrors: [],
  };
}
