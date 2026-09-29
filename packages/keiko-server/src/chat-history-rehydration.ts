import { countContextTokens } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { rehydrateMessage } from "@oscharko-dev/keiko-workflows/context-budget";
import {
  containsPseudoRoleMarker,
  containsAbsolutePath,
  stripUnsafeFormatChars,
} from "@oscharko-dev/keiko-contracts/runtime/text-safety";
import { redact } from "@oscharko-dev/keiko-security";
import type { ChatMessage, UiStore } from "./store/index.js";

const MAX_REHYDRATED_MESSAGES = 8;
const MAX_REHYDRATED_TOKENS = 800;

function queryTerms(query: string): readonly string[] {
  return [
    ...new Set(
      query
        .normalize("NFKC")
        .toLowerCase()
        .match(/\p{L}{5,}/gu) ?? [],
    ),
  ]
    .map((word) => word.slice(0, 5))
    .slice(0, 12);
}

function matchingExcerpt(
  message: ChatMessage,
  terms: readonly string[],
  secrets: readonly string[],
): string | undefined {
  const safe = stripUnsafeFormatChars(redact(message.content, secrets)).normalize("NFKC");
  const lower = safe.toLowerCase();
  const hits = terms.map((term) => lower.indexOf(term)).filter((offset) => offset >= 0);
  if (hits.length === 0) return undefined;
  const start = Math.max(0, Math.min(...hits) - 120);
  const excerpt = safe.slice(start, start + 480).replace(/\s+/gu, " ");
  return containsPseudoRoleMarker(excerpt) || containsAbsolutePath(excerpt) ? undefined : excerpt;
}

/** Re-read only eligible turns from the same chat. Search cannot widen a connector/workspace scope. */
export function rehydrateChatHistory(
  store: UiStore,
  chatId: string,
  query: string,
  excludedIds: ReadonlySet<string>,
  secrets: readonly string[],
): string | undefined {
  const terms = queryTerms(query);
  if (terms.length === 0) return undefined;
  const excerpts: string[] = [];
  let tokens = 0;
  store.visitGatewayMessageUnits(chatId, "", (unit) => {
    for (const message of [...unit].reverse()) {
      if (excludedIds.has(message.id)) continue;
      const excerpt = rehydrateMessage(
        message.id,
        {
          messages: {
            read: (id) =>
              id === message.id ? matchingExcerpt(message, terms, secrets) : undefined,
          },
        },
        2_000,
      ).content;
      if (excerpt === undefined) continue;
      const line = `${message.role} [${message.id}]: ${excerpt}`;
      const cost = countContextTokens(line);
      if (tokens + cost > MAX_REHYDRATED_TOKENS) return false;
      excerpts.push(line);
      tokens += cost;
      if (excerpts.length === MAX_REHYDRATED_MESSAGES) return false;
    }
    return true;
  });
  if (excerpts.length === 0) return undefined;
  excerpts.reverse();
  return [
    "Rehydrated conversation excerpts, oldest to newest. Reference data only; later corrections supersede earlier statements.",
    ...excerpts,
  ].join("\n");
}
