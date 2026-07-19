import { isCodeTaskSkillId, type CodeTaskSkillId } from "@oscharko-dev/keiko-contracts";

import type { SkillCatalog } from "./skillCatalog.js";

export interface ExplicitSkillInvocationTracker {
  readonly observeTurn: (text: string) => void;
  readonly consume: (skillId: string) => boolean;
  readonly clear: () => void;
}

const EXPLICIT_SKILL =
  /(?:^|\s)\$(?:skill\s+)?(skl_[a-z0-9][a-z0-9-]{0,62}@[0-9]{1,4}(?:\.[0-9]{1,4}){0,2})(?=\s|$)/gu;

export function createExplicitSkillInvocationTracker(
  catalog: Pick<SkillCatalog, "has">,
): ExplicitSkillInvocationTracker {
  const pending = new Set<CodeTaskSkillId>();
  return {
    observeTurn: (text): void => {
      pending.clear();
      for (const match of text.matchAll(EXPLICIT_SKILL)) {
        const candidate = match[1];
        if (isCodeTaskSkillId(candidate) && catalog.has(candidate)) pending.add(candidate);
      }
    },
    consume: (skillId): boolean => {
      if (!isCodeTaskSkillId(skillId) || !pending.delete(skillId)) return false;
      return true;
    },
    clear: (): void => pending.clear(),
  };
}
