import type { KnowledgeStore } from "@oscharko-dev/keiko-local-knowledge";

import type { UiHandlerDeps } from "./deps.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import { correlationIdOrUnknown } from "./correlation.js";
import { chatKnowledgeScopes, collectForTurn } from "./requirement-inventory.js";
import { KNOWLEDGE_REQUIREMENTS_TOOL } from "./requirementsToolName.js";

/** How many detected requirement units the Chat's Pods hold, and how many the excerpts show. */
export interface RequirementCoverage {
  readonly unitCount: number;
  readonly shownCount: number;
}

export interface RequirementCoverageInput {
  readonly deps: Pick<UiHandlerDeps, "store" | "diagnostics">;
  readonly store: KnowledgeStore;
  readonly chatId: string | undefined;
  readonly userMessageId: string | undefined;
  readonly correlationId: string | undefined;
  /** The text of the prompt the grounded answer sends: its excerpts and the question. */
  readonly sentText: string;
}

/** `LH-1` is not shown by `LH-10`: an identifier counts only between non-identifier characters. */
function mentions(text: string, id: string): boolean {
  const escaped = id.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  return new RegExp(String.raw`(?<![\p{L}\p{N}_-])${escaped}(?![\p{L}\p{N}])`, "u").test(text);
}

/**
 * The evidence-completeness fact of a grounded turn that offers the requirements tool (#4179).
 * Ranked excerpts rarely carry every requirement of a specification, and a model that is not told
 * so answers from them. This is a count of what the Pods hold against what was sent, never a
 * keyword rule on the question; the per-turn read is the one the tool itself reuses.
 */
export function requirementCoverage(
  input: RequirementCoverageInput,
): RequirementCoverage | undefined {
  if (input.chatId === undefined) return undefined;
  const chat = input.deps.store.findChatById(input.chatId);
  if (chat?.jiraPodBinding === undefined) return undefined;
  const scopes = chatKnowledgeScopes(chat);
  if (scopes.length === 0) return undefined;
  try {
    const { units } = collectForTurn(input.store, scopes, input.chatId, input.userMessageId);
    const ids = new Set(units.map((unit) => unit.entry.id));
    const shownCount = [...ids].filter((id) => mentions(input.sentText, id)).length;
    return ids.size === 0 ? undefined : { unitCount: ids.size, shownCount };
  } catch (error) {
    // The hint is optional: the turn keeps its tools and evidence, the failure stays diagnosable.
    emitServerDiagnostic(
      input.deps.diagnostics,
      serverDiagnosticFromError({
        correlationId: correlationIdOrUnknown(input.correlationId),
        operation: "knowledge.requirement-coverage",
        source: "requirement-coverage-note",
        error,
        redact: () => "server-operation-failed",
      }),
    );
    return undefined;
  }
}

/** The model-facing sentence, only when the excerpts miss some of the detected units. */
export function requirementCoverageNote(coverage: RequirementCoverage | undefined): string {
  if (coverage === undefined || coverage.shownCount >= coverage.unitCount) return "";
  return ` The attached Pods hold ${String(coverage.unitCount)} detected requirements; the excerpts show ${String(coverage.shownCount)}. For all of them call ${KNOWLEDGE_REQUIREMENTS_TOOL}.`;
}
