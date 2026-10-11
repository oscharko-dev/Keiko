import type { GroundedInsufficiencyDeclaration } from "@oscharko-dev/keiko-contracts/bff-wire";
import { GROUNDING_LIMIT_CEILINGS } from "@oscharko-dev/keiko-contracts/bff-wire";
import { isValidScopePath } from "@oscharko-dev/keiko-contracts/runtime/connected-context";
import { isRecord } from "@oscharko-dev/keiko-contracts/runtime/coding-context";
import type {
  ConnectedContextPack,
  ContextExcerpt,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { ContinuityReferentSource } from "@oscharko-dev/keiko-contracts/connected-context";
import { extractPathReferences, type SearchReference } from "@oscharko-dev/keiko-workflows";
import { declaredInsufficiencyPaths, parseInlineCitations } from "./grounded-faithfulness.js";
import type { ChatMessage } from "./store/index.js";

export interface AssistantReferents {
  readonly assistantReferents: readonly AssistantRetrievalReference[];
  readonly continuityReferentSource: ContinuityReferentSource;
}

export interface AssistantRetrievalReference extends SearchReference {
  /** Prior citation attribution only; it never authorizes a read in the current request. */
  readonly sourceScopeFingerprint?: string;
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

function citationLineHint(citation: Record<string, unknown>): number | undefined {
  const line = isRecord(citation.lineRange) ? citation.lineRange.startLine : undefined;
  return typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

function folderCitationReference(citation: unknown): AssistantRetrievalReference | undefined {
  if (!isRecord(citation)) return undefined;
  const fingerprint = citation.sourceScopeFingerprint;
  if (
    typeof fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(fingerprint) ||
    typeof citation.scopePath !== "string" ||
    !isValidScopePath(citation.scopePath, { mustBeRelative: true })
  )
    return undefined;
  const line = citationLineHint(citation);
  return {
    path: citation.scopePath,
    ...(line === undefined ? {} : { line }),
    origin: "assistant",
    sourceScopeFingerprint: fingerprint,
  };
}

function folderCitationReferences(message: ChatMessage): readonly AssistantRetrievalReference[] {
  const answer = message.groundedAnswer;
  if (answer === undefined || answer.groundingKind === "local-knowledge") return [];
  const citations: unknown = answer.citations;
  if (!Array.isArray(citations)) return [];
  return citations
    .slice(0, GROUNDING_LIMIT_CEILINGS.hybridMaxCandidates)
    .map(folderCitationReference)
    .filter((reference): reference is AssistantRetrievalReference => reference !== undefined);
}

function citedPathReferences(message: ChatMessage): readonly AssistantRetrievalReference[] {
  const structured = folderCitationReferences(message);
  const attributedPaths = new Set(structured.map((reference) => reference.path));
  const prose = parseInlineCitations(message.content).map((citation): SearchReference => ({
    path: citation.scopePath,
    ...(citation.lineRange === undefined ? {} : { line: citation.lineRange.startLine }),
    origin: "assistant",
  }));
  return [...structured, ...prose.filter((reference) => !attributedPaths.has(reference.path))];
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
  const citations = citedPathReferences(message);
  const attributedPaths = new Set(
    citations
      .filter((reference) => reference.sourceScopeFingerprint !== undefined)
      .map((reference) => reference.path),
  );
  const other = extractPathReferences(message.content).filter(
    (reference) => !declared.has(reference.path) && !attributedPaths.has(reference.path),
  );
  const paths: readonly AssistantRetrievalReference[] = [...citations, ...other];
  const seen = new Set<string>();
  const assistantReferents = [
    ...declarations.map((path): AssistantRetrievalReference => ({ path, origin: "assistant" })),
    ...paths,
  ]
    .filter((reference) => {
      const identity = `${reference.sourceScopeFingerprint ?? ""}\u0000${reference.path}`;
      if (seen.has(identity) || blocked.has(reference.path)) return false;
      seen.add(identity);
      return true;
    })
    .slice(0, 6)
    .map((reference): AssistantRetrievalReference => ({ ...reference, origin: "assistant" }));
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

function excerptContainsReference(excerpt: ContextExcerpt, reference: SearchReference): boolean {
  if (reference.line === undefined) return true;
  const range = excerpt.atom.lineRange;
  return (
    range !== undefined && range.startLine <= reference.line && range.endLine >= reference.line
  );
}

/** Picks one already-read window per hint; callers bind hints to their source before using it. */
export function assistantReferenceExcerptIds(
  pack: ConnectedContextPack,
  references: readonly SearchReference[],
): readonly string[] {
  const ids = new Set<string>();
  for (const reference of references.slice(0, 6)) {
    const file = pack.files.find((entry) => entry.scopePath === reference.path);
    const current = file?.excerpts.filter((excerpt) =>
      excerptContainsReference(excerpt, reference),
    );
    const windows = current?.length ? current : (file?.excerpts ?? []);
    const best = [...windows].sort(
      (a, b) => b.atom.score - a.atom.score || a.atom.stableId.localeCompare(b.atom.stableId),
    )[0];
    if (best !== undefined) ids.add(best.atom.stableId);
  }
  return [...ids];
}
