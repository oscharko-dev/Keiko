import type {
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchMode,
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
