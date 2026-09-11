"use client";

import type { ReactNode } from "react";
import type { CodingWorkbenchSkillsStatus } from "@/lib/useCodingWorkbenchSkills";
import type {
  SkillCategory,
  SkillDiscoveryEntryV1,
  SkillDiscoveryResultV1,
  SkillUnavailableReason,
} from "@oscharko-dev/keiko-contracts";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import type { CodingWorkbenchMessageKey } from "./coding-workbench-i18n.en";
import styles from "./CodingWorkbenchWindow.module.css";

const SKILLS_LABEL_ID = "coding-workbench-skills-label";

// One label per closed category and per closed unavailable reason: a vocabulary the contract fixes,
// so a new value cannot reach the operator as a raw identifier.
const CATEGORY_LABELS: Readonly<Record<SkillCategory, CodingWorkbenchMessageKey>> = {
  "repository-analysis": "codingWorkbench.skills.category.repositoryAnalysis",
  "public-research": "codingWorkbench.skills.category.publicResearch",
  "documentation-lookup": "codingWorkbench.skills.category.documentationLookup",
};

const REASON_LABELS: Readonly<Record<SkillUnavailableReason, CodingWorkbenchMessageKey>> = {
  disabled: "codingWorkbench.skills.reason.disabled",
  incompatible: "codingWorkbench.skills.reason.incompatible",
  "handler-unavailable": "codingWorkbench.skills.reason.handlerUnavailable",
  "authority-denied": "codingWorkbench.skills.reason.authorityDenied",
  "budget-exhausted": "codingWorkbench.skills.reason.budgetExhausted",
};

/**
 * #3417 — the operator's view of the approved skills this run may use: the pinned `id@version`, the
 * category, and the readiness the catalog itself can tell, with the closed reason when a skill is
 * not ready. The listing is body-free by contract: no summary, path, prompt, argument or output
 * ever reaches it, and the general runtime snapshot cannot carry it at all.
 */
export function ApprovedSkillsDisclosure({
  status,
  skills,
  retry,
}: {
  readonly status: CodingWorkbenchSkillsStatus;
  readonly skills: SkillDiscoveryResultV1 | undefined;
  readonly retry: () => void;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  // A channel that could not be read is not the same fact as a run with no approved skill: the
  // operator is told which one it is, and keeps the one recourse the hook offers.
  if (status === "unavailable") {
    return (
      <p className={styles["cmp-skills-unavailable"]} role="note">
        {t("codingWorkbench.skills.unavailable")}{" "}
        <button type="button" onClick={retry}>
          {t("codingWorkbench.skills.retry")}
        </button>
      </p>
    );
  }
  if (skills === undefined || skills.skills.length === 0) return null;
  return (
    <details className={styles["cmp-skills-disclosure"]}>
      <summary className={styles["cmp-skills-summary"]} id={SKILLS_LABEL_ID}>
        {t("codingWorkbench.skills.summary", { count: skills.skills.length })}
      </summary>
      <ul className={styles["cmp-skills-list"]} aria-labelledby={SKILLS_LABEL_ID}>
        {skills.skills.map((skill) => (
          <SkillRow key={skill.skillId} skill={skill} t={t} />
        ))}
      </ul>
    </details>
  );
}

function SkillRow({
  skill,
  t,
}: {
  readonly skill: SkillDiscoveryEntryV1;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <li className={styles["cmp-skill-row"]}>
      <span className={styles["cmp-skill-id"]}>{skill.skillId}</span>
      <span className={styles["cmp-skill-category"]}>{t(CATEGORY_LABELS[skill.category])}</span>
      <span className={styles["cmp-skill-readiness"]}>
        {skill.readiness.state === "ready"
          ? t("codingWorkbench.skills.ready")
          : t(REASON_LABELS[skill.readiness.reason])}
      </span>
    </li>
  );
}
