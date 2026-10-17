"use client";

import { useEffect, useRef } from "react";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import type { ClientDiagnosticScopeNotice } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import type { Chat, ChatConnectedScope } from "@/lib/types";
import { effectiveScopes } from "./hooks/workspaceActions";
import { connectedScopeSignature } from "./connectedScopePresentation";

export function reportScopeNotice(
  reason: ClientDiagnosticScopeNotice["reason"],
  scope: ChatConnectedScope,
): void {
  reportClientDiagnostic("client.scope.notice", {
    correlationId: newClientCorrelationId(),
    scopeNotice: { reason, scopeKind: scope.kind, pathCount: scope.relativePaths.length },
  });
}

function sameScope(left: ChatConnectedScope, right: ChatConnectedScope): boolean {
  return connectedScopeSignature([left]) === connectedScopeSignature([right]);
}

function replacedScope(
  previous: readonly ChatConnectedScope[],
  next: readonly ChatConnectedScope[],
  scope: ChatConnectedScope,
): ChatConnectedScope | undefined {
  const removed = previous.filter(
    (old) => old.root === scope.root && !next.some((current) => sameScope(old, current)),
  );
  return removed.length === 1 ? removed[0] : undefined;
}

function transitionReason(
  previous: ChatConnectedScope | undefined,
  scope: ChatConnectedScope,
): ClientDiagnosticScopeNotice["reason"] {
  if (scope.kind === "workspace-root") return "widened";
  if (scope.kind === "files") return "narrowed-to-file";
  const containsPrevious =
    previous !== undefined &&
    previous.relativePaths.length > 0 &&
    previous.relativePaths.every((path) =>
      scope.relativePaths.some((folder) => path.startsWith(`${folder}/`)),
    );
  return containsPrevious ? "widened" : "narrowed-to-directory";
}

// Current source pills own the accessible announcement. This observer retains body-free
// transition evidence without confirmation controls or a second live-region announcement.
export function ChatScopeNotice({ chat }: { readonly chat: Chat }): null {
  const scopes = effectiveScopes(chat);
  const signature = connectedScopeSignature(scopes);
  const latest = useRef(scopes);
  useEffect(() => {
    latest.current = scopes;
  }, [scopes]);
  const previous = useRef({ id: chat.id, scopes });
  useEffect(() => {
    const before = previous.current;
    const next = latest.current;
    previous.current = { id: chat.id, scopes: next };
    if (before.id !== chat.id) return;
    const changed = next.filter((scope) => !before.scopes.some((old) => sameScope(old, scope)));
    const timer = setTimeout(() => {
      for (const scope of changed) {
        reportScopeNotice(
          transitionReason(replacedScope(before.scopes, next, scope), scope),
          scope,
        );
      }
    }, 100);
    return (): void => clearTimeout(timer);
  }, [chat.id, signature]);
  return null;
}
