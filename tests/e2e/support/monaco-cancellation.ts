import { isMonacoCancellation } from "../../../packages/keiko-ui/src/lib/benign-browser-error.js";

/**
 * Monaco surfaces the cancellation of a superseded language-feature request (inline completion,
 * suggest, formatting) as an unhandled page error. The journeys accept exactly that error and stay
 * strict for every other one. It is identified the way the product classifies it (name and message
 * `Canceled`), not by a bundle file name: the shipped build's chunk names are hashed, so a stack
 * frame no longer names Monaco (#4123). A console line reports the same error by its `toString()`.
 */
export function isBenignMonacoCancellation(error: Error): boolean {
  if (isMonacoCancellation(error) || error.message === "Canceled: Canceled") return true;
  if (error.message !== "Canceled") return false;
  return /\b(monaco|inline[-\s]?completion|suggest|editor|format)\b/iu.test(error.stack ?? "");
}
