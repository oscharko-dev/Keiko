import type { IncomingMessage } from "node:http";
import type { UiHandlerDeps } from "./deps.js";
import { resolveAppSessionReadAuthority } from "./coding-app-session/appSessionReadAuthority.js";
import { logMarkdownSkillOperation } from "./markdown-skill-log.js";
import { notFound } from "./store/errors.js";

/** Request-local binding to the existing paired session; never accepted from the wire or stored. */
export function withMarkdownSkillRequestAuthority(
  deps: UiHandlerDeps,
  request: IncomingMessage,
): UiHandlerDeps {
  let captured = false;
  let session: ReturnType<typeof resolveAppSessionReadAuthority>;
  return {
    ...deps,
    markdownSkillAuthority: (): boolean => {
      // Ordinary no-skill and rejected requests must not renew the session idle lifetime.
      if (!captured) {
        session = resolveAppSessionReadAuthority(deps, request);
        captured = true;
      }
      if (session === undefined) return false;
      const current = resolveAppSessionReadAuthority(deps, request);
      return (
        current?.sessionId === session.sessionId && current.rotationCount === session.rotationCount
      );
    },
  };
}

export function assertMarkdownSkillAuthority(
  authority: (() => boolean) | undefined,
  correlationId?: string,
): void {
  if (authority?.() === true) return;
  logMarkdownSkillOperation(correlationId, "selection-read", "rejected", 404);
  throw notFound("Skill");
}
