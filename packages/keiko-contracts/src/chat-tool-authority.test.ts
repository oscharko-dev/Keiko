import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CODING_WORKBENCH_MODES, resolveEffectiveCodingWorkbenchMode } from "./coding-workbench.js";
import { validateCodingWorkbenchAuthorityEnvelope } from "./coding-workbench-validation.js";
import {
  validateChatToolAuthorityEnvelope,
  validateChatToolAuthoritySubject,
  validateChatToolReadGrant,
  CHAT_TOOL_READ_GRANT_STATES,
  type ChatToolReadGrant,
  type ChatToolAuthorityEnvelope,
} from "./chat-tool-authority.js";

function envelope(): ChatToolAuthorityEnvelope {
  return {
    schemaVersion: "1",
    kind: "chat-tool-authority",
    runId: "chat-authority-1",
    subject: {
      actorDigest: "a".repeat(64),
      chatId: "chat-1",
      podId: "d5f5681e-ce98-4c3c-b27e-51d707c9d018",
      bindingGeneration: 2,
      authenticationGeneration: 3,
    },
    requestedMode: "governed-assist",
    deploymentCeiling: "autonomous-delivery",
    effectiveMode: "governed-assist",
    actionClasses: ["connector-access", "network-egress"],
    connectorScopes: ["issue-tracker.read", "issue-tracker.write"],
    budget: { maxRuntimeMs: 60_000, maxToolCalls: 20, maxPromptTokens: 50_000, maxPatchBytes: 0 },
    expiresAt: "2026-10-27T15:00:00.000Z",
    approvalProofDigest: "b".repeat(64),
  };
}

describe("ordinary Chat tool authority contract (#4084)", () => {
  it("accepts Chat identity without a Coding workspace, branch or session", () => {
    const value = envelope();
    expect(validateChatToolAuthorityEnvelope(value)).toEqual({ ok: true, value });
    expect(validateCodingWorkbenchAuthorityEnvelope(value).ok).toBe(false);
    expect(validateChatToolAuthoritySubject(value.subject)).toEqual({
      ok: true,
      value: value.subject,
    });
  });

  it.each(CODING_WORKBENCH_MODES)("keeps the shared mode ordering for %s", (requestedMode) => {
    for (const deploymentCeiling of CODING_WORKBENCH_MODES) {
      const value = {
        ...envelope(),
        requestedMode,
        deploymentCeiling,
        effectiveMode: resolveEffectiveCodingWorkbenchMode(requestedMode, deploymentCeiling),
      };
      expect(validateChatToolAuthorityEnvelope(value).ok).toBe(true);
      const different = CODING_WORKBENCH_MODES.find((mode) => mode !== value.effectiveMode);
      expect(validateChatToolAuthorityEnvelope({ ...value, effectiveMode: different }).ok).toBe(
        false,
      );
    }
  });

  it.each([
    { actorDigest: "not-a-digest" },
    { chatId: "" },
    { podId: "not-a-pod" },
    { bindingGeneration: 0 },
    { authenticationGeneration: -1 },
    { bindingGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { authenticationGeneration: 1.5 },
    { credentialRef: "credential-1" },
    { workspaceRoot: "/workspace" },
  ])("rejects malformed or widened subjects %j", (patch) => {
    const subject = { ...envelope().subject, ...patch };
    expect(validateChatToolAuthoritySubject(subject).ok).toBe(false);
    expect(validateChatToolAuthorityEnvelope({ ...envelope(), subject }).ok).toBe(false);
  });

  it.each([
    { kind: "coding-authority" },
    { schemaVersion: "2" },
    { runId: "" },
    { requestedMode: "invalid" },
    { deploymentCeiling: "invalid" },
    { actionClasses: ["connector-access", "network-egress", "file-edit"] },
    { actionClasses: ["connector-access"] },
    { connectorScopes: [] },
    { connectorScopes: ["knowledge-base.read"] },
    { connectorScopes: ["issue-tracker.read", "issue-tracker.read"] },
    { expiresAt: "2026-02-30T00:00:00.000Z" },
    { expiresAt: "tomorrow" },
    { approvalProofDigest: "" },
    { workspace: { root: "/workspace" } },
    { branch: { headRef: "dev" } },
    { authRef: "credential-1" },
  ])("rejects invalid policy or extra authority fields %j", (patch) => {
    expect(validateChatToolAuthorityEnvelope({ ...envelope(), ...patch }).ok).toBe(false);
  });

  it.each([
    { maxToolCalls: 0 },
    { maxToolCalls: Number.POSITIVE_INFINITY },
    { maxPromptTokens: -1 },
    { maxRuntimeMs: 1.5 },
    { maxPatchBytes: 1 },
    { maxNetworkCalls: 1 },
  ])("rejects invalid budgets and any file patch authority %j", (patch) => {
    const value = envelope();
    expect(
      validateChatToolAuthorityEnvelope({ ...value, budget: { ...value.budget, ...patch } }).ok,
    ).toBe(false);
  });

  it("accepts a narrower read-only connector scope", () => {
    expect(
      validateChatToolAuthorityEnvelope({ ...envelope(), connectorScopes: ["issue-tracker.read"] })
        .ok,
    ).toBe(true);
  });

  it.each([null, undefined, [], "authority", 1])("fails closed on non-record input %j", (value) => {
    expect(validateChatToolAuthorityEnvelope(value).ok).toBe(false);
    expect(validateChatToolAuthoritySubject(value).ok).toBe(false);
  });

  it("does not echo hostile keys or values in validation errors", () => {
    const privateText = "private-customer-data";
    const result = validateChatToolAuthorityEnvelope({ ...envelope(), [privateText]: privateText });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(privateText);
  });

  it.each(["envelope", "subject", "budget"] as const)("rejects inherited %s facts", (target) => {
    const value = envelope();
    const inherited: unknown = Object.create(target === "envelope" ? value : value[target]);
    const candidate = target === "envelope" ? inherited : { ...value, [target]: inherited };
    expect(validateChatToolAuthorityEnvelope(candidate).ok).toBe(false);
  });
});

function readGrant(): ChatToolReadGrant {
  return {
    schemaVersion: "1",
    kind: "jira-chat-read-grant",
    grantId: "grant-1",
    subject: envelope().subject,
    disclosureVersion: "jira-chat-read-v1",
    requestedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_600_000,
    state: "pending",
    consentProofDigest: null,
  };
}

describe("generation-bound Jira Chat read consent", () => {
  it("publishes the closed read-grant states", () => {
    expect(CHAT_TOOL_READ_GRANT_STATES).toEqual([
      "pending",
      "granted",
      "rejected",
      "expired",
      "revoked",
    ]);
  });
  it.each(["pending", "granted", "rejected", "expired", "revoked"])(
    "validates the %s state",
    (state) => {
      const value = {
        ...readGrant(),
        state,
        consentProofDigest: state === "granted" ? "c".repeat(64) : null,
      };
      expect(validateChatToolReadGrant(value)).toEqual({ ok: true, value });
    },
  );

  it.each([
    { schemaVersion: "2" },
    { kind: "jira-write-grant" },
    { grantId: "" },
    { disclosureVersion: "unreviewed-disclosure" },
    { state: "approved" },
    { requestedAt: -1 },
    { requestedAt: Number.NaN },
    { expiresAt: 1_700_000_000_000 },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { state: "granted", consentProofDigest: null },
    { state: "granted", consentProofDigest: "secret" },
    { consentProofDigest: "c".repeat(64) },
    { connectorScopes: ["issue-tracker.write"] },
    { authority: "model-chosen" },
    { subject: { ...envelope().subject, authenticationGeneration: 0 } },
  ])("rejects malformed or broadened grant facts %#", (patch) => {
    expect(validateChatToolReadGrant({ ...readGrant(), ...patch }).ok).toBe(false);
  });

  it.each(["grantId", "state", "consentProofDigest", "subject"])("requires own %s facts", (key) => {
    const value: Record<string, unknown> = { ...readGrant() };
    const inherited = value[key];
    const ownFields = Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
    Object.setPrototypeOf(ownFields, { [key]: inherited });
    expect(validateChatToolReadGrant(ownFields).ok).toBe(false);
  });

  it.each([null, [], "grant"])("rejects non-object input %#", (value) => {
    expect(validateChatToolReadGrant(value).ok).toBe(false);
  });

  it("retains the acceptance proof when a granted scope expires or is revoked", () => {
    for (const state of ["expired", "revoked"])
      expect(
        validateChatToolReadGrant({ ...readGrant(), state, consentProofDigest: "c".repeat(64) }).ok,
      ).toBe(true);
  });

  it("does not echo hostile unknown fields in diagnostics", () => {
    const result = validateChatToolReadGrant({
      ...readGrant(),
      "private-token-must-not-appear": "private-value",
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private-");
  });
});

describe("configured MCP Chat authority", () => {
  const subject = {
    kind: "configured-mcp",
    actorDigest: "a".repeat(64),
    chatId: "chat-mcp",
    configurationDigest: "c".repeat(64),
  };
  it("accepts a configuration-bound subject without any fabricated Pod or workspace", () => {
    expect(validateChatToolAuthoritySubject(subject)).toEqual({ ok: true, value: subject });
    const value = { ...envelope(), subject, connectorScopes: ["mcp.tools"] };
    expect(validateChatToolAuthorityEnvelope(value)).toEqual({ ok: true, value });
  });
  it.each([
    { configurationDigest: "bad" },
    { kind: "jira" },
    { podId: "d5f5681e-ce98-4c3c-b27e-51d707c9d018" },
    { bindingGeneration: 1 },
    { authenticationGeneration: 1 },
    { endpoint: "https://private.example.invalid" },
  ])("rejects mixed or unbound MCP subjects %j", (patch) => {
    expect(validateChatToolAuthoritySubject({ ...subject, ...patch }).ok).toBe(false);
  });
  it("does not permit a scope from another subject family", () => {
    expect(validateChatToolAuthorityEnvelope({ ...envelope(), subject }).ok).toBe(false);
    expect(
      validateChatToolAuthorityEnvelope({ ...envelope(), connectorScopes: ["mcp.tools"] }).ok,
    ).toBe(false);
  });
  it("keeps MCP consent distinct from Jira consent", () => {
    const value = {
      ...readGrant(),
      subject,
      kind: "mcp-chat-read-grant",
      disclosureVersion: "mcp-chat-read-v1",
    };
    expect(validateChatToolReadGrant(value)).toEqual({ ok: true, value });
    expect(validateChatToolReadGrant({ ...value, disclosureVersion: "jira-chat-read-v1" }).ok).toBe(
      false,
    );
    expect(validateChatToolReadGrant({ ...value, kind: "jira-chat-read-grant" }).ok).toBe(false);
  });
});

import { expectTypeOf } from "vitest";
import * as authoritySource from "./chat-tool-authority.js";
import * as authorityPublic from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import type { CodingWorkbenchValidationResult } from "./coding-workbench.js";

type ExpectedChatAuthorityValidators = [
  (value: unknown) => CodingWorkbenchValidationResult<authoritySource.ChatToolAuthoritySubject>,
  (value: unknown) => CodingWorkbenchValidationResult<authoritySource.ChatToolAuthorityEnvelope>,
  (value: unknown) => CodingWorkbenchValidationResult<authoritySource.ChatToolReadConsentDecision>,
  (value: unknown) => CodingWorkbenchValidationResult<authoritySource.ChatToolReadGrant>,
  (value: unknown) => CodingWorkbenchValidationResult<authoritySource.ChatToolWriteApprovalView>,
  (
    value: unknown,
  ) => CodingWorkbenchValidationResult<authoritySource.ChatToolWriteApprovalDecision>,
];

type ChatAuthorityAdmissionCase = readonly [
  name: string,
  source: (value: unknown) => CodingWorkbenchValidationResult<unknown>,
  published: (value: unknown) => CodingWorkbenchValidationResult<unknown>,
  makeInput: () => unknown,
  nonRecordError: string,
];

function mcpWriteApprovalProjection(): authoritySource.ChatToolWriteApprovalView {
  return {
    kind: "mcp-chat-write",
    approvalId: "approval-mcp-1",
    chatId: "chat-mcp-1",
    configurationDigest: "c".repeat(64),
    invocationId: "invocation-mcp-1",
    operation: "notes_lookup",
    actionDigest: "d".repeat(64),
    requestedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_600_000,
    state: "pending",
  };
}

const authorityAdmissionCases: readonly ChatAuthorityAdmissionCase[] = [
  [
    "subject",
    authoritySource.validateChatToolAuthoritySubject,
    authorityPublic.validateChatToolAuthoritySubject,
    (): authoritySource.ChatToolAuthoritySubject => envelope().subject,
    "chatAuthority.subject must be an object",
  ],
  [
    "envelope",
    authoritySource.validateChatToolAuthorityEnvelope,
    authorityPublic.validateChatToolAuthorityEnvelope,
    envelope,
    "chatAuthority must be an object",
  ],
  [
    "read consent",
    authoritySource.validateChatToolReadConsentDecision,
    authorityPublic.validateChatToolReadConsentDecision,
    (): authoritySource.ChatToolReadConsentDecision => ({
      decision: "approve",
      disclosureVersion: authoritySource.MCP_CHAT_READ_DISCLOSURE_VERSION,
    }),
    "chatReadConsent must be an object",
  ],
  [
    "read grant",
    authoritySource.validateChatToolReadGrant,
    authorityPublic.validateChatToolReadGrant,
    readGrant,
    "chatReadGrant must be an object",
  ],
  [
    "write projection",
    authoritySource.validateChatToolWriteApprovalView,
    authorityPublic.validateChatToolWriteApprovalView,
    mcpWriteApprovalProjection,
    "chatWriteApproval must be an object",
  ],
  [
    "write decision",
    authoritySource.validateChatToolWriteApprovalDecision,
    authorityPublic.validateChatToolWriteApprovalDecision,
    (): authoritySource.ChatToolWriteApprovalDecision => ({
      decision: "approve",
      actionDigest: "e".repeat(64),
    }),
    "chatWriteDecision must be an object",
  ],
];

describe("concrete Chat authority admission", () => {
  it("retains the six concrete unknown-input source and public signatures", () => {
    expectTypeOf<
      [
        typeof authoritySource.validateChatToolAuthoritySubject,
        typeof authoritySource.validateChatToolAuthorityEnvelope,
        typeof authoritySource.validateChatToolReadConsentDecision,
        typeof authoritySource.validateChatToolReadGrant,
        typeof authoritySource.validateChatToolWriteApprovalView,
        typeof authoritySource.validateChatToolWriteApprovalDecision,
      ]
    >().toEqualTypeOf<ExpectedChatAuthorityValidators>();
    expectTypeOf<
      [
        typeof authorityPublic.validateChatToolAuthoritySubject,
        typeof authorityPublic.validateChatToolAuthorityEnvelope,
        typeof authorityPublic.validateChatToolReadConsentDecision,
        typeof authorityPublic.validateChatToolReadGrant,
        typeof authorityPublic.validateChatToolWriteApprovalView,
        typeof authorityPublic.validateChatToolWriteApprovalDecision,
      ]
    >().toEqualTypeOf<ExpectedChatAuthorityValidators>();
  });

  it.each(authorityAdmissionCases)(
    "preserves admitted %s identity and its complete non-record refusal",
    (_name, source, published, makeInput, nonRecordError): void => {
      for (const validate of [source, published]) {
        const value = makeInput();
        const result = validate(value);
        expect(result).toEqual({ ok: true, value });
        if (!result.ok) throw new TypeError("Expected admitted Chat authority fixture");
        expect(result.value).toBe(value);
        expect(validate(null)).toEqual({ ok: false, errors: [nonRecordError] });
      }
    },
  );

  it("keeps the full ordered authority diagnostics without exposing unknown private fields", () => {
    const input = {
      ...envelope(),
      schemaVersion: "2",
      runId: "",
      effectiveMode: "autonomous-delivery",
      budget: { ...envelope().budget, maxPatchBytes: 1 },
      approvalProofDigest: "",
      "private-field-must-not-appear": "private-value",
    };
    const errors = [
      "chatAuthority has unknown fields",
      "chatAuthority kind or schemaVersion is invalid",
      "chatAuthority.runId must be a bounded safe identifier",
      "chatAuthority.effectiveMode must match the shared mode ceiling",
      "chatAuthority.budget.maxPatchBytes must be zero",
      "chatAuthority.approvalProofDigest must be a SHA-256 digest",
    ];
    for (const validate of [
      authoritySource.validateChatToolAuthorityEnvelope,
      authorityPublic.validateChatToolAuthorityEnvelope,
    ])
      expect(validate(input)).toEqual({ ok: false, errors });
  });

  it("preserves consent getter phases, admitted identity and the exact second-read failure", () => {
    for (const validate of [
      authoritySource.validateChatToolReadConsentDecision,
      authorityPublic.validateChatToolReadConsentDecision,
    ]) {
      let reads = 0;
      const value = {
        decision: "approve",
        get disclosureVersion(): string {
          reads += 1;
          return authoritySource.MCP_CHAT_READ_DISCLOSURE_VERSION;
        },
      };
      const result = validate(value);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new TypeError("Expected admitted consent fixture");
      expect(result.value).toBe(value);
      expect(reads).toBe(2);
      const failure: TypeError = Object.freeze(new TypeError("consent second read failed"));
      let attempts = 0;
      const hostile = {
        decision: "approve",
        get disclosureVersion(): string {
          attempts += 1;
          if (attempts === 2) throw failure;
          return authoritySource.MCP_CHAT_READ_DISCLOSURE_VERSION;
        },
      };
      let caught: unknown;
      try {
        validate(hostile);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(attempts).toBe(2);
    }
  });
});

// REVIEW-3918-013: this module and bff-wire import each other. A process whose first contracts
// import is this public subpath must still load, and bff-wire must then read the grant states at
// call time; a load-time read either throws a TDZ ReferenceError or rejects every read grant.
const FIRST_IMPORT_CONTROL = `
import { strict as assert } from "node:assert";
const authority = await import("@oscharko-dev/keiko-contracts/runtime/chat-tool-authority");
const wire = await import("@oscharko-dev/keiko-contracts/runtime/bff-wire");
const view = (state) => ({
  kind: "jira-chat-read", grantId: "grant-1", chatId: "chat-1", state,
  disclosureVersion: authority.CHAT_TOOL_READ_DISCLOSURE_VERSION, requestedAt: 1, expiresAt: 2,
  podId: "pod-1", bindingGeneration: 1, authenticationGeneration: 1,
});
for (const state of authority.CHAT_TOOL_READ_GRANT_STATES)
  assert.equal(wire.isChatToolReadGrantView(view(state)), true, state);
assert.equal(wire.isChatToolReadGrantView(view("approved")), false);
`;

describe("chat tool authority module graph (REVIEW-3918-013)", () => {
  it("loads as the first contracts import and validates read-grant views afterwards", () => {
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", FIRST_IMPORT_CONTROL],
      {
        encoding: "utf8",
        timeout: 10_000,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024,
      },
    );
    expect(child.error).toBeUndefined();
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: "" });
  });
});
