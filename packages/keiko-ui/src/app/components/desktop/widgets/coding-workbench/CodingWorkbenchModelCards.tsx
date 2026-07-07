import type { ReactNode } from "react";
import type { CodingWorkbenchModelSource } from "@oscharko-dev/keiko-contracts";
import type { CodingWorkbenchProfileState } from "./CodingWorkbenchWindow";
import type { CodingWorkbenchProjection } from "./codingWorkbenchProjection";
import {
  codexStatusLabel,
  healthLabel,
  healthTone,
  modelSourceLabel,
  type CodingWorkbenchTone,
} from "./codingWorkbenchLabels";
import { PanelTitle } from "./CodingWorkbenchSections";
import styles from "./CodingWorkbenchWindow.module.css";

interface ModelRuntimeStatusProps {
  readonly projection: CodingWorkbenchProjection;
  readonly profiles: CodingWorkbenchProfileState;
}

interface ModelCard {
  readonly source: CodingWorkbenchModelSource;
  readonly label: string;
  readonly detail: string;
  readonly status: string;
  readonly tone: CodingWorkbenchTone;
  readonly active: boolean;
}

export function ModelRuntimeStatus({ projection, profiles }: ModelRuntimeStatusProps): ReactNode {
  const cards = modelCards(projection.authority.modelProfile.source, profiles);
  return (
    <section className={styles.card} aria-labelledby="coding-workbench-runtime-title">
      <div className={styles.cardHeader}>
        <PanelTitle eyebrow="Runtime and model source" id="coding-workbench-runtime-title">
          Source status
        </PanelTitle>
        <span className={styles.healthPill} data-tone={healthTone(projection.sidecarHealth)}>
          {healthLabel(projection.sidecarHealth)}
        </span>
      </div>
      <div className={styles.modelGrid}>
        {cards.map((card) => (
          <article key={card.source} className={styles.modelCard} data-active={card.active}>
            <p className={styles.modelName}>{card.label}</p>
            <p className={styles.modelDetail}>{card.detail}</p>
            <span className={styles.modelStatus} data-tone={card.tone}>
              {card.status}
            </span>
          </article>
        ))}
      </div>
    </section>
  );
}

function modelCards(
  active: CodingWorkbenchModelSource,
  profiles: CodingWorkbenchProfileState,
): readonly ModelCard[] {
  return [
    gatewayCard("keiko-model-gateway", active, profiles),
    gatewayCard("openai-api-key-through-gateway", active, profiles),
    codexCard(active, profiles),
  ];
}

function gatewayCard(
  source: "keiko-model-gateway" | "openai-api-key-through-gateway",
  active: CodingWorkbenchModelSource,
  profiles: CodingWorkbenchProfileState,
): ModelCard {
  const available = profiles.status === "ready" && profiles.sidecarGateway.status === "available";
  return {
    source,
    label: modelSourceLabel(source),
    detail: gatewayDetail(source),
    status: profiles.status === "loading" ? "Checking" : available ? "Available" : "Unavailable",
    tone: profiles.status === "loading" ? "neutral" : available ? "success" : "warning",
    active: active === source,
  };
}

function codexCard(
  active: CodingWorkbenchModelSource,
  profiles: CodingWorkbenchProfileState,
): ModelCard {
  const status = profiles.status === "ready" ? profiles.codexProfile.status : profiles.status;
  return {
    source: "chatgpt-codex-subscription-profile",
    label: modelSourceLabel("chatgpt-codex-subscription-profile"),
    detail: "Subscription profile executes through the Codex runtime adapter",
    status: codexStatusLabel(status),
    tone: status === "connected" ? "success" : status === "loading" ? "neutral" : "warning",
    active: active === "chatgpt-codex-subscription-profile",
  };
}

function gatewayDetail(source: "keiko-model-gateway" | "openai-api-key-through-gateway"): string {
  return source === "keiko-model-gateway"
    ? "Managed provider through Keiko Gateway"
    : "API key routed through Keiko Gateway";
}
