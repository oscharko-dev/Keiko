// Scope inference for keiko-memory-capture. Fail-closed: when the requested scope kind requires
// a coordinate (project/workspace/workflow) that is absent from the CaptureContext, the helper
// returns `null` so the top-level capture function emits a `scope-not-resolvable` rejection
// rather than silently downgrading to a less-specific scope (which would leak a project-scoped
// memory into the user's global view).

import type { MemoryScope, MemoryScopeKind } from "@oscharko-dev/keiko-contracts/memory";

import type { CaptureContext } from "./types.js";

interface ScopeInferenceOptions {
  readonly scopeKind?: MemoryScopeKind;
  readonly allowGlobalScope?: boolean;
}

// When no explicit scopeKind is supplied, pick the most specific coordinate available on the
// context. Precedence: project > workspace > workflow > user. This matches the user mental
// model that captures made INSIDE a project are project-scoped by default.
function pickImplicitScopeKind(context: CaptureContext): MemoryScopeKind {
  if (context.projectId !== undefined) {
    return "project";
  }
  if (context.workspaceId !== undefined) {
    return "workspace";
  }
  if (context.workflowDefinitionId !== undefined) {
    return "workflow";
  }
  return "user";
}

function resolveExplicitScope(
  kind: MemoryScopeKind,
  context: CaptureContext,
  allowGlobal: boolean,
): MemoryScope | null {
  if (kind === "global") {
    return allowGlobal ? { kind: "global" } : null;
  }
  if (kind === "user") {
    return { kind: "user", userId: context.userId };
  }
  if (kind === "project") {
    return context.projectId === undefined
      ? null
      : { kind: "project", projectId: context.projectId };
  }
  if (kind === "workspace") {
    return context.workspaceId === undefined
      ? null
      : { kind: "workspace", workspaceId: context.workspaceId };
  }
  return context.workflowDefinitionId === undefined
    ? null
    : { kind: "workflow", workflowDefinitionId: context.workflowDefinitionId };
}

export function inferScopeFromContext(
  context: CaptureContext,
  options: ScopeInferenceOptions,
): MemoryScope | null {
  const kind = options.scopeKind ?? pickImplicitScopeKind(context);
  return resolveExplicitScope(kind, context, options.allowGlobalScope ?? false);
}
