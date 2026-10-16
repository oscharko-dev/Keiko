// Shared command grammar for distinguishing source requests from coordinated objects.
export const REQUEST_COMMAND_PATTERNS: readonly RegExp[] = [
  /\b(?:read|show|open|explain|describe|summarize|inspect|find|search|locate)(?:s|ed|ing)?\b/iu,
  /\b(?:lies|zeige|öffne|erkläre|erklären|erklärst|beschreibe|beschreiben|suche|finde)\b/iu,
];
