import { describe, expect, it } from "vitest";
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_CODEX_AUTH_METHODS,
  CODING_WORKBENCH_CODEX_AUTH_STATE_ROOTS,
  CODING_WORKBENCH_CODEX_AUTH_STATUSES,
  CODING_WORKBENCH_CODEX_CREDENTIAL_STORES,
  CODING_WORKBENCH_CODEX_RUNTIME_BINARY_SOURCES,
  CODING_WORKBENCH_MODEL_SOURCES,
  CODING_WORKBENCH_MODES,
  CODING_WORKBENCH_RUNTIME_EVENT_KINDS,
  CODING_WORKBENCH_RUNTIME_SOURCES,
  CODING_WORKBENCH_SCHEMA_VERSION,
  CODING_WORKBENCH_SUPERVISED_ACTION_KINDS,
  decideCodingWorkbenchActionForMode,
  isCodingWorkbenchEvidenceSafeText,
  permissionKindForSupervisedCodingAction,
  redactCodingWorkbenchEvidenceText,
  resolveEffectiveCodingWorkbenchMode,
  selectCodingWorkbenchRuntimeProfile,
  supervisedCodingActionRequiresApproval,
  validateCodingWorkbenchAuthorityEnvelope,
  validateCodingWorkbenchCodexAuthSetupPlan,
  validateCodingWorkbenchCodexAuthSetupRequest,
  validateCodingWorkbenchCodexSubscriptionProfile,
  validateCodingWorkbenchEvidenceRecord,
  validateCodingWorkbenchPermissionRequest,
  validateCodingWorkbenchRuntimeEvent,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchCodexAuthSetupPlan,
  type CodingWorkbenchCodexSubscriptionProfile,
  type CodingWorkbenchEvidenceRecord,
  type CodingWorkbenchPermissionRequest,
  type CodingWorkbenchRuntimeEvent,
} from "./index.js";
import {
  CODING_WORKBENCH_APPROVAL_RISKS,
  CODING_WORKBENCH_MODE_POLICIES,
  CODING_WORKBENCH_POLICY_EFFECTS,
  CODING_WORKBENCH_POLICY_RESOURCE_SCOPES,
  codingWorkbenchPolicyEffectFor,
  strictestCodingWorkbenchPolicyEffect,
} from "./coding-workbench.js";
import { hasDisallowedEvidenceContent } from "./coding-workbench-evidence.js";

function baseAuthorityEnvelope(): CodingWorkbenchAuthorityEnvelope {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    runId: "run-1986",
    localUser: "local-operator",
    taskRefs: ["issue-1986"],
    workspace: {
      workspaceId: "workspace-1",
      rootLabel: "keiko-workspace",
      rootDigest: "a".repeat(64),
    },
    branch: {
      baseRef: "dev",
      headRef: "issue/1986-coding-workbench-contracts",
      allowDetachedHead: false,
      allowedPrefixes: ["issue/", "codex/"],
    },
    requestedMode: "supervised-coding",
    deploymentCeiling: "supervised-coding",
    effectiveMode: "supervised-coding",
    runtimeSource: "keiko-sidecar",
    actionClasses: [
      "workspace-read",
      "workspace-write",
      "command-execution",
      "verification",
      "connector-access",
    ],
    connectorScopes: ["source-control.read", "issue-tracker.read"],
    modelProfile: {
      profileId: "local-codex",
      source: "chatgpt-codex-subscription-profile",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "governed",
      allow: ["npm", "node"],
      deny: ["curl"],
      maxCommandTimeoutMs: 30_000,
      requirePerCommandApproval: true,
    },
    networkPolicy: {
      mode: "deny-all",
      allowLoopback: false,
      connectorScopes: [],
    },
    gates: ["human-approval", "verification-green", "artifact-review"],
    budget: {
      maxRuntimeMs: 120_000,
      maxToolCalls: 12,
      maxPromptTokens: 24_000,
      maxPatchBytes: 32_768,
    },
    expiresAt: "2026-07-08T12:00:00Z",
    approvalProofDigest: "b".repeat(64),
  };
}

function baseRuntimeEvent(): CodingWorkbenchRuntimeEvent {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    eventId: "evt-1",
    runId: "run-1986",
    occurredAt: "2026-07-07T12:00:00Z",
    kind: "runtime-started",
    runtimeSource: "codex-cli-adapter",
    modelSource: "openai-api-key-through-gateway",
    requestedMode: "supervised-coding",
    effectiveMode: "governed-assist",
  };
}

function validPermissionRequest(): CodingWorkbenchPermissionRequest {
  return {
    requestId: "perm-1",
    kind: "workspace-write",
    actionClass: "workspace-write",
    reasonCode: "verification-required",
    expiresAt: "2026-07-07T12:30:00Z",
  };
}

function baseEvidenceRecord(): CodingWorkbenchEvidenceRecord {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    recordId: "ev-1",
    runId: "run-1986",
    occurredAt: "2026-07-07T12:00:00Z",
    kind: "failure",
    effectiveMode: "governed-assist",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    safeSummary: "approval-required",
    digest: "c".repeat(64),
    byteCount: 0,
    denied: true,
  };
}

describe("coding-workbench constants", () => {
  it("pins the schema version and closed vocabularies", () => {
    expect(CODING_WORKBENCH_SCHEMA_VERSION).toBe("1");
    expect(CODING_WORKBENCH_MODES).toEqual([
      "governed-assist",
      "supervised-coding",
      "autonomous-delivery",
    ]);
    expect(CODING_WORKBENCH_RUNTIME_SOURCES).toEqual([
      "keiko-sidecar",
      "codex-cli-adapter",
      "delivery-runner",
    ]);
    expect(CODING_WORKBENCH_MODEL_SOURCES).toEqual([
      "keiko-model-gateway",
      "openai-api-key-through-gateway",
      "chatgpt-codex-subscription-profile",
    ]);
    expect(CODING_WORKBENCH_CODEX_AUTH_METHODS).toEqual([
      "chatgpt-browser-login",
      "chatgpt-device-code",
      "codex-access-token",
    ]);
    expect(CODING_WORKBENCH_CODEX_AUTH_STATUSES).toContain("redistribution-unapproved");
    expect(CODING_WORKBENCH_CODEX_CREDENTIAL_STORES).toEqual(["file", "keyring", "auto"]);
    expect(CODING_WORKBENCH_CODEX_AUTH_STATE_ROOTS).toEqual([
      "keiko-codex-runtime-state",
      "os-credential-store",
    ]);
    expect(CODING_WORKBENCH_CODEX_RUNTIME_BINARY_SOURCES).toEqual(["managed-sidecar-runtime"]);
    expect(CODING_WORKBENCH_RUNTIME_EVENT_KINDS).toContain("permission-requested");
    expect(CODING_WORKBENCH_ACTION_CLASSES).toContain("delivery-substrate");
    expect(CODING_WORKBENCH_SUPERVISED_ACTION_KINDS).toEqual([
      "file-edit",
      "verification-command",
      "commit",
      "push",
      "pull-request",
      "merge",
      "connector-write",
      "external-write",
      "system-mutation",
    ]);
  });
});

describe("coding workbench autonomy policy", () => {
  it("pins the exact display labels and descriptions", () => {
    expect(CODING_WORKBENCH_MODE_POLICIES["governed-assist"].display).toEqual({
      label: "Ask for approval",
      description:
        "Workspace-contained edits, saves, and commands proceed; external-file access and internet use require approval. Delivery remains separately human-approved.",
    });
    expect(CODING_WORKBENCH_MODE_POLICIES["supervised-coding"].display).toEqual({
      label: "Approve for me",
      description:
        "Low- and medium-risk file and internet operations proceed; high- and critical-risk actions require approval. Delivery remains separately human-approved.",
    });
    expect(CODING_WORKBENCH_MODE_POLICIES["autonomous-delivery"].display).toEqual({
      label: "Full access",
      description:
        "File and internet operations within the validated Authority Envelope proceed without per-action approval. Delivery remains separately human-approved.",
    });
  });

  it("pins the closed effect, risk, and resource-scope vocabularies", () => {
    expect(CODING_WORKBENCH_POLICY_EFFECTS).toEqual(["allowed", "approval-required", "denied"]);
    expect(CODING_WORKBENCH_APPROVAL_RISKS).toEqual(["low", "medium", "high", "critical"]);
    expect(CODING_WORKBENCH_POLICY_RESOURCE_SCOPES).toEqual([
      "workspace-contained",
      "external-file",
      "internet",
      "delivery",
    ]);
  });

  it("admits every action class in every mode without treating admission as pre-approval", () => {
    for (const mode of CODING_WORKBENCH_MODES) {
      const policy = CODING_WORKBENCH_MODE_POLICIES[mode];
      expect(policy.allowedActionClasses).toEqual(CODING_WORKBENCH_ACTION_CLASSES);
      expect(policy.allowsWorkspaceWrites).toBe(true);
      expect(policy.allowsCommandExecution).toBe(true);
      expect(policy.allowsDeliverySubstrate).toBe(true);
    }
  });

  it("covers the full mode, resource, and risk matrix", () => {
    const expected = {
      "governed-assist": {
        low: ["allowed", "approval-required", "approval-required", "approval-required"],
        medium: ["allowed", "approval-required", "approval-required", "approval-required"],
        high: ["allowed", "approval-required", "approval-required", "approval-required"],
        critical: ["allowed", "approval-required", "approval-required", "approval-required"],
      },
      "supervised-coding": {
        low: ["allowed", "allowed", "allowed", "approval-required"],
        medium: ["allowed", "allowed", "allowed", "approval-required"],
        high: ["approval-required", "approval-required", "approval-required", "approval-required"],
        critical: [
          "approval-required",
          "approval-required",
          "approval-required",
          "approval-required",
        ],
      },
      "autonomous-delivery": {
        low: ["allowed", "allowed", "allowed", "approval-required"],
        medium: ["allowed", "allowed", "allowed", "approval-required"],
        high: ["allowed", "allowed", "allowed", "approval-required"],
        critical: ["allowed", "allowed", "allowed", "approval-required"],
      },
    } as const;
    for (const mode of CODING_WORKBENCH_MODES) {
      for (const risk of CODING_WORKBENCH_APPROVAL_RISKS) {
        const actual = CODING_WORKBENCH_POLICY_RESOURCE_SCOPES.map((scope) =>
          codingWorkbenchPolicyEffectFor(mode, scope, risk),
        );
        expect(actual).toEqual(expected[mode][risk]);
      }
    }
  });

  it("combines independent policy gates with the stricter effect winning", () => {
    expect(strictestCodingWorkbenchPolicyEffect("allowed", "approval-required")).toBe(
      "approval-required",
    );
    expect(strictestCodingWorkbenchPolicyEffect("approval-required", "denied", "allowed")).toBe(
      "denied",
    );
    expect(strictestCodingWorkbenchPolicyEffect("allowed")).toBe("allowed");
  });
});

function codexSubscriptionProfile(): CodingWorkbenchCodexSubscriptionProfile {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    profileId: "codex-subscription",
    modelSource: "chatgpt-codex-subscription-profile",
    runtimeSource: "codex-cli-adapter",
    status: "connected",
    authMethod: "chatgpt-device-code",
    credentialStore: "keyring",
    stateScope: "os-credential-store",
    stateRoot: "os-credential-store",
    usesGlobalCodexHome: false,
    runtimeBinarySources: ["managed-sidecar-runtime"],
    supportsBrowserLogin: true,
    supportsDeviceCode: true,
    supportsAccessToken: true,
    deploymentPolicyDisabled: false,
    headless: false,
  };
}

function codexSetupPlan(): CodingWorkbenchCodexAuthSetupPlan {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    profileId: "codex-subscription",
    method: "codex-access-token",
    modelSource: "chatgpt-codex-subscription-profile",
    runtimeSource: "codex-cli-adapter",
    credentialStore: "keyring",
    stateScope: "os-credential-store",
    stateRoot: "os-credential-store",
    usesGlobalCodexHome: false,
    commandLabel: "codex-login-with-access-token",
    requiresSecretInput: true,
    credentialTransport: "stdin",
  };
}

describe("coding workbench Codex subscription profile", () => {
  it("validates a content-free profile without token, account, cache, or path fields", () => {
    const profile = codexSubscriptionProfile();

    expect(validateCodingWorkbenchCodexSubscriptionProfile(profile)).toEqual({
      ok: true,
      value: profile,
    });
    expect(JSON.stringify(profile)).not.toMatch(/token|refresh|auth\\.json|account|\\.codex/u);
  });

  it("rejects raw credentials, private account labels, and global auth cache paths", () => {
    const parsed = validateCodingWorkbenchCodexSubscriptionProfile({
      ...codexSubscriptionProfile(),
      profileId: "sk-1234567890",
      accountEmail: "user@example.com",
      authCachePath: "/Users/alice/.codex/auth.json",
      accessToken: "Bearer secret-token",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain("profile.profileId must be content-free evidence-safe text");
      expect(parsed.errors).toContain("profile.accountEmail is not allowed");
      expect(parsed.errors).toContain("profile.authCachePath is not allowed");
      expect(parsed.errors).toContain("profile.accessToken is not allowed");
    }
  });

  it("makes an unapproved Codex redistribution profile unavailable without a runtime or setup", () => {
    const profile = {
      ...codexSubscriptionProfile(),
      status: "redistribution-unapproved" as const,
      runtimeBinarySources: [],
      supportsBrowserLogin: false,
      supportsDeviceCode: false,
      supportsAccessToken: false,
    };

    expect(validateCodingWorkbenchCodexSubscriptionProfile(profile)).toEqual({
      ok: true,
      value: profile,
    });
    expect(
      validateCodingWorkbenchCodexSubscriptionProfile({
        ...profile,
        runtimeBinarySources: ["managed-sidecar-runtime"],
        supportsDeviceCode: true,
      }),
    ).toMatchObject({
      ok: false,
      errors: [
        "profile.runtimeBinarySources must be empty when redistribution is unapproved",
        "supportsDeviceCode must be false when redistribution is unapproved",
      ],
    });
  });

  it("selects the Codex adapter for subscription profiles and the sidecar for gateway profiles", () => {
    expect(selectCodingWorkbenchRuntimeProfile("chatgpt-codex-subscription-profile")).toEqual({
      schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
      modelSource: "chatgpt-codex-subscription-profile",
      runtimeSource: "codex-cli-adapter",
      adapterKind: "codex-cli-adapter",
      sidecarGatewayAllowed: false,
      codexSubscriptionAllowed: false,
      runtimeBinarySources: [],
    });
    expect(selectCodingWorkbenchRuntimeProfile("openai-api-key-through-gateway")).toMatchObject({
      modelSource: "openai-api-key-through-gateway",
      runtimeSource: "keiko-sidecar",
      adapterKind: "model-gateway-sidecar",
      sidecarGatewayAllowed: true,
      codexSubscriptionAllowed: false,
      runtimeBinarySources: [],
    });
  });

  it("validates setup requests and plans without carrying secrets", () => {
    expect(validateCodingWorkbenchCodexAuthSetupRequest({ method: "chatgpt-device-code" })).toEqual(
      { ok: true, value: { method: "chatgpt-device-code" } },
    );
    expect(validateCodingWorkbenchCodexAuthSetupPlan(codexSetupPlan())).toEqual({
      ok: true,
      value: codexSetupPlan(),
    });
    expect(
      validateCodingWorkbenchCodexAuthSetupRequest({
        method: "codex-access-token",
        accessToken: "secret",
      }),
    ).toMatchObject({
      ok: false,
      errors: ["setup.accessToken is not allowed"],
    });
  });

  it("keeps Codex subscription authority bounded by the same envelope policy", () => {
    const envelope = {
      ...baseAuthorityEnvelope(),
      runtimeSource: "codex-cli-adapter",
      modelProfile: {
        profileId: "codex-subscription",
        source: "chatgpt-codex-subscription-profile",
        supportsStreaming: true,
        supportsToolCalling: true,
      },
      requestedMode: "governed-assist",
      deploymentCeiling: "governed-assist",
      effectiveMode: "governed-assist",
      actionClasses: ["workspace-read", "verification", "connector-access"],
      commandPolicy: {
        mode: "deny",
        allow: [],
        deny: ["curl"],
        maxCommandTimeoutMs: 30_000,
        requirePerCommandApproval: true,
      },
      connectorScopes: ["source-control.read"],
      networkPolicy: {
        mode: "deny-all",
        allowLoopback: false,
        connectorScopes: [],
      },
    };

    expect(validateCodingWorkbenchAuthorityEnvelope(envelope)).toEqual({
      ok: true,
      value: envelope,
    });
    const commandEnvelope = {
      ...envelope,
      actionClasses: [...envelope.actionClasses, "command-execution"],
    };
    expect(validateCodingWorkbenchAuthorityEnvelope(commandEnvelope)).toEqual({
      ok: true,
      value: commandEnvelope,
    });
  });
});

describe("resolveEffectiveCodingWorkbenchMode", () => {
  it("uses the fail-closed minimum rule", () => {
    expect(resolveEffectiveCodingWorkbenchMode("autonomous-delivery", "governed-assist")).toBe(
      "governed-assist",
    );
    expect(resolveEffectiveCodingWorkbenchMode("supervised-coding", "autonomous-delivery")).toBe(
      "supervised-coding",
    );
  });

  it("fails closed to governed-assist for unknown values", () => {
    expect(resolveEffectiveCodingWorkbenchMode("ship-it", "supervised-coding")).toBe(
      "governed-assist",
    );
    expect(resolveEffectiveCodingWorkbenchMode("autonomous-delivery", "wide-open")).toBe(
      "governed-assist",
    );
  });
});

describe("decideCodingWorkbenchActionForMode", () => {
  it("admits every action class for every mode before tri-state policy evaluation", () => {
    for (const mode of CODING_WORKBENCH_MODES) {
      for (const actionClass of CODING_WORKBENCH_ACTION_CLASSES) {
        expect(
          decideCodingWorkbenchActionForMode(mode, actionClass, [
            "source-control.write",
            "issue-tracker.write",
          ]),
        ).toEqual({ allowed: true });
      }
    }
  });
});

describe("supervised coding action authority", () => {
  it("requires approval only for delivery, connector, external, and system mutations", () => {
    expect(supervisedCodingActionRequiresApproval("file-edit")).toBe(false);
    expect(supervisedCodingActionRequiresApproval("verification-command")).toBe(false);
    expect(supervisedCodingActionRequiresApproval("commit")).toBe(true);
    expect(supervisedCodingActionRequiresApproval("push")).toBe(true);
    expect(supervisedCodingActionRequiresApproval("pull-request")).toBe(true);
    expect(supervisedCodingActionRequiresApproval("merge")).toBe(true);
    expect(supervisedCodingActionRequiresApproval("connector-write")).toBe(true);
    expect(supervisedCodingActionRequiresApproval("external-write")).toBe(true);
  });

  it("maps supervised actions to the existing permission classes", () => {
    expect(permissionKindForSupervisedCodingAction("file-edit")).toBe("workspace-write");
    expect(permissionKindForSupervisedCodingAction("verification-command")).toBe(
      "command-execution",
    );
    expect(permissionKindForSupervisedCodingAction("connector-write")).toBe("connector-access");
    expect(permissionKindForSupervisedCodingAction("external-write")).toBe("connector-access");
    expect(permissionKindForSupervisedCodingAction("commit")).toBe("delivery-substrate");
  });

  it("validates prompt metadata without accepting raw scope or policy strings", () => {
    const request: CodingWorkbenchPermissionRequest = {
      ...validPermissionRequest(),
      kind: "delivery-substrate",
      actionClass: "delivery-substrate",
      actionKind: "push",
      scopeLabel: "workspace-scope",
      risk: "high",
      policyReason: "approval-required",
    };

    expect(validateCodingWorkbenchPermissionRequest(request)).toEqual({ ok: true, value: request });
    expect(
      validateCodingWorkbenchPermissionRequest({
        ...request,
        scopeLabel: "/Users/alice/repo",
        policyReason: "ship-it",
      }),
    ).toMatchObject({
      ok: false,
      errors: [
        "permissionRequest.scopeLabel must be content-free evidence-safe text",
        "permissionRequest.policyReason is invalid",
      ],
    });
  });

  it("rejects supervised prompt metadata when action kind and permission class disagree", () => {
    expect(
      validateCodingWorkbenchPermissionRequest({
        ...validPermissionRequest(),
        kind: "workspace-write",
        actionClass: "workspace-write",
        actionKind: "push",
        scopeLabel: "workspace-scope",
        risk: "high",
        policyReason: "approval-required",
      }),
    ).toMatchObject({
      ok: false,
      errors: [
        "permissionRequest.actionKind must match permissionRequest.kind and permissionRequest.actionClass",
      ],
    });
  });

  it("requires write-capable connector scopes for supervised connector mutations", () => {
    const request: CodingWorkbenchPermissionRequest = {
      ...validPermissionRequest(),
      kind: "connector-access",
      actionClass: "connector-access",
      actionKind: "external-write",
      connectorScopes: ["issue-tracker.write"],
      scopeLabel: "workspace-scope",
      risk: "high",
      policyReason: "approval-required",
    };

    expect(validateCodingWorkbenchPermissionRequest(request)).toEqual({ ok: true, value: request });
    expect(
      validateCodingWorkbenchPermissionRequest({
        ...request,
        connectorScopes: ["issue-tracker.read"],
      }),
    ).toMatchObject({
      ok: false,
      errors: ["permissionRequest.connectorScopes[0] must be write-capable for external-write"],
    });
  });
});

describe("isCodingWorkbenchEvidenceSafeText", () => {
  it.each([
    { label: "bidi override", value: "approval-required\u202E" },
    { label: "control character", value: "approval-required\u0001" },
    { label: "trimmed boundary", value: " approval-required" },
    { label: "url-like scheme", value: "ssh://corp-host/repo" },
    { label: "natural-language slug", value: "please-fix-login-bug" },
    { label: "fine-grained PAT", value: "github_pat_1234567890" },
    { label: "retired local runtime source", value: "policy-allowed-local-install" },
  ])("rejects unsafe evidence text: $label", ({ value }) => {
    expect(isCodingWorkbenchEvidenceSafeText(value)).toBe(false);
  });

  // Issue #2244 (ADR-0128 D4): the knowledge-base connector scope labels are evidence-safe, so a
  // permission request or evidence record carrying the Confluence write scope never gets
  // redacted into an unreadable token. The segments are inert vocabulary words; hostile labels
  // that merely CONTAIN them still fail the detectors.
  it("accepts the knowledge-base connector scope labels as evidence-safe text", () => {
    for (const scopeLabel of [
      "knowledge-base.read",
      "knowledge-base.write",
      "issue-tracker.write",
    ]) {
      expect(isCodingWorkbenchEvidenceSafeText(scopeLabel)).toBe(true);
    }
  });

  it("still rejects hostile labels around the knowledge-base tokens", () => {
    expect(isCodingWorkbenchEvidenceSafeText("knowledge-base.write token=abc")).toBe(false);
    expect(isCodingWorkbenchEvidenceSafeText("https://knowledge-base.write")).toBe(false);
    expect(isCodingWorkbenchEvidenceSafeText("knowledge-base.write\u202E")).toBe(false);
    expect(isCodingWorkbenchEvidenceSafeText("knowledge-base-password")).toBe(false);
  });
});

describe("validateCodingWorkbenchAuthorityEnvelope", () => {
  it("accepts a valid content-free authority envelope", () => {
    expect(validateCodingWorkbenchAuthorityEnvelope(baseAuthorityEnvelope())).toEqual({
      ok: true,
      value: baseAuthorityEnvelope(),
    });
  });

  it("rejects a missing expiry, missing action scopes, unknown connector scopes, missing workspace identity, and invalid approval proof digest", () => {
    const parsed = validateCodingWorkbenchAuthorityEnvelope({
      ...baseAuthorityEnvelope(),
      workspace: undefined,
      actionClasses: [],
      connectorScopes: ["mail.send"],
      expiresAt: undefined,
      approvalProofDigest: "not-a-digest",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain("authorityEnvelope.workspace must be an object");
      expect(parsed.errors).toContain("authorityEnvelope.actionClasses must not be empty");
      expect(parsed.errors).toContain("authorityEnvelope.connectorScopes[0] is invalid");
      expect(parsed.errors).toContain(
        "authorityEnvelope.expiresAt must be an ISO-8601 UTC instant",
      );
      expect(parsed.errors).toContain(
        "authorityEnvelope.approvalProofDigest must be a 64-character lowercase hex digest",
      );
    }
  });

  it("rejects documentation connector scope labels", () => {
    const parsed = validateCodingWorkbenchAuthorityEnvelope({
      ...baseAuthorityEnvelope(),
      connectorScopes: ["documentation.read"],
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain("authorityEnvelope.connectorScopes[0] is invalid");
    }
  });

  it("rejects governed-assist authority with connector scopes but no connector-access action class", () => {
    const parsed = validateCodingWorkbenchAuthorityEnvelope({
      ...baseAuthorityEnvelope(),
      requestedMode: "governed-assist",
      deploymentCeiling: "governed-assist",
      effectiveMode: "governed-assist",
      actionClasses: ["workspace-read", "verification"],
      connectorScopes: ["source-control.read"],
      commandPolicy: {
        ...baseAuthorityEnvelope().commandPolicy,
        mode: "deny",
        allow: [],
        deny: [],
      },
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "authorityEnvelope.connectorScopes must be empty when authorityEnvelope.actionClasses omits connector-access",
      );
    }
  });

  it("rejects supervised-coding authority with connector scopes but no connector-access action class", () => {
    const parsed = validateCodingWorkbenchAuthorityEnvelope({
      ...baseAuthorityEnvelope(),
      actionClasses: ["workspace-read", "workspace-write", "command-execution", "verification"],
      connectorScopes: ["source-control.read"],
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "authorityEnvelope.connectorScopes must be empty when authorityEnvelope.actionClasses omits connector-access",
      );
    }
  });

  it("accepts governed-assist class admission for approvable command, network, and connector work", () => {
    const envelope = {
      ...baseAuthorityEnvelope(),
      requestedMode: "governed-assist",
      deploymentCeiling: "governed-assist",
      effectiveMode: "governed-assist",
      actionClasses: CODING_WORKBENCH_ACTION_CLASSES,
      connectorScopes: ["source-control.write"],
      commandPolicy: {
        ...baseAuthorityEnvelope().commandPolicy,
        mode: "governed",
      },
      networkPolicy: {
        ...baseAuthorityEnvelope().networkPolicy,
        mode: "governed-egress",
        allowLoopback: true,
        connectorScopes: ["source-control.write"],
      },
    } as const;

    expect(validateCodingWorkbenchAuthorityEnvelope(envelope)).toEqual({
      ok: true,
      value: envelope,
    });
  });

  it("rejects write and command-capable authority without a human-approval gate", () => {
    const parsed = validateCodingWorkbenchAuthorityEnvelope({
      ...baseAuthorityEnvelope(),
      gates: ["verification-green"],
      actionClasses: ["workspace-read", "workspace-write", "command-execution", "verification"],
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "authorityEnvelope.gates must include human-approval when authorityEnvelope.actionClasses or connector scopes grant elevated authority",
      );
    }
  });

  it("rejects supervised-coding authority that omits network-egress while using governed egress", () => {
    const parsed = validateCodingWorkbenchAuthorityEnvelope({
      ...baseAuthorityEnvelope(),
      networkPolicy: {
        ...baseAuthorityEnvelope().networkPolicy,
        mode: "governed-egress",
        allowLoopback: true,
        connectorScopes: ["source-control.read"],
      },
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "authorityEnvelope.actionClasses must include network-egress when authorityEnvelope.networkPolicy.mode is not deny-all",
      );
      expect(parsed.errors).toContain(
        "authorityEnvelope.networkPolicy.mode must be deny-all when authorityEnvelope.actionClasses omits network-egress",
      );
      expect(parsed.errors).toContain(
        "authorityEnvelope.networkPolicy.allowLoopback must be false when authorityEnvelope.actionClasses omits network-egress",
      );
      expect(parsed.errors).toContain(
        "authorityEnvelope.networkPolicy.connectorScopes must be empty when authorityEnvelope.actionClasses omits network-egress",
      );
    }
  });

  it("rejects secret-bearing authority IDs", () => {
    const parsed = validateCodingWorkbenchAuthorityEnvelope({
      ...baseAuthorityEnvelope(),
      runId: "ghp_1234567890",
      workspace: {
        ...baseAuthorityEnvelope().workspace,
        workspaceId: "sk-1234567890",
      },
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "authorityEnvelope.runId must be content-free evidence-safe text",
      );
      expect(parsed.errors).toContain(
        "authorityEnvelope.workspace.workspaceId must be content-free evidence-safe text",
      );
    }
  });

  it("rejects governed-assist command policies with deny-mode allow entries", () => {
    const parsed = validateCodingWorkbenchAuthorityEnvelope({
      ...baseAuthorityEnvelope(),
      requestedMode: "governed-assist",
      deploymentCeiling: "governed-assist",
      effectiveMode: "governed-assist",
      actionClasses: ["workspace-read", "verification", "connector-access"],
      commandPolicy: {
        ...baseAuthorityEnvelope().commandPolicy,
        mode: "deny",
        allow: ["npm"],
        deny: [],
      },
      networkPolicy: {
        ...baseAuthorityEnvelope().networkPolicy,
        mode: "deny-all",
        allowLoopback: false,
        connectorScopes: [],
      },
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "authorityEnvelope.commandPolicy.allow must be empty when mode is deny",
      );
    }
  });

  it("rejects governed-assist network policies with loopback enabled in deny-all mode", () => {
    const parsed = validateCodingWorkbenchAuthorityEnvelope({
      ...baseAuthorityEnvelope(),
      requestedMode: "governed-assist",
      deploymentCeiling: "governed-assist",
      effectiveMode: "governed-assist",
      actionClasses: ["workspace-read", "verification", "connector-access"],
      commandPolicy: {
        ...baseAuthorityEnvelope().commandPolicy,
        mode: "deny",
        allow: [],
        deny: ["curl"],
      },
      networkPolicy: {
        ...baseAuthorityEnvelope().networkPolicy,
        mode: "deny-all",
        allowLoopback: true,
        connectorScopes: [],
      },
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "authorityEnvelope.networkPolicy.allowLoopback must be false when mode is deny-all",
      );
    }
  });

  it("rejects supervised-coding command policies that grant commands without command-execution", () => {
    const parsed = validateCodingWorkbenchAuthorityEnvelope({
      ...baseAuthorityEnvelope(),
      actionClasses: ["workspace-read", "workspace-write", "verification", "connector-access"],
      commandPolicy: {
        ...baseAuthorityEnvelope().commandPolicy,
        mode: "governed",
        allow: ["npm"],
        deny: [],
        requirePerCommandApproval: true,
      },
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "authorityEnvelope.commandPolicy.mode must be deny when authorityEnvelope.actionClasses omits command-execution",
      );
      expect(parsed.errors).toContain(
        "authorityEnvelope.commandPolicy.allow must be empty when authorityEnvelope.actionClasses omits command-execution",
      );
    }
  });

  it("keeps command policy allow and deny entries evidence-safe", () => {
    expect(
      validateCodingWorkbenchAuthorityEnvelope({
        ...baseAuthorityEnvelope(),
        commandPolicy: {
          ...baseAuthorityEnvelope().commandPolicy,
          allow: ["npm", "node"],
          deny: ["curl"],
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        ...baseAuthorityEnvelope(),
        commandPolicy: {
          ...baseAuthorityEnvelope().commandPolicy,
          allow: ["npm", "node"],
          deny: ["curl"],
        },
      },
    });
  });

  it("rejects raw command-log style command policy entries", () => {
    const parsed = validateCodingWorkbenchAuthorityEnvelope({
      ...baseAuthorityEnvelope(),
      commandPolicy: {
        ...baseAuthorityEnvelope().commandPolicy,
        allow: ["npm test -- --runInBand", "https://example.com"],
        deny: ["bash -lc 'echo secret'", "/tmp/keiko/workspace", "diff --git a/a b/b"],
      },
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "authorityEnvelope.commandPolicy.allow[0] must be content-free evidence-safe text",
      );
      expect(parsed.errors).toContain(
        "authorityEnvelope.commandPolicy.allow[1] must be content-free evidence-safe text",
      );
      expect(parsed.errors).toContain(
        "authorityEnvelope.commandPolicy.deny[0] must be content-free evidence-safe text",
      );
      expect(parsed.errors).toContain(
        "authorityEnvelope.commandPolicy.deny[1] must be content-free evidence-safe text",
      );
      expect(parsed.errors).toContain(
        "authorityEnvelope.commandPolicy.deny[2] must be content-free evidence-safe text",
      );
    }
  });

  it("rejects network connector scopes that widen beyond the envelope", () => {
    const parsed = validateCodingWorkbenchAuthorityEnvelope({
      ...baseAuthorityEnvelope(),
      connectorScopes: ["source-control.read"],
      networkPolicy: {
        ...baseAuthorityEnvelope().networkPolicy,
        connectorScopes: ["issue-tracker.read"],
      },
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "authorityEnvelope.networkPolicy.connectorScopes[0] must be listed in authorityEnvelope.connectorScopes",
      );
    }
  });

  it("rejects network connector scopes when network mode is deny-all", () => {
    const parsed = validateCodingWorkbenchAuthorityEnvelope({
      ...baseAuthorityEnvelope(),
      networkPolicy: {
        ...baseAuthorityEnvelope().networkPolicy,
        mode: "deny-all",
        connectorScopes: ["source-control.read"],
      },
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "authorityEnvelope.networkPolicy.connectorScopes must be empty when mode is deny-all",
      );
    }
  });

  it("accepts evidence-safe branch refs and prefixes like issue/1986-coding-workbench-contracts", () => {
    const parsed = validateCodingWorkbenchAuthorityEnvelope({
      ...baseAuthorityEnvelope(),
      branch: {
        ...baseAuthorityEnvelope().branch,
        baseRef: "dev",
        headRef: "issue/1986-coding-workbench-contracts",
        allowedPrefixes: ["issue/", "codex/"],
      },
      modelProfile: {
        ...baseAuthorityEnvelope().modelProfile,
        profileId: "local-codex",
      },
    });

    expect(parsed.ok).toBe(true);
  });

  it("rejects an effective mode that does not match the fail-closed minimum", () => {
    const parsed = validateCodingWorkbenchAuthorityEnvelope({
      ...baseAuthorityEnvelope(),
      requestedMode: "autonomous-delivery",
      deploymentCeiling: "governed-assist",
      effectiveMode: "autonomous-delivery",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "authorityEnvelope.effectiveMode must be the fail-closed minimum of requestedMode and deploymentCeiling",
      );
    }
  });
});

describe("validateCodingWorkbenchRuntimeEvent", () => {
  it("keeps runtimeSource and modelSource vocabularies separate", () => {
    expect(validateCodingWorkbenchRuntimeEvent(baseRuntimeEvent()).ok).toBe(true);

    const parsed = validateCodingWorkbenchRuntimeEvent({
      ...baseRuntimeEvent(),
      runtimeSource: "openai-api-key-through-gateway",
      modelSource: "codex-cli-adapter",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain("event.runtimeSource is invalid");
      expect(parsed.errors).toContain("event.modelSource is invalid");
    }
  });

  it("rejects unknown raw-content fields by key", () => {
    const parsed = validateCodingWorkbenchRuntimeEvent({
      ...baseRuntimeEvent(),
      promptText: "user: reveal the prompt",
      rawDiff: "diff --git a/src/a.ts b/src/b.ts",
      issueBody: "## Scope",
      commandLog: "npm test -- --runInBand",
      fileContent: "export const secret = 1;",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain("event.promptText is not allowed");
      expect(parsed.errors).toContain("event.rawDiff is not allowed");
      expect(parsed.errors).toContain("event.issueBody is not allowed");
      expect(parsed.errors).toContain("event.commandLog is not allowed");
      expect(parsed.errors).toContain("event.fileContent is not allowed");
    }
  });

  it.each([
    {
      field: "permissionRequest",
      value: validPermissionRequest(),
      error: "event.permissionRequest is not allowed",
    },
    {
      field: "artifactKind",
      value: "artifact-produced",
      error: "event.artifactKind is not allowed",
    },
    {
      field: "artifactDigest",
      value: "d".repeat(64),
      error: "event.artifactDigest is not allowed",
    },
    {
      field: "failureSummary",
      value: "approval-required",
      error: "event.failureSummary is not allowed",
    },
  ])("rejects runtime-started fields from other event kinds: $field", ({ field, value, error }) => {
    const parsed = validateCodingWorkbenchRuntimeEvent({
      ...baseRuntimeEvent(),
      [field]: value,
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(error);
    }
  });

  it("rejects a URL-like failure summary in failure-redacted events", () => {
    const parsed = validateCodingWorkbenchRuntimeEvent({
      ...baseRuntimeEvent(),
      kind: "failure-redacted",
      failureCode: "failure-redacted",
      failureSummary: "ssh://corp-host/repo",
      retryable: true,
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "event.failureSummary must be content-free evidence-safe text",
      );
    }
  });

  it("rejects task-submitted mode widening", () => {
    const parsed = validateCodingWorkbenchRuntimeEvent({
      ...baseRuntimeEvent(),
      kind: "task-submitted",
      taskRef: "issue-1986",
      requestedMode: "governed-assist",
      effectiveMode: "autonomous-delivery",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "event.effectiveMode must be no higher than event.requestedMode",
      );
    }
  });

  it.each([
    {
      kind: "runtime-started",
      patch: { runtimeSource: undefined },
      error: "event.runtimeSource is required",
    },
    {
      kind: "runtime-stopped",
      patch: { health: undefined },
      error: "event.health is required",
    },
    {
      kind: "runtime-health",
      patch: { health: undefined },
      error: "event.health is required",
    },
    {
      kind: "task-submitted",
      patch: { taskRef: undefined },
      error: "event.taskRef is required",
    },
    {
      kind: "observation-streamed",
      patch: {},
      error: "event.channel is required",
    },
    {
      kind: "permission-requested",
      patch: { permissionRequest: undefined },
      error: "event.permissionRequest is required",
    },
    {
      kind: "diff-summarized",
      patch: {},
      error: "event.fileCount is required",
    },
    {
      kind: "verification-summarized",
      patch: {
        verificationStatus: "passed",
        passedCount: 0,
        failedCount: 0,
        skippedCount: 0,
      },
      error: "event.verificationKind is required",
    },
    {
      kind: "artifact-produced",
      patch: {
        artifactLabel: "approval-required",
        artifactDigest: "d".repeat(64),
        artifactBytes: 0,
      },
      error: "event.artifactKind is required",
    },
    {
      kind: "failure-redacted",
      patch: {
        failureSummary: "approval-required",
        retryable: true,
      },
      error: "event.failureCode is required",
    },
  ])("rejects missing required runtime payload fields for $kind", ({ kind, patch, error }) => {
    const parsed = validateCodingWorkbenchRuntimeEvent({
      ...baseRuntimeEvent(),
      kind,
      ...patch,
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(error);
    }
  });

  it.each([
    {
      field: "eventId",
      value: "sk-1234567890",
      error: "event.eventId must be content-free evidence-safe text",
    },
    {
      field: "eventId",
      value: "github_pat_1234567890",
      error: "event.eventId must be content-free evidence-safe text",
    },
    {
      field: "runId",
      value: "ghp_1234567890",
      error: "event.runId must be content-free evidence-safe text",
    },
  ])("rejects secret-bearing runtime IDs in $field", ({ field, value, error }) => {
    const parsed = validateCodingWorkbenchRuntimeEvent({
      ...baseRuntimeEvent(),
      [field]: value,
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(error);
    }
  });

  it.each([
    {
      field: "taskRef",
      value: "diff --git a/src/a.ts b/src/b.ts",
      error: "event.taskRef must be content-free evidence-safe text",
    },
    {
      field: "verificationKind",
      value: "https://internal.example.local/private",
      error: "event.verificationKind must be content-free evidence-safe text",
    },
    {
      field: "artifactKind",
      value: "/Users/nikolaos/Documents/Projects/Keiko/src/index.ts",
      error: "event.artifactKind must be content-free evidence-safe text",
    },
    {
      field: "artifactLabel",
      value: "npm test -- --runInBand",
      error: "event.artifactLabel must be content-free evidence-safe text",
    },
    {
      field: "failureCode",
      value: "assistant: here is the full generated patch",
      error: "event.failureCode must be content-free evidence-safe text",
    },
    {
      field: "failureSummary",
      value: "Please fix the login bug",
      error: "event.failureSummary must be content-free evidence-safe text",
    },
  ])("rejects unsafe runtime text in $field", ({ field, value, error }) => {
    const parsed = validateCodingWorkbenchRuntimeEvent({
      ...baseRuntimeEvent(),
      [field]: value,
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(error);
    }
  });

  it("rejects permission request kind/actionClass mismatches", () => {
    const parsed = validateCodingWorkbenchPermissionRequest({
      requestId: "perm-1",
      kind: "workspace-write",
      actionClass: "network-egress",
      reasonCode: "verification-required",
      expiresAt: "2026-07-07T12:30:00Z",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "permissionRequest.kind must match permissionRequest.actionClass for the shared action classes",
      );
    }
  });

  it("rejects nested command-execution permission requests without a command label", () => {
    const parsed = validateCodingWorkbenchRuntimeEvent({
      schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
      eventId: "evt-1",
      runId: "run-1986",
      occurredAt: "2026-07-07T12:00:00Z",
      kind: "permission-requested",
      permissionRequest: {
        requestId: "perm-1",
        kind: "command-execution",
        actionClass: "command-execution",
        reasonCode: "approval-required",
        expiresAt: "2026-07-07T12:30:00Z",
      },
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain("event.permissionRequest.commandLabel is required");
    }
  });

  it("accepts nested command-execution permission requests with a safe command label", () => {
    expect(
      validateCodingWorkbenchRuntimeEvent({
        schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
        eventId: "evt-1",
        runId: "run-1986",
        occurredAt: "2026-07-07T12:00:00Z",
        kind: "permission-requested",
        permissionRequest: {
          requestId: "perm-1",
          kind: "command-execution",
          actionClass: "command-execution",
          reasonCode: "approval-required",
          commandLabel: "npm",
          expiresAt: "2026-07-07T12:30:00Z",
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
        eventId: "evt-1",
        runId: "run-1986",
        occurredAt: "2026-07-07T12:00:00Z",
        kind: "permission-requested",
        permissionRequest: {
          requestId: "perm-1",
          kind: "command-execution",
          actionClass: "command-execution",
          reasonCode: "approval-required",
          commandLabel: "npm",
          expiresAt: "2026-07-07T12:30:00Z",
        },
      },
    });
  });

  it("rejects nested command-execution permission requests with unsafe command text", () => {
    const parsed = validateCodingWorkbenchRuntimeEvent({
      schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
      eventId: "evt-1",
      runId: "run-1986",
      occurredAt: "2026-07-07T12:00:00Z",
      kind: "permission-requested",
      permissionRequest: {
        requestId: "perm-1",
        kind: "command-execution",
        actionClass: "command-execution",
        reasonCode: "approval-required",
        commandLabel: "npm test -- --runInBand",
        expiresAt: "2026-07-07T12:30:00Z",
      },
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "event.permissionRequest.commandLabel must be content-free evidence-safe text",
      );
    }
  });

  it("rejects connector-access permission requests without connector scopes", () => {
    const parsed = validateCodingWorkbenchPermissionRequest({
      requestId: "perm-1",
      kind: "connector-access",
      actionClass: "connector-access",
      reasonCode: "connector-access-requested",
      expiresAt: "2026-07-07T12:30:00Z",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain("permissionRequest.connectorScopes is required");
    }
  });

  it("accepts connector-access permission requests with connector scopes", () => {
    expect(
      validateCodingWorkbenchPermissionRequest({
        requestId: "perm-1",
        kind: "connector-access",
        actionClass: "connector-access",
        reasonCode: "connector-access-requested",
        connectorScopes: ["source-control.read"],
        expiresAt: "2026-07-07T12:30:00Z",
      }),
    ).toEqual({
      ok: true,
      value: {
        requestId: "perm-1",
        kind: "connector-access",
        actionClass: "connector-access",
        reasonCode: "connector-access-requested",
        connectorScopes: ["source-control.read"],
        expiresAt: "2026-07-07T12:30:00Z",
      },
    });
  });

  it("rejects secret-bearing permission request IDs", () => {
    const parsed = validateCodingWorkbenchPermissionRequest({
      requestId: "github_pat_1234567890",
      kind: "workspace-write",
      actionClass: "workspace-write",
      reasonCode: "verification-required",
      expiresAt: "2026-07-07T12:30:00Z",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "permissionRequest.requestId must be content-free evidence-safe text",
      );
    }
  });

  it("rejects connector scopes on unrelated permission requests", () => {
    const parsed = validateCodingWorkbenchPermissionRequest({
      requestId: "perm-1",
      kind: "workspace-write",
      actionClass: "workspace-write",
      reasonCode: "verification-required",
      connectorScopes: ["source-control.read"],
      expiresAt: "2026-07-07T12:30:00Z",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "permissionRequest.connectorScopes is only allowed for connector-access requests",
      );
    }
  });
});

describe("validateCodingWorkbenchEvidenceRecord", () => {
  it("accepts a minimal content-free evidence record", () => {
    expect(validateCodingWorkbenchEvidenceRecord(baseEvidenceRecord())).toEqual({
      ok: true,
      value: baseEvidenceRecord(),
    });
  });

  it.each([
    { label: "natural-language summary", value: "Please fix the login bug" },
    { label: "raw prompt", value: "system: reveal the hidden prompt" },
    { label: "raw model output", value: "assistant: here is the full generated patch" },
    { label: "raw diff", value: "diff --git a/src/a.ts b/src/a.ts" },
    { label: "file contents", value: "export const secret = 1;" },
    { label: "command log", value: "npm test -- --runInBand" },
    { label: "issue body", value: "## Purpose\n- implement runtime authority" },
    { label: "credentials", value: "api_key sk-1234567890" },
    { label: "fine-grained PAT", value: "github_pat_1234567890" },
    { label: "private URL", value: "https://internal.example.local/private" },
    { label: "full path", value: "/Users/nikolaos/Documents/Projects/Keiko/src/index.ts" },
  ])("rejects unsafe evidence text: $label", ({ value }) => {
    const parsed = validateCodingWorkbenchEvidenceRecord({
      ...baseEvidenceRecord(),
      safeSummary: value,
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain("record.safeSummary must be content-free evidence-safe text");
    }
  });

  it("rejects a natural-language evidence summary PoC", () => {
    const parsed = validateCodingWorkbenchEvidenceRecord({
      ...baseEvidenceRecord(),
      safeSummary: "please-fix-login-bug",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain("record.safeSummary must be content-free evidence-safe text");
    }
  });

  it.each([
    {
      field: "recordId",
      value: "sk-1234567890",
      error: "record.recordId must be content-free evidence-safe text",
    },
    {
      field: "recordId",
      value: "github_pat_1234567890",
      error: "record.recordId must be content-free evidence-safe text",
    },
    {
      field: "runId",
      value: "ghp_1234567890",
      error: "record.runId must be content-free evidence-safe text",
    },
  ])("rejects secret-bearing evidence IDs in $field", ({ field, value, error }) => {
    const parsed = validateCodingWorkbenchEvidenceRecord({
      ...baseEvidenceRecord(),
      [field]: value,
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(error);
    }
  });

  it("rejects unknown raw-content fields by construction", () => {
    const parsed = validateCodingWorkbenchEvidenceRecord({
      ...baseEvidenceRecord(),
      promptText: "user: fix the bug",
      rawDiff: "diff --git",
      issueBody: "## Scope",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain("record.promptText is not allowed");
      expect(parsed.errors).toContain("record.rawDiff is not allowed");
      expect(parsed.errors).toContain("record.issueBody is not allowed");
    }
  });

  it("rejects bearer credentials consistently across repeated disallowed-content checks", () => {
    const secretBearingValue = "Bearer abcdef123456";

    for (let index = 0; index < 20; index += 1) {
      expect(hasDisallowedEvidenceContent(secretBearingValue)).toBe(true);
    }
  });
});

describe("redactCodingWorkbenchEvidenceText", () => {
  it("redacts URLs, secrets, and absolute paths into evidence-safe labels", () => {
    const redacted = redactCodingWorkbenchEvidenceText(
      "api_key used with https://internal.example.local/token under /Users/nikolaos/secret",
    );

    expect(isCodingWorkbenchEvidenceSafeText(redacted)).toBe(true);
    expect(redacted).toContain("redacted-url");
    expect(redacted).toContain("redacted-path");
    expect(redacted).toContain("redacted-credential");
    expect(redacted).not.toContain("https://internal.example.local/token");
    expect(redacted).not.toContain("/Users/nikolaos/secret");
  });

  it("redacts ssh URLs into a bounded generic token", () => {
    const redacted = redactCodingWorkbenchEvidenceText("ssh://corp-host/repo");

    expect(redacted).not.toBe("ssh://corp-host/repo");
    expect(isCodingWorkbenchEvidenceSafeText(redacted)).toBe(true);
  });

  it("redacts bearer credentials and token-shaped secrets without leaking the original substrings", () => {
    const redacted = redactCodingWorkbenchEvidenceText(
      "Authorization: Bearer abcdef123456 api_key=sk-1234567890 github_pat_1234567890 ghp_1234567890 password: hunter2",
    );

    expect(isCodingWorkbenchEvidenceSafeText(redacted)).toBe(true);
    expect(redacted).toContain("redacted-auth");
    expect(redacted).toContain("redacted-credential");
    expect(redacted).not.toContain("Bearer abcdef123456");
    expect(redacted).not.toContain("sk-1234567890");
    expect(redacted).not.toContain("github_pat_1234567890");
    expect(redacted).not.toContain("ghp_1234567890");
    expect(redacted).not.toContain("password: hunter2");
  });

  it.each([
    "Please fix the login bug",
    "npm test -- --runInBand",
    "diff --git a/src/a.ts b/src/b.ts",
  ])("redacts hostile free text without leaking lexical content: %s", (value) => {
    const redacted = redactCodingWorkbenchEvidenceText(value);

    expect(isCodingWorkbenchEvidenceSafeText(redacted)).toBe(true);
    expect(redacted).not.toMatch(/\blogin\b/i);
    expect(redacted).not.toMatch(/\bbug\b/i);
    expect(redacted).not.toMatch(/\bnpm\b/i);
    expect(redacted).not.toMatch(/\brunInBand\b/i);
    expect(redacted).not.toMatch(/\bdiff\b/i);
    expect(redacted).not.toMatch(/\bgit\b/i);
    expect(redacted).not.toMatch(/\bsrc\b/i);
    expect(redacted).not.toMatch(/\ba\.ts\b/i);
    expect(redacted).not.toMatch(/\bb\.ts\b/i);
  });
});
