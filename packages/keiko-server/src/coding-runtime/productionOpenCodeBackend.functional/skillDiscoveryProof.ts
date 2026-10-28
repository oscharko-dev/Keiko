// Scripted MODEL boundary for the real-binary lane (#3417, #3897): the original runtime lists the
// skills it can load in its own system prompt, and the model invokes the one it finds there with the
// runtime's own `skill` tool, so the skill id it passes comes from that listing and never from a
// fixture. The skill itself is a repository skill the fixture repository carries: it reaches the
// listing only through Keiko's sanitized repository-item admission (#3903) into the run's private
// discovery directory, so a listed fixture skill proves that boundary end to end.
import { createHash } from "node:crypto";

import { nativeSystemPrompt } from "./nativeToolTranscript.js";

export const SKILL_DISCOVERY_PROOF_CALL_ID = "skill-real-binary-discovery";

/** The repository skill the journey's fixture repository carries under `.opencode/skills/`. */
export const FUNCTIONAL_REPOSITORY_SKILL_NAME = "repo-structure-summary";

/** The fixture skill's `SKILL.md`: closed frontmatter and a plain Markdown body, no authority. */
export function functionalRepositorySkillText(): string {
  return [
    "---",
    `name: ${FUNCTIONAL_REPOSITORY_SKILL_NAME}`,
    "description: Summarize the structure of the repository in a few lines.",
    "---",
    "List the top-level folders of the repository and what each one is for.",
    "",
  ].join("\n");
}

export interface SkillDiscoveryConsumptionProof {
  readonly schemaVersion: 1;
  readonly toolCallId: string;
  readonly listedCount: number;
  readonly listingDigest: string;
  readonly skillIdDigest: string;
  readonly invokedSkillDerivedFromResult: true;
}

interface ListedSkill {
  readonly id: string;
  readonly name: string;
}

const AVAILABLE_SKILLS = /<available_skills>([\s\S]*?)<\/available_skills>/u;
const LISTED_SKILL = /<skill>\s*<id>([^<]*)<\/id>\s*<name>([^<]*)<\/name>/gu;

function skillListing(transcript: string): { block: string; skills: readonly ListedSkill[] } {
  const block = AVAILABLE_SKILLS.exec(nativeSystemPrompt(transcript))?.[1];
  if (block === undefined) throw new TypeError("skill proof requires the runtime skill listing");
  const skills = [...block.matchAll(LISTED_SKILL)].flatMap((match) =>
    match[1] === undefined || match[2] === undefined ? [] : [{ id: match[1], name: match[2] }],
  );
  return { block, skills };
}

/** The `skill` arguments derived from the runtime's own listing, never from a fixture constant. */
export function skillInvocationHandoff(
  transcript: string,
  skillName: string,
  observe: ((proof: SkillDiscoveryConsumptionProof) => void) | undefined,
): Record<string, unknown> {
  const listing = skillListing(transcript);
  const skill = listing.skills.find((candidate) => candidate.name === skillName);
  if (skill === undefined) throw new TypeError("skill proof requires the admitted skill listed");
  observe?.({
    schemaVersion: 1,
    toolCallId: SKILL_DISCOVERY_PROOF_CALL_ID,
    listedCount: listing.skills.length,
    listingDigest: createHash("sha256").update(listing.block).digest("hex"),
    skillIdDigest: createHash("sha256").update(skill.id).digest("hex"),
    invokedSkillDerivedFromResult: true,
  });
  return { id: skill.id };
}
