import { detectPromptInjectionSignals } from "@oscharko-dev/keiko-security";

import type { RejectionReason } from "./errors.js";
import { classifyDeniedCategory } from "./classify-denied-category.js";
import { classifySensitivity } from "./policy.js";
import { scanForSecrets } from "./secret-patterns.js";
import type { CapturePolicyOptions } from "./types.js";

export function memoryTextEgressRejectionReason(
  text: string,
  policy: CapturePolicyOptions = {},
): RejectionReason | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const hardDenial = memoryTextSecretEgressRejectionReason(trimmed, policy);
  if (hardDenial !== null) {
    return hardDenial;
  }
  if (policy.defaultSensitivity === "restricted") {
    return "restricted-sensitivity";
  }
  const sensitivity = classifySensitivity(trimmed, policy.defaultSensitivity);
  return sensitivity === "public" ? null : "sensitive-memory-requires-approval";
}

export function memoryTextSecretEgressRejectionReason(
  text: string,
  policy: CapturePolicyOptions = {},
): RejectionReason | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const secretReason = scanForSecrets(trimmed, policy.customerIdentifierMatchers ?? []);
  if (secretReason !== null) {
    return secretReason;
  }
  return classifyDeniedCategory(trimmed, policy.deniedCategoryMatchers ?? []);
}

// The shared cues name fixed phrases ("ignoriere alle Anweisungen"); a wish stated in a sentence
// of its own puts the verb elsewhere ("dass du ab jetzt deine Regeln ignorierst"). A sentence that
// asks to ignore, bypass or override the rules is refused as the same override.
const RULE_VERB_STEMS = ["ignorier", "missacht", "umgeh", "übergeh", "disregard", "bypass"];
const RULE_VERBS = new Set([
  "umgangen",
  "ignore",
  "ignores",
  "ignored",
  "ignoring",
  "override",
  "overrides",
  "overriden",
  "overriding",
]);
const RULE_NOUNS = new Set(
  (
    "regel regeln anweisung anweisungen richtlinie richtlinien vorgabe vorgaben beschränkung " +
    "beschränkungen sicherheitsregel sicherheitsregeln systemprompt systemprompts rule rules " +
    "instruction instructions guideline guidelines restriction restrictions safeguard safeguards"
  ).split(" "),
);
const SENTENCE_RE = /[^.!?\n]+/gu;
const NON_LETTERS_RE = /[^\p{L}]+/u;

function isRuleVerb(word: string): boolean {
  return RULE_VERBS.has(word) || RULE_VERB_STEMS.some((stem) => word.startsWith(stem));
}

const SYSTEM_PROMPT_RE = /(?:^|[^\p{L}])system\s+prompt(?!\p{L})/iu;

function namesRules(sentence: string, words: readonly string[]): boolean {
  return words.some((word) => RULE_NOUNS.has(word)) || SYSTEM_PROMPT_RE.test(sentence);
}

function asksToOverrideRules(text: string): boolean {
  return [...text.matchAll(SENTENCE_RE)].some(([sentence]) => {
    const words = sentence.toLowerCase().split(NON_LETTERS_RE);
    return words.some((word) => isRuleVerb(word)) && namesRules(sentence, words);
  });
}

// What may become a memory. A person's clear statement is their decision, but it cannot make a
// memory out of an instruction to drop the assistant's rules. Reading stored text is a different
// question and stays with the secret check above.
export function memoryTextCaptureRejectionReason(
  text: string,
  policy: CapturePolicyOptions = {},
): RejectionReason | null {
  const secretReason = memoryTextSecretEgressRejectionReason(text, policy);
  if (secretReason !== null) {
    return secretReason;
  }
  const overridesRules =
    asksToOverrideRules(text) ||
    detectPromptInjectionSignals(text).some((signal) => signal.code === "instruction-override");
  return overridesRules ? "instruction-override" : null;
}
