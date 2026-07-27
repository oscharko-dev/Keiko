"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import { loadMemoryAutonomyMode, persistMemoryAutonomyMode } from "@/lib/memory-api";
import {
  currentConversationMemoryMode,
  currentConversationMemoryModeRevision,
  useConversationMemorySettings,
} from "./memorySettings";

type AutonomyModePolicyError = "hydrate" | "persist" | null;
let latestPersistenceRequest = 0;
let persistenceQueue: Promise<void> = Promise.resolve();

function persistInIntentOrder(
  persist: typeof persistMemoryAutonomyMode,
  mode: CodingWorkbenchMode,
): ReturnType<typeof persistMemoryAutonomyMode> {
  const pending = persistenceQueue.then(() => persist(mode));
  persistenceQueue = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

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
  const mounted = useRef(true);

  useEffect((): (() => void) => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  useEffect((): (() => void) => {
    let active = true;
    const request = ++sequence.current;
    const revisionAtStart = currentConversationMemoryModeRevision();
    void load()
      .then((policy): void => {
        if (!active || request !== sequence.current) return;
        if (currentConversationMemoryModeRevision() === revisionAtStart) {
          setMemoryMode(policy.requestedMode);
        }
        if (currentConversationMemoryMode() === policy.requestedMode) {
          setEffectiveMode(policy.effectiveMode);
          setDeploymentCeiling(policy.deploymentCeiling);
          setError(null);
        }
      })
      .catch((): void => {
        if (
          active &&
          request === sequence.current &&
          currentConversationMemoryModeRevision() === revisionAtStart
        ) {
          setError("hydrate");
        }
      })
      .finally((): void => {
        if (active && request === sequence.current) setPending(false);
      });
    return (): void => {
      active = false;
    };
  }, [load, setMemoryMode]);

  const change = useCallback(
    (mode: CodingWorkbenchMode): void => {
      const request = ++sequence.current;
      const persistenceRequest = ++latestPersistenceRequest;
      setPending(true);
      setError(null);
      void persistInIntentOrder(persist, mode)
        .then((policy): void => {
          if (
            !mounted.current ||
            request !== sequence.current ||
            persistenceRequest !== latestPersistenceRequest
          ) {
            return;
          }
          setMemoryMode(policy.requestedMode);
          if (currentConversationMemoryMode() === policy.requestedMode) {
            setEffectiveMode(policy.effectiveMode);
            setDeploymentCeiling(policy.deploymentCeiling);
          }
        })
        .catch((): void => {
          if (
            mounted.current &&
            request === sequence.current &&
            persistenceRequest === latestPersistenceRequest
          ) {
            setError("persist");
          }
        })
        .finally((): void => {
          if (mounted.current && request === sequence.current) setPending(false);
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
