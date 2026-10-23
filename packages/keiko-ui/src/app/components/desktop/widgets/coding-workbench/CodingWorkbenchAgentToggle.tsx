"use client";

import { useId, type ReactNode } from "react";
import type { CodingWorkbenchAgent } from "@oscharko-dev/keiko-contracts";
import { CODING_WORKBENCH_AGENTS } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import styles from "./CodingWorkbenchAgentToggle.module.css";

export interface CodingWorkbenchAgentToggleProps {
  /** The agents the server's tool profile can honour; the toggle offers exactly these. */
  readonly agents: readonly CodingWorkbenchAgent[];
  readonly value: CodingWorkbenchAgent;
  readonly disabled: boolean;
  readonly onChange: (agent: CodingWorkbenchAgent) => void;
}

const AGENT_LABEL_KEYS = {
  build: "codingWorkbench.composer.agent.build",
  plan: "codingWorkbench.composer.agent.plan",
} as const satisfies Record<CodingWorkbenchAgent, string>;

const AGENT_DESCRIPTION_KEYS = {
  build: "codingWorkbench.composer.agent.build.description",
  plan: "codingWorkbench.composer.agent.plan.description",
} as const satisfies Record<CodingWorkbenchAgent, string>;

interface AgentOptionProps {
  readonly agent: CodingWorkbenchAgent;
  readonly active: boolean;
  readonly disabled: boolean;
  readonly descriptionId: string;
  readonly onChange: (agent: CodingWorkbenchAgent) => void;
  readonly t: CodingWorkbenchTranslate;
}

function AgentOption({
  agent,
  active,
  disabled,
  descriptionId,
  onChange,
  t,
}: AgentOptionProps): ReactNode {
  const description = t(AGENT_DESCRIPTION_KEYS[agent]);
  return (
    <>
      <button
        className={styles.cmpAgentOption}
        type="button"
        aria-pressed={active}
        aria-describedby={descriptionId}
        title={description}
        disabled={disabled}
        data-agent={agent}
        onClick={(): void => {
          if (!active) onChange(agent);
        }}
      >
        {t(AGENT_LABEL_KEYS[agent])}
      </button>
      <span className="sr-only" id={descriptionId}>
        {description}
      </span>
    </>
  );
}

/**
 * The Build | Plan switch of the composer, as in standalone OpenCode's primary agent switch (#3897).
 * It is a labelled group of two toggle buttons, so Tab reaches each and Enter or Space selects it.
 * It renders only where the server offers more than the default agent: a deployment that can run
 * Build alone shows no control at all, rather than a choice it would refuse.
 */
export function CodingWorkbenchAgentToggle({
  agents,
  value,
  disabled,
  onChange,
}: CodingWorkbenchAgentToggleProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const idPrefix = useId();
  const offered = CODING_WORKBENCH_AGENTS.filter((agent) => agents.includes(agent));
  if (offered.length < 2) return null;
  return (
    <div
      className={styles.cmpAgentControl}
      role="group"
      aria-label={t("codingWorkbench.composer.agent.label")}
      data-testid="coding-workbench-agent-toggle"
    >
      {offered.map((agent) => (
        <AgentOption
          key={agent}
          agent={agent}
          active={agent === value}
          disabled={disabled}
          descriptionId={`${idPrefix}-${agent}-description`}
          onChange={onChange}
          t={t}
        />
      ))}
    </div>
  );
}
