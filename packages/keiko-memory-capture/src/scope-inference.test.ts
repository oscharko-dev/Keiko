import { describe, expect, it } from "vitest";

import type {
  MemoryScope,
  ProjectId,
  UserId,
  WorkflowDefinitionId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";

import { inferScopeFromContext } from "./scope-inference.js";
import type { CaptureContext } from "./types.js";

function ctx(overrides: Partial<CaptureContext> = {}): CaptureContext {
  const base: CaptureContext = {
    userId: "u-1" as UserId,
    nowMs: 1_700_000_000_000,
    newMemoryId: () => "m-1" as never,
    newProposalId: () => "p-1" as never,
    ...overrides,
  };
  return base;
}

describe("inferScopeFromContext", () => {
  it("defaults to user scope when only userId is present", () => {
    const scope = inferScopeFromContext(ctx(), {});
    expect(scope).toEqual<MemoryScope>({ kind: "user", userId: "u-1" as UserId });
  });

  it("prefers project scope when projectId is available and no explicit kind is set", () => {
    const scope = inferScopeFromContext(ctx({ projectId: "p-1" as ProjectId }), {});
    expect(scope).toEqual<MemoryScope>({ kind: "project", projectId: "p-1" as ProjectId });
  });

  it("respects an explicit scopeKind=user even when projectId is set", () => {
    const scope = inferScopeFromContext(ctx({ projectId: "p-1" as ProjectId }), {
      scopeKind: "user",
    });
    expect(scope).toEqual<MemoryScope>({ kind: "user", userId: "u-1" as UserId });
  });

  it("returns null when scopeKind=project but no projectId on context (fail-closed)", () => {
    expect(inferScopeFromContext(ctx(), { scopeKind: "project" })).toBeNull();
  });

  it("returns null when scopeKind=workspace but no workspaceId on context (fail-closed)", () => {
    expect(inferScopeFromContext(ctx(), { scopeKind: "workspace" })).toBeNull();
  });

  it("returns null when scopeKind=workflow but no workflowDefinitionId on context (fail-closed)", () => {
    expect(inferScopeFromContext(ctx(), { scopeKind: "workflow" })).toBeNull();
  });

  it("returns workspace scope when context has workspaceId", () => {
    const scope = inferScopeFromContext(ctx({ workspaceId: "w-1" as WorkspaceId }), {
      scopeKind: "workspace",
    });
    expect(scope).toEqual<MemoryScope>({ kind: "workspace", workspaceId: "w-1" as WorkspaceId });
  });

  it("returns workflow scope when context has workflowDefinitionId", () => {
    const scope = inferScopeFromContext(
      ctx({ workflowDefinitionId: "wf-1" as WorkflowDefinitionId }),
      { scopeKind: "workflow" },
    );
    expect(scope).toEqual<MemoryScope>({
      kind: "workflow",
      workflowDefinitionId: "wf-1" as WorkflowDefinitionId,
    });
  });

  it("rejects global scope unless allowGlobalScope=true", () => {
    expect(inferScopeFromContext(ctx(), { scopeKind: "global" })).toBeNull();
  });

  it("accepts global scope only when allowGlobalScope=true is explicitly opted in", () => {
    const scope = inferScopeFromContext(ctx(), { scopeKind: "global", allowGlobalScope: true });
    expect(scope).toEqual<MemoryScope>({ kind: "global" });
  });
});
