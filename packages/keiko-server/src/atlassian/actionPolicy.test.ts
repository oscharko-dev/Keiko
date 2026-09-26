import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchConnectorScope,
  CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts";
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_SCHEMA_VERSION,
  resolveEffectiveCodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import type { UiHandlerDeps } from "../deps.js";
import {
  editorAgentAuthorityRegistry,
  editorAgentWorkspaceRootDigest,
} from "../editor/agentAuthorityRegistry.js";
import {
  ATLASSIAN_AUTHORITY_FAILURE_REASON,
  decideGovernedAtlassianAction,
  type AtlassianActionAuthorityContext,
} from "./actionPolicy.js";

describe("Atlassian governed action authority mapping", () => {
  it("emits the dedicated authority-revoked reason on mid-flight revocation (KEIKO-0547)", () => {
    // The disposition remains `denied` (fail-closed) in every mode; only the reason CODE gains
    // precision so operators reading the connector activity trail can tell a mid-flight-revoked
    // envelope apart from a malformed/unregistered one. Editor lane has always carried this
    // distinction (agentAuthorityRegistry.ts:143-149); the Atlassian lane now matches.
    expect(ATLASSIAN_AUTHORITY_FAILURE_REASON.revoked).toBe("authority-revoked");
  });
});

// KEIKO-0200: strictestModeDecision is reached only through decideGovernedAtlassianAction and its
// composition mirrors composeEditorAgentActionPolicyDecision's triple-mode reduce (seed =
// requestedMode's decision; iterate over [deploymentCeiling, effectiveMode] keeping the strictest).
// These cases construct an Authority Envelope with all three mode facets set to different
// CodingWorkbenchMode values and pin that the strictest per-facet decision wins in both
// directions — a deploymentCeiling-driven case and an effectiveMode-driven case — so a future
// edit that flips the reduce comparator or reverts to a static requestedMode-only decision fails
// here.
const ROOT = "/repo";
const BOTH_WRITE_SCOPES: readonly CodingWorkbenchConnectorScope[] = [
  "issue-tracker.write",
  "knowledge-base.write",
];

// A valid CodingWorkbenchAuthorityEnvelope must satisfy effectiveMode === min(requestedMode,
// deploymentCeiling) — the validator enforces that fail-closed invariant, so no valid envelope
// can carry three genuinely distinct mode values. The tests below therefore vary requestedMode
// and deploymentCeiling independently and let effectiveMode derive to the fail-closed minimum;
// this still exercises the three-facet reduce (seed = decide(requestedMode); iterate over
// deploymentCeiling then effectiveMode) with facets that produce genuinely different per-facet
// dispositions.
function envelope(
  requestedMode: CodingWorkbenchMode,
  deploymentCeiling: CodingWorkbenchMode,
  connectorScopes: readonly CodingWorkbenchConnectorScope[],
): CodingWorkbenchAuthorityEnvelope {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    runId: "run-0200",
    localUser: "local-operator",
    taskRefs: ["issue-0200"],
    workspace: {
      workspaceId: "workspace-1",
      rootLabel: "workspace",
      rootDigest: editorAgentWorkspaceRootDigest(ROOT),
    },
    branch: {
      baseRef: "dev",
      headRef: "local-workspace",
      allowDetachedHead: false,
      allowedPrefixes: ["local-"],
    },
    requestedMode,
    deploymentCeiling,
    effectiveMode: resolveEffectiveCodingWorkbenchMode(requestedMode, deploymentCeiling),
    runtimeSource: "keiko-sidecar",
    actionClasses: CODING_WORKBENCH_ACTION_CLASSES,
    connectorScopes,
    modelProfile: {
      profileId: "profile-1",
      source: "keiko-model-gateway",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "governed",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 60_000,
      requirePerCommandApproval: false,
    },
    networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    gates: ["human-approval", "branch-allowlist"],
    budget: {
      maxRuntimeMs: 3_600_000,
      maxToolCalls: 50,
      maxPromptTokens: 10_000,
      maxPatchBytes: 65_536,
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
    approvalProofDigest: "a".repeat(64),
  };
}

function registerEnvelope(
  requestedMode: CodingWorkbenchMode,
  deploymentCeiling: CodingWorkbenchMode,
): AtlassianActionAuthorityContext {
  const value = envelope(requestedMode, deploymentCeiling, BOTH_WRITE_SCOPES);
  const registration = editorAgentAuthorityRegistry.register(
    value,
    deploymentCeiling,
    new Date().toISOString(),
  );
  if (!registration.ok)
    throw new Error(`test envelope registration failed: ${registration.reason}`);
  return { ...registration.authorityRef, workspaceRoot: ROOT };
}

function depsFor(ceiling: CodingWorkbenchMode): UiHandlerDeps {
  return { autonomousDeliveryDeploymentCeiling: ceiling } as UiHandlerDeps;
}

describe("strictestModeDecision across divergent envelope facets (KEIKO-0200)", () => {
  beforeEach(() => {
    editorAgentAuthorityRegistry.reset();
  });
  afterEach(() => {
    editorAgentAuthorityRegistry.reset();
  });

  // Case A — deploymentCeiling (and thus the derived effectiveMode) is strictly stricter than
  // requestedMode: seed = decide(requestedMode: autonomous-delivery) → allowed; iterate over
  // deploymentCeiling=supervised-coding → review-required (>), effectiveMode=supervised-coding →
  // review-required (=). Result must be review-required. A comparator flipped to "<" would keep
  // the seeded allowed decision and this assertion would fail.
  it("promotes to review-required when deploymentCeiling is stricter than requestedMode", () => {
    const authority = registerEnvelope("autonomous-delivery", "supervised-coding");
    const outcome = decideGovernedAtlassianAction(
      "create-issue",
      authority,
      depsFor("supervised-coding"),
    );
    expect(outcome.kind).toBe("review-required");
  });

  // Case B — deploymentCeiling is the OTHER stricter mode (governed-assist), forcing effectiveMode
  // to governed-assist as well; both non-requestedMode facets are stricter than requested. This
  // pins that stricter decisions win regardless of WHICH sub-full-access ceiling is in effect and
  // exercises the reduce's second iteration too, since effectiveMode is a distinct decision
  // instance from deploymentCeiling's even when their dispositions match.
  it("promotes to review-required when deploymentCeiling is governed-assist (bottom rung)", () => {
    const authority = registerEnvelope("autonomous-delivery", "governed-assist");
    const outcome = decideGovernedAtlassianAction(
      "create-issue",
      authority,
      depsFor("governed-assist"),
    );
    expect(outcome.kind).toBe("review-required");
  });

  // Case C — control: requestedMode's stricter decision must NOT be overwritten by looser
  // subsequent facets. seed = decide(requestedMode: governed-assist) → review-required; iterate
  // over deploymentCeiling=autonomous-delivery → allowed (<, stays), effectiveMode=governed-assist
  // (derived from min) → review-required (=, stays). Result: review-required. If the seed had
  // been replaced by a constant "allowed", the accumulator would pick up review from effectiveMode
  // on the last iteration and still return review — but if the comparator were flipped to "<",
  // the seed would be overwritten by the looser deploymentCeiling and this assertion would fail.
  it("keeps requestedMode's stricter decision when deploymentCeiling is looser", () => {
    const authority = registerEnvelope("governed-assist", "autonomous-delivery");
    const outcome = decideGovernedAtlassianAction(
      "create-issue",
      authority,
      depsFor("autonomous-delivery"),
    );
    expect(outcome.kind).toBe("review-required");
  });
});
