import type { ContentRedactionPolicy } from "@oscharko-dev/keiko-contracts";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { deepRedactStrings, redactContent } from "@oscharko-dev/keiko-security";
import { currentRedactionSecrets, type Redactor, type UiHandlerDeps } from "./deps.js";

// #4098: the deployment content policy of Chat. It is resolved once, at startup, from `KEIKO_CONTENT_REDACTION` (see `resolveContentRedactionPolicy`)
// and lives on the deps graph, so a surface that does not ask for it keeps the default projection.
// Diagnostics, evidence, audit records, exports and memory never read it.

/** The content policy of this deps graph; a graph without one keeps the default projection. */
export function deploymentContentPolicy(
  deps: Pick<UiHandlerDeps, "contentRedaction">,
): ContentRedactionPolicy {
  return deps.contentRedaction ?? "redact";
}

/** Projects private Chat content under the deployment policy, never diagnostics or evidence. */
export function currentContentRedactor(deps: UiHandlerDeps): Redactor {
  if (deploymentContentPolicy(deps) === "redact") return deps.redactor;
  const secrets = currentRedactionSecrets(deps);
  return (value: unknown): unknown =>
    deepRedactStrings(value, (text) => redactContent(text, "preserve", secrets));
}

/**
 * Hands a Chat answer model port the deployment policy, so the gateway preserves the answer only
 * for the Chat calls that ask for it. Under the default policy the port is returned unchanged.
 */
export function withChatContentPolicy(deps: UiHandlerDeps, model: ModelPort): ModelPort {
  if (deploymentContentPolicy(deps) === "redact") return model;
  const { callStream } = model;
  return {
    call: (request, signal) => model.call({ ...request, contentRedaction: "preserve" }, signal),
    ...(callStream === undefined
      ? {}
      : {
          callStream: (request, signal) =>
            callStream.call(model, { ...request, contentRedaction: "preserve" }, signal),
        }),
  };
}
