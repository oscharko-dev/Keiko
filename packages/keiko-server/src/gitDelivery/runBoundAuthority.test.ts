import type {
  ActiveGitDeliveryRunAuthority,
  GitDeliveryAuthorityDenial,
  GitDeliveryAuthorityRequest,
  GitDeliveryRunAuthorityPort,
} from "./runBoundAuthority.js";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { ServerLogEvent } from "../observability/index.js";
import { describe, expect, it } from "vitest";
import { CORRELATION_RESPONSE_HEADER, UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { gitDeliveryAuthorityDenial, gitDeliveryAuthorityGate } from "./requestPreparation.js";
import { authorizeGitDelivery } from "./runBoundAuthority.js";
import { permittedGitDeliveryAuthority } from "./runBoundAuthority.test-support.js";

const NOW = "2026-08-28T12:00:00.000Z";
const PROJECT_ID = "project-1";
const WORKSPACE_ROOT = "/workspace/project-1";

const REQUEST = {
  projectId: PROJECT_ID,
  workspaceRoot: WORKSPACE_ROOT,
  operation: "push",
  headBranchName: "feature/test",
  baseBranchName: "dev",
  remoteBranchName: "feature/test",
} as const;

function authorityPort(
  adjust: (active: ActiveGitDeliveryRunAuthority) => ActiveGitDeliveryRunAuthority,
): GitDeliveryRunAuthorityPort {
  const initial = permittedGitDeliveryAuthority(
    () => PROJECT_ID,
    () => WORKSPACE_ROOT,
  ).current(NOW);
  if (initial === undefined) throw new Error("test authority was not available");
  return { current: () => adjust(initial) };
}

type AuthorityDenialCase = readonly [
  GitDeliveryRunAuthorityPort | undefined,
  GitDeliveryAuthorityRequest,
  GitDeliveryAuthorityDenial,
];

const AUTHORITY_DENIAL_CASES: readonly AuthorityDenialCase[] = [
  [undefined, REQUEST, "accepted-run-unavailable"],
  [
    authorityPort((active) => ({
      ...active,
      authority: { ...active.authority, expiresAt: NOW },
    })),
    REQUEST,
    "authority-expired",
  ],
  [
    authorityPort((active) => ({ ...active, projectId: "another-project" })),
    REQUEST,
    "workspace-out-of-envelope",
  ],
  [
    authorityPort((active) => ({
      ...active,
      authority: { ...active.authority, effectiveMode: "governed-assist" },
    })),
    REQUEST,
    "mode-denied",
  ],
  [
    authorityPort((active) => ({
      ...active,
      authority: { ...active.authority, connectorScopes: ["source-control.read"] },
    })),
    REQUEST,
    "permission-scope-missing",
  ],
  [
    permittedGitDeliveryAuthority(
      () => PROJECT_ID,
      () => WORKSPACE_ROOT,
    ),
    { ...REQUEST, headBranchName: "other/branch" },
    "branch-out-of-envelope",
  ],
  [
    permittedGitDeliveryAuthority(
      () => PROJECT_ID,
      () => WORKSPACE_ROOT,
    ),
    { ...REQUEST, remoteBranchName: "dev" },
    "branch-out-of-envelope",
  ],
  // #2958 (KEIKO-0115): relocated from codingAutonomyQaMatrix.test.ts, which asserted these four
  // boundaries against the deleted `decideAutonomousDeliveryOperation`. `authorizeGitDelivery` is
  // the layer that now owns them on the mounted routes, so the pins move here rather than lapse.
  // A missing action class denies even when every connector scope is present.
  [
    authorityPort((active) => ({
      ...active,
      authority: {
        ...active.authority,
        actionClasses: ["workspace-write", "network-egress"],
      },
    })),
    REQUEST,
    "permission-scope-missing",
  ],
  // Network drift: the envelope grants the scope but its network policy does not carry it, so a
  // network-bound operation cannot borrow the non-network grant.
  [
    authorityPort((active) => ({
      ...active,
      authority: {
        ...active.authority,
        networkPolicy: {
          mode: "connector-scoped-egress",
          allowLoopback: true,
          connectorScopes: ["source-control.read"],
        },
      },
    })),
    REQUEST,
    "permission-scope-missing",
  ],
  // A deny-all network policy denies every network-bound operation outright. The scopes are left
  // in place deliberately: with an empty scope list the later per-scope check would deny anyway and
  // this case would pass with the mode guard removed, pinning nothing.
  [
    authorityPort((active) => ({
      ...active,
      authority: {
        ...active.authority,
        networkPolicy: {
          mode: "deny-all",
          allowLoopback: false,
          connectorScopes: ["source-control.read", "source-control.write"],
        },
      },
    })),
    REQUEST,
    "permission-scope-missing",
  ],
  // A base ref outside the envelope is refused, not only a head or remote ref.
  [
    permittedGitDeliveryAuthority(
      () => PROJECT_ID,
      () => WORKSPACE_ROOT,
    ),
    { ...REQUEST, baseBranchName: "main" },
    "branch-out-of-envelope",
  ],
  // A head ref that matches the accepted run but escapes the envelope's allowed prefixes is
  // refused: the prefix list is checked against the run's own head, not only against the request.
  [
    authorityPort((active) => ({
      ...active,
      branch: { ...active.branch, allowedPrefixes: ["release/"] },
      authority: {
        ...active.authority,
        branch: { ...active.authority.branch, allowedPrefixes: ["release/"] },
      },
    })),
    REQUEST,
    "branch-out-of-envelope",
  ],
];

describe("authorizeGitDelivery per operation", () => {
  // Every case above drives `operation: "push"`, and the shared fixture grants every class and scope
  // regardless of mode, so the per-operation requirement table was never exercised through this
  // admission at all. These cases bind each operation class to the authority it actually demands, so
  // weakening a row in `gitOperationRequirements.ts` is refused here and not only in that table's own
  // test.
  const WITHOUT = (
    actionClasses: readonly string[],
    connectorScopes: readonly string[],
  ): GitDeliveryRunAuthorityPort =>
    authorityPort((active) => ({
      ...active,
      authority: {
        ...active.authority,
        actionClasses: actionClasses as never,
        connectorScopes: connectorScopes as never,
      },
    }));

  it.each([
    ["commit", ["workspace-write"], ["source-control.write"]],
    ["commit", ["delivery-substrate"], ["source-control.read"]],
    ["stage", ["workspace-read"], ["source-control.write"]],
    ["stage", ["workspace-write"], ["source-control.read"]],
    ["branch-create", ["workspace-read"], ["source-control.write"]],
    ["status", ["delivery-substrate"], ["source-control.write"]],
  ] as const)(
    "denies %s when the envelope lacks the classes or scopes it requires",
    (operation, actionClasses, connectorScopes) => {
      expect(
        authorizeGitDelivery(
          WITHOUT(actionClasses, connectorScopes),
          { ...REQUEST, operation },
          NOW,
        ),
      ).toEqual({ allowed: false, reason: "permission-scope-missing" });
    },
  );

  it.each(["commit", "stage", "unstage", "branch-create", "branch-switch"] as const)(
    "admits %s without network authority, because it reaches no remote",
    (operation) => {
      expect(
        authorizeGitDelivery(
          authorityPort((active) => ({
            ...active,
            authority: {
              ...active.authority,
              actionClasses: ["workspace-write", "delivery-substrate"],
              networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
            },
          })),
          { ...REQUEST, operation },
          NOW,
        ),
      ).toMatchObject({ allowed: true });
    },
  );

  it.each(["fetch", "pull", "push", "pull-request", "merge"] as const)(
    "denies %s under a deny-all network policy, because it reaches a remote",
    (operation) => {
      expect(
        authorizeGitDelivery(
          authorityPort((active) => ({
            ...active,
            authority: {
              ...active.authority,
              networkPolicy: {
                mode: "deny-all",
                allowLoopback: false,
                connectorScopes: ["source-control.read", "source-control.write"],
              },
            },
          })),
          { ...REQUEST, operation },
          NOW,
        ),
      ).toEqual({ allowed: false, reason: "permission-scope-missing" });
    },
  );

  it.each(["fetch", "pull", "push", "pull-request", "merge"] as const)(
    "denies %s below autonomous-delivery, because it reaches a remote",
    (operation) => {
      expect(
        authorizeGitDelivery(
          permittedGitDeliveryAuthority(
            () => PROJECT_ID,
            () => WORKSPACE_ROOT,
            "supervised-coding",
          ),
          { ...REQUEST, operation },
          NOW,
        ),
      ).toEqual({ allowed: false, reason: "mode-denied" });
    },
  );
});

describe("authorizeGitDelivery", () => {
  it("allows a matching accepted autonomous delivery run", () => {
    expect(
      authorizeGitDelivery(
        permittedGitDeliveryAuthority(
          () => PROJECT_ID,
          () => WORKSPACE_ROOT,
        ),
        REQUEST,
        NOW,
      ),
    ).toMatchObject({
      allowed: true,
      runId: "test-run",
    });
  });

  it.each(AUTHORITY_DENIAL_CASES)("denies %s with %s", (port, request, reason) => {
    expect(authorizeGitDelivery(port, request, NOW)).toEqual({ allowed: false, reason });
  });

  it("writes a body-free authority audit event through the injected activity-log seam", () => {
    const events: ServerLogEvent[] = [];
    const workspace = { root: WORKSPACE_ROOT } as WorkspaceInfo;
    const result = gitDeliveryAuthorityDenial(
      { correlationId: "correlation-1" } as never,
      {
        gitDeliveryAuthority: permittedGitDeliveryAuthority(
          () => PROJECT_ID,
          () => WORKSPACE_ROOT,
        ),
      },
      PROJECT_ID,
      workspace,
      "push",
      { headBranchName: "feature/test", baseBranchName: "dev" },
      {
        nowIso: NOW,
        logSink: { write: (event) => events.push(event) },
      },
    );

    expect(result).toBeUndefined();
    expect(events).toEqual([
      expect.objectContaining({
        category: "security",
        op: "git.delivery.authority.admitted",
        correlationId: "correlation-1",
        status: 200,
        extra: { operation: "push", phase: "admission", runId: "test-run" },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(WORKSPACE_ROOT);
  });

  it("writes the denial reason and falls back to the unknown correlation id", () => {
    const events: ServerLogEvent[] = [];
    const workspace = { root: WORKSPACE_ROOT } as WorkspaceInfo;
    const result = gitDeliveryAuthorityDenial(
      {} as never,
      { gitDeliveryAuthority: undefined },
      PROJECT_ID,
      workspace,
      "push",
      { headBranchName: "feature/test", remoteBranchName: "feature/test" },
      { nowIso: NOW, logSink: { write: (event) => events.push(event) } },
    );

    expect(result?.status).toBe(403);
    expect(result?.body).toEqual({
      error: {
        code: "GIT_DELIVERY_AUTHORITY_DENIED",
        message: "The accepted runtime authority does not admit this Git delivery operation.",
        correlationId: UNKNOWN_CORRELATION_ID,
      },
    });
    expect(result?.headers).toEqual({
      [CORRELATION_RESPONSE_HEADER]: UNKNOWN_CORRELATION_ID,
    });
    expect(events).toEqual([
      expect.objectContaining({
        category: "security",
        op: "git.delivery.authority.denied",
        correlationId: UNKNOWN_CORRELATION_ID,
        status: 403,
        extra: {
          operation: "push",
          phase: "admission",
          reason: "accepted-run-unavailable",
        },
      }),
    ]);
  });

  it("denies and logs when a different allowed authority replaces the admitted run", () => {
    const events: ServerLogEvent[] = [];
    const workspace = { root: WORKSPACE_ROOT } as WorkspaceInfo;
    const result = gitDeliveryAuthorityGate(
      { correlationId: "correlation-2" } as never,
      {
        gitDeliveryAuthority: permittedGitDeliveryAuthority(
          () => PROJECT_ID,
          () => WORKSPACE_ROOT,
        ),
      },
      PROJECT_ID,
      workspace,
      "push",
      { headBranchName: "feature/test", remoteBranchName: "feature/test" },
      {
        nowIso: NOW,
        expectedAuthority: { runId: "previous-run", envelopeDigest: "d".repeat(64) },
        logSink: { write: (event) => events.push(event) },
      },
    );

    expect(result.allowed).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({
        op: "git.delivery.authority.denied",
        correlationId: "correlation-2",
        status: 403,
        extra: { operation: "push", phase: "continuity", reason: "authority-changed" },
      }),
    ]);
  });
});
