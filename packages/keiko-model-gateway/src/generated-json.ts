function unwrapJsonFence(text: string): string {
  const trimmed = text.trim();
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline === -1 || !trimmed.endsWith("\n```")) return trimmed;
  const openingFence = trimmed.slice(0, firstNewline).trimEnd();
  if (openingFence !== "```" && openingFence !== "```json") return trimmed;
  return trimmed.slice(firstNewline + 1, -4);
}

/** Parse a complete generated JSON answer. Callers validate the candidate against their schema. */
export function parseGeneratedJson(text: string): unknown {
  try {
    return JSON.parse(unwrapJsonFence(text)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
