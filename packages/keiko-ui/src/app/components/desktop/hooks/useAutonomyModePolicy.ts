"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CodingWorkbenchMode, MemoryAutonomyPolicyWire } from "@oscharko-dev/keiko-contracts";
import { resolveEffectiveCodingWorkbenchMode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { ApiError } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { correlationIdOf } from "@/lib/client-error-summary";
import { bffRequestErrorKind } from "@/lib/http";
import { loadMemoryAutonomyMode, persistMemoryAutonomyMode } from "@/lib/memory-session-api";
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
type LoadAutonomyMode = (signal?: AbortSignal) => Promise<MemoryAutonomyPolicyWire>;
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

// The server refused the save because its policy revision is not the one this page last saw:
// another window saved a mode, or the page now talks to a Keiko whose state started over.
function isRevisionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

// The mode stayed as it was; the person sees "could not be saved", the log records why.
function reportPersistFailure(
  error: unknown,
  attempt: "first" | "after-reread",
): PersistenceOutcome {
  reportClientDiagnostic(`Autonomy mode save failed (${attempt} attempt).`, {
    correlationId: correlationIdOf(error),
    errorKind: bffRequestErrorKind(error),
    errorEvidence: clientErrorEvidence(error),
  });
  return { kind: "failure" };
}

// One deadline covers the complete save, re-read and retry included, so a stalled request cannot
// hold the queue: later intents would otherwise wait behind it with no error shown.
async function beforeDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
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
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

// One re-read and one more save: the re-read revision is the server's own, so it replaces the
// remembered one even when it is lower. A second conflict is surfaced, never retried again.
async function persistOrRereadOnce(
  persist: PersistAutonomyMode,
  reload: LoadAutonomyMode,
  mode: CodingWorkbenchMode,
  signal: AbortSignal,
  progress: { attempt: "first" | "after-reread" },
): Promise<MemoryAutonomyPolicyWire> {
  try {
    return await persist(mode, latestServerRevision, signal);
  } catch (error) {
    if (!isRevisionConflict(error)) throw error;
    progress.attempt = "after-reread";
    const current = await reload(signal);
    signal.throwIfAborted();
    if (Number.isSafeInteger(current.revision)) latestServerRevision = current.revision;
    return await persist(mode, latestServerRevision, signal);
  }
}

async function settlePersistence(
  persist: PersistAutonomyMode,
  reload: LoadAutonomyMode,
  mode: CodingWorkbenchMode,
  timeoutMs: number,
): Promise<PersistenceOutcome> {
  const progress: { attempt: "first" | "after-reread" } = { attempt: "first" };
  try {
    const policy = await beforeDeadline(
      (signal) => persistOrRereadOnce(persist, reload, mode, signal, progress),
      timeoutMs,
    );
    observeServerRevision(policy);
    return { kind: "success", policy };
  } catch (error) {
    // Convert the rejection to an explicit queue outcome; change() surfaces it to the user.
    return reportPersistFailure(error, progress.attempt);
  }
}

function persistInIntentOrder(
  persist: PersistAutonomyMode,
  reload: LoadAutonomyMode,
  mode: CodingWorkbenchMode,
  timeoutMs: number,
): Promise<PersistenceOutcome> {
  const pending = persistenceQueue.then(() => settlePersistence(persist, reload, mode, timeoutMs));
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
  // Whether the operator's ceiling holds new routine facts for review (#4206); false until known.
  readonly routineFactsHeldForReview: boolean;
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
  const [routineFactsHeldForReview, setRoutineFactsHeldForReview] = useState(false);
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
        setRoutineFactsHeldForReview(policy.routineFactsHeldForReview === true);
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
      void persistInIntentOrder(persist, load, mode, persistTimeoutMs)
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
          setRoutineFactsHeldForReview(policy.routineFactsHeldForReview === true);
        })
        .finally((): void => {
          if (mounted.current && request === sequence.current) setPending(false);
        });
    },
    [load, persist, persistTimeoutMs, setMemoryMode],
  );

  return {
    requestedMode: memoryMode,
    effectiveMode:
      deploymentCeiling === null
        ? null
        : resolveEffectiveCodingWorkbenchMode(memoryMode, deploymentCeiling),
    deploymentCeiling,
    routineFactsHeldForReview,
    pending,
    error,
    change,
  };
}
