"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import { loadMemoryAutonomyMode, persistMemoryAutonomyMode } from "@/lib/memory-api";
import { currentConversationMemoryMode, useConversationMemorySettings } from "./memorySettings";

type AutonomyModePolicyError = "hydrate" | "persist" | null;

export interface AutonomyModePolicy {
  readonly requestedMode: CodingWorkbenchMode;
  readonly effectiveMode: CodingWorkbenchMode | null;
  readonly deploymentCeiling: CodingWorkbenchMode | null;
  readonly pending: boolean;
  readonly error: AutonomyModePolicyError;
  readonly change: (mode: CodingWorkbenchMode) => void;
}

interface AutonomyModePolicyOptions {
  readonly load?: typeof loadMemoryAutonomyMode;
  readonly persist?: typeof persistMemoryAutonomyMode;
}

export function useAutonomyModePolicy(options: AutonomyModePolicyOptions = {}): AutonomyModePolicy {
  const load = options.load ?? loadMemoryAutonomyMode;
  const persist = options.persist ?? persistMemoryAutonomyMode;
  const { memoryMode, setMemoryMode } = useConversationMemorySettings();
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<AutonomyModePolicyError>(null);
  const [effectiveMode, setEffectiveMode] = useState<CodingWorkbenchMode | null>(null);
  const [deploymentCeiling, setDeploymentCeiling] = useState<CodingWorkbenchMode | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    let active = true;
    const request = ++sequence.current;
    const modeAtStart = currentConversationMemoryMode();
    void load()
      .then((policy) => {
        if (!active || request !== sequence.current) return;
        if (currentConversationMemoryMode() === modeAtStart) {
          setMemoryMode(policy.requestedMode);
        }
        setEffectiveMode(policy.effectiveMode);
        setDeploymentCeiling(policy.deploymentCeiling);
        setError(null);
      })
      .catch(() => {
        if (active && request === sequence.current) setError("hydrate");
      })
      .finally(() => {
        if (active && request === sequence.current) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [load, setMemoryMode]);

  const change = useCallback(
    (mode: CodingWorkbenchMode): void => {
      const request = ++sequence.current;
      setPending(true);
      setError(null);
      void persist(mode)
        .then((policy) => {
          if (request !== sequence.current) return;
          setMemoryMode(policy.requestedMode);
          setEffectiveMode(policy.effectiveMode);
          setDeploymentCeiling(policy.deploymentCeiling);
        })
        .catch(() => {
          if (request === sequence.current) setError("persist");
        })
        .finally(() => {
          if (request === sequence.current) setPending(false);
        });
    },
    [persist, setMemoryMode],
  );

  return {
    requestedMode: memoryMode,
    effectiveMode,
    deploymentCeiling,
    pending,
    error,
    change,
  };
}
