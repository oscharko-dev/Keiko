import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  CodingWorkbenchRuntimeAuthorityFacts,
  CodingWorkbenchRuntimeIntent,
} from "@oscharko-dev/keiko-contracts";
import { validateCodingWorkbenchRuntimeAuthorityFacts } from "@oscharko-dev/keiko-contracts";
import { EditorAgentAuthorityRegistry } from "../editor/agentAuthorityRegistry.js";
import {
  CodingRuntimeAuthorityService,
  codingRuntimeBudgetDigest,
  codingRuntimeFactDigest,
  type CodingRuntimeMintResult,
  type CodingRuntimeResolution,
  type CodingRuntimeTrustedContext,
} from "./runtimeAuthorityService.js";

const NOW = "2026-07-11T12:00:00.000Z";
const ROOT = "/managed/project/task-2252";
const DIGEST = "a".repeat(64);
const intent: Extract<CodingWorkbenchRuntimeIntent, { readonly command: "start" }> = {
  schemaVersion: "1",
  requestId: "request-1",
  command: "start",
  taskIntent: "Implement issue",
  requestedMode: "supervised-coding",
  modelSource: "keiko-model-gateway",
};

function context(): CodingRuntimeTrustedContext {
  return {
    operatorId: "operator-1",
    taskId: "task-2252",
    projectId: "project-1",
    projectDigest: DIGEST,
    workspaceId: "workspace-1",
    workspaceRoot: ROOT,
    branchRef: "issue-2252",
    branchHeadDigest: DIGEST,
    branch: {
      baseRef: "dev",
      headRef: "issue-2252",
      allowDetachedHead: false,
      allowedPrefixes: ["issue-"],
    },
    deploymentCeiling: "autonomous-delivery",
    runtimeSource: "keiko-sidecar",
    actionClasses: ["workspace-read", "workspace-write", "command-execution", "verification"],
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
  };
}

function facts(
  overrides: Partial<CodingWorkbenchRuntimeAuthorityFacts> = {},
): CodingWorkbenchRuntimeAuthorityFacts {
  const trusted = context();
  return {
    binding: {
      taskId: trusted.taskId,
      projectId: trusted.projectId,
      projectDigest: trusted.projectDigest,
      workspaceId: trusted.workspaceId,
      workspaceRootDigest: createHash("sha256").update(ROOT).digest("hex"),
      branchRef: trusted.branchRef,
      branchHeadDigest: trusted.branchHeadDigest,
    },
    actionClasses: trusted.actionClasses,
    connectorScopes: [],
    runtimeSource: trusted.runtimeSource,
    modelSource: trusted.modelProfile.source,
    budgetDigest: codingRuntimeBudgetDigest(trusted.budget),
    commandPolicyDigest: codingRuntimeFactDigest(trusted.commandPolicy),
    networkPolicyDigest: codingRuntimeFactDigest(trusted.networkPolicy),
    gatesDigest: codingRuntimeFactDigest(trusted.gates),
    branchConstraintsDigest: codingRuntimeFactDigest(trusted.branch),
    modelProfileDigest: codingRuntimeFactDigest(trusted.modelProfile),
    ...overrides,
  };
}

function service(): CodingRuntimeAuthorityService {
  return new CodingRuntimeAuthorityService(
    new EditorAgentAuthorityRegistry(),
    () => "run-1",
    () => "nonce-1",
  );
}

function mint(
  authority: CodingRuntimeAuthorityService,
  startIntent = intent,
  makeRunning = true,
): CodingRuntimeMintResult {
  const trusted = context();
  const confirmation = authority.confirmStart(startIntent, trusted.taskId, trusted.operatorId, NOW);
  const minted = authority.mintStart(startIntent, trusted, confirmation, NOW);
  if (minted.ok && makeRunning) {
    authority.transition(minted.authorityRef.runId, "ready", NOW);
    authority.transition(minted.authorityRef.runId, "running", NOW);
  }
  return minted;
}

function resolve(
  authority: CodingRuntimeAuthorityService,
  reference: { readonly runId: string; readonly envelopeDigest: string },
  live = facts(),
  delegationId = "delegation-1",
  usage = { toolCalls: 1, patchBytes: 1, promptTokens: 1 },
  idempotencyKey = `key-${delegationId}`,
): CodingRuntimeResolution {
  return authority.resolveForDelegation(
    reference,
    live,
    delegationId,
    idempotencyKey,
    usage,
    ROOT,
    "autonomous-delivery",
    NOW,
  );
}

describe("CodingRuntimeAuthorityService", () => {
  it("uses a one-use confirmation to mint retained server authority", () => {
    const authority = service();
    const trusted = context();
    const confirmation = authority.confirmStart(intent, trusted.taskId, trusted.operatorId, NOW);
    const minted = authority.mintStart(intent, trusted, confirmation, NOW);
    expect(minted).toMatchObject({ ok: true, authorityRef: { runId: "run-1" } });
    expect(authority.mintStart(intent, trusted, confirmation, NOW)).toEqual({
      ok: false,
      reason: "active-run-conflict",
    });
    if (!minted.ok) throw new Error("expected mint");
    authority.transition(minted.authorityRef.runId, "ready", NOW);
    authority.transition(minted.authorityRef.runId, "running", NOW);
    expect(resolve(authority, minted.authorityRef)).toMatchObject({
      ok: true,
      envelope: { authority: { localUser: "operator-1" } },
    });
    expect(resolve(authority, minted.authorityRef, facts(), "delegation-2")).toMatchObject({
      ok: true,
    });
    expect(
      JSON.stringify(resolve(authority, minted.authorityRef, facts(), "delegation-3")),
    ).not.toContain(intent.taskIntent);
  });

  it("rejects replay of a delegation identity while retaining the run envelope", () => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("expected mint");
    expect(resolve(authority, minted.authorityRef)).toMatchObject({ ok: true });
    expect(resolve(authority, minted.authorityRef)).toEqual({
      ok: false,
      reason: "authority-replayed",
    });
  });

  it("rejects reuse of either delegation identity and binds the original usage", () => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("mint");
    expect(
      resolve(
        authority,
        minted.authorityRef,
        facts(),
        "d-1",
        { toolCalls: 1, patchBytes: 2, promptTokens: 3 },
        "key-1",
      ),
    ).toMatchObject({ ok: true });
    expect(
      resolve(
        authority,
        minted.authorityRef,
        facts(),
        "d-1",
        { toolCalls: 9, patchBytes: 9, promptTokens: 9 },
        "key-2",
      ),
    ).toEqual({ ok: false, reason: "authority-replayed" });
    expect(
      resolve(
        authority,
        minted.authorityRef,
        facts(),
        "d-2",
        { toolCalls: 1, patchBytes: 2, promptTokens: 3 },
        "key-1",
      ),
    ).toEqual({ ok: false, reason: "authority-replayed" });
  });

  it("returns a deterministic concurrent-start conflict", () => {
    const authority = service();
    expect(mint(authority)).toMatchObject({ ok: true });
    expect(mint(authority, { ...intent, requestId: "request-2" })).toEqual({
      ok: false,
      reason: "active-run-conflict",
    });
  });

  it.each([
    ["task-drift", { binding: { ...facts().binding, taskId: "other" } }],
    ["workspace-drift", { binding: { ...facts().binding, workspaceId: "other" } }],
    ["project-drift", { binding: { ...facts().binding, projectDigest: "b".repeat(64) } }],
    ["branch-drift", { binding: { ...facts().binding, branchHeadDigest: "b".repeat(64) } }],
    ["scope-drift", { actionClasses: ["workspace-read"] }],
    ["budget-drift", { budgetDigest: "b".repeat(64) }],
    ["source-drift", { runtimeSource: "codex-cli-adapter" }],
    ["scope-drift", { commandPolicyDigest: "b".repeat(64) }],
    ["scope-drift", { networkPolicyDigest: "b".repeat(64) }],
    ["scope-drift", { gatesDigest: "b".repeat(64) }],
    ["scope-drift", { branchConstraintsDigest: "b".repeat(64) }],
    ["scope-drift", { modelProfileDigest: "b".repeat(64) }],
  ] as const)("rejects %s", (reason, override) => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("expected mint");
    expect(resolve(authority, minted.authorityRef, facts(override))).toEqual({ ok: false, reason });
  });

  it.each([
    { requestId: "swapped" },
    { taskIntent: "swapped" },
    { requestedMode: "governed-assist" as const },
    { modelSource: "chatgpt-codex-subscription-profile" as const },
  ])("rejects a start-intent swap: $requestId$taskIntent$requestedMode$modelSource", (swap) => {
    const authority = service();
    const confirmation = authority.confirmStart(
      intent,
      context().taskId,
      context().operatorId,
      NOW,
    );
    expect(authority.mintStart({ ...intent, ...swap }, context(), confirmation, NOW)).toMatchObject(
      { ok: false },
    );
  });

  it("rejects confirmation consumption by another authenticated operator", () => {
    const authority = service();
    const trusted = context();
    const confirmation = authority.confirmStart(intent, trusted.taskId, trusted.operatorId, NOW);
    expect(
      authority.mintStart(intent, { ...trusted, operatorId: "operator-2" }, confirmation, NOW),
    ).toEqual({ ok: false, reason: "authority-resolution-failed" });
  });

  it("reserves all delegation budgets once per id", () => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("mint");
    const usage = { toolCalls: 10, patchBytes: 65_536, promptTokens: 10_000 };
    expect(validateCodingWorkbenchRuntimeAuthorityFacts(facts())).toMatchObject({ ok: true });
    expect(resolve(authority, minted.authorityRef, facts(), "budgeted", usage)).toMatchObject({
      ok: true,
    });
    expect(resolve(authority, minted.authorityRef, facts(), "budgeted", usage)).toEqual({
      ok: false,
      reason: "authority-replayed",
    });
    expect(
      resolve(authority, minted.authorityRef, facts(), "fresh", {
        toolCalls: 1,
        patchBytes: 0,
        promptTokens: 0,
      }),
    ).toEqual({ ok: false, reason: "authority-budget-exceeded" });
  });

  it("owns legal lifecycle transitions and rejects illegal or wrong-run transitions", () => {
    const authority = service();
    const minted = mint(authority, intent, false);
    if (!minted.ok) throw new Error("mint");
    expect(authority.state()).toMatchObject({ state: "starting", runId: "run-1", revision: 1 });
    expect(authority.transition("run-1", "running", NOW)).toBe(false);
    expect(authority.transition("other", "ready", NOW)).toBe(false);
    expect(authority.transition("run-1", "ready", NOW)).toBe(true);
    expect(authority.transition("run-1", "running", NOW)).toBe(true);
    expect(authority.transition("run-1", "succeeded", NOW)).toBe(true);
    expect(authority.transition("run-1", "idle", NOW)).toBe(true);
    expect(authority.transition(undefined, "recovery-required", NOW, "recovery-required")).toBe(
      true,
    );
  });

  it.each([
    ["starting", []],
    ["ready", ["ready"]],
    ["running", ["ready", "running"]],
    ["awaiting-approval", ["ready", "running", "awaiting-approval"]],
    ["stopping", ["ready", "stopping"]],
    ["succeeded", ["ready", "running", "succeeded"]],
    ["failed", ["failed"]],
    ["cancelled", ["cancelled"]],
    ["taken-over", ["taken-over"]],
    ["recovery-required", ["recovery-required"]],
    ["idle", ["cancelled", "idle"]],
    ["unavailable", ["recovery-required", "unavailable"]],
  ] as const)("permits productive delegation only in %s state", (state, path) => {
    const authority = service();
    const minted = mint(authority, intent, false);
    if (!minted.ok) throw new Error("mint");
    for (const target of path)
      expect(
        authority.transition(
          authority.state().runId,
          target,
          NOW,
          target === "failed" || target === "recovery-required" ? "runtime-failed" : undefined,
        ),
      ).toBe(true);
    const result = resolve(authority, minted.authorityRef);
    expect(result.ok).toBe(state === "running");
  });

  it("revokes stop/takeover authority and releases the active-run slot", () => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("expected mint");
    authority.revoke(minted.authorityRef.runId, NOW);
    expect(resolve(authority, minted.authorityRef)).toEqual({
      ok: false,
      reason: "authority-resolution-failed",
    });
    expect(mint(authority, { ...intent, requestId: "request-2" })).toMatchObject({ ok: false });
    expect(authority.transition("run-1", "idle", NOW)).toBe(true);
    expect(mint(authority, { ...intent, requestId: "request-2" })).toMatchObject({ ok: true });
  });
});
