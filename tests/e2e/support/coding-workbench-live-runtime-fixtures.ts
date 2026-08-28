import { expect, type Route } from "@playwright/test";
import type {
  CodingWorkbenchCodexAuthMethod,
  CodingWorkbenchCodexAuthSetupPlan,
  CodingWorkbenchCodexSubscriptionProfile,
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeSseEvent,
  CodingWorkbenchRuntimeStateName,
  CodingWorkbenchSidecarGatewayResult,
  WorkspaceBinding,
  WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts";
import {
  validateCodingWorkbenchCodexAuthSetupPlan,
  validateCodingWorkbenchCodexSubscriptionProfile,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-codex-auth";
import {
  validateCodingWorkbenchRuntimeSnapshot,
  validateCodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import type { LiveRuntimeFixtureOptions } from "./coding-workbench-live-runtime.js";

export type FixtureAuthStatus = Extract<
  CodingWorkbenchCodexSubscriptionProfile["status"],
  "connected" | "missing" | "expired" | "redistribution-unapproved"
>;

const AT = "2026-07-13T12:00:00.000Z";
export const FIXTURE_RUN_ID = "run-2257";

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
    ...(state === "idle" ? {} : { runId: FIXTURE_RUN_ID, requestedMode: "governed-assist" }),
    ...(state === "awaiting-approval"
      ? {
          pendingPermission: {
            requestId: "permission-2257",
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
