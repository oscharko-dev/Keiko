"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  resolveEffectiveCodingWorkbenchMode,
  type CodingWorkbenchMode,
  type MemoryAutonomyPolicyWire,
} from "@oscharko-dev/keiko-contracts";
import { loadMemoryAutonomyMode, persistMemoryAutonomyMode } from "@/lib/memory-api";
import {
  currentConversationMemoryModeRevision,
  useConversationMemorySettings,
} from "./memorySettings";

type AutonomyModePolicyError = "hydrate" | "persist" | null;
type PersistAutonomyMode = (
  mode: CodingWorkbenchMode,
  expectedRevision: number,
  signal?: AbortSignal,
) => Promise<MemoryAutonomyPolicyWire>;
type PersistenceOutcome =
  | { readonly kind: "success"; readonly policy: MemoryAutonomyPolicyWire }
  | { readonly kind: "failure" };

const DEFAULT_PERSIST_TIMEOUT_MS = 15_000;
let latestPersistenceRequest = 0;
let latestServerRevision = 0;
let persistenceQueue: Promise<void> = Promise.resolve();

function observeServerRevision(policy: MemoryAutonomyPolicyWire): void {
  if (Number.isSafeInteger(policy.revision) && policy.revision > latestServerRevision) {
    latestServerRevision = policy.revision;
  }
}

async function settlePersistence(
  persist: PersistAutonomyMode,
  mode: CodingWorkbenchMode,
  timeoutMs: number,
): Promise<PersistenceOutcome> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject): void => {
    timeout = setTimeout((): void => {
      const error_ = new DOMException("Memory autonomy persistence timed out.", "TimeoutError");
      controller.abort(error_);
      reject(error_);
    }, timeoutMs);
  });
  try {
    const policy = await Promise.race([
      persist(mode, latestServerRevision, controller.signal),
      deadline,
    ]);
    observeServerRevision(policy);
    return { kind: "success", policy };
  } catch {
    // Convert the rejection to an explicit queue outcome; change() surfaces it to the user.
    return { kind: "failure" };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function persistInIntentOrder(
  persist: PersistAutonomyMode,
  mode: CodingWorkbenchMode,
  timeoutMs: number,
): Promise<PersistenceOutcome> {
  const pending = persistenceQueue.then(() => settlePersistence(persist, mode, timeoutMs));
  persistenceQueue = pending.then((): void => undefined);
  return pending;
}

export function resetAutonomyPersistenceQueueForTests(): void {
  latestPersistenceRequest = 0;
  latestServerRevision = 0;
  persistenceQueue = Promise.resolve();
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
  readonly persist?: PersistAutonomyMode;
  readonly persistTimeoutMs?: number;
}

export function useAutonomyModePolicy(options: AutonomyModePolicyOptions = {}): AutonomyModePolicy {
  const load = options.load ?? loadMemoryAutonomyMode;
  const persist = options.persist ?? persistMemoryAutonomyMode;
  const persistTimeoutMs = options.persistTimeoutMs ?? DEFAULT_PERSIST_TIMEOUT_MS;
  const { memoryMode, setMemoryMode } = useConversationMemorySettings();
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<AutonomyModePolicyError>(null);
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
        observeServerRevision(policy);
        if (!active || request !== sequence.current) return;
        if (currentConversationMemoryModeRevision() === revisionAtStart) {
          setMemoryMode(policy.requestedMode);
        }
        setDeploymentCeiling(policy.deploymentCeiling);
        setError(null);
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
      void persistInIntentOrder(persist, mode, persistTimeoutMs)
        .then((outcome): void => {
          if (outcome.kind === "failure") {
            if (
              mounted.current &&
              request === sequence.current &&
              persistenceRequest === latestPersistenceRequest
            ) {
              setError("persist");
            }
            return;
          }
          const { policy } = outcome;
          // Every fulfilled PUT is authoritative server state. Publish it even when a newer local
          // intent exists or the initiating surface unmounted; serialization ensures a later
          // fulfilled intent will supersede it in the same order on both client and server.
          setMemoryMode(policy.requestedMode);
          if (
            !mounted.current ||
            request !== sequence.current ||
            persistenceRequest !== latestPersistenceRequest
          ) {
            return;
          }
          setDeploymentCeiling(policy.deploymentCeiling);
        })
        .finally((): void => {
          if (mounted.current && request === sequence.current) setPending(false);
        });
    },
    [persist, persistTimeoutMs, setMemoryMode],
  );

  return {
    requestedMode: memoryMode,
    effectiveMode:
      deploymentCeiling === null
        ? null
        : resolveEffectiveCodingWorkbenchMode(memoryMode, deploymentCeiling),
    deploymentCeiling,
    pending,
    error,
    change,
  };
}
