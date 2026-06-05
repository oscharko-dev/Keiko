// Canonical scope coordinate for storage. The `(scope_kind, scope_coordinate)` column pair is the
// SOLE identity surface a scoped query keys on, so the encoding MUST be:
//   - deterministic (same scope -> same string, bit-for-bit)
//   - kind-disjoint at the row level (kind is its own column; coordinate is only the id)
//
// We deliberately do NOT serialise `kind:id` into one column. Kind is already stored separately;
// concatenating would make two records at different kinds but matching coordinates structurally
// equal if a caller ever forgot the kind filter. The factory enforces both filters together.

import type { MemoryScope, MemoryScopeKind } from "@oscharko-dev/keiko-contracts/memory";

export function scopeKindOf(scope: MemoryScope): MemoryScopeKind {
  return scope.kind;
}

export function scopeCoordinateOf(scope: MemoryScope): string {
  switch (scope.kind) {
    case "user":
      return scope.userId;
    case "workspace":
      return scope.workspaceId;
    case "project":
      return scope.projectId;
    case "workflow":
      return scope.workflowDefinitionId;
    case "global":
      // Global scope has no coordinate value; the empty string is the canonical placeholder so the
      // NOT NULL column is always populated and an indexed equality check still works.
      return "";
  }
}
