import type { ContentRedactionPolicy } from "@oscharko-dev/keiko-contracts";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { deepRedactStrings, redact, redactContent } from "@oscharko-dev/keiko-security";
import type { Redactor, UiHandlerDeps } from "./deps.js";
import { currentRedactionSecrets } from "./redaction-secrets.js";

// #4098: the deployment content policy. It is resolved once, at startup, from
// `KEIKO_CONTENT_REDACTION`, and lives on the deps graph. Owner decision 2026-11-04: what a person
// reads and what the model receives lose only the credential floor by default, so `deps.redactor` is
// that projection. Evidence, audit records and memory keep the strict projection through
// `strictRedactor`, and the Activity Log has its own stricter sink (`log-redaction.ts`).

/** The content policy of this deps graph; a graph without one keeps the default projection. */
export function deploymentContentPolicy(
  deps: Pick<UiHandlerDeps, "contentRedaction">,
): ContentRedactionPolicy {
  return deps.contentRedaction ?? "redact";
}

/**
 * The strict projection, whatever the deployment policy is: what evidence, audit records and memory
 * store. A graph already on the strict policy keeps its own redactor.
 */
export function strictRedactor(deps: UiHandlerDeps): Redactor {
  if (deploymentContentPolicy(deps) === "redact") return deps.redactor;
  return (value: unknown): unknown =>
    deepRedactStrings(value, (text) => redact(text, currentRedactionSecrets(deps)));
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
