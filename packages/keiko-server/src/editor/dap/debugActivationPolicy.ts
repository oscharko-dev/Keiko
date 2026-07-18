import {
  parseDebugActivationInput,
  resolveDebugActivation,
  type DebugActivationInput,
  type DebugActivationResolution,
} from "@oscharko-dev/keiko-contracts";

/**
 * The policy boundary intentionally delegates all precedence to the contracts resolver. Keeping
 * this wrapper total prevents malformed provider output from becoming an accidental allow.
 */
export function evaluateDebugActivation(value: unknown): DebugActivationResolution {
  const parsed = parseDebugActivationInput(value);
  return parsed.ok
    ? resolveDebugActivation(parsed.value)
    : { ok: false, state: "disabled", reasonCode: "INVALID_INPUT", policyResult: "denied" };
}

type DebugCapabilityListener = (resolution: DebugActivationResolution) => void;

export interface DebugCapabilityGate {
  readonly resolve: (input: DebugActivationInput) => DebugActivationResolution;
  readonly subscribe: (listener: DebugCapabilityListener) => () => void;
  readonly publish: (input: DebugActivationInput) => DebugActivationResolution;
}

/**
 * A small in-memory subscription port for future live deployment-policy providers. It stores no
 * human opt-in and no durable activation state; callers must always pass the current four-factor
 * input when resolving or publishing.
 */
export function createDebugCapabilityGate(): DebugCapabilityGate {
  const listeners = new Set<DebugCapabilityListener>();
  const resolve = (input: DebugActivationInput): DebugActivationResolution =>
    evaluateDebugActivation(input);
  return {
    resolve,
    subscribe: (listener): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    publish: (input): DebugActivationResolution => {
      const resolution = resolve(input);
      for (const listener of listeners) listener(resolution);
      return resolution;
    },
  };
}
