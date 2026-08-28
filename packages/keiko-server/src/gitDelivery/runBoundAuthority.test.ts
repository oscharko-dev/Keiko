import type {
  ActiveGitDeliveryRunAuthority,
  GitDeliveryAuthorityDenial,
  GitDeliveryAuthorityRequest,
  GitDeliveryRunAuthorityPort,
} from "./runBoundAuthority.js";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { ServerLogEvent } from "../observability/index.js";
import { describe, expect, it } from "vitest";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { gitDeliveryAuthorityDenial } from "./requestPreparation.js";
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
];

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
        extra: { operation: "push", runId: "test-run" },
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
    expect(events).toEqual([
      expect.objectContaining({
        category: "security",
        op: "git.delivery.authority.denied",
        correlationId: UNKNOWN_CORRELATION_ID,
        status: 403,
        extra: { operation: "push", reason: "accepted-run-unavailable" },
      }),
    ]);
  });
});
