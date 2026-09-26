// Scripted MODEL boundary for the real-binary lane (#3417): the model discovers the approved skills
// and invokes the one discovery listed, so the skill id it passes comes from the runtime's own
// discovery result. Discovery, invocation and their evidence still traverse the shipped runtime,
// protocol, binder and production skill handlers.
import { createHash } from "node:crypto";

export const SKILL_DISCOVERY_PROOF_CALL_ID = "skill-real-binary-discovery";

export interface SkillDiscoveryConsumptionProof {
  readonly schemaVersion: 1;
  readonly toolCallId: string;
  readonly listedCount: number;
  readonly catalogDigest: string;
  readonly skillIdDigest: string;
  readonly invokedSkillDerivedFromResult: true;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function discoveryOutput(transcript: string): Record<string, unknown> {
  const messages: unknown = JSON.parse(transcript);
  if (!Array.isArray(messages)) throw new TypeError("skill proof requires gateway messages");
  const reply: unknown = messages.find(
    (message: unknown) =>
      record(message) &&
      message.role === "tool" &&
      message.toolCallId === SKILL_DISCOVERY_PROOF_CALL_ID,
  );
  if (!record(reply) || typeof reply.content !== "string") {
    throw new TypeError("skill proof requires the correlated runtime discovery result");
  }
  const output: unknown = JSON.parse(reply.content);
  if (!record(output) || output.status !== "completed" || !record(output.skills)) {
    throw new TypeError("skill proof requires a completed discovery result");
  }
  return output.skills;
}

function firstReadySkill(discovery: Record<string, unknown>): string {
  const skill: unknown = Array.isArray(discovery.skills) ? discovery.skills[0] : undefined;
  if (
    !record(skill) ||
    typeof skill.skillId !== "string" ||
    !record(skill.readiness) ||
    skill.readiness.state !== "ready"
  ) {
    throw new TypeError("skill proof requires a listed, ready skill");
  }
  return skill.skillId;
}

/** The keiko_skill arguments derived from the correlated discovery result, never from a fixture. */
export function skillInvocationHandoff(
  transcript: string,
  observe: ((proof: SkillDiscoveryConsumptionProof) => void) | undefined,
): Record<string, unknown> {
  const discovery = discoveryOutput(transcript);
  if (typeof discovery.catalogDigest !== "string") {
    throw new TypeError("skill proof requires the listing's catalog digest");
  }
  const skillId = firstReadySkill(discovery);
  observe?.({
    schemaVersion: 1,
    toolCallId: SKILL_DISCOVERY_PROOF_CALL_ID,
    listedCount: Array.isArray(discovery.skills) ? discovery.skills.length : 0,
    catalogDigest: discovery.catalogDigest,
    skillIdDigest: createHash("sha256").update(skillId).digest("hex"),
    invokedSkillDerivedFromResult: true,
  });
  return { skillId };
}
