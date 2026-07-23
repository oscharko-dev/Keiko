import type { ReactNode } from "react";
import type { CodingWorkbenchRuntimeResearchGrant } from "@oscharko-dev/keiko-contracts";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import styles from "./CodingWorkbenchWindow.module.css";

const RESEARCH_LABEL_ID = "coding-workbench-research-label";

/**
 * #2387 — the live "Internet · Research only" grant chip. It renders only while a governed
 * research grant is present on the authenticated research channel and exposes its scope, named
 * public domains, and verbatim expiry, plus a revoke control that stays usable during a live run.
 * The server owns the parent-and-children cascade; the UI re-reads channel truth after the
 * revision-bound revoke.
 */
export function ResearchGrantChip({
  grant,
  busy,
  onRevoke,
}: {
  readonly grant: CodingWorkbenchRuntimeResearchGrant | undefined;
  readonly busy: boolean;
  readonly onRevoke: () => void;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  if (grant === undefined) return null;
  return (
    <fieldset className={styles.researchGrant} aria-labelledby={RESEARCH_LABEL_ID}>
      <p id={RESEARCH_LABEL_ID} className={styles.statusBadge}>
        <span aria-hidden="true">●</span>
        {t("codingWorkbench.research.chipLabel")}
      </p>
      <ResearchGrantFacts grant={grant} t={t} />
      <div className={styles.controls}>
        <button
          className={styles.button}
          type="button"
          disabled={busy}
          aria-label={t("codingWorkbench.research.revokeLabel")}
          onClick={onRevoke}
        >
          {busy ? t("codingWorkbench.research.revoking") : t("codingWorkbench.research.revoke")}
        </button>
      </div>
    </fieldset>
  );
}

function ResearchGrantFacts({
  grant,
  t,
}: {
  readonly grant: CodingWorkbenchRuntimeResearchGrant;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <dl className={styles.approvalFacts} aria-label={t("codingWorkbench.research.facts")}>
      <ResearchFact
        label={t("codingWorkbench.research.scope")}
        value={t("codingWorkbench.research.scopeValue")}
      />
      <ResearchFact
        label={t("codingWorkbench.research.domains")}
        value={grant.domains.join(", ")}
      />
      <ResearchFact label={t("codingWorkbench.research.expiry")} value={grant.expiresAt} />
    </dl>
  );
}

function ResearchFact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  return (
    <div className={styles.approvalFact}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
