import type {
  CodingWorkbenchActionClass,
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchConnectorScope,
  CodingWorkbenchMode,
  CodingWorkbenchNetworkPolicy,
} from "@oscharko-dev/keiko-contracts";

import { productionGitDeliveryModeGrants } from "../coding-runtime/productionRuntimeWorkspaceAuthority.js";
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
// (actionClasses, connectorScopes, networkPolicy) — all three are the exact production per-mode
// projection: `productionGitDeliveryModeGrants` (exported by productionRuntimeWorkspaceAuthority.ts
// for exactly this purpose, epic #3384 correction 5 item 2) already includes `network-egress` for
// `autonomous-delivery` (its `researchEgressEnabled: false` default only withholds it for the two
// lower modes, matching `runtimeActionClasses`'s own unconditional `mode === "autonomous-delivery"`
// branch), so nothing needs restating here. `productionGitDeliveryModeGrants` is the producer both
// this fixture and the real minting path call, so the two can never diverge silently — a change to
// the production formula is observed here on the next run, not restated by hand. This exists instead
// of `permittedGitDeliveryAuthority`'s mode-independent full grant below, which is what let the
// ADR-0138 D2 admission gap ship undetected: with a fully-permissive fixture, no test could ever
// observe `hasRequiredScopes` short-circuiting a lower mode before the mode/approval matrix ran.
function productionRuntimeActionClasses(
  mode: CodingWorkbenchMode,
): readonly CodingWorkbenchActionClass[] {
  return productionGitDeliveryModeGrants(mode).actionClasses;
}

function productionRuntimeConnectorScopes(
  mode: CodingWorkbenchMode,
): readonly CodingWorkbenchConnectorScope[] {
  return productionGitDeliveryModeGrants(mode).connectorScopes;
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
