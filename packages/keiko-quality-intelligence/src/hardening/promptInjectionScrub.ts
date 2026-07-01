// Quality Intelligence — prompt-injection scrubber (Epic #270, Issue #284).
//
// Pure detection of prompt-injection vectors that survive
// `normaliseUntrustedContent` (Issue #278). The scrubber returns the list of
// matched patterns instead of mutating the text, so callers may quarantine the
// snippet, redact it, or fail-closed. The injection patterns are layered as a
// second line of defence behind the Markdown escapes in #278 — they aim at
// natural-language imperatives that markdown escaping does NOT touch.
//
// Pure: no IO, no clock, no randomness. Matching is case-insensitive over the
// NFKC-normalised + control-stripped form of the input — callers SHOULD run
// `normaliseUntrustedContent` first so the patterns see the canonical form.
//
// Structurally inspired by Test Intelligence reference (TI) prompt-injection
// detectors, rewritten against the Keiko contracts surface.

export interface PromptInjectionScanResult {
  readonly safe: boolean;
  readonly injections: readonly string[];
}

interface InjectionPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

const PROMPT_INJECTION_PATTERNS: readonly InjectionPattern[] = [
  {
    name: "ignore-previous-instructions",
    pattern: /ignore (?:all |the )?previous instructions?/iu,
  },
  {
    name: "disregard-previous-instructions",
    pattern: /disregard (?:all |the )?(?:previous|above) instructions?/iu,
  },
  { name: "override-system-prompt", pattern: /(?:override|bypass) (?:the )?system prompt/iu },
  { name: "system-role-injection", pattern: /(^|[\n\r])\s*system\s*:/iu },
  { name: "assistant-role-injection", pattern: /(^|[\n\r])\s*assistant\s*:/iu },
  { name: "developer-role-injection", pattern: /(^|[\n\r])\s*developer\s*:/iu },
  { name: "im-start-token", pattern: /<\|im_start\|>/iu },
  { name: "im-end-token", pattern: /<\|im_end\|>/iu },
  { name: "endoftext-token", pattern: /<\|endoftext\|>/iu },
  { name: "markdown-system-heading", pattern: /(^|\n)#{1,6}\s*system\b/iu },
  {
    name: "you-are-now-jailbreak",
    pattern: /you are (?:now )?(?:a |an )?(?:dan|jailbroken|unrestricted)/iu,
  },
  {
    name: "act-as-different-model",
    pattern: /act as (?:a |an )?(?:different|new) (?:ai|model|assistant)/iu,
  },
  {
    name: "reveal-system-prompt",
    pattern: /(?:reveal|print|show|output) (?:the |your )?system prompt/iu,
  },
  {
    name: "exfiltrate-secrets",
    pattern:
      /(?:reveal|print|show|leak|exfiltrate) (?:the |your |any )?(?:api[\s-]?key|secret|password|token)s?/iu,
  },
  {
    name: "de-ignore-previous-instructions",
    pattern:
      /ignoriere\s+(?:alle\s+|die\s+)?(?:bisherigen|vorherigen|obigen)?\s*(?:anweisungen|instruktionen|regeln|vorgaben)/iu,
  },
  {
    name: "de-forget-previous-instructions",
    pattern:
      /vergiss\s+(?:alle\s+|die\s+)?(?:bisherigen|vorherigen|obigen)?\s*(?:anweisungen|instruktionen|regeln|vorgaben)/iu,
  },
  {
    name: "de-disregard-previous-instructions",
    pattern:
      /missachte\s+(?:alle\s+|die\s+)?(?:bisherigen|vorherigen|obigen)?\s*(?:anweisungen|instruktionen|regeln|vorgaben)/iu,
  },
  {
    name: "de-override-system-prompt",
    pattern: /(?:ue|ü)berschreibe\s+(?:den\s+)?(?:system[\s-]*prompt|die\s+anweisungen)/iu,
  },
  {
    name: "de-you-are-now-jailbreak",
    pattern: /du\s+bist\s+jetzt/iu,
  },
  {
    name: "de-reveal-system-prompt",
    pattern: /gib\s+(?:den\s+|die\s+)?system[\s-]*prompt\s+aus/iu,
  },
  {
    name: "de-system-role-injection",
    pattern: /(^|[\n\r])\s*systemnachricht\s*:/iu,
  },
  {
    name: "de-developer-role-injection",
    pattern: /(^|[\n\r])\s*entwicklernachricht\s*:/iu,
  },
];

/** Number of patterns in the injection corpus. Useful for tests/diagnostics. */
export const PROMPT_INJECTION_PATTERN_COUNT = PROMPT_INJECTION_PATTERNS.length;

/**
 * Scan an untrusted text payload for known prompt-injection vectors.
 *
 * Returns `{ safe: true, injections: [] }` when no pattern matches, or
 * `{ safe: false, injections }` with the names of the matched patterns. The
 * caller decides whether to redact, quarantine, or fail-closed.
 *
 * Pure: no IO, no clock, no randomness.
 */
export const scanForPromptInjections = (input: string): PromptInjectionScanResult => {
  if (typeof input !== "string" || input.length === 0) {
    return { safe: true, injections: [] };
  }
  const matched: string[] = [];
  for (const { name, pattern } of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(input)) {
      matched.push(name);
    }
  }
  return { safe: matched.length === 0, injections: matched };
};
