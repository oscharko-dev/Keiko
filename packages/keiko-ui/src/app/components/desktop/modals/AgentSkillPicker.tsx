"use client";

import { useEffect, useState, type ReactNode } from "react";
import type {
  MarkdownSkillMetadata,
  MarkdownSkillReference,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { correlationIdOf } from "@/lib/client-error-summary";
import { bffRequestErrorKind } from "@/lib/http";
import { fetchMarkdownSkills } from "@/lib/markdown-skills-api";
import type { OptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import KeikoSelect from "../KeikoSelect";

// Skill identities start with `msk_`, so this value never names a skill.
const NO_SKILL = "none";

// The library's skills, read once when the launcher opens. A failed read offers none.
function useLaunchableSkills(): {
  readonly skills: readonly MarkdownSkillMetadata[];
  readonly unavailable: boolean;
} {
  const [skills, setSkills] = useState<readonly MarkdownSkillMetadata[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let active = true;
    fetchMarkdownSkills().then(
      (listed) => {
        if (active) setSkills(listed);
      },
      (error: unknown) => {
        if (active) setUnavailable(true);
        reportClientDiagnostic("Private skill library request failed.", {
          correlationId: correlationIdOf(error),
          errorKind: bffRequestErrorKind(error),
          errorEvidence: clientErrorEvidence(error),
        });
      },
    );
    return (): void => {
      active = false;
    };
  }, []);
  return { skills, unavailable };
}

/**
 * The private Markdown skill a governed agent run is launched with (#4025 AC1). Only its identity
 * travels with the run request; the server resolves that exact revision and binds it to the run.
 * Nothing is selected by default, and a library that cannot be read offers no skill at all.
 */
export function AgentSkillPicker({
  value,
  onChange,
  optionalT,
}: {
  readonly value: MarkdownSkillReference | undefined;
  readonly onChange: (skill: MarkdownSkillReference | undefined) => void;
  readonly optionalT: OptionalWidgetTranslate;
}): ReactNode {
  const { skills, unavailable } = useLaunchableSkills();
  const choose = (next: string): void => {
    const skill = skills.find((candidate) => candidate.id === next);
    onChange(
      skill === undefined
        ? undefined
        : { id: skill.id, revision: skill.revision, digest: skill.digest },
    );
  };
  return (
    <div className="dlg-field">
      <span className="dlg-label">{optionalT("agentLauncher.skill")}</span>
      <span className="dlg-selwrap">
        <KeikoSelect
          triggerClassName="dlg-input"
          value={value?.id ?? NO_SKILL}
          ariaLabel={optionalT("agentLauncher.skill")}
          menuTitle={optionalT("agentLauncher.skill")}
          disabled={skills.length === 0}
          sections={[
            {
              options: [
                { value: NO_SKILL, label: optionalT("agentLauncher.skillNone") },
                ...skills.map((skill) => ({ value: skill.id, label: skill.name })),
              ],
            },
          ]}
          onValueChange={choose}
        />
      </span>
      <span className="dlg-note">
        {optionalT(unavailable ? "agentLauncher.skillUnavailable" : "agentLauncher.skillNote")}
      </span>
    </div>
  );
}
