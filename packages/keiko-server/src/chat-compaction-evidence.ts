// ADR-0057 D3: best-effort wiring of the chat history-compaction record into regulated evidence.
// buildGatewayMessages drops the ContextCompactionRecord that conversationForGatewayWithCompaction
// produces on the slow path (> MAX_CONTEXT_MESSAGES filtered turns with an active profile). This
// module persists it via persistCompactionEvidence AFTER the turn completes, redacted and retained
// under DEFAULT_RETENTION. The raw chatId NEVER reaches the manifest — only sha256Hex(chatId) and a
// derived runId. Persistence is strictly best-effort: a malformed chatId, an invalid runId, or a
// throwing store can NEVER fail the chat send. The fast path (no compaction record) is a no-op.

import { persistCompactionEvidence } from "@oscharko-dev/keiko-evidence";
import { resolveCostClass } from "@oscharko-dev/keiko-model-gateway";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type { ContextCompactionRecord } from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import { currentRedactionSecrets } from "./deps.js";

export interface ChatCompactionEvidenceInput {
  // The optional record returned by deriveCompactionOutcome; undefined on the fast path.
  readonly compaction: ContextCompactionRecord | undefined;
  readonly chatId: string;
  readonly modelId: string;
  // Message count for the chat BEFORE the new user message was stored. Pinned identically across
  // the buffered and streaming paths so the runId is collision-free and off-by-one-free.
  readonly messageCount: number;
  readonly startedAt: number;
  readonly finishedAt: number;
}

// runId = chat-<sha256Hex(chatId)[:16]>-t<messageCount>. Hex-only + the fixed prefix/suffix are all
// in the assertValidRunId charset [A-Za-z0-9._-]; max length 5+16+2+20 = 43 << 256.
function compactionRunId(chatIdHash: string, messageCount: number): string {
  return `chat-${chatIdHash.slice(0, 16)}-t${String(messageCount)}`;
}

// Best-effort persist of one compaction record. EVERYTHING after the fast-path guard — including the
// chatId hash, runId construction, and persistCompactionEvidence (which itself calls
// assertValidRunId) — is wrapped so a malformed chatId or a throwing store cannot escape into the
// send path. The fast path (no record) returns immediately without touching the store.
export function persistChatCompactionEvidence(
  deps: UiHandlerDeps,
  input: ChatCompactionEvidenceInput,
): void {
  if (input.compaction === undefined) {
    return;
  }
  const record = input.compaction;
  try {
    const chatIdHash = sha256Hex(input.chatId);
    persistCompactionEvidence(
      {
        runId: compactionRunId(chatIdHash, input.messageCount),
        modelId: input.modelId,
        records: [record],
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        chatIdHash,
      },
      {
        store: deps.evidenceStore,
        env: deps.env,
        additionalSecrets: currentRedactionSecrets(deps),
        costClassResolver: resolveCostClass,
      },
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      "chat-compaction-evidence: persistence failed (best-effort, send unaffected)",
      error,
    );
  }
}
