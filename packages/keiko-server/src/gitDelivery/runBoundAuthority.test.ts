import type {
  ActiveGitDeliveryDescriptionAuthority,
  ActiveGitDeliveryRunAuthority,
  GitDeliveryAuthorityDenial,
  GitDeliveryAuthorityRequest,
  GitDeliveryDescriptionAuthorityPort,
  GitDeliveryDescriptionAuthorityScope,
  GitDeliveryRunAuthorityPort,
} from "./runBoundAuthority.js";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { ServerLogEvent } from "../observability/index.js";
import { describe, expect, it } from "vitest";
import { CORRELATION_RESPONSE_HEADER, UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { gitDeliveryAuthorityDenial, gitDeliveryAuthorityGate } from "./requestPreparation.js";
import { authorizeGitDelivery, authorizeGitDeliveryModelEgress } from "./runBoundAuthority.js";
import {
  permittedGitDeliveryAuthority,
  productionScopedGitDeliveryAuthority,
} from "./runBoundAuthority.test-support.js";
import {
  createInMemoryGitDeliveryApprovalStore,
  GIT_DELIVERY_LOCAL_OPERATOR_ID,
} from "./approvalStore.js";

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
  // ADR-0138 D2 (epic #3384 correction 5 / #3386 contract correction 1): a delivery effect is
  // approval-required in every mode, never mode-denied merely because the mode is governed-assist.
  // Relocated from "mode-denied" — this pin still enforces that governed-assist cannot commit,
  // push, fetch, pull, propose, or merge without an approval; only the closed reason changed to
  // one that is actually redeemable (see "redeems an approval-required disposition" below).
  [
    authorityPort((active) => ({
      ...active,
      authority: { ...active.authority, effectiveMode: "governed-assist" },
    })),
    REQUEST,
    "approval-required",
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

  // ADR-0138 D2 (epic #3384 correction 5 / #3386 contract correction 1): relocated from
  // "mode-denied" to "approval-required" — supervised-coding still refuses to reach a remote
  // without an approval; only the closed reason changed to one a caller can actually redeem via a
  // one-use claim (see "redeems an approval-required disposition" below). #3387 owns the push/PR
  // mint routes that make redemption reachable in production; until then this reason is a fail-
  // closed refusal, never a silent allow.
  it.each(["fetch", "pull", "push", "pull-request", "merge"] as const)(
    "requires approval for %s below autonomous-delivery, because it reaches a remote",
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
      ).toEqual({ allowed: false, reason: "approval-required" });
    },
  );

  // Reviewer repair (#3386 blocking finding): `permittedGitDeliveryAuthority` above grants full
  // connector scopes and actionClasses regardless of `effectiveMode`, which never happens in
  // production (`productionRuntimeWorkspaceAuthority.ts` mints `source-control.write` /
  // `delivery-substrate` / a connector-scoped network policy only for `autonomous-delivery`). That
  // made the "requires approval for %s below autonomous-delivery" case above pass even before the
  // scope-deferral fix in `runBoundAuthority.ts`, because `hasRequiredScopes` never actually ran
  // into the missing scope. These cases drive `productionScopedGitDeliveryAuthority`, which
  // withholds exactly what production withholds below `autonomous-delivery`, and would have failed
  // with "permission-scope-missing" (never reaching the matrix or the redemption hook) before this
  // repair.
  it.each(["commit", "fetch", "pull", "push", "pull-request", "merge"] as const)(
    "requires approval for %s at supervised-coding under a production-scoped envelope with no delivery grant",
    (operation) => {
      expect(
        authorizeGitDelivery(
          productionScopedGitDeliveryAuthority(
            () => PROJECT_ID,
            () => WORKSPACE_ROOT,
            "supervised-coding",
          ),
          { ...REQUEST, operation },
          NOW,
        ),
      ).toEqual({ allowed: false, reason: "approval-required" });
    },
  );

  it("redeems a supervised-coding push's approval-required disposition against a production-scoped envelope that never grants source-control.write or network egress", () => {
    const decision = authorizeGitDelivery(
      productionScopedGitDeliveryAuthority(
        () => PROJECT_ID,
        () => WORKSPACE_ROOT,
        "supervised-coding",
      ),
      { ...REQUEST, operation: "push" },
      NOW,
      () => true,
    );
    expect(decision).toEqual({
      allowed: true,
      runId: "test-run",
      envelopeDigest: "c".repeat(64),
    });
  });

  // `autonomous-delivery` keeps the scope/network gate as a genuine, stricter-wins check: even
  // under the production-realistic fixture (which grants full delivery scope only at this mode),
  // an explicitly under-scoped envelope is still refused before the matrix, never waved through.
  it("still refuses commit at autonomous-delivery when a production-scoped envelope is explicitly stripped of source-control.write", () => {
    const port = productionScopedGitDeliveryAuthority(
      () => PROJECT_ID,
      () => WORKSPACE_ROOT,
      "autonomous-delivery",
    );
    const stripped: GitDeliveryRunAuthorityPort = {
      current: (nowIso) => {
        const active = port.current(nowIso);
        if (active === undefined) throw new Error("test authority was not available");
        return { ...active, authority: { ...active.authority, connectorScopes: [] } };
      },
    };
    expect(
      authorizeGitDelivery(stripped, { ...REQUEST, operation: "commit" }, NOW, () => true),
    ).toEqual({ allowed: false, reason: "permission-scope-missing" });
  });

  it("redeems an approval-required disposition via a caller-supplied claim, admitting the run", () => {
    const decision = authorizeGitDelivery(
      permittedGitDeliveryAuthority(
        () => PROJECT_ID,
        () => WORKSPACE_ROOT,
        "supervised-coding",
      ),
      { ...REQUEST, operation: "push" },
      NOW,
      () => true,
    );
    expect(decision).toEqual({
      allowed: true,
      runId: "test-run",
      envelopeDigest: "c".repeat(64),
    });
  });

  it("does not redeem an approval-required disposition when the caller's claim is rejected", () => {
    const decision = authorizeGitDelivery(
      permittedGitDeliveryAuthority(
        () => PROJECT_ID,
        () => WORKSPACE_ROOT,
        "supervised-coding",
      ),
      { ...REQUEST, operation: "push" },
      NOW,
      () => false,
    );
    expect(decision).toEqual({ allowed: false, reason: "approval-required" });
  });

  it("never asks the caller to redeem a hard denial (permission-scope-missing)", () => {
    let calls = 0;
    const decision = authorizeGitDelivery(
      authorityPort((active) => ({
        ...active,
        authority: { ...active.authority, connectorScopes: ["source-control.read"] },
      })),
      REQUEST,
      NOW,
      () => {
        calls += 1;
        return true;
      },
    );
    expect(decision).toEqual({ allowed: false, reason: "permission-scope-missing" });
    expect(calls).toBe(0);
  });
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

  // Final-audit F2/#3390 (ADR-0138 D2 / #3386 contract correction 1): proves the redemption
  // end-to-end through the composed gate `gitDeliveryAuthorityGate` actually mounts, not only the
  // raw predicate `authorizeGitDelivery` accepts. Before this fix, a supervised-coding push was
  // hard-denied as "approval-required" with no way to ever redeem it — the coarse admission layer
  // had no production caller that threaded a claim through this seam. Push's OWN execute path
  // already enforces a mandatory, mode-independent consumed approval regardless of mode
  // (pushRoutes.ts's `runPushMutation`), so the route defers this coarse disposition to it instead
  // of demanding a second, redundant claim here.
  it("admits a supervised-coding push once its approval-required disposition is deferred to the operation's own mandatory downstream approval", () => {
    const workspace = { root: WORKSPACE_ROOT } as WorkspaceInfo;
    const deps = {
      gitDeliveryAuthority: permittedGitDeliveryAuthority(
        () => PROJECT_ID,
        () => WORKSPACE_ROOT,
        "supervised-coding",
      ),
    };

    const result = gitDeliveryAuthorityGate(
      { correlationId: "correlation-3" } as never,
      deps,
      PROJECT_ID,
      workspace,
      "push",
      { headBranchName: "feature/test", remoteBranchName: "feature/test" },
      { nowIso: NOW, deliveryApprovalDeferred: true },
    );

    expect(result).toEqual({ allowed: true, runId: "test-run", envelopeDigest: "c".repeat(64) });
  });

  // Final-audit F1/#3390: the workspace-contained counterpart. Local mutations have no
  // operation-independent mandatory downstream enforcement (the repo/org policy pack decides
  // per-command), so `deliveryApprovalDeferred` must never apply here — redemption requires an
  // actual matching claim, peeked (never consumed) against the SAME "local-mutation" binding
  // `localMutationRoutes.ts` already mints/parses from its own request body.
  it("admits a governed-assist local mutation once its approval-required disposition is redeemed by a matching local-mutation claim", () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const workspace = { root: WORKSPACE_ROOT } as WorkspaceInfo;
    const deps = {
      gitDeliveryAuthority: permittedGitDeliveryAuthority(
        () => PROJECT_ID,
        () => WORKSPACE_ROOT,
        "governed-assist",
      ),
    };
    // NOT run-bound: matches the EXACT binding shape localMutationRoutes.ts's own
    // `resolveGitDeliveryApprovalRequirement` call uses for "local-mutation" (project + operation +
    // command only) — the peek in `gitDeliveryApprovalRedemption` must hash the same shape.
    const command = { kind: "stage", pathspecs: ["a.txt"], includeUntracked: false };
    const issued = approvalStore.issue({
      binding: { projectId: PROJECT_ID, operation: "local-mutation", command },
      approvedByUserId: GIT_DELIVERY_LOCAL_OPERATOR_ID,
      nowMs: Date.parse(NOW),
    });

    const result = gitDeliveryAuthorityGate(
      { correlationId: "correlation-5" } as never,
      deps,
      PROJECT_ID,
      workspace,
      "stage",
      {},
      {
        nowIso: NOW,
        approval: { kind: "claim", claim: issued.approval },
        approvalStore,
        approvalBinding: { operation: "local-mutation", command },
      },
    );

    expect(result).toEqual({ allowed: true, runId: "test-run", envelopeDigest: "c".repeat(64) });
    // The peek never consumed the claim: it still matches for the route's own subsequent, single
    // real consumption (the invariant this mechanism exists to preserve).
    expect(
      approvalStore.matches({
        approval: issued.approval,
        binding: { projectId: PROJECT_ID, operation: "local-mutation", command },
        nowMs: Date.parse(NOW),
      }),
    ).toBe(true);
  });

  it("still refuses a supervised-coding push when no claim is offered to redeem it, and logs the approval-required reason", () => {
    const workspace = { root: WORKSPACE_ROOT } as WorkspaceInfo;
    const deps = {
      gitDeliveryAuthority: permittedGitDeliveryAuthority(
        () => PROJECT_ID,
        () => WORKSPACE_ROOT,
        "supervised-coding",
      ),
    };
    const events: ServerLogEvent[] = [];

    const result = gitDeliveryAuthorityGate(
      { correlationId: "correlation-4" } as never,
      deps,
      PROJECT_ID,
      workspace,
      "push",
      { headBranchName: "feature/test", remoteBranchName: "feature/test" },
      { nowIso: NOW, logSink: { write: (event) => events.push(event) } },
    );

    expect(result.allowed).toBe(false);
    expect(result.allowed ? undefined : result.reason).toBe("approval-required");
    expect(events).toEqual([
      expect.objectContaining({
        op: "git.delivery.authority.denied",
        correlationId: "correlation-4",
        status: 403,
        extra: { operation: "push", phase: "admission", reason: "approval-required" },
      }),
    ]);
  });
});

// #3399 (epic #3384 correction 4): the description authority admits exactly two effects outside a
// running Code task — model egress and the "pull-request" body-only apply. It never widens what a
// running run already decides, and every other operation keeps requiring one.
describe("authorizeGitDelivery — description authority (#3399)", () => {
  const SCOPE: GitDeliveryDescriptionAuthorityScope = {
    remoteDigest: "d".repeat(64),
    pr: { ownerAndRepo: "oscharko-dev/Keiko", prNumber: 3399 },
    snapshotDigest: "e".repeat(64),
  };

  function descriptionPort(
    active: ActiveGitDeliveryDescriptionAuthority | undefined,
  ): GitDeliveryDescriptionAuthorityPort {
    return { current: () => active };
  }

  it("admits the pull-request apply from the description authority when no run is active", () => {
    const decision = authorizeGitDelivery(
      undefined,
      { ...REQUEST, operation: "pull-request" },
      NOW,
      undefined,
      {
        port: descriptionPort({ scope: SCOPE, effectiveMode: "supervised-coding", expiresAt: NOW }),
        scope: SCOPE,
      },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.allowed && decision.runId).toBe("description-authority");
    expect(decision.allowed && /^[0-9a-f]{64}$/u.test(decision.envelopeDigest)).toBe(true);
  });

  it("falls back to accepted-run-unavailable when the description authority has no live record", () => {
    const decision = authorizeGitDelivery(
      undefined,
      { ...REQUEST, operation: "pull-request" },
      NOW,
      undefined,
      { port: descriptionPort(undefined), scope: SCOPE },
    );
    expect(decision).toEqual({ allowed: false, reason: "accepted-run-unavailable" });
  });

  it("never admits any operation other than pull-request through the description authority", () => {
    const decision = authorizeGitDelivery(
      undefined,
      { ...REQUEST, operation: "push" },
      NOW,
      undefined,
      {
        port: descriptionPort({
          scope: SCOPE,
          effectiveMode: "autonomous-delivery",
          expiresAt: NOW,
        }),
        scope: SCOPE,
      },
    );
    expect(decision).toEqual({ allowed: false, reason: "accepted-run-unavailable" });
  });

  it("prefers a running accepted run over the description authority when both are present", () => {
    const decision = authorizeGitDelivery(
      permittedGitDeliveryAuthority(
        () => PROJECT_ID,
        () => WORKSPACE_ROOT,
      ),
      { ...REQUEST, operation: "pull-request" },
      NOW,
      undefined,
      {
        port: descriptionPort({ scope: SCOPE, effectiveMode: "governed-assist", expiresAt: NOW }),
        scope: SCOPE,
      },
    );
    // The real run's own runId ("test-run"), never the description authority's fixed identity.
    expect(decision).toEqual({ allowed: true, runId: "test-run", envelopeDigest: "c".repeat(64) });
  });

  it("mints a byte-identical envelopeDigest for the identical scope, so a stale-scope claim never matches", () => {
    const first = authorizeGitDelivery(
      undefined,
      { ...REQUEST, operation: "pull-request" },
      NOW,
      undefined,
      {
        port: descriptionPort({
          scope: SCOPE,
          effectiveMode: "autonomous-delivery",
          expiresAt: NOW,
        }),
        scope: SCOPE,
      },
    );
    const second = authorizeGitDelivery(
      undefined,
      { ...REQUEST, operation: "pull-request" },
      NOW,
      undefined,
      {
        port: descriptionPort({
          scope: SCOPE,
          effectiveMode: "autonomous-delivery",
          expiresAt: NOW,
        }),
        scope: { ...SCOPE, snapshotDigest: "f".repeat(64) },
      },
    );
    expect(first.allowed && second.allowed && first.envelopeDigest !== second.envelopeDigest).toBe(
      true,
    );
  });
});

describe("authorizeGitDeliveryModelEgress (#3399)", () => {
  const SCOPE: GitDeliveryDescriptionAuthorityScope = {
    remoteDigest: "d".repeat(64),
    pr: { baseRef: "dev", headRef: "feat/x" },
    snapshotDigest: "e".repeat(64),
  };

  it("admits when the description authority holds a live record for the exact scope", () => {
    const port: GitDeliveryDescriptionAuthorityPort = {
      current: () => ({ scope: SCOPE, effectiveMode: "supervised-coding", expiresAt: NOW }),
    };
    expect(authorizeGitDeliveryModelEgress(port, SCOPE, NOW)).toEqual({
      allowed: true,
      effectiveMode: "supervised-coding",
    });
  });

  it("denies authority-absent when no live record matches and the port cannot tell why", () => {
    const port: GitDeliveryDescriptionAuthorityPort = { current: () => undefined };
    expect(authorizeGitDeliveryModelEgress(port, SCOPE, NOW)).toEqual({
      allowed: false,
      reason: "authority-absent",
    });
  });

  // #3400/#3401 final-audit F1: before this discriminant existed, an expired record and no record
  // at all were indistinguishable from this function's own return value (both collapsed to
  // `undefined`). This is the failing-before case: a port whose `current` reports no live record
  // (correctly, since the record IS expired) but whose new `expired` reports it was minted for
  // this exact scope must surface `authority-expired`, never the generic absent reason.
  it("denies authority-expired when the port reports a past record for the exact scope", () => {
    const port: GitDeliveryDescriptionAuthorityPort = {
      current: () => undefined,
      expired: (scope) => scope.snapshotDigest === SCOPE.snapshotDigest,
    };
    expect(authorizeGitDeliveryModelEgress(port, SCOPE, NOW)).toEqual({
      allowed: false,
      reason: "authority-expired",
    });
  });
});
