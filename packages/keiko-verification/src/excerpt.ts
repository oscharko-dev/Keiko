// The bounded, redacted tail of a step's captured output. The report itself stays data-minimal
// (`outputSummary` names byte counts only) because it is persisted as evidence; this excerpt exists
// for the caller that has to REPAIR the failure — the coding model behind the governed verification
// tool (ADR-0126 D3) — and travels through the orchestrator's `onStepOutput` seam, never through
// the report. Output arriving here is already redacted and capped by the keiko-tools command
// boundary; it is redacted again as defence in depth before the tail is cut.

import { redact } from "@oscharko-dev/keiko-security";
import type { CommandResult } from "@oscharko-dev/keiko-tools";
import { VERIFICATION_OUTPUT_EXCERPT_MAX_CHARS } from "@oscharko-dev/keiko-contracts/runtime/verification";

export function outputExcerpt(
  result: Pick<CommandResult, "stdout" | "stderr">,
  maxChars: number = VERIFICATION_OUTPUT_EXCERPT_MAX_CHARS,
): string {
  const combined = redact(`${result.stdout}\n${result.stderr}`).trim();
  if (combined.length <= maxChars) return combined;
  return `…${combined.slice(combined.length - maxChars)}`;
}
