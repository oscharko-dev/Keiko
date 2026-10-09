import type { GroundedInsufficiencyDeclaration } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ContinuityReferentSource } from "@oscharko-dev/keiko-contracts/connected-context";
import { extractPathReferences, type SearchReference } from "@oscharko-dev/keiko-workflows";
import { declaredInsufficiencyPaths, parseInlineCitations } from "./grounded-faithfulness.js";
import type { ChatMessage } from "./store/index.js";

export interface AssistantReferents {
  readonly assistantReferents: readonly SearchReference[];
  readonly continuityReferentSource: ContinuityReferentSource;
}

function latestAssistant(history: readonly ChatMessage[]): ChatMessage | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1)
    if (history[index]?.role === "assistant") return history[index];
  return undefined;
}

function structuredDeclarations(message: ChatMessage): readonly GroundedInsufficiencyDeclaration[] {
  const answer = message.groundedAnswer;
  return answer !== undefined && "insufficiencyDeclarations" in answer
    ? (answer.insufficiencyDeclarations ?? [])
    : [];
}

function declarationPaths(message: ChatMessage): readonly string[] {
  const structured = structuredDeclarations(message);
  return [
    ...new Set([
      ...structured.map((declaration) => declaration.scopePath),
      ...declaredInsufficiencyPaths(message.content),
    ]),
  ].slice(0, 3);
}

/** These are untrusted hints; only the existing live admission boundary grants reads. */
export function assistantRetrievalReferents(
  history: readonly ChatMessage[],
  asksAgain = true,
): AssistantReferents {
  const message = latestAssistant(history);
  if (message === undefined) return { assistantReferents: [], continuityReferentSource: "none" };
  const blocked = new Set(
    asksAgain
      ? []
      : structuredDeclarations(message)
          .filter((declaration) => declaration.state === "read-in-this-turn")
          .map((declaration) => declaration.scopePath),
  );
  const declarations = declarationPaths(message).filter((path) => !blocked.has(path));
  const declared = new Set(declarations);
  const citations = parseInlineCitations(message.content).map((citation): SearchReference => ({
    path: citation.scopePath,
    ...(citation.lineRange === undefined ? {} : { line: citation.lineRange.startLine }),
    origin: "assistant",
  }));
  const other = extractPathReferences(message.content).filter(
    (reference) => !declared.has(reference.path),
  );
  const paths = [...citations, ...other];
  const seen = new Set<string>();
  const assistantReferents = [
    ...declarations.map((path): SearchReference => ({ path, origin: "assistant" })),
    ...paths,
  ]
    .filter((reference) => {
      if (seen.has(reference.path) || blocked.has(reference.path)) return false;
      seen.add(reference.path);
      return true;
    })
    .slice(0, 6)
    .map((reference): SearchReference => ({ ...reference, origin: "assistant" }));
  const hasPaths = assistantReferents.some((reference) => !declared.has(reference.path));
  return {
    assistantReferents,
    continuityReferentSource: referentSource(declarations.length > 0, hasPaths),
  };
}

function referentSource(declared: boolean, paths: boolean): ContinuityReferentSource {
  if (declared && paths) return "assistant-paths-and-declaration";
  if (declared) return "assistant-declaration";
  return paths ? "assistant-paths" : "none";
}
