import type { ConversationDocumentContextWire } from "@oscharko-dev/keiko-contracts";
import { deepRedactStrings } from "@oscharko-dev/keiko-security";
import {
  MAX_DOCUMENT_CONTEXT_ENTRIES,
  parseDocumentContextEntry,
} from "../chat-document-context.js";
import { validateConversationPayloadSafety } from "../conversation-validation.js";
import { invalidRequest, UiStoreError } from "./errors.js";

function validatedContext(value: unknown): readonly ConversationDocumentContextWire[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_DOCUMENT_CONTEXT_ENTRIES) return undefined;
  const entries = value.map(parseDocumentContextEntry);
  if (entries.includes(undefined)) return undefined;
  const context = entries as ConversationDocumentContextWire[];
  return validateConversationPayloadSafety({ documentContext: context }).ok ? context : undefined;
}

export function encodeStoredDocumentContext(
  value: readonly ConversationDocumentContextWire[] | undefined,
  role: string,
  redactContent: (text: string) => string,
): string | null {
  if (value === undefined) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  if (role !== "user" || validatedContext(value) === undefined)
    throw invalidRequest("Document context requires a bounded user attachment.");
  const projected = validatedContext(deepRedactStrings(value, redactContent));
  if (projected === undefined)
    throw invalidRequest("Redacted document context exceeds its bounds.");
  return JSON.stringify(projected);
}

export function decodeStoredDocumentContext(
  raw: string | null,
  role: string,
): readonly ConversationDocumentContextWire[] | undefined {
  if (raw === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new UiStoreError("INTERNAL", "Stored document context is invalid.", 500);
  }
  const context = validatedContext(value);
  if (role !== "user" || context === undefined)
    throw new UiStoreError("INTERNAL", "Stored document context is invalid.", 500);
  return context;
}
