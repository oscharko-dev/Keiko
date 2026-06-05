// Issue #148 — Pure prompt composer for conversation send payloads (AC #4).
//
// The composer keeps the user-authored draft and the attached document context in distinct,
// labeled blocks separated by a fixed structural separator. The block headers and separator
// are exported so the test suite and the gateway can assert the separation contract directly.
// No IO, no redaction (the extractor already redacted), no error throwing.

import type { ConversationDocumentContextWire } from "@oscharko-dev/keiko-contracts";

export const CONVERSATION_USER_BLOCK_HEADER = "User message:";
export const CONVERSATION_CONTEXT_BLOCK_HEADER = "Attached document context:";
export const CONVERSATION_DOCUMENT_SEPARATOR = "---";

function renderDocumentBlock(doc: ConversationDocumentContextWire): string {
  const truncatedFlag = doc.truncated ? "yes" : "no";
  const header = `- [${doc.displayName}] (truncated: ${truncatedFlag}) ${String(doc.extractedBytes)} bytes`;
  const marker =
    doc.truncated && doc.truncationMarker !== undefined ? `\n${doc.truncationMarker}` : "";
  return `${header}\n${doc.text}${marker}\n${CONVERSATION_DOCUMENT_SEPARATOR}`;
}

export function composeConversationPrompt(
  draft: string,
  documentContext: readonly ConversationDocumentContextWire[],
): string {
  if (documentContext.length === 0) {
    return draft;
  }
  const userBlock = `${CONVERSATION_USER_BLOCK_HEADER}\n${draft}`;
  const contextBlocks = documentContext.map(renderDocumentBlock).join("\n");
  return `${userBlock}\n\n${CONVERSATION_CONTEXT_BLOCK_HEADER}\n${contextBlocks}`;
}
