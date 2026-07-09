import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchAuthorityEnvelope } from "@oscharko-dev/keiko-contracts";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import type { CommandRunnerManager, CommandRunInput } from "../command-runner.js";
import type { GitProcessRunner } from "../gitRoutes.js";
import { matchRoute, type RouteContext } from "../routes.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import type {
  AutonomousDeliveryConnectorExecutor,
  AutonomousDeliveryConnectorOperationRequest,
  AutonomousDeliveryConnectorOperationResult,
} from "./autonomousDeliveryPolicy.js";
import {
  createAutonomousDeliveryApprovalStore,
  type AutonomousDeliveryApprovalStore,
} from "./autonomousDeliveryApprovalStore.js";
import {
  handleAutonomousDeliveryConfirm,
  handleAutonomousDeliveryExecute,
} from "./autonomousDeliveryRoutes.js";

let root: string;
let store: UiStore;
let approvalStore: AutonomousDeliveryApprovalStore;

function ok(stdout: string): Awaited<ReturnType<GitProcessRunner>> {
  return { exitCode: 0, signal: null, stdout, stderr: "", truncated: false };
}

function deps(
  runner: GitProcessRunner = vi.fn(() => Promise.resolve(ok(""))),
  commandRunner?: CommandRunnerManager,
  autonomousDeliveryConnector?: AutonomousDeliveryConnectorExecutor,
  overrides: Partial<UiHandlerDeps> = {},
): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    autonomousDeliveryApprovalStore: approvalStore,
    autonomousDeliveryDeploymentCeiling: "autonomous-delivery",
    ...(commandRunner === undefined ? {} : { commandRunner }),
    ...(autonomousDeliveryConnector === undefined ? {} : { autonomousDeliveryConnector }),
    gitRouteOptions: { runner, maxDiffBytes: 64, maxStatusBytes: 4096, maxChanges: 10 },
    ...overrides,
  };
}

interface ConnectorHarness {
  readonly connector: AutonomousDeliveryConnectorExecutor;
  readonly calls: AutonomousDeliveryConnectorOperationRequest[];
}

function connectorExecutor(routeStatus = 200): ConnectorHarness {
  const calls: AutonomousDeliveryConnectorOperationRequest[] = [];
  return {
    calls,
    connector: {
      execute: (request): Promise<AutonomousDeliveryConnectorOperationResult> => {
        calls.push(request);
        return Promise.resolve({
          status: request.dryRun === true ? "previewed" : "applied",
          routeStatus,
        } satisfies AutonomousDeliveryConnectorOperationResult);
      },
    },
  };
}

function commandRunner(failureReason: "none" | "non-zero-exit" = "none"): CommandRunnerManager {
  return {
    discover: (projectId: string) => ({ schemaVersion: "1", projectId, tasks: [] }),
    execute: (input: CommandRunInput) =>
      Promise.resolve({
        schemaVersion: "1",
        runId: "cmd-1",
        taskId: input.taskId,
        kind: "test",
        exitCode: failureReason === "none" ? 0 : 1,
        durationMs: 12,
        truncated: false,
        timedOut: false,
        failureReason,
        stdout: "",
        stderr: "",
      }),
    abort: () => false,
    subscribe: () => (): void => undefined,
    inFlightCount: () => 0,
  };
}

function ctx(body: unknown): RouteContext {
  const raw = JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw, "utf8")]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json", "x-keiko-csrf": "1" };
  return {
    req,
    res: {} as ServerResponse,
    params: {},
    url: new URL("http://127.0.0.1/api/coding-workbench/autonomous-delivery/execute"),
  };
}

function envelope(
  overrides: Partial<CodingWorkbenchAuthorityEnvelope> = {},
): CodingWorkbenchAuthorityEnvelope {
  return {
    schemaVersion: "1",
    runId: "run-1993",
    localUser: "operator",
    taskRefs: ["issue-1993"],
    workspace: { workspaceId: "workspace", rootLabel: "workspace", rootDigest: "b".repeat(64) },
    branch: {
      baseRef: "dev",
      headRef: "issue/1993",
      allowDetachedHead: false,
      allowedPrefixes: ["issue/"],
    },
    requestedMode: "autonomous-delivery",
    deploymentCeiling: "autonomous-delivery",
    effectiveMode: "autonomous-delivery",
    runtimeSource: "delivery-runner",
    actionClasses: [
      "workspace-read",
      "workspace-write",
      "command-execution",
      "verification",
      "connector-access",
      "network-egress",
      "delivery-substrate",
    ],
    connectorScopes: ["source-control.read", "source-control.write"],
    modelProfile: {
      profileId: "codex",
      source: "keiko-model-gateway",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "governed",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 120_000,
      requirePerCommandApproval: false,
    },
    networkPolicy: {
      mode: "connector-scoped-egress",
      allowLoopback: true,
      connectorScopes: ["source-control.read", "source-control.write"],
    },
    gates: ["human-approval", "branch-allowlist", "verification-green", "policy-review"],
    budget: {
      maxRuntimeMs: 3_600_000,
      maxToolCalls: 20,
      maxPromptTokens: 200_000,
      maxPatchBytes: 1_000_000,
    },
    expiresAt: "2999-01-01T00:00:00.000Z",
    approvalProofDigest: "a".repeat(64),
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const authorityEnvelope =
    (overrides.authorityEnvelope as CodingWorkbenchAuthorityEnvelope | undefined) ?? envelope();
  const confirmedAt = "2026-07-07T13:00:00.000Z";
  const confirmation =
    overrides.confirmation ?? approvalStore.issue(authorityEnvelope, confirmedAt);
  return {
    schemaVersion: "1",
    authorityEnvelope,
    confirmation,
    operations: [
      {
        kind: "repository-operation",
        stepId: "step-1",
        request: {
          schemaVersion: "1",
          operation: "status",
          mode: "read",
          projectId: root,
        },
      },
    ],
    usage: { runtimeMs: 0, toolCalls: 0, promptTokens: 0, patchBytes: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-autonomous-delivery-"));
  store = createInMemoryUiStore();
  approvalStore = createAutonomousDeliveryApprovalStore(Buffer.alloc(32, 1));
  store.createProject(root, "fixture");
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("POST /api/coding-workbench/autonomous-delivery/execute", () => {
  it("is registered as an exact POST route", () => {
    const confirmMatch = matchRoute("POST", "/api/coding-workbench/autonomous-delivery/confirm");
    const match = matchRoute("POST", "/api/coding-workbench/autonomous-delivery/execute");

    expect(confirmMatch).not.toBe("method-not-allowed");
    expect(confirmMatch).toBeDefined();
    expect(match).not.toBe("method-not-allowed");
    expect(match).toBeDefined();
    if (confirmMatch === undefined || confirmMatch === "method-not-allowed") {
      throw new Error("confirm route missing");
    }
    if (match === undefined || match === "method-not-allowed") throw new Error("route missing");
    expect(confirmMatch.definition.pattern).toBe(
      "/api/coding-workbench/autonomous-delivery/confirm",
    );
    expect(match.definition.pattern).toBe("/api/coding-workbench/autonomous-delivery/execute");
    expect(matchRoute("GET", "/api/coding-workbench/autonomous-delivery/confirm")).toBe(
      "method-not-allowed",
    );
    expect(matchRoute("GET", "/api/coding-workbench/autonomous-delivery/execute")).toBe(
      "method-not-allowed",
    );
  });

  it("mints server-owned confirmations that execute can consume once", async () => {
    const authorityEnvelope = envelope();
    const confirm = await handleAutonomousDeliveryConfirm(
      ctx({ schemaVersion: "1", authorityEnvelope }),
      deps(),
    );
    const confirmation = (
      confirm.body as {
        readonly confirmation: {
          readonly confirmed: boolean;
          readonly approvalProofDigest: string;
          readonly confirmedAt: string;
        };
      }
    ).confirmation;
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(ok("## main\0"));

    const first = await handleAutonomousDeliveryExecute(
      ctx(body({ authorityEnvelope, confirmation })),
      deps(runner),
    );
    const replay = await handleAutonomousDeliveryExecute(
      ctx(body({ authorityEnvelope, confirmation })),
      deps(runner),
    );

    expect(confirm).toMatchObject({
      status: 200,
      body: { schemaVersion: "1", runId: "run-1993", confirmation: { confirmed: true } },
    });
    expect(confirmation.approvalProofDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(confirmation.approvalProofDigest).not.toBe(authorityEnvelope.approvalProofDigest);
    expect(first.body).toMatchObject({ status: "completed" });
    expect(replay.body).toMatchObject({
      status: "denied",
      steps: [{ denialReason: "authority-envelope-unconfirmed" }],
    });
  });

  it("delegates allowed read operations through the existing repository facade", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(ok("## main\0"));
    const result = await handleAutonomousDeliveryExecute(ctx(body()), deps(runner));

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      schemaVersion: "1",
      runId: "run-1993",
      status: "completed",
      steps: [{ stepId: "step-1", operation: "status", status: "delegated", routeStatus: 200 }],
    });
    expect(runner).toHaveBeenCalled();
  });

  it("denies unconfirmed envelopes and branch escapes before delegation", async () => {
    const runner = vi.fn<GitProcessRunner>(() => Promise.resolve(ok("")));
    const unconfirmed = await handleAutonomousDeliveryExecute(
      ctx(
        body({
          confirmation: {
            confirmed: false,
            approvalProofDigest: "a".repeat(64),
            confirmedAt: "2026-07-07T13:00:00.000Z",
          },
        }),
      ),
      deps(runner),
    );
    const branchEscape = await handleAutonomousDeliveryExecute(
      ctx(
        body({
          operations: [
            {
              kind: "repository-operation",
              stepId: "step-1",
              request: {
                schemaVersion: "1",
                operation: "pull-request",
                mode: "execute",
                projectId: root,
                idempotencyKey: "pr-1",
                payload: {
                  kind: "create",
                  ownerAndRepo: "oscharko-dev/Keiko",
                  headBranchName: "other/1993",
                  baseBranchName: "dev",
                  title: "Redacted",
                  description: "Redacted",
                  isDraft: true,
                },
              },
            },
          ],
        }),
      ),
      deps(runner),
    );

    expect(unconfirmed.body).toMatchObject({
      status: "denied",
      steps: [{ status: "denied", denialReason: "authority-envelope-unconfirmed" }],
    });
    expect(branchEscape.body).toMatchObject({
      status: "denied",
      steps: [{ status: "denied", denialReason: "branch-out-of-envelope" }],
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("denies client-raised ceilings and server-recorded stopped runs before delegation", async () => {
    const runner = vi.fn<GitProcessRunner>(() => Promise.resolve(ok("")));
    const clientRaisedCeiling = await handleAutonomousDeliveryExecute(
      ctx(body()),
      deps(runner, undefined, undefined, {
        autonomousDeliveryDeploymentCeiling: "supervised-coding",
      }),
    );
    const serverStopped = await handleAutonomousDeliveryExecute(
      ctx(body()),
      deps(runner, undefined, undefined, {
        autonomousDeliveryStopState: { isStopped: () => true },
      }),
    );

    expect(clientRaisedCeiling.body).toMatchObject({
      status: "denied",
      steps: [{ status: "denied", denialReason: "delivery-policy-denied" }],
    });
    expect(serverStopped.body).toMatchObject({
      status: "denied",
      steps: [{ status: "denied", denialReason: "operator-stopped" }],
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects direct shell and credential-shaped payloads before any Git runner is called", async () => {
    const runner = vi.fn<GitProcessRunner>(() => Promise.resolve(ok("")));
    const directShell = body({
      operations: [
        {
          kind: "repository-operation",
          stepId: "step-1",
          request: {
            schemaVersion: "1",
            operation: "status",
            mode: "read",
            projectId: root,
            payload: { command: "git status", argv: ["git", "status"] },
          },
        },
      ],
    });
    const credential = body({
      confirmation: {
        confirmed: true,
        approvalProofDigest: `ghp_${"a".repeat(20)}`,
        confirmedAt: "2026-07-07T13:00:00.000Z",
      },
    });

    expect(await handleAutonomousDeliveryExecute(ctx(directShell), deps(runner))).toMatchObject({
      status: 400,
      body: { error: { code: "AUTONOMOUS_DELIVERY_BAD_REQUEST" } },
    });
    expect(await handleAutonomousDeliveryExecute(ctx(credential), deps(runner))).toMatchObject({
      status: 400,
      body: { error: { code: "AUTONOMOUS_DELIVERY_FORBIDDEN_PAYLOAD" } },
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("delegates command-task verification and halts when the structured result is red", async () => {
    const passedRequest = body({
      operations: [
        {
          kind: "command-task",
          stepId: "verify-1",
          request: { projectId: root, taskId: "npm-script:test", requestId: "verify-1" },
        },
      ],
    });
    const failedRequest = body({
      operations: [
        {
          kind: "command-task",
          stepId: "verify-1",
          request: { projectId: root, taskId: "npm-script:test", requestId: "verify-1" },
        },
      ],
    });
    const passed = await handleAutonomousDeliveryExecute(
      ctx(passedRequest),
      deps(undefined, commandRunner()),
    );
    const failed = await handleAutonomousDeliveryExecute(
      ctx(failedRequest),
      deps(undefined, commandRunner("non-zero-exit")),
    );

    expect(passed.body).toMatchObject({
      status: "completed",
      steps: [{ operation: "command-task", status: "delegated", outcome: "passed" }],
    });
    expect(failed.body).toMatchObject({
      status: "halted",
      steps: [{ operation: "command-task", status: "delegated", outcome: "failed" }],
    });
  });

  it("delegates bounded connector writes through the injected governed connector executor", async () => {
    const harness = connectorExecutor();
    const request = body({
      authorityEnvelope: envelope({
        connectorScopes: ["source-control.read", "source-control.write", "issue-tracker.write"],
        networkPolicy: {
          mode: "connector-scoped-egress",
          allowLoopback: true,
          connectorScopes: ["source-control.read", "source-control.write", "issue-tracker.write"],
        },
      }),
      operations: [
        {
          kind: "connector-operation",
          stepId: "connector-1",
          request: {
            provider: "github",
            objectKind: "issue",
            action: "comment",
            targetRef: "issue-1993",
            idempotencyKey: "issue-comment-1",
            commentKind: "progress",
            dryRun: true,
          },
        },
      ],
    });

    const result = await handleAutonomousDeliveryExecute(
      ctx(request),
      deps(undefined, undefined, harness.connector),
    );

    expect(result.body).toMatchObject({
      status: "completed",
      steps: [
        {
          operation: "connector-operation",
          status: "delegated",
          routeStatus: 200,
          evidence: { artifactLabel: "issue-tracker" },
        },
      ],
    });
    expect(harness.calls).toEqual([
      {
        provider: "github",
        objectKind: "issue",
        action: "comment",
        targetRef: "issue-1993",
        idempotencyKey: "issue-comment-1",
        commentKind: "progress",
        dryRun: true,
      },
    ]);
    expect(JSON.stringify(result.body)).not.toContain("body");
  });

  it("fails connector writes closed when the connector executor is unavailable", async () => {
    const request = body({
      authorityEnvelope: envelope({
        connectorScopes: ["source-control.read", "source-control.write", "issue-tracker.write"],
        networkPolicy: {
          mode: "connector-scoped-egress",
          allowLoopback: true,
          connectorScopes: ["source-control.read", "source-control.write", "issue-tracker.write"],
        },
      }),
      operations: [
        {
          kind: "connector-operation",
          stepId: "connector-1",
          request: {
            provider: "jira",
            objectKind: "issue",
            action: "status-update",
            targetRef: "issue-1993",
            idempotencyKey: "jira-status-1",
            status: "ready-for-human-review",
          },
        },
      ],
    });

    const result = await handleAutonomousDeliveryExecute(ctx(request), deps());

    expect(result.body).toMatchObject({
      status: "denied",
      steps: [
        {
          operation: "connector-operation",
          status: "denied",
          denialReason: "delivery-policy-denied",
        },
      ],
    });
  });
});
