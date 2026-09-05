import type {
  CodingWorkbenchActionClass,
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchConnectorScope,
  CodingWorkbenchMode,
  CodingWorkbenchNetworkPolicy,
} from "@oscharko-dev/keiko-contracts";

import type { GitDeliveryRunAuthorityPort } from "./runBoundAuthority.js";

const TEST_AUTHORITY: CodingWorkbenchAuthorityEnvelope = {
  schemaVersion: "1",
  runId: "test-run",
  localUser: "test-operator",
  taskRefs: ["test-task"],
  workspace: { workspaceId: "test-workspace", rootLabel: "test", rootDigest: "a".repeat(64) },
  branch: {
    baseRef: "dev",
    headRef: "feature/test",
    allowDetachedHead: false,
    allowedPrefixes: ["feature/"],
  },
  requestedMode: "autonomous-delivery",
  deploymentCeiling: "autonomous-delivery",
  effectiveMode: "autonomous-delivery",
  runtimeSource: "delivery-runner",
  actionClasses: ["workspace-write", "delivery-substrate", "network-egress"],
  connectorScopes: ["source-control.read", "source-control.write"],
  modelProfile: {
    profileId: "test",
    source: "keiko-model-gateway",
    supportsStreaming: false,
    supportsToolCalling: false,
  },
  commandPolicy: {
    mode: "deny",
    allow: [],
    deny: [],
    maxCommandTimeoutMs: 1,
    requirePerCommandApproval: true,
  },
  networkPolicy: {
    mode: "connector-scoped-egress",
    allowLoopback: false,
    connectorScopes: ["source-control.read", "source-control.write"],
  },
  gates: [],
  budget: { maxRuntimeMs: 1_000, maxToolCalls: 1, maxPromptTokens: 1, maxPatchBytes: 1 },
  expiresAt: "2999-01-01T00:00:00.000Z",
  approvalProofDigest: "b".repeat(64),
};

// Production-realistic per-mode grant, restricted to the three facts `authorizeGitDelivery` reads
// (actionClasses, connectorScopes, networkPolicy). The actual producer is
// productionRuntimeWorkspaceAuthority.ts's `runtimeActionClasses` / `DELIVERY_CONNECTOR_SCOPES` /
// `runtimeNetworkPolicy` (~lines 63-100), but that module lives under `coding-runtime/**` — out of
// this item's write scope — and exports only `DELIVERY_CONNECTOR_SCOPES`; the other two are private,
// so they cannot be imported here. This restates their exact, verified per-mode shape (holding
// `researchEgressEnabled` at its production default of `false`, the case that matters for Git
// delivery) instead of `permittedGitDeliveryAuthority`'s mode-independent full grant below, which is
// what let the ADR-0138 D2 admission gap ship undetected: with a fully-permissive fixture, no test
// could ever observe `hasRequiredScopes` short-circuiting a lower mode before the mode/approval
// matrix ran. `productionRuntimeWorkspaceAuthority.test.ts` pins the producer's own values directly,
// so a future divergence between that producer and this restatement is caught there first, not here.
function productionRuntimeActionClasses(
  mode: CodingWorkbenchMode,
): readonly CodingWorkbenchActionClass[] {
  const actionClasses: CodingWorkbenchActionClass[] = [
    "workspace-read",
    "workspace-write",
    "verification",
  ];
  if (mode !== "governed-assist") actionClasses.push("command-execution");
  if (mode === "autonomous-delivery") {
    actionClasses.push("delivery-substrate", "connector-access", "network-egress");
  }
  return actionClasses;
}

function productionRuntimeConnectorScopes(
  mode: CodingWorkbenchMode,
): readonly CodingWorkbenchConnectorScope[] {
  return mode === "autonomous-delivery" ? ["source-control.read", "source-control.write"] : [];
}

function productionRuntimeNetworkPolicy(mode: CodingWorkbenchMode): CodingWorkbenchNetworkPolicy {
  return mode === "autonomous-delivery"
    ? {
        mode: "connector-scoped-egress",
        allowLoopback: false,
        connectorScopes: ["source-control.read", "source-control.write"],
      }
    : { mode: "deny-all", allowLoopback: false, connectorScopes: [] };
}

// Same shape as `permittedGitDeliveryAuthority` below, but scoped/network-policed exactly as
// production mints a run for `effectiveMode` — i.e. it withholds `source-control.write`,
// `delivery-substrate` and network egress below `autonomous-delivery`, precisely the fixture the
// blocking finding on #3386's repair asked for: a lower-mode envelope that cannot satisfy
// `hasRequiredScopes` for a "delivery" operation at all, so redemption is exercised against the real
// gap rather than a fixture that grants what production never does.
export function productionScopedGitDeliveryAuthority(
  projectId: () => string,
  workspaceRoot: () => string = projectId,
  effectiveMode: CodingWorkbenchMode = "autonomous-delivery",
  branch: CodingWorkbenchAuthorityEnvelope["branch"] = TEST_AUTHORITY.branch,
): GitDeliveryRunAuthorityPort {
  return {
    current: () => ({
      runId: "test-run",
      envelopeDigest: "c".repeat(64),
      projectId: projectId(),
      workspaceRoot: workspaceRoot(),
      branch,
      authority: {
        ...TEST_AUTHORITY,
        branch,
        requestedMode: effectiveMode,
        deploymentCeiling: effectiveMode,
        effectiveMode,
        actionClasses: productionRuntimeActionClasses(effectiveMode),
        connectorScopes: productionRuntimeConnectorScopes(effectiveMode),
        networkPolicy: productionRuntimeNetworkPolicy(effectiveMode),
      },
    }),
  };
}

export function permittedGitDeliveryAuthority(
  projectId: () => string,
  workspaceRoot: () => string = projectId,
  effectiveMode: CodingWorkbenchMode = "autonomous-delivery",
  branch: CodingWorkbenchAuthorityEnvelope["branch"] = TEST_AUTHORITY.branch,
): GitDeliveryRunAuthorityPort {
  return {
    current: () => ({
      runId: "test-run",
      envelopeDigest: "c".repeat(64),
      projectId: projectId(),
      workspaceRoot: workspaceRoot(),
      branch,
      authority: {
        ...TEST_AUTHORITY,
        branch,
        requestedMode: effectiveMode,
        deploymentCeiling: effectiveMode,
        effectiveMode,
      },
    }),
  };
}
