"use client";

import { useId, type ReactNode } from "react";
import type {
  CodingWorkbenchAgent,
  CodingWorkbenchBuiltInAgent,
} from "@oscharko-dev/keiko-contracts";
import {
  CODING_WORKBENCH_AGENTS,
  isCodingWorkbenchBuiltInAgent,
  type CodingWorkbenchMentionableAgent,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import styles from "./CodingWorkbenchAgentToggle.module.css";

export interface CodingWorkbenchAgentToggleProps {
  /** The built-in agents the server's tool profile can honour; the toggle offers exactly these. */
  readonly agents: readonly CodingWorkbenchBuiltInAgent[];
  /**
   * The custom primary agents the run's runtime lists right now (#3903 AC1), offered beside the
   * built-ins; absent or empty offers none.
   */
  readonly customAgents?: readonly CodingWorkbenchMentionableAgent[] | undefined;
  readonly value: CodingWorkbenchAgent;
  readonly disabled: boolean;
  readonly onChange: (agent: CodingWorkbenchAgent) => void;
}

const AGENT_LABEL_KEYS = {
  build: "codingWorkbench.composer.agent.build",
  plan: "codingWorkbench.composer.agent.plan",
} as const satisfies Record<CodingWorkbenchBuiltInAgent, string>;

const AGENT_DESCRIPTION_KEYS = {
  build: "codingWorkbench.composer.agent.build.description",
  plan: "codingWorkbench.composer.agent.plan.description",
} as const satisfies Record<CodingWorkbenchBuiltInAgent, string>;

/** One offered agent: a built-in with its translated label, or a custom one with its own name. */
interface OfferedAgent {
  readonly agent: CodingWorkbenchAgent;
  readonly label: string;
  readonly description: string;
}

function offeredAgents(
  agents: readonly CodingWorkbenchBuiltInAgent[],
  customAgents: readonly CodingWorkbenchMentionableAgent[],
  t: CodingWorkbenchTranslate,
): readonly OfferedAgent[] {
  const builtIns = CODING_WORKBENCH_AGENTS.filter((agent) => agents.includes(agent)).map(
    (agent): OfferedAgent => ({
      agent,
      label: t(AGENT_LABEL_KEYS[agent]),
      description: t(AGENT_DESCRIPTION_KEYS[agent]),
    }),
  );
  // Custom primary agents exist only where the server runs OpenCode's own agents (`plan` offered).
  const customs = agents.includes("plan")
    ? customAgents
        .filter((custom) => !isCodingWorkbenchBuiltInAgent(custom.name))
        .map((custom): OfferedAgent => ({
          agent: custom.name,
          label: custom.name,
          description: custom.description ?? t("codingWorkbench.composer.agent.custom.description"),
        }))
    : [];
  return [...builtIns, ...customs];
}

interface AgentOptionProps {
  readonly option: OfferedAgent;
  readonly active: boolean;
  readonly disabled: boolean;
  readonly descriptionId: string;
  readonly onChange: (agent: CodingWorkbenchAgent) => void;
}

function AgentOption({
  option,
  active,
  disabled,
  descriptionId,
  onChange,
}: AgentOptionProps): ReactNode {
  return (
    <>
      <button
        className={styles.cmpAgentOption}
        type="button"
        aria-pressed={active}
        aria-describedby={descriptionId}
        title={option.description}
        disabled={disabled}
        data-agent={option.agent}
        onClick={(): void => {
          if (!active) onChange(option.agent);
        }}
      >
        {option.label}
      </button>
      <span className="sr-only" id={descriptionId}>
        {option.description}
      </span>
    </>
  );
}

/**
 * The primary agent switch of the composer, as in standalone OpenCode's primary agent switch
 * (#3897): Build, Plan and, on a paused native run, the custom primary agents its runtime lists
 * (#3903 AC1). It is a labelled group of toggle buttons, so Tab reaches each and Enter or Space
 * selects it. It renders only where the server offers more than the default agent: a deployment
 * that can run Build alone shows no control at all, rather than a choice it would refuse.
 */
export function CodingWorkbenchAgentToggle({
  agents,
  customAgents = [],
  value,
  disabled,
  onChange,
}: CodingWorkbenchAgentToggleProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const idPrefix = useId();
  const offered = offeredAgents(agents, customAgents, t);
  if (offered.length < 2) return null;
  return (
    <div
      className={styles.cmpAgentControl}
      role="group"
      aria-label={t("codingWorkbench.composer.agent.label")}
      data-testid="coding-workbench-agent-toggle"
    >
      {offered.map((option) => (
        <AgentOption
          key={option.agent}
          option={option}
          active={option.agent === value}
          disabled={disabled}
          descriptionId={`${idPrefix}-${option.agent}-description`}
          onChange={onChange}
        />
      ))}
    </div>
  );
}
