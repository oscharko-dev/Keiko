import { createHash } from "node:crypto";
import type { MemoryAuditEvent, MemoryScope } from "@oscharko-dev/keiko-contracts";
import { safeSummary } from "./memory-audit-event-builders.js";

function maskedCoordinate(value: string, redactString: (input: string) => string): string {
  const redacted = redactString(value);
  if (redacted !== value) {
    return redacted;
  }
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `[redacted:${digest}]`;
}

export function sanitizeMemoryScope(
  scope: MemoryScope,
  redactString: (input: string) => string,
): MemoryScope {
  switch (scope.kind) {
    case "user":
      return {
        kind: "user",
        userId: maskedCoordinate(scope.userId, redactString) as typeof scope.userId,
      };
    case "workspace":
      return {
        kind: "workspace",
        workspaceId: maskedCoordinate(scope.workspaceId, redactString) as typeof scope.workspaceId,
      };
    case "project":
      return {
        kind: "project",
        projectId: maskedCoordinate(scope.projectId, redactString) as typeof scope.projectId,
      };
    case "workflow":
      return {
        kind: "workflow",
        workflowDefinitionId: maskedCoordinate(
          scope.workflowDefinitionId,
          redactString,
        ) as typeof scope.workflowDefinitionId,
      };
    case "global":
      return { kind: "global" };
    default: {
      const never: never = scope;
      return never;
    }
  }
}

export function memoryScopeKey(scope: MemoryScope): string {
  switch (scope.kind) {
    case "user":
      return `user:${scope.userId}`;
    case "workspace":
      return `workspace:${scope.workspaceId}`;
    case "project":
      return `project:${scope.projectId}`;
    case "workflow":
      return `workflow:${scope.workflowDefinitionId}`;
    case "global":
      return "global";
    default: {
      const never: never = scope;
      return never;
    }
  }
}

export function sanitizeAuditEvent(
  event: MemoryAuditEvent,
  redactString: (input: string) => string,
): MemoryAuditEvent {
  const redactedSummary = safeSummary(event.summary, redactString);
  switch (event.kind) {
    case "memory:retrieved":
      return {
        ...event,
        summary: redactedSummary,
        scopes: event.scopes.map((scope) => sanitizeMemoryScope(scope, redactString)),
      };
    case "memory:workflow-used":
      return { ...event, summary: redactedSummary };
    default:
      return {
        ...event,
        summary: redactedSummary,
        scope: sanitizeMemoryScope(event.scope, redactString),
      };
  }
}

export function auditEventTouchesScope(
  event: MemoryAuditEvent,
  allowedScopeKeys: ReadonlySet<string>,
): boolean {
  switch (event.kind) {
    case "memory:retrieved":
      return event.scopes.some((scope) => allowedScopeKeys.has(memoryScopeKey(scope)));
    case "memory:workflow-used":
      return false;
    default:
      return allowedScopeKeys.has(memoryScopeKey(event.scope));
  }
}
