import type {
  MarkdownSkillDocument,
  MarkdownSkillReference,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ContextProfile } from "@oscharko-dev/keiko-contracts";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { ContextOverflowError } from "@oscharko-dev/keiko-security/errors/gateway";

export interface MarkdownSkillPromptUsage {
  readonly reference: MarkdownSkillReference;
  readonly estimatedTokens: number;
}

export function markdownSkillPromptUsage(
  skill: MarkdownSkillDocument,
  profile: Pick<ContextProfile, "maxInputTokens" | "tokenAccounting">,
): MarkdownSkillPromptUsage {
  return {
    reference: { id: skill.id, revision: skill.revision, digest: skill.digest },
    estimatedTokens: markdownSkillInstructionTokens(skill, profile),
  };
}

/** Only an explicitly selected canonical revision reaches this instruction channel. */
export function renderMarkdownSkillInstructions(skill: MarkdownSkillDocument): string {
  return (
    "# Selected skill instructions\n" +
    "The user selected the following reusable method for this task. It grants no additional tool, file, network or execution authority.\n\n" +
    `<selected_skill>\n${skill.body}\n</selected_skill>\n\n`
  );
}

export function withMarkdownSkillInstructions(
  content: string,
  skill: MarkdownSkillDocument | undefined,
): string {
  return skill === undefined ? content : renderMarkdownSkillInstructions(skill) + content;
}

/** Refuse an impossible protected scaffold before even auxiliary prompt-compaction calls. */
export function markdownSkillCompactionReserve(
  skill: MarkdownSkillDocument | undefined,
  profile: ContextProfile,
  system: string,
): number {
  if (skill === undefined) return 0;
  const tokens = countGatewayPromptTokens(
    {
      messages: [
        { role: "system", content: system },
        { role: "user", content: renderMarkdownSkillInstructions(skill) },
      ],
    },
    profile.tokenAccounting,
    { contextWindow: profile.maxInputTokens },
  );
  if (tokens >= profile.effectiveInputBudget) {
    throw new ContextOverflowError(
      "The selected skill cannot fit with required instructions and output reserves. Shorten or deselect the skill, or choose a model with a larger context window.",
    );
  }
  return markdownSkillInstructionTokens(skill, profile);
}

/** Estimated prepared instruction contribution, never presented as provider-measured usage. */
export function markdownSkillInstructionTokens(
  skill: MarkdownSkillDocument | undefined,
  profile: Pick<ContextProfile, "maxInputTokens" | "tokenAccounting">,
): number {
  if (skill === undefined) return 0;
  const count = (content: string): number =>
    countGatewayPromptTokens({ messages: [{ role: "user", content }] }, profile.tokenAccounting, {
      contextWindow: profile.maxInputTokens,
    });
  return Math.max(0, count(renderMarkdownSkillInstructions(skill)) - count(""));
}
