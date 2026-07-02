import type { IncomingMessage } from "node:http";
import { normaliseCandidateText } from "@oscharko-dev/keiko-quality-intelligence";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type { QualityIntelligenceReviewPrincipal, UiHandlerDeps } from "../deps.js";

const MAX_DISPLAY_LABEL = 80;

const cleanLabel = (value: string | undefined, fallback: string): string => {
  const cleaned = value === undefined ? "" : normaliseCandidateText(value);
  return cleaned.length > 0 ? cleaned.slice(0, MAX_DISPLAY_LABEL) : fallback;
};

const localOperatorSeed = (deps: UiHandlerDeps): string =>
  deps.env.KEIKO_QI_OPERATOR_ID ??
  deps.env.USER ??
  deps.env.USERNAME ??
  deps.env.LOGNAME ??
  "local-operator";

const localOperatorLabel = (deps: UiHandlerDeps): string =>
  cleanLabel(deps.env.KEIKO_QI_OPERATOR_LABEL ?? localOperatorSeed(deps), "Local operator");

const localOperatorPrincipal = (deps: UiHandlerDeps): QualityIntelligenceReviewPrincipal => {
  const seed = cleanLabel(localOperatorSeed(deps), "local-operator");
  return {
    actorId: `local:${sha256Hex(seed).slice(0, 16)}`,
    displayLabel: localOperatorLabel(deps),
    source: "server-local",
    kind: "human",
  };
};

export const resolveQualityIntelligenceReviewPrincipal = (
  req: IncomingMessage,
  deps: UiHandlerDeps,
): QualityIntelligenceReviewPrincipal =>
  deps.qualityIntelligenceReviewPrincipal?.(req) ?? localOperatorPrincipal(deps);
