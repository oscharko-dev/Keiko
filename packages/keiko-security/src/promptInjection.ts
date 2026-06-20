// Authoritative prompt-injection / unsafe-content detector for the Prompt Enhancer
// (Epic #1307, Issue #1313; ADR-0044 §1/§5).
//
// ADR-0044 places the authoritative prompt-injection patterns and secret/PII detectors in
// `keiko-security`; the contracts analyzer's lexical risk cues (#1309) are a deliberately shallow
// signal only. This module is the deep detector the gateway validate stage composes over the
// contracts structural assessment: it scans UNTRUSTED text for instruction-override, system/developer
// prompt disclosure, secret-exfiltration, unsafe tool/agency requests, egress requests, and
// manipulative role-reassignment, and it detects embedded secret material by reusing `redact`.
//
// Content-free by construction (safe-error discipline, ADR-0003/ADR-0044 §5): a signal carries only a
// stable closed-vocabulary `code` and a match COUNT — never the matched text. The result is therefore
// always safe to log, persist as evidence, and surface across trust boundaries.
//
// ReDoS-safe by construction: detection is substring containment over a normalized lowercase view
// (linear, no backtracking). The only regular expressions reached are inside `redact`, which is itself
// bounded-quantifier ReDoS-safe (ADR-0002).

import { redact } from "./redaction.js";

// The closed vocabulary of unsafe-content signals. Stable identifiers; the gateway validate stage maps
// each to a `PromptSafetyViolationCode` from `keiko-contracts`.
export type PromptInjectionSignalCode =
  // Attempts to ignore, override, or bypass the trusted instructions.
  | "instruction-override"
  // Attempts to extract the system or developer prompt / hidden instructions.
  | "system-prompt-disclosure"
  // Attempts to extract secrets, credentials, environment values, or keys.
  | "secret-exfiltration"
  // Requests to run commands, scripts, or otherwise self-authorize tool/agency use.
  | "tool-authority-request"
  // Requests to send, upload, or post data to an external destination.
  | "egress-request"
  // Manipulative framing or role reassignment intended to change model behaviour.
  | "manipulative-framing"
  // The text itself CONTAINS redactable secret material (a token/key/credential shape).
  | "embedded-secret-material";

export const PROMPT_INJECTION_SIGNAL_CODES: readonly PromptInjectionSignalCode[] = [
  "instruction-override",
  "system-prompt-disclosure",
  "secret-exfiltration",
  "tool-authority-request",
  "egress-request",
  "manipulative-framing",
  "embedded-secret-material",
] as const;

export const isPromptInjectionSignalCode = (value: unknown): value is PromptInjectionSignalCode =>
  typeof value === "string" && (PROMPT_INJECTION_SIGNAL_CODES as readonly string[]).includes(value);

// Relative danger of a signal. `critical` signals (override / disclosure / exfiltration / tool / egress)
// indicate an active attack attempt; `elevated` signals (manipulative framing, embedded secrets)
// warrant review but are weaker on their own.
export type PromptInjectionSeverity = "elevated" | "critical";

// One detected signal. Content-free: `matchCount` is the number of distinct cues that fired, never the
// matched text.
export interface PromptInjectionSignal {
  readonly code: PromptInjectionSignalCode;
  readonly severity: PromptInjectionSeverity;
  readonly matchCount: number;
}

interface InjectionRule {
  readonly code: Exclude<PromptInjectionSignalCode, "embedded-secret-material">;
  readonly severity: PromptInjectionSeverity;
  readonly cues: readonly string[];
}

// Cue tables. Lowercased substrings; each is a deeper, more comprehensive set than the contracts
// analyzer's shallow risk cues. Ordered by code for readability.
const INJECTION_RULES: readonly InjectionRule[] = [
  {
    code: "instruction-override",
    severity: "critical",
    cues: [
      "ignore previous instructions",
      "ignore all previous",
      "ignore the above",
      "ignore your instructions",
      "ignore your guidelines",
      "ignore all prior",
      "disregard previous",
      "disregard the above",
      "disregard all prior",
      "disregard your instructions",
      "forget your instructions",
      "forget all previous",
      "override your instructions",
      "do not follow your instructions",
      "bypass your restrictions",
      "ignore the safety rules",
      "ignore all safety",
    ],
  },
  {
    code: "system-prompt-disclosure",
    severity: "critical",
    cues: [
      "system prompt",
      "reveal your instructions",
      "show me your instructions",
      "print your instructions",
      "repeat the words above",
      "repeat your system",
      "what is your system prompt",
      "reveal your prompt",
      "show your prompt",
      "your initial instructions",
      "disclose your instructions",
      "what were you told",
      "the text above this line",
    ],
  },
  {
    code: "secret-exfiltration",
    severity: "critical",
    cues: [
      "api key",
      "apikey",
      "secret key",
      "access token",
      "your password",
      "the password",
      "your credentials",
      "environment variable",
      "env var",
      "process.env",
      ".env file",
      "private key",
      "ssh key",
      "reveal the secret",
      "print the secret",
      "show me the api",
      "leak the",
      "dump the secrets",
      "exfiltrate the",
    ],
  },
  {
    code: "tool-authority-request",
    severity: "critical",
    cues: [
      "run this command",
      "execute this command",
      "run the script",
      "execute the following",
      "sudo ",
      "rm -rf",
      "grant yourself",
      "give yourself access",
      "install and run",
      "you have permission to run",
      "act as root",
      "with admin privileges",
      "escalate privileges",
      "deploy to production",
    ],
  },
  {
    code: "egress-request",
    severity: "critical",
    cues: [
      "exfiltrate",
      "send the data to",
      "upload to",
      "post to http",
      "curl http",
      "wget http",
      "make a request to http",
      "send it to my server",
      "download from and run",
      "email the data",
      "leak to",
    ],
  },
  {
    code: "manipulative-framing",
    severity: "elevated",
    cues: [
      "you are now ",
      "pretend to be",
      "pretend you are",
      "act as if you have no",
      "developer mode",
      "jailbreak",
      "dan mode",
      "you must comply",
      "without any restrictions",
      "there are no rules",
      "this is only hypothetical so",
      "from now on you are",
      "you are no longer",
      "new system role",
      "assume the role of an unrestricted",
    ],
  },
];

// Inclusive code-point ranges to strip: C0 controls (excluding tab/LF/CR), DEL, C1 controls, the
// zero-width joiners/space, the BOM, and the bidi-embedding/isolate format characters used to hide
// injection markers. Tab (0x09), LF (0x0a), and CR (0x0d) are preserved by carving the C0 range.
const STRIPPABLE_CODE_POINT_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x7f],
  [0x80, 0x9f],
  [0x200b, 0x200d],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

// Strip control / zero-width / bidi code points and NFKC-normalise so unicode obfuscation cannot evade
// substring matching. Mirrors the QI promptSegmentation control stripper (code-point scan, no
// no-control-regex lint suppression needed).
function isStrippableCodePoint(codePoint: number): boolean {
  return STRIPPABLE_CODE_POINT_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);
}

function normalizeForDetection(input: string): string {
  let out = "";
  for (const ch of input.normalize("NFKC")) {
    const codePoint = ch.codePointAt(0);
    if (codePoint === undefined) continue;
    if (!isStrippableCodePoint(codePoint)) out += ch;
  }
  return out.toLowerCase();
}

function countCueHits(haystack: string, cues: readonly string[]): number {
  let count = 0;
  for (const cue of cues) {
    if (haystack.includes(cue)) count += 1;
  }
  return count;
}

/**
 * Detect unsafe-content signals in a piece of UNTRUSTED text (raw user draft, retrieved snippet, or
 * tool output). Pure and content-free: returns a stable list of `{ code, severity, matchCount }`
 * signals and never echoes the matched text. ReDoS-safe (substring containment + the bounded `redact`).
 *
 * `embedded-secret-material` fires when the text itself contains a redactable secret shape — relevant
 * both to secret-exfiltration detection and to the redaction guarantee for persisted evidence.
 */
export function detectPromptInjectionSignals(
  untrustedText: string,
): readonly PromptInjectionSignal[] {
  if (typeof untrustedText !== "string" || untrustedText.length === 0) {
    return [];
  }
  const normalized = normalizeForDetection(untrustedText);
  const signals: PromptInjectionSignal[] = [];
  for (const rule of INJECTION_RULES) {
    const matchCount = countCueHits(normalized, rule.cues);
    if (matchCount > 0) {
      signals.push({ code: rule.code, severity: rule.severity, matchCount });
    }
  }
  if (containsRedactableSecret(untrustedText)) {
    signals.push({ code: "embedded-secret-material", severity: "elevated", matchCount: 1 });
  }
  return signals;
}

/**
 * Whether the text contains redactable secret material (a known token/key/credential shape). Reuses
 * the authoritative `redact` so the detector and the redactor agree by construction. Pure.
 */
export function containsRedactableSecret(text: string): boolean {
  return typeof text === "string" && text.length > 0 && redact(text) !== text;
}

/**
 * Whether any detected signal is `critical` — an active attack attempt (override, disclosure,
 * exfiltration, unsafe tool, or egress). Pure helper for callers gating on attack severity.
 */
export function hasCriticalInjectionSignal(signals: readonly PromptInjectionSignal[]): boolean {
  return signals.some((signal) => signal.severity === "critical");
}
