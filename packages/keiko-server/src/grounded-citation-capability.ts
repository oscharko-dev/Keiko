import type { GroundedCitationBehaviour } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  findConfiguredCapability,
  toolCallingConfigurationFingerprint,
} from "@oscharko-dev/keiko-model-gateway";
import {
  CITATION_BEHAVIOUR_WINDOW_MAX,
  type RuntimeGatewayConfig,
  type UiHandlerDeps,
  type VerifiedModelCapabilityObservation,
} from "./deps.js";
import { persistObservedCitationBehaviour } from "./gateway-setup.js";

const RELIABLE_DIRECT_CITATION_MIN = 3;
interface CitationObservationContext {
  readonly holder: RuntimeGatewayConfig;
  readonly modelId: string;
  readonly generation: number;
  readonly deploymentIdentitySha256: string;
}

function observationContext(
  deps: UiHandlerDeps,
  modelId: string,
): CitationObservationContext | undefined {
  const holder = deps.gatewayConfig;
  const config = holder?.current();
  if (
    holder === undefined ||
    config === undefined ||
    findConfiguredCapability(config, modelId)?.kind !== "chat"
  )
    return undefined;
  const provider = config.providers.find((candidate) => candidate.modelId === modelId);
  return provider === undefined
    ? undefined
    : {
        holder,
        modelId,
        generation: holder.generation(),
        deploymentIdentitySha256: toolCallingConfigurationFingerprint(provider),
      };
}

function matchingContext(deps: UiHandlerDeps, captured: CitationObservationContext): boolean {
  const current = observationContext(deps, captured.modelId);
  return (
    current?.holder === captured.holder &&
    current.generation === captured.generation &&
    current.deploymentIdentitySha256 === captured.deploymentIdentitySha256
  );
}

function currentObservation(
  context: CitationObservationContext,
): VerifiedModelCapabilityObservation | undefined {
  const observed = context.holder.verifiedCapability(context.modelId);
  return observed?.generation === context.generation &&
    observed.citationBehaviourDeploymentSha256 === context.deploymentIdentitySha256
    ? observed
    : undefined;
}

function describeWindow(
  outcomes: readonly GroundedCitationBehaviour[],
): GroundedCitationBehaviour | undefined {
  if (outcomes.every((outcome) => outcome === "cites")) return "cites";
  if (outcomes.some((outcome) => outcome === "cites-after-repair")) return "cites-after-repair";
  return outcomes.every((outcome) => outcome === "never") ? "never" : undefined;
}

function recordCitationOutcome(
  deps: UiHandlerDeps,
  context: CitationObservationContext,
  outcome: GroundedCitationBehaviour,
  correlationId?: string,
): void {
  const observed = context.holder.verifiedCapability(context.modelId);
  const previous = observed?.generation === context.generation ? observed : undefined;
  const window = [...(currentObservation(context)?.citationBehaviourWindow ?? []), outcome].slice(
    -CITATION_BEHAVIOUR_WINDOW_MAX,
  );
  const applied = persistObservedCitationBehaviour(
    deps,
    context.modelId,
    describeWindow(window),
    context.generation,
    context.deploymentIdentitySha256,
    correlationId,
  );
  recordWindow(context, previous, window, applied);
}

function recordWindow(
  context: CitationObservationContext,
  previous: VerifiedModelCapabilityObservation | undefined,
  window: readonly GroundedCitationBehaviour[],
  applied: boolean,
): void {
  context.holder.recordVerifiedCapability(
    context.modelId,
    previous?.fields ?? {},
    previous?.checkedAt ?? new Date().toISOString(),
    context.generation,
    previous?.conversationCheckedAt,
    {
      citationBehaviourWindow: window,
      citationBehaviourDeploymentSha256: context.deploymentIdentitySha256,
      citationBehaviourObservationStatus: applied ? "applied" : "unavailable",
    },
  );
}

/** One final answer outcome per turn; the holder already owns generation invalidation and state. */
export function citationBehaviourObserverFor(
  deps: UiHandlerDeps,
  modelId: string,
  correlationId?: string,
): (behaviour: GroundedCitationBehaviour) => void {
  const captured = observationContext(deps, modelId);
  let recorded = false;
  return (behaviour): void => {
    if (recorded || captured === undefined || !matchingContext(deps, captured)) return;
    recorded = true;
    recordCitationOutcome(deps, captured, behaviour, correlationId);
  };
}

/** Persisted descriptive metadata alone never authorizes skipping repair after a replacement. */
export function citationBehaviourFor(
  deps: UiHandlerDeps,
  modelId: string,
): GroundedCitationBehaviour | undefined {
  const context = observationContext(deps, modelId);
  if (context === undefined) return undefined;
  const observation = currentObservation(context);
  const outcomes = observation?.citationBehaviourWindow ?? [];
  return observation?.citationBehaviourObservationStatus === "applied" &&
    outcomes.length >= RELIABLE_DIRECT_CITATION_MIN &&
    outcomes.every((outcome) => outcome === "cites")
    ? "cites"
    : undefined;
}
