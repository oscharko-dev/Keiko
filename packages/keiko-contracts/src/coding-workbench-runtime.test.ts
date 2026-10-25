import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchRuntimeAuthorityEnvelope,
} from "./index.js";
import { CODING_WORKBENCH_ACTION_CLASSES } from "./coding-workbench.js";
import {
  CODING_WORKBENCH_RUNTIME_STATE_NAMES,
  isLegalCodingWorkbenchRuntimeTransition,
  validateCodingWorkbenchRuntimeAuthorityEnvelope,
  validateCodingWorkbenchRuntimeAdapterStartRequest,
  validateCodingWorkbenchRuntimeAuthorityFacts,
  validateCodingWorkbenchRuntimeIntent,
  validateCodingWorkbenchRuntimeMintConfirmation,
  validateCodingWorkbenchRuntimeState,
} from "./coding-workbench-runtime.js";

const DIGEST = "a".repeat(64);

// F9 (#3873): the closed causes a failed run settles with instead of `runtime-failed` (an internal
// error): its own bounds, a repeated output exhaustion, an unreachable provider, a failed model call.
const TERMINAL_RUN_CAUSES = [
  "prompt-allowance-exhausted",
  "envelope-duration-exhausted",
  "output-exhausted-repeated",
  "provider-unavailable",
  "model-turn-failed",
] as const;

function authority(): CodingWorkbenchAuthorityEnvelope {
  return {
    schemaVersion: "1",
    runId: "run-1",
    localUser: "operator-1",
    taskRefs: ["task-1"],
    workspace: { workspaceId: "workspace-1", rootLabel: "workspace", rootDigest: DIGEST },
    branch: {
      baseRef: "dev",
      headRef: "issue/2252",
      allowDetachedHead: false,
      allowedPrefixes: ["issue/"],
    },
    requestedMode: "supervised-coding",
    deploymentCeiling: "autonomous-delivery",
    effectiveMode: "supervised-coding",
    runtimeSource: "keiko-sidecar",
    actionClasses: CODING_WORKBENCH_ACTION_CLASSES,
    connectorScopes: [],
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
    gates: ["human-approval"],
    budget: {
      maxRuntimeMs: 60_000,
      maxToolCalls: 10,
      maxPromptTokens: 10_000,
      maxPatchBytes: 65_536,
    },
    expiresAt: "2026-07-11T13:00:00.000Z",
    approvalProofDigest: DIGEST,
  };
}

function runtimeAuthority(): CodingWorkbenchRuntimeAuthorityEnvelope {
  return {
    schemaVersion: "1",
    authority: authority(),
    binding: {
      taskId: "task-1",
      projectId: "project-1",
      projectDigest: DIGEST,
      workspaceId: "workspace-1",
      workspaceRootDigest: DIGEST,
      branchRef: "issue/2252",
      branchHeadDigest: DIGEST,
    },
    intentDigest: DIGEST,
    nonceDigest: DIGEST,
    issuedAt: "2026-07-11T12:00:00.000Z",
  };
}

describe("Coding Workbench runtime contracts", () => {
  it("accepts the minimal start intent and rejects every client-authored authority field", () => {
    const intent = {
      schemaVersion: "1",
      requestId: "request-1",
      command: "start",
      taskIntent: "Investigate the failing unit test",
      requestedMode: "supervised-coding",
      modelSource: "keiko-model-gateway",
    };
    expect(validateCodingWorkbenchRuntimeIntent(intent)).toEqual({ ok: true, value: intent });
    for (const key of [
      "path",
      "argv",
      "endpoint",
      "environment",
      "credential",
      "deploymentCeiling",
      "actionClasses",
      "budget",
      "projectRoot",
    ]) {
      expect(validateCodingWorkbenchRuntimeIntent({ ...intent, [key]: "forged" })).toMatchObject({
        ok: false,
      });
    }
  });

  it("keeps lifecycle commands closed and run-bound", () => {
    expect(
      validateCodingWorkbenchRuntimeIntent({
        schemaVersion: "1",
        requestId: "r",
        command: "stop",
        runId: "run-1",
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateCodingWorkbenchRuntimeIntent({
        schemaVersion: "1",
        requestId: "r",
        command: "pause",
        runId: "run-1",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeIntent({ schemaVersion: "1", requestId: "r", command: "stop" }),
    ).toMatchObject({ ok: false });
  });

  it("defines all twelve states and only explicit transitions", () => {
    expect(CODING_WORKBENCH_RUNTIME_STATE_NAMES).toHaveLength(12);
    expect(CODING_WORKBENCH_RUNTIME_STATE_NAMES).toContain("paused");
    expect(isLegalCodingWorkbenchRuntimeTransition("idle", "starting")).toBe(true);
    expect(isLegalCodingWorkbenchRuntimeTransition("starting", "stopping")).toBe(true);
    expect(isLegalCodingWorkbenchRuntimeTransition("running", "idle")).toBe(false);
    expect(isLegalCodingWorkbenchRuntimeTransition("taken-over", "idle")).toBe(true);
  });

  // KEIKO-0539: `unavailable` was declared as a legal FSM state with real transitions but no
  // orchestrator code path ever produced it (host-qualification is reported exclusively through
  // the unrelated `codingRuntimeUnavailableReason` field). Pin its removal so the state vocabulary
  // never quietly regrows a state nothing can ever reach.
  it("removes the unreachable unavailable state from the state vocabulary (KEIKO-0539)", () => {
    expect(CODING_WORKBENCH_RUNTIME_STATE_NAMES).toHaveLength(12);
    expect(CODING_WORKBENCH_RUNTIME_STATE_NAMES).not.toContain("unavailable");
    expect(
      validateCodingWorkbenchRuntimeState({
        schemaVersion: "1",
        state: "unavailable",
        revision: 0,
        updatedAt: "2026-07-11T12:00:00.000Z",
      }),
    ).toMatchObject({ ok: false });
  });

  it("pauses and resumes only through the explicit paused transitions", () => {
    expect(isLegalCodingWorkbenchRuntimeTransition("running", "paused")).toBe(true);
    expect(isLegalCodingWorkbenchRuntimeTransition("paused", "running")).toBe(true);
    expect(isLegalCodingWorkbenchRuntimeTransition("paused", "awaiting-approval")).toBe(true);
    expect(isLegalCodingWorkbenchRuntimeTransition("paused", "stopping")).toBe(true);
    // Paused is a run-bound halt, never a direct terminal-success or idle transition.
    expect(isLegalCodingWorkbenchRuntimeTransition("paused", "succeeded")).toBe(false);
    expect(isLegalCodingWorkbenchRuntimeTransition("paused", "idle")).toBe(false);
    expect(isLegalCodingWorkbenchRuntimeTransition("idle", "paused")).toBe(false);
  });

  it("validates the server-owned binding and rejects content-bearing or mismatched fields", () => {
    expect(validateCodingWorkbenchRuntimeAuthorityEnvelope(runtimeAuthority())).toMatchObject({
      ok: true,
    });
    expect(
      validateCodingWorkbenchRuntimeAuthorityEnvelope({ ...runtimeAuthority(), prompt: "secret" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeAuthorityEnvelope({
        ...runtimeAuthority(),
        binding: { ...runtimeAuthority().binding, workspaceRootDigest: "b".repeat(64) },
      }),
    ).toMatchObject({ ok: false });
  });

  // Epic #3384 correction 8: the issue binding is a fact of the run's public snapshot
  // (`CodingWorkbenchRuntimeSnapshot.issueBinding`) only. Restating it on the execution binding —
  // embedded in both the runtime authority envelope and the runtime authority facts — would create
  // a second source of truth for the same fact, so both validators must reject it as an unknown key
  // even though it is a legal field name on `CodingWorkbenchIssueBinding` elsewhere in this module.
  it("rejects issueBinding on the execution binding and the authority facts binding (epic #3384 correction 8)", () => {
    const forgedEnvelopeBinding = {
      ...runtimeAuthority(),
      binding: {
        ...runtimeAuthority().binding,
        issueBinding: {
          schemaVersion: "1",
          repositoryId: "repo-1",
          remoteDigest: DIGEST,
          issueNumber: 1,
          issueIdDigest: DIGEST,
          contentRevisionDigest: DIGEST,
          defaultBaseRef: "dev",
          bindingDigest: DIGEST,
        },
      },
    };
    expect(validateCodingWorkbenchRuntimeAuthorityEnvelope(forgedEnvelopeBinding)).toMatchObject({
      ok: false,
    });
    const forgedFactsBinding = {
      binding: {
        taskId: "task-1",
        projectId: "project-1",
        projectDigest: DIGEST,
        workspaceId: "workspace-1",
        workspaceRootDigest: DIGEST,
        branchRef: "issue/2252",
        branchHeadDigest: DIGEST,
        issueBinding: {
          schemaVersion: "1",
          repositoryId: "repo-1",
          remoteDigest: DIGEST,
          issueNumber: 1,
          issueIdDigest: DIGEST,
          contentRevisionDigest: DIGEST,
          defaultBaseRef: "dev",
          bindingDigest: DIGEST,
        },
      },
      actionClasses: [],
      connectorScopes: [],
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
      budgetDigest: DIGEST,
      commandPolicyDigest: DIGEST,
      networkPolicyDigest: DIGEST,
      gatesDigest: DIGEST,
      branchConstraintsDigest: DIGEST,
      modelProfileDigest: DIGEST,
    };
    expect(validateCodingWorkbenchRuntimeAuthorityFacts(forgedFactsBinding)).toMatchObject({
      ok: false,
    });
    // The clean binding (no issueBinding) remains valid on both — the removal above is additive
    // strictness, not a regression in the fields the binding legitimately carries.
    expect(validateCodingWorkbenchRuntimeAuthorityEnvelope(runtimeAuthority())).toMatchObject({
      ok: true,
    });
  });

  it.each([
    ["task", { binding: { ...runtimeAuthority().binding, taskId: "other" } }],
    ["workspace", { binding: { ...runtimeAuthority().binding, workspaceId: "other" } }],
    ["root", { binding: { ...runtimeAuthority().binding, workspaceRootDigest: "b".repeat(64) } }],
    ["branch", { binding: { ...runtimeAuthority().binding, branchRef: "other" } }],
  ])("rejects a %s correlation mismatch", (_axis, override) => {
    expect(
      validateCodingWorkbenchRuntimeAuthorityEnvelope({ ...runtimeAuthority(), ...override }),
    ).toMatchObject({ ok: false });
  });

  it("validates exact-key state, confirmation, adapter request, and live facts", () => {
    const state = {
      schemaVersion: "1",
      state: "idle",
      revision: 0,
      updatedAt: "2026-07-11T12:00:00.000Z",
    };
    expect(validateCodingWorkbenchRuntimeState(state)).toMatchObject({ ok: true });
    expect(validateCodingWorkbenchRuntimeState({ ...state, revision: -1 })).toMatchObject({
      ok: false,
    });
    expect(validateCodingWorkbenchRuntimeState({ ...state, updatedAt: "bad" })).toMatchObject({
      ok: false,
    });
    expect(validateCodingWorkbenchRuntimeState({ ...state, prompt: "content" })).toMatchObject({
      ok: false,
    });
    const confirmation = {
      approvalId: "approval",
      approvalToken: "token",
      taskId: "task-1",
      operatorId: "operator-1",
      intentDigest: DIGEST,
      expiresAt: "2026-07-11T13:00:00.000Z",
    };
    expect(validateCodingWorkbenchRuntimeMintConfirmation(confirmation)).toMatchObject({
      ok: true,
    });
    expect(
      validateCodingWorkbenchRuntimeMintConfirmation({ ...confirmation, rawPrompt: "content" }),
    ).toMatchObject({ ok: false });
    const adapter = {
      authorityRef: { runId: "run-1", envelopeDigest: DIGEST },
      delegationId: "d-1",
      idempotencyKey: "i-1",
      binding: runtimeAuthority().binding,
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
    };
    expect(validateCodingWorkbenchRuntimeAdapterStartRequest(adapter)).toMatchObject({ ok: true });
    expect(
      validateCodingWorkbenchRuntimeAdapterStartRequest({ ...adapter, argv: [] }),
    ).toMatchObject({ ok: false });
    const facts = {
      binding: runtimeAuthority().binding,
      actionClasses: [],
      connectorScopes: [],
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
      budgetDigest: DIGEST,
      commandPolicyDigest: DIGEST,
      networkPolicyDigest: DIGEST,
      gatesDigest: DIGEST,
      branchConstraintsDigest: DIGEST,
      modelProfileDigest: DIGEST,
    };
    expect(validateCodingWorkbenchRuntimeAuthorityFacts(facts)).toMatchObject({ ok: true });
    expect(
      validateCodingWorkbenchRuntimeAuthorityFacts({ ...facts, response: "content" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeAuthorityFacts({ ...facts, actionClasses: ["shell-root"] }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeAuthorityFacts({ ...facts, connectorScopes: ["secrets.read"] }),
    ).toMatchObject({ ok: false });
  });

  it("enforces state-dependent binding and closed optional fields", () => {
    const active = {
      schemaVersion: "1",
      state: "running",
      revision: 1,
      updatedAt: "2026-07-11T12:00:00.000Z",
      runId: "run-1",
      taskId: "task-1",
      workspaceId: "workspace-1",
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
    };
    expect(validateCodingWorkbenchRuntimeState(active)).toMatchObject({ ok: true });
    expect(validateCodingWorkbenchRuntimeState({ ...active, runId: undefined })).toMatchObject({
      ok: false,
    });
    expect(
      validateCodingWorkbenchRuntimeState({ ...active, runtimeSource: "unknown" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeState({ ...active, failureCode: "raw-error" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeState({ ...active, failureCode: "runtime-failed" }),
    ).toMatchObject({ ok: false });
    // F5 (#3873): the refusal causes are failures of a settled run only, never of a live one.
    for (const failureCode of ["edits-blocked", "edit-retries-exhausted"]) {
      expect(validateCodingWorkbenchRuntimeState({ ...active, failureCode })).toMatchObject({
        ok: false,
      });
      expect(
        validateCodingWorkbenchRuntimeState({ ...active, state: "failed", failureCode }),
      ).toMatchObject({ ok: true });
    }
    expect(
      validateCodingWorkbenchRuntimeState({ ...active, updatedAt: "2026-07-11 12:00:00" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeState({ ...active, updatedAt: "2026-02-30T12:00:00.000Z" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeState({ ...active, state: "failed", failureCode: undefined }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeState({
        ...active,
        state: "failed",
        failureCode: "approval-activation-failed",
      }),
    ).toMatchObject({ ok: true });
    expect(validateCodingWorkbenchRuntimeState({ ...active, state: "idle" })).toMatchObject({
      ok: false,
    });
    expect(
      validateCodingWorkbenchRuntimeState({
        schemaVersion: "1",
        state: "recovery-required",
        revision: 1,
        updatedAt: "2026-07-11T12:00:00.000Z",
        failureCode: "recovery-required",
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateCodingWorkbenchRuntimeState({
        ...active,
        state: "recovery-required",
        failureCode: "recovery-required",
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateCodingWorkbenchRuntimeState({
        ...active,
        state: "recovery-required",
        taskId: undefined,
        failureCode: "recovery-required",
      }),
    ).toMatchObject({ ok: false });
  });

  // F9 (#3873): the terminal causes are failures of a settled run only. A live run never
  // carries one, and a per-turn gateway cause never stands in for one.
  it.each(TERMINAL_RUN_CAUSES)(
    "binds the %s terminal cause to a failed run state only",
    (failureCode) => {
      const failed = {
        schemaVersion: "1",
        state: "failed",
        revision: 4,
        updatedAt: "2026-07-11T12:00:00.000Z",
        runId: "run-1",
        taskId: "task-1",
        workspaceId: "workspace-1",
        runtimeSource: "keiko-sidecar",
        modelSource: "keiko-model-gateway",
        failureCode,
      };
      expect(validateCodingWorkbenchRuntimeState(failed)).toMatchObject({ ok: true });
      expect(validateCodingWorkbenchRuntimeState({ ...failed, state: "running" })).toMatchObject({
        ok: false,
      });
      expect(
        validateCodingWorkbenchRuntimeState({ ...failed, failureCode: "stream-incomplete" }),
      ).toMatchObject({ ok: false });
    },
  );
});

describe("Coding Workbench runtime contract failure branches", () => {
  function facts(): Record<string, unknown> {
    return {
      binding: runtimeAuthority().binding,
      actionClasses: [],
      connectorScopes: [],
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
      budgetDigest: DIGEST,
      commandPolicyDigest: DIGEST,
      networkPolicyDigest: DIGEST,
      gatesDigest: DIGEST,
      branchConstraintsDigest: DIGEST,
      modelProfileDigest: DIGEST,
    };
  }

  function adapter(): Record<string, unknown> {
    return {
      authorityRef: { runId: "run-1", envelopeDigest: DIGEST },
      delegationId: "d-1",
      idempotencyKey: "i-1",
      binding: runtimeAuthority().binding,
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
    };
  }

  it("rejects a foreign schema version on every runtime surface", () => {
    expect(
      validateCodingWorkbenchRuntimeIntent({
        schemaVersion: "2",
        requestId: "r",
        command: "stop",
        runId: "run-1",
      }),
    ).toMatchObject({ ok: false, errors: ["schemaVersion is invalid"] });
    expect(
      validateCodingWorkbenchRuntimeAuthorityEnvelope({ ...runtimeAuthority(), schemaVersion: 1 }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeState({
        schemaVersion: "0",
        state: "idle",
        revision: 0,
        updatedAt: "2026-07-11T12:00:00.000Z",
      }),
    ).toMatchObject({ ok: false, errors: ["schemaVersion is invalid"] });
  });

  it("rejects a bounded-overflow or empty start task intent", () => {
    const start = {
      schemaVersion: "1",
      requestId: "r",
      command: "start",
      taskIntent: "x".repeat(65_537),
      requestedMode: "supervised-coding",
      modelSource: "keiko-model-gateway",
    };
    expect(validateCodingWorkbenchRuntimeIntent(start)).toMatchObject({
      ok: false,
      errors: ["taskIntent must be a bounded non-empty string"],
    });
    expect(validateCodingWorkbenchRuntimeIntent({ ...start, taskIntent: "" })).toMatchObject({
      ok: false,
    });
  });

  it("rejects non-array authority scopes and unknown sources on live facts", () => {
    expect(
      validateCodingWorkbenchRuntimeAuthorityFacts({ ...facts(), actionClasses: "all" }),
    ).toMatchObject({ ok: false, errors: ["authority scopes must be arrays"] });
    expect(
      validateCodingWorkbenchRuntimeAuthorityFacts({ ...facts(), runtimeSource: "external" }),
    ).toMatchObject({ ok: false, errors: ["runtimeSource is invalid"] });
    expect(
      validateCodingWorkbenchRuntimeAuthorityFacts({ ...facts(), modelSource: "external" }),
    ).toMatchObject({ ok: false, errors: ["modelSource is invalid"] });
  });

  // issueBindingDigest is optional on live facts (epic #3384 correction 8: the execution binding
  // never carries the issue binding itself, only this content-free fingerprint the drift check
  // compares — see agentAuthorityRegistry.ts's issueBindingDiffers).
  it("accepts live facts with no bound issue and a valid issueBindingDigest, rejects a malformed one", () => {
    expect(validateCodingWorkbenchRuntimeAuthorityFacts(facts())).toMatchObject({ ok: true });
    expect(
      validateCodingWorkbenchRuntimeAuthorityFacts({ ...facts(), issueBindingDigest: DIGEST }),
    ).toMatchObject({ ok: true });
    expect(
      validateCodingWorkbenchRuntimeAuthorityFacts({
        ...facts(),
        issueBindingDigest: "not-a-digest",
      }),
    ).toMatchObject({
      ok: false,
      errors: ["issueBindingDigest must be a 64-character lowercase hex digest"],
    });
  });

  it("rejects unknown sources on the adapter start request", () => {
    expect(
      validateCodingWorkbenchRuntimeAdapterStartRequest({ ...adapter(), runtimeSource: "shell" }),
    ).toMatchObject({ ok: false, errors: ["runtimeSource is invalid"] });
    expect(
      validateCodingWorkbenchRuntimeAdapterStartRequest({ ...adapter(), modelSource: "shell" }),
    ).toMatchObject({ ok: false, errors: ["modelSource is invalid"] });
  });

  it("fails closed on a non-object binding, malformed digests, and malformed instants", () => {
    expect(
      validateCodingWorkbenchRuntimeAuthorityEnvelope({ ...runtimeAuthority(), binding: "b" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeAuthorityEnvelope({
        ...runtimeAuthority(),
        intentDigest: "A".repeat(64),
      }),
    ).toMatchObject({
      ok: false,
      errors: ["intentDigest must be a 64-character lowercase hex digest"],
    });
    expect(
      validateCodingWorkbenchRuntimeAuthorityEnvelope({
        ...runtimeAuthority(),
        issuedAt: "not-a-date",
      }),
    ).toMatchObject({ ok: false, errors: ["issuedAt must be a strict UTC instant"] });
    for (const issuedAt of ["2026-02-31T00:00:00Z", "Jul 31 2026 Z"]) {
      expect(
        validateCodingWorkbenchRuntimeAuthorityEnvelope({ ...runtimeAuthority(), issuedAt }),
      ).toMatchObject({ ok: false });
    }
  });

  it("rejects empty optional identity fields and unknown model sources on runtime state", () => {
    const active = {
      schemaVersion: "1",
      state: "running",
      revision: 1,
      updatedAt: "2026-07-11T12:00:00.000Z",
      runId: "run-1",
      taskId: "task-1",
      workspaceId: "workspace-1",
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
    };
    const emptyTask = validateCodingWorkbenchRuntimeState({ ...active, taskId: "" });
    expect(emptyTask.ok).toBe(false);
    if (!emptyTask.ok) expect(emptyTask.errors).toContain("taskId must be a non-empty string");
    expect(validateCodingWorkbenchRuntimeState({ ...active, modelSource: "other" })).toMatchObject({
      ok: false,
      errors: ["modelSource is invalid"],
    });
  });
});

describe("coding workbench runtime module structure (KEIKO-0532)", () => {
  it("does not re-declare the validation primitives owned by coding-workbench-runtime-api-validation.ts", () => {
    // isRecord, isOneOf, unknownKeys, result, and validateStrictIso used to be re-declared here
    // byte-for-byte identical to their coding-workbench-runtime-api-validation.ts counterparts
    // (exactKeys / validateStrictUtcInstant there). This module now imports them instead of
    // keeping a second copy; a re-introduced local declaration must fail this pin.
    const source = readFileSync(
      fileURLToPath(new URL("./coding-workbench-runtime.ts", import.meta.url)),
      "utf8",
    );
    const forbiddenLocalDeclaration =
      /^function isRecord|^function isOneOf|^function unknownKeys|^function result|^function validateStrictIso/m;
    expect(forbiddenLocalDeclaration.test(source)).toBe(false);
  });
});

// PRIVATE C1B source/public hypothesis controls: UNEXECUTED, no regression claimed.
function c1bAuthorityFacts(): Record<string, unknown> {
  return {
    binding: runtimeAuthority().binding,
    actionClasses: authority().actionClasses,
    connectorScopes: [],
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    budgetDigest: DIGEST,
    commandPolicyDigest: DIGEST,
    networkPolicyDigest: DIGEST,
    gatesDigest: DIGEST,
    branchConstraintsDigest: DIGEST,
    modelProfileDigest: DIGEST,
  };
}
describe("C1B runtime physical scope admission", () => {
  it.each(["source", "public"])(
    "retains actual healthy facts and binding identity through %s",
    async (seam) => {
      const validate =
        seam === "source"
          ? validateCodingWorkbenchRuntimeAuthorityFacts
          : (await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime"))
              .validateCodingWorkbenchRuntimeAuthorityFacts;
      const input = c1bAuthorityFacts();
      const result = validate(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(input);
      expect(result.value.binding).toBe(input.binding);
      expect(result.value.actionClasses).toBe(input.actionClasses);
    },
  );
  it.each([
    { field: "actionClasses", seam: "source" },
    { field: "actionClasses", seam: "public" },
    { field: "connectorScopes", seam: "source" },
    { field: "connectorScopes", seam: "public" },
  ])("refuses skipped $field through $seam", async ({ field, seam }) => {
    const validate =
      seam === "source"
        ? validateCodingWorkbenchRuntimeAuthorityFacts
        : (await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime"))
            .validateCodingWorkbenchRuntimeAuthorityFacts;
    const entries = ["invalid-member"];
    Object.defineProperty(entries, "every", { value: (): boolean => true });
    expect(validate({ ...c1bAuthorityFacts(), [field]: entries }).ok).toBe(false);
  });
  it.each([
    { field: "actionClasses", seam: "source" },
    { field: "actionClasses", seam: "public" },
    { field: "connectorScopes", seam: "source" },
    { field: "connectorScopes", seam: "public" },
  ])("refuses missing $field through $seam", async ({ field, seam }) => {
    const validate =
      seam === "source"
        ? validateCodingWorkbenchRuntimeAuthorityFacts
        : (await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime"))
            .validateCodingWorkbenchRuntimeAuthorityFacts;
    expect(validate({ ...c1bAuthorityFacts(), [field]: Array<unknown>(1) }).ok).toBe(false);
  });
});

function c1bPreview(): Record<string, unknown> {
  return {
    untrusted: true,
    title: "fixture",
    bodyExcerpt: "fixture",
    bodyExcerptTruncated: false,
    commentCount: 0,
    comments: [],
    commentsTruncated: false,
    state: "open",
    provenance: {
      ownerAndRepo: "owner/repo",
      issueNumber: 1,
      url: "https://github.com/owner/repo/issues/1",
    },
  };
}
describe("C1B additional original runtime observations", () => {
  it.each(["source", "public"] as const)(
    "preserves healthy preview reference through %s",
    async (seam) => {
      const input = c1bPreview();
      const validator =
        seam === "source"
          ? (await import("./coding-workbench-runtime.js")).validateCodingWorkbenchIssuePreview
          : (await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime"))
              .validateCodingWorkbenchIssuePreview;
      const result = validator(input);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("healthy preview refusal");
      expect(result.value).toBe(input);
      expect(result.value.provenance).toBe(input.provenance);
      expect(result.value.comments).toBe(input.comments);
    },
  );
  it.each(["source", "public"] as const)(
    "rejects hidden malformed preview comment through %s",
    async (seam) => {
      const entries: unknown[] = [7];
      Object.defineProperty(entries, "some", { value: () => false });
      const input = { ...c1bPreview(), comments: entries };
      const validator =
        seam === "source"
          ? (await import("./coding-workbench-runtime.js")).validateCodingWorkbenchIssuePreview
          : (await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime"))
              .validateCodingWorkbenchIssuePreview;
      expect(validator(input).ok).toBe(false);
    },
  );
  it.each(["source", "public"] as const)(
    "rejects sparse preview comment through %s",
    async (seam) => {
      const input = { ...c1bPreview(), comments: new Array<unknown>(1) };
      const validator =
        seam === "source"
          ? (await import("./coding-workbench-runtime.js")).validateCodingWorkbenchIssuePreview
          : (await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime"))
              .validateCodingWorkbenchIssuePreview;
      expect(validator(input).ok).toBe(false);
    },
  );
  it.each(["source", "public"] as const)(
    "rejects numeric second revision observation through %s",
    async (seam) => {
      let reads = 0;
      const input = { schemaVersion: "1", state: "idle", updatedAt: "2026-07-08T12:00:00Z" };
      Object.defineProperty(input, "revision", {
        enumerable: true,
        get: () => (++reads === 1 ? 0 : "0"),
      });
      const validator =
        seam === "source"
          ? validateCodingWorkbenchRuntimeState
          : (await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime"))
              .validateCodingWorkbenchRuntimeState;
      expect(validator(input).ok).toBe(false);
      expect(reads).toBe(2);
    },
  );
  it.each(["source", "public"] as const)(
    "preserves healthy numeric revision reads through %s",
    async (seam) => {
      let reads = 0;
      const input = { schemaVersion: "1", state: "idle", updatedAt: "2026-07-08T12:00:00Z" };
      Object.defineProperty(input, "revision", {
        enumerable: true,
        get: () => {
          reads += 1;
          return 0;
        },
      });
      const validator =
        seam === "source"
          ? validateCodingWorkbenchRuntimeState
          : (await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime"))
              .validateCodingWorkbenchRuntimeState;
      const result = validator(input);
      expect(result.ok).toBe(true);
      expect(reads).toBe(2);
      if (!result.ok) throw new Error("healthy state refusal");
      expect(result.value).toBe(input);
    },
  );
  it.each(["source", "public"] as const)(
    "rejects a later invalid intent discriminator through %s",
    async (seam) => {
      let reads = 0;
      const input = {
        schemaVersion: "1",
        requestId: "req-1",
        taskIntent: "fixture",
        requestedMode: "supervised-coding",
        modelSource: "keiko-model-gateway",
      };
      Object.defineProperty(input, "command", {
        enumerable: true,
        get: () => (++reads <= 2 ? "start" : "invalid"),
      });
      const validator =
        seam === "source"
          ? validateCodingWorkbenchRuntimeIntent
          : (await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime"))
              .validateCodingWorkbenchRuntimeIntent;
      expect(validator(input).ok).toBe(false);
    },
  );
  it.each(["source", "public"] as const)(
    "rejects a later non-string preview title through %s",
    async (seam) => {
      let reads = 0;
      const input = c1bPreview();
      Object.defineProperty(input, "title", {
        enumerable: true,
        get: () => (++reads === 1 ? "fixture" : { length: 0 }),
      });
      const validator =
        seam === "source"
          ? (await import("./coding-workbench-runtime.js")).validateCodingWorkbenchIssuePreview
          : (await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime"))
              .validateCodingWorkbenchIssuePreview;
      expect(validator(input).ok).toBe(false);
    },
  );
});

function c1bInvalidCapturedNumber(invalidKind: string, field: string): number {
  return invalidKind === "NaN"
    ? Number.NaN
    : invalidKind === "fraction"
      ? field === "issueNumber"
        ? 1.5
        : 0.5
      : invalidKind === "infinity"
        ? Number.POSITIVE_INFINITY
        : Number.MAX_SAFE_INTEGER + 1;
}

describe("C1B numeric captured observation wave", () => {
  const fields = ["revision", "commentCount", "issueNumber"] as const;
  const invalid = ["NaN", "fraction", "infinity", "unsafe"] as const;
  const invalidCases = fields.flatMap((field) =>
    invalid.flatMap((invalidKind) =>
      ["source", "public"].map((seam) => ({ field, invalidKind, seam })),
    ),
  );
  it.each(invalidCases)(
    "rejects second $invalidKind $field through $seam",
    async ({ field, invalidKind, seam }) => {
      let reads = 0;
      const input: Record<string, unknown> =
        field === "revision"
          ? { schemaVersion: "1", state: "idle", updatedAt: "2026-07-08T12:00:00Z" }
          : c1bPreview();
      const target: unknown = field === "issueNumber" ? input.provenance : input;
      if (typeof target !== "object" || target === null)
        throw new Error("invalid numeric fixture target");
      const bad = c1bInvalidCapturedNumber(invalidKind, field);
      Object.defineProperty(target, field, {
        enumerable: true,
        get: () => (++reads === 1 ? (field === "issueNumber" ? 1 : 0) : bad),
      });
      const module =
        seam === "source"
          ? await import("./coding-workbench-runtime.js")
          : await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime");
      const result =
        field === "revision"
          ? module.validateCodingWorkbenchRuntimeState(input)
          : module.validateCodingWorkbenchIssuePreview(input);
      expect(result.ok).toBe(false);
      expect(reads).toBe(2);
    },
  );
  const healthyCases = fields.flatMap((field) =>
    ["same", "changed"].flatMap((schedule) =>
      ["source", "public"].map((seam) => ({ field, schedule, seam })),
    ),
  );
  it.each(healthyCases)(
    "preserves $schedule integer $field through $seam",
    async ({ field, schedule, seam }) => {
      let reads = 0;
      const input: Record<string, unknown> =
        field === "revision"
          ? { schemaVersion: "1", state: "idle", updatedAt: "2026-07-08T12:00:00Z" }
          : c1bPreview();
      const target: unknown = field === "issueNumber" ? input.provenance : input;
      if (typeof target !== "object" || target === null)
        throw new Error("invalid numeric fixture target");
      const first = field === "issueNumber" ? 1 : 0;
      Object.defineProperty(target, field, {
        enumerable: true,
        get: () => {
          reads += 1;
          return schedule === "same" || reads === 1 ? first : first + 1;
        },
      });
      const module =
        seam === "source"
          ? await import("./coding-workbench-runtime.js")
          : await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime");
      const result =
        field === "revision"
          ? module.validateCodingWorkbenchRuntimeState(input)
          : module.validateCodingWorkbenchIssuePreview(input);
      expect(result.ok).toBe(true);
      expect(reads).toBe(2);
      if (!result.ok) throw new Error("healthy numeric refusal");
      expect(result.value).toBe(input);
    },
  );
});

describe("C1B fourth command observation wave", () => {
  it.each(["source", "public"] as const)(
    "rejects invalid fourth command through %s",
    async (seam) => {
      let reads = 0;
      const commands = ["start", "start", "stop", "invalid"];
      const input = {
        schemaVersion: "1",
        requestId: "req-1",
        taskIntent: "fixture",
        requestedMode: "supervised-coding",
        modelSource: "keiko-model-gateway",
      };
      Object.defineProperty(input, "command", { enumerable: true, get: () => commands[reads++] });
      const module =
        seam === "source"
          ? await import("./coding-workbench-runtime.js")
          : await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime");
      expect(module.validateCodingWorkbenchRuntimeIntent(input)).toEqual({
        ok: false,
        errors: ["command is invalid"],
      });
      expect(reads).toBe(4);
    },
  );
  it.each(["source", "public"] as const)(
    "preserves finite healthy command schedules through %s",
    async (seam) => {
      const module =
        seam === "source"
          ? await import("./coding-workbench-runtime.js")
          : await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime");
      for (const commands of [
        ["start", "start", "start"],
        ["stop", "stop", "stop", "stop"],
        ["stop", "stop", "stop", "recover"],
      ]) {
        let reads = 0;
        const input =
          commands[0] === "start"
            ? {
                schemaVersion: "1",
                requestId: "req-1",
                taskIntent: "fixture",
                requestedMode: "supervised-coding",
                modelSource: "keiko-model-gateway",
              }
            : { schemaVersion: "1", requestId: "req-1", runId: "run-1" };
        Object.defineProperty(input, "command", { enumerable: true, get: () => commands[reads++] });
        const result = module.validateCodingWorkbenchRuntimeIntent(input);
        expect(result.ok).toBe(true);
        expect(reads).toBe(commands.length);
        if (!result.ok) throw new Error("healthy command refused");
        expect(result.value).toBe(input);
      }
    },
  );
});

describe("C1B command diagnostic preservation wave", () => {
  it.each(["source", "public"] as const)(
    "retains one command diagnostic through %s",
    async (seam) => {
      let reads = 0;
      const commands = ["stop", "invalid", "invalid", "stop"];
      const input = { schemaVersion: "1", requestId: "req-1", runId: "run-1" };
      Object.defineProperty(input, "command", { enumerable: true, get: () => commands[reads++] });
      const module =
        seam === "source"
          ? await import("./coding-workbench-runtime.js")
          : await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime");
      expect(module.validateCodingWorkbenchRuntimeIntent(input)).toEqual({
        ok: false,
        errors: ["command is invalid"],
      });
      expect(reads).toBe(4);
    },
  );
});

describe("C1B runtime closed ingress branches", () => {
  it.each([
    "validateCodingWorkbenchRuntimeIntent",
    "validateCodingWorkbenchRuntimeAuthorityEnvelope",
    "validateCodingWorkbenchRuntimeState",
    "validateCodingWorkbenchRuntimeMintConfirmation",
    "validateCodingWorkbenchRuntimeAuthorityFacts",
    "validateCodingWorkbenchRuntimeAdapterStartRequest",
    "validateCodingWorkbenchIssuePreview",
  ] as const)("refuses non-object through source and public %s", async (name) => {
    const source = await import("./coding-workbench-runtime.js");
    const publicModule =
      await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime");
    expect(source[name](null).ok).toBe(false);
    expect(publicModule[name](null).ok).toBe(false);
  });
  it("preserves missing request and run identity diagnostics before success", () => {
    expect(
      validateCodingWorkbenchRuntimeIntent({ schemaVersion: "1", requestId: "", command: "stop" }),
    ).toEqual({
      ok: false,
      errors: ["requestId must be a non-empty string", "runId must be a non-empty string"],
    });
    const input = { ...runtimeAuthority(), authority: null };
    expect(validateCodingWorkbenchRuntimeAuthorityEnvelope(input).ok).toBe(false);
  });
});

it("preserves full authority-validator digest observation order (#3918)", async () => {
  const publicModule =
    await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime");
  const observations = [];
  for (const validate of [
    validateCodingWorkbenchRuntimeAuthorityEnvelope,
    publicModule.validateCodingWorkbenchRuntimeAuthorityEnvelope,
  ]) {
    for (const variant of ["equal", "mismatch", "non-record", "digest-throws"] as const) {
      const input = runtimeAuthority();
      const binding = input.binding;
      const trace: string[] = [];
      const failure = new TypeError("fixture observation failure");
      Object.defineProperty(input.authority.workspace, "rootDigest", {
        enumerable: true,
        get: (): string => {
          trace.push("expected");
          return DIGEST;
        },
      });
      Object.defineProperty(input, "binding", {
        enumerable: true,
        get: (): unknown => {
          trace.push("binding");
          return variant === "non-record" ? null : binding;
        },
      });
      Object.defineProperty(binding, "workspaceRootDigest", {
        enumerable: true,
        get: (): string => {
          trace.push("digest");
          if (variant === "digest-throws") throw failure;
          return variant === "mismatch" ? "b".repeat(64) : DIGEST;
        },
      });
      let outcome: boolean | "threw";
      try {
        outcome = validate(input).ok;
      } catch (error) {
        expect(error).toBe(failure);
        outcome = "threw";
      }
      observations.push(`${variant}:${String(outcome)}:${trace.join(">")}`);
    }
  }
  expect(observations.join("\n")).toMatchInlineSnapshot(`
    "equal:true:expected>binding>digest>expected>binding>digest>binding>binding
    mismatch:false:expected>binding>digest>expected>binding>digest>binding>binding
    non-record:false:expected>binding>expected>binding>binding
    digest-throws:threw:expected>binding>digest
    equal:true:expected>binding>digest>expected>binding>digest>binding>binding
    mismatch:false:expected>binding>digest>expected>binding>digest>binding>binding
    non-record:false:expected>binding>expected>binding>binding
    digest-throws:threw:expected>binding>digest"
  `);
});

function requiredSourcePairInput(kind: "facts" | "adapter"): Record<string, unknown> {
  const facts = c1bAuthorityFacts();
  if (kind === "facts") return facts;
  return {
    authorityRef: { runId: "run-1", envelopeDigest: DIGEST },
    delegationId: "d-1",
    idempotencyKey: "i-1",
    binding: facts.binding,
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
  };
}

function observeRequiredSources(
  input: Record<string, unknown>,
  trace: string[],
  healthy: boolean,
  missing: boolean,
): void {
  const binding = input.binding;
  Object.defineProperty(input, "binding", {
    enumerable: true,
    get: (): unknown => {
      trace.push("binding");
      return binding;
    },
  });
  Object.defineProperty(input, "runtimeSource", {
    enumerable: true,
    get: (): unknown => {
      trace.push("runtimeSource");
      if (missing) return undefined;
      return healthy ? "keiko-sidecar" : "invalid";
    },
  });
  Object.defineProperty(input, "modelSource", {
    enumerable: true,
    get: (): unknown => {
      trace.push("modelSource");
      if (missing) return undefined;
      return healthy ? "keiko-model-gateway" : "invalid";
    },
  });
}

describe("required runtime and model source admission", () => {
  it.each([
    ["source", "facts"],
    ["public", "facts"],
    ["source", "adapter"],
    ["public", "adapter"],
  ] as const)("preserves eager reads and diagnostic order through %s %s", async (surface, kind) => {
    const module =
      surface === "source"
        ? await import("./coding-workbench-runtime.js")
        : await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime");
    const validate =
      kind === "facts"
        ? module.validateCodingWorkbenchRuntimeAuthorityFacts
        : module.validateCodingWorkbenchRuntimeAdapterStartRequest;
    for (const variant of ["healthy", "invalid-both", "missing-both", "prior-invalid"] as const) {
      const input = requiredSourcePairInput(kind);
      const trace: string[] = [];
      if (variant === "prior-invalid") input.binding = null;
      observeRequiredSources(input, trace, variant === "healthy", variant === "missing-both");
      const result = validate(input);
      expect(trace).toEqual(["binding", "runtimeSource", "modelSource"]);
      if (variant === "healthy") {
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value).toBe(input);
      } else {
        expect(result).toEqual({
          ok: false,
          errors: [
            ...(variant === "prior-invalid" ? ["binding must be an object"] : []),
            "runtimeSource is invalid",
            "modelSource is invalid",
          ],
        });
      }
    }
  });

  it.each([
    ["source", "facts"],
    ["public", "facts"],
    ["source", "adapter"],
    ["public", "adapter"],
  ] as const)("preserves source getter exceptions through %s %s", async (surface, kind) => {
    const module =
      surface === "source"
        ? await import("./coding-workbench-runtime.js")
        : await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime");
    const validate =
      kind === "facts"
        ? module.validateCodingWorkbenchRuntimeAuthorityFacts
        : module.validateCodingWorkbenchRuntimeAdapterStartRequest;
    for (const throwingField of ["runtimeSource", "modelSource"] as const) {
      const input = requiredSourcePairInput(kind);
      const trace: string[] = [];
      const failure = new TypeError("fixture source read refused");
      for (const field of ["runtimeSource", "modelSource"] as const) {
        Object.defineProperty(input, field, {
          enumerable: true,
          get: (): string => {
            trace.push(field);
            if (field === throwingField) throw failure;
            return "invalid";
          },
        });
      }
      expect(() => validate(input)).toThrow(failure);
      expect(trace).toEqual(
        throwingField === "runtimeSource" ? ["runtimeSource"] : ["runtimeSource", "modelSource"],
      );
    }
  });
});

async function envelopeStateValidator(
  surface: "source" | "public",
): Promise<typeof validateCodingWorkbenchRuntimeState> {
  return surface === "source"
    ? validateCodingWorkbenchRuntimeState
    : (await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime"))
        .validateCodingWorkbenchRuntimeState;
}

async function envelopeAuthorityValidator(
  surface: "source" | "public",
): Promise<
  typeof import("./coding-workbench-validation.js").validateCodingWorkbenchAuthorityEnvelope
> {
  return surface === "source"
    ? (await import("./coding-workbench-validation.js")).validateCodingWorkbenchAuthorityEnvelope
    : (await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation"))
        .validateCodingWorkbenchAuthorityEnvelope;
}

function envelopeIdleState(): Record<string, unknown> {
  return { schemaVersion: "1", state: "idle", revision: 0, updatedAt: "2026-07-08T12:00:00Z" };
}

for (const surface of ["source", "public"] as const) {
  it(`${surface}: preserves the idle-state envelope's accepted reference`, async () => {
    const validate = await envelopeStateValidator(surface);
    const value = envelopeIdleState();
    const result = validate(value);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(value);
  });

  it(`${surface}: returns independent state failure envelopes and readonly arrays`, async () => {
    const validate = await envelopeStateValidator(surface);
    const first = validate(null);
    const second = validate(null);
    expect(first).toEqual({ ok: false, errors: ["runtime state must be an object"] });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    if (!first.ok && !second.ok) expect(second.errors).not.toBe(first.errors);
  });

  it(`${surface}: keeps the state's complete ordered admission errors`, async () => {
    const validate = await envelopeStateValidator(surface);
    expect(
      validate({
        ...envelopeIdleState(),
        unexpected: true,
        schemaVersion: "invalid",
        state: "invalid",
        revision: -1,
      }),
    ).toEqual({
      ok: false,
      errors: [
        "runtimeState.unexpected is not allowed",
        "schemaVersion is invalid",
        "state is invalid",
        "revision must be non-negative",
      ],
    });
  });

  it(`${surface}: preserves late state inspection after an earlier admission error`, async () => {
    const validate = await envelopeStateValidator(surface);
    const value = { ...envelopeIdleState(), schemaVersion: "invalid" };
    const failure = new TypeError("Late state envelope inspection");
    const trace: string[] = [];
    Object.defineProperties(value, {
      revision: {
        get: (): number => {
          trace.push("revision");
          return 0;
        },
      },
      updatedAt: {
        get: (): never => {
          trace.push("updatedAt");
          throw failure;
        },
      },
    });
    let caught: unknown;
    try {
      validate(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(trace).toEqual(["revision", "revision", "updatedAt"]);
  });

  it(`${surface}: preserves authority identity and all three gate observations`, async () => {
    const validate = await envelopeAuthorityValidator(surface);
    const value = authority();
    const gates = value.gates;
    const trace: string[] = [];
    Object.defineProperty(value, "gates", {
      get: (): readonly string[] => {
        trace.push("gates");
        return gates;
      },
    });
    const result = validate(value);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(value);
    expect(trace).toEqual(["gates", "gates", "gates"]);
  });

  it(`${surface}: returns independent authority failure envelopes and readonly arrays`, async () => {
    const validate = await envelopeAuthorityValidator(surface);
    const first = validate(null);
    const second = validate(null);
    expect(first).toEqual({ ok: false, errors: ["authority envelope must be an object"] });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    if (!first.ok && !second.ok) expect(second.errors).not.toBe(first.errors);
  });

  it(`${surface}: eagerly retains every authority consistency-tail refusal in order`, async () => {
    const validate = await envelopeAuthorityValidator(surface);
    const value = {
      ...authority(),
      actionClasses: ["workspace-write", "command-execution"],
      connectorScopes: ["source-control.read"],
      gates: ["verification-green"],
      networkPolicy: {
        mode: "deny-all",
        allowLoopback: false,
        connectorScopes: ["issue-tracker.read"],
      },
    };
    expect(validate(value)).toEqual({
      ok: false,
      errors: [
        "authorityEnvelope.networkPolicy.connectorScopes must be empty when mode is deny-all",
        "authorityEnvelope.networkPolicy.connectorScopes[0] must be listed in authorityEnvelope.connectorScopes",
        "authorityEnvelope.networkPolicy.connectorScopes must be empty when authorityEnvelope.actionClasses omits network-egress",
        "authorityEnvelope.connectorScopes must be empty when authorityEnvelope.actionClasses omits connector-access",
        "authorityEnvelope.gates must include human-approval when authorityEnvelope.actionClasses or connector scopes grant elevated authority",
      ],
    });
  });

  it(`${surface}: reaches final authority gate inspection after earlier policy refusal`, async () => {
    const validate = await envelopeAuthorityValidator(surface);
    const value = { ...authority(), approvalProofDigest: "invalid" };
    const gates = value.gates;
    const trace: string[] = [];
    const failure = new TypeError("Late authority tail inspection");
    Object.defineProperty(value, "gates", {
      get: (): readonly string[] => {
        trace.push("gates");
        if (trace.length === 2) throw failure;
        return gates;
      },
    });
    let caught: unknown;
    try {
      validate(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(trace).toEqual(["gates", "gates"]);
  });
}
