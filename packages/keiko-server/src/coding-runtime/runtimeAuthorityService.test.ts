import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  CodingWorkbenchRuntimeAuthorityFacts,
  CodingWorkbenchRuntimeIntent,
} from "@oscharko-dev/keiko-contracts";
import { EditorAgentAuthorityRegistry } from "../editor/agentAuthorityRegistry.js";
import {
  CodingRuntimeAuthorityService,
  codingRuntimeBudgetDigest,
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
): CodingRuntimeMintResult {
  const trusted = context();
  const confirmation = authority.confirmStart(startIntent, trusted.taskId, NOW);
  return authority.mintStart(startIntent, trusted, confirmation, NOW);
}

function resolve(
  authority: CodingRuntimeAuthorityService,
  reference: { readonly runId: string; readonly envelopeDigest: string },
  live = facts(),
  delegationId = "delegation-1",
): CodingRuntimeResolution {
  return authority.resolveForDelegation(
    reference,
    live,
    delegationId,
    ROOT,
    "autonomous-delivery",
    NOW,
  );
}

describe("CodingRuntimeAuthorityService", () => {
  it("uses a one-use confirmation to mint retained server authority", () => {
    const authority = service();
    const trusted = context();
    const confirmation = authority.confirmStart(intent, trusted.taskId, NOW);
    const minted = authority.mintStart(intent, trusted, confirmation, NOW);
    expect(minted).toMatchObject({ ok: true, authorityRef: { runId: "run-1" } });
    expect(authority.mintStart(intent, trusted, confirmation, NOW)).toEqual({
      ok: false,
      reason: "active-run-conflict",
    });
    if (!minted.ok) throw new Error("expected mint");
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
  ] as const)("rejects %s", (reason, override) => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("expected mint");
    expect(resolve(authority, minted.authorityRef, facts(override))).toEqual({ ok: false, reason });
  });

  it("revokes stop/takeover authority and releases the active-run slot", () => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("expected mint");
    authority.revoke(minted.authorityRef.runId);
    expect(resolve(authority, minted.authorityRef)).toEqual({
      ok: false,
      reason: "authority-resolution-failed",
    });
    expect(mint(authority, { ...intent, requestId: "request-2" })).toMatchObject({ ok: true });
  });
});
