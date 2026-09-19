// Turn-based Digital Twin capture. The existing dictation recorder, VAD, canonical chat queue,
// and assistant playback own media, answer generation, and speech. This hook advances the floor.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClientVoiceDialogueStage } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import type { SendMessageOutcome } from "./useChatSession";
import { useDictation, type DictationController, type UseDictationOptions } from "./useDictation";
import { createBrowserVoiceActivityDetector } from "./voice-activity-detector";
import {
  canonicalVoiceHasherIsReady,
  prepareCanonicalVoiceHasher as prepareDefaultCanonicalVoiceHasher,
} from "./canonical-voice-hasher";

export interface BatchVoiceDialogueOptions {
  readonly captureOwner: string;
  readonly captureLease: symbol;
  readonly submit: (text: string, correlationId: string) => Promise<SendMessageOutcome> | undefined;
  readonly dictation?:
    Pick<UseDictationOptions, "createRecorder" | "transcribe" | "vad"> | undefined;
  readonly prepareCanonicalVoiceHasher?: (() => Promise<void>) | undefined;
}

export interface BatchVoiceDialogue {
  readonly dictation: DictationController;
  readonly waitingForAnswer: boolean;
  readonly preparing: boolean;
  readonly error: string | undefined;
  readonly failedTranscript: string | undefined;
  readonly start: () => void;
  readonly stop: () => void;
  readonly retry: () => void;
  readonly onSpeechSettled: (assistantMessageId: string) => void;
}

interface DeliveryFlags {
  active: boolean;
  generation: number;
  expectedAnswerId: string | undefined;
  expectedAnswerCorrelationId: string | undefined;
  sessionCorrelationId: string | undefined;
}

interface BatchDeliverySetters {
  readonly setWaiting: (value: boolean) => void;
  readonly setError: (value: string) => void;
  readonly setFailedTranscript: (value: string | undefined) => void;
}

function reportBatchStage(stage: ClientVoiceDialogueStage, correlationId?: string): void {
  reportClientDiagnostic(`[keiko] batch voice dialogue (stage=${stage})`, {
    kind: "voice-dialogue",
    voiceDialogueStage: stage,
    ...(correlationId === undefined ? {} : { correlationId }),
  });
}

interface BatchTurnDelivery {
  readonly flagsRef: { readonly current: DeliveryFlags };
  readonly waitingForAnswer: boolean;
  readonly error: string | undefined;
  readonly failedTranscript: string | undefined;
  readonly acceptTranscript: (text: string) => void;
  readonly activate: () => void;
  readonly deactivate: () => void;
  readonly clearError: () => void;
  readonly takeSettledAnswer: (assistantMessageId: string) => boolean;
}

function deliveryIsCurrent(flags: DeliveryFlags, generation: number): boolean {
  return flags.active && flags.generation === generation;
}

function settleDelivery(
  outcome: SendMessageOutcome,
  flags: DeliveryFlags,
  generation: number,
  transcript: string,
  correlationId: string,
  setters: BatchDeliverySetters,
): void {
  if (!deliveryIsCurrent(flags, generation)) return;
  if (outcome.status === "completed") {
    flags.expectedAnswerId = outcome.assistantMessageId;
    flags.expectedAnswerCorrelationId = correlationId;
    reportBatchStage("answer-ready", correlationId);
    return;
  }
  reportBatchStage("delivery-failed", correlationId);
  setters.setWaiting(false);
  setters.setFailedTranscript(transcript);
  setters.setError(
    outcome.status === "cancelled"
      ? "The spoken turn was cancelled. You can retry or continue in text."
      : "The spoken turn could not be completed. You can retry or continue in text.",
  );
}

function changeDeliveryActivity(
  flags: DeliveryFlags,
  active: boolean,
  setWaiting: (value: boolean) => void,
  setError: (value: string | undefined) => void,
  setFailedTranscript: (value: string | undefined) => void,
): void {
  flags.generation += 1;
  flags.active = active;
  flags.expectedAnswerId = undefined;
  flags.expectedAnswerCorrelationId = undefined;
  flags.sessionCorrelationId = active ? crypto.randomUUID() : undefined;
  setWaiting(false);
  setError(undefined);
  setFailedTranscript(undefined);
}

function observeBatchDelivery(
  delivery: Promise<SendMessageOutcome>,
  flags: DeliveryFlags,
  generation: number,
  text: string,
  correlationId: string,
  setters: BatchDeliverySetters,
): void {
  void delivery.then(
    (outcome) => settleDelivery(outcome, flags, generation, text, correlationId, setters),
    () => {
      if (!deliveryIsCurrent(flags, generation)) return;
      reportBatchStage("delivery-failed", correlationId);
      setters.setWaiting(false);
      setters.setFailedTranscript(text);
      setters.setError("The spoken turn failed. You can retry or continue in text.");
    },
  );
}

function useBatchTurnAdmission(
  submitRef: { readonly current: BatchVoiceDialogueOptions["submit"] },
  flagsRef: BatchTurnDelivery["flagsRef"],
  setWaiting: (value: boolean) => void,
  setError: (value: string) => void,
  setFailedTranscript: (value: string | undefined) => void,
): (text: string) => void {
  return useCallback(
    (text: string): void => {
      const flags = flagsRef.current;
      if (!flags.active) return;
      const correlationId = crypto.randomUUID();
      const delivery = submitRef.current(text, correlationId);
      if (delivery === undefined) {
        reportBatchStage("queue-unavailable", correlationId);
        setFailedTranscript(text);
        setError("The spoken turn could not be queued. You can retry or continue in text.");
        return;
      }
      reportBatchStage("turn-submitted", correlationId);
      setWaiting(true);
      const generation = flags.generation;
      observeBatchDelivery(delivery, flags, generation, text, correlationId, {
        setWaiting,
        setError,
        setFailedTranscript,
      });
    },
    [submitRef, flagsRef, setWaiting, setError, setFailedTranscript],
  );
}

function useBatchDeliveryLifecycle(
  flagsRef: BatchTurnDelivery["flagsRef"],
  setWaiting: (value: boolean) => void,
  setError: (value: string | undefined) => void,
  setFailedTranscript: (value: string | undefined) => void,
): Pick<BatchTurnDelivery, "activate" | "deactivate" | "clearError" | "takeSettledAnswer"> {
  const activate = useCallback((): void => {
    changeDeliveryActivity(flagsRef.current, true, setWaiting, setError, setFailedTranscript);
  }, [flagsRef, setWaiting, setError, setFailedTranscript]);
  const deactivate = useCallback((): void => {
    changeDeliveryActivity(flagsRef.current, false, setWaiting, setError, setFailedTranscript);
  }, [flagsRef, setWaiting, setError, setFailedTranscript]);
  const clearError = useCallback((): void => {
    setError(undefined);
    setFailedTranscript(undefined);
  }, [setError, setFailedTranscript]);
  const takeSettledAnswer = useCallback(
    (id: string): boolean => {
      const flags = flagsRef.current;
      if (!flags.active || flags.expectedAnswerId !== id) return false;
      flags.expectedAnswerId = undefined;
      setWaiting(false);
      reportBatchStage("playback-settled", flags.expectedAnswerCorrelationId);
      flags.expectedAnswerCorrelationId = undefined;
      return true;
    },
    [flagsRef, setWaiting],
  );
  return { activate, deactivate, clearError, takeSettledAnswer };
}

function useBatchTurnDelivery(submit: BatchVoiceDialogueOptions["submit"]): BatchTurnDelivery {
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const flagsRef = useRef<DeliveryFlags>({
    active: false,
    generation: 0,
    expectedAnswerId: undefined,
    expectedAnswerCorrelationId: undefined,
    sessionCorrelationId: undefined,
  });
  const [waitingForAnswer, setWaitingForAnswer] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [failedTranscript, setFailedTranscript] = useState<string | undefined>();
  const acceptTranscript = useBatchTurnAdmission(
    submitRef,
    flagsRef,
    setWaitingForAnswer,
    setError,
    setFailedTranscript,
  );
  const { activate, deactivate, clearError, takeSettledAnswer } = useBatchDeliveryLifecycle(
    flagsRef,
    setWaitingForAnswer,
    setError,
    setFailedTranscript,
  );
  return {
    flagsRef,
    waitingForAnswer,
    error,
    failedTranscript,
    acceptTranscript,
    activate,
    deactivate,
    clearError,
    takeSettledAnswer,
  };
}

function useBatchTranscriptPreview(
  dictation: DictationController,
  flagsRef: BatchTurnDelivery["flagsRef"],
): void {
  const handledRef = useRef(false);
  const { phase, transcript, discard, insert, start } = dictation;
  useEffect((): void => {
    if (phase !== "preview") {
      handledRef.current = false;
      return;
    }
    if (!flagsRef.current.active || handledRef.current) return;
    handledRef.current = true;
    if (transcript.trim().length === 0) {
      discard();
      start();
      return;
    }
    insert();
  }, [phase, transcript, discard, insert, start, flagsRef]);
}

async function prepareBatchCapture(input: {
  readonly prepare: () => Promise<void>;
  readonly flagsRef: BatchTurnDelivery["flagsRef"];
  readonly generation: number;
  readonly preparedRef: { current: boolean };
  readonly setPreparing: (value: boolean) => void;
  readonly setStartupError: (value: string) => void;
  readonly startDictation: () => void;
}): Promise<void> {
  try {
    await input.prepare();
    if (!deliveryIsCurrent(input.flagsRef.current, input.generation)) return;
    input.preparedRef.current = true;
    input.setPreparing(false);
    input.startDictation();
  } catch {
    if (!deliveryIsCurrent(input.flagsRef.current, input.generation)) return;
    input.setPreparing(false);
    input.setStartupError("Voice could not be prepared. Try again.");
    reportBatchStage("preparation-failed", input.flagsRef.current.sessionCorrelationId);
  }
}

function useBatchCapturePreparation(
  options: BatchVoiceDialogueOptions,
  flagsRef: BatchTurnDelivery["flagsRef"],
  activate: () => void,
  startDictation: () => void,
): {
  readonly start: () => void;
  readonly preparedRef: { current: boolean };
  readonly preparing: boolean;
  readonly startupError: string | undefined;
  readonly reset: () => void;
} {
  const prepareRef = useRef(
    options.prepareCanonicalVoiceHasher ?? prepareDefaultCanonicalVoiceHasher,
  );
  prepareRef.current = options.prepareCanonicalVoiceHasher ?? prepareDefaultCanonicalVoiceHasher;
  const preparedRef = useRef(
    options.prepareCanonicalVoiceHasher === undefined && canonicalVoiceHasherIsReady(),
  );
  const [preparing, setPreparing] = useState(false);
  const [startupError, setStartupError] = useState<string | undefined>();
  const start = useCallback((): void => {
    activate();
    reportBatchStage("started", flagsRef.current.sessionCorrelationId);
    setStartupError(undefined);
    if (preparedRef.current) {
      startDictation();
      return;
    }
    const generation = flagsRef.current.generation;
    setPreparing(true);
    void prepareBatchCapture({
      prepare: prepareRef.current,
      flagsRef,
      generation,
      preparedRef,
      setPreparing,
      setStartupError,
      startDictation,
    });
  }, [activate, flagsRef, startDictation]);
  const reset = useCallback((): void => {
    setPreparing(false);
    setStartupError(undefined);
  }, []);
  return { start, preparedRef, preparing, startupError, reset };
}

function useBatchSpeechSettlement(
  takeSettledAnswer: (assistantMessageId: string) => boolean,
  startDictation: () => void,
): (assistantMessageId: string) => void {
  return useCallback(
    (id: string): void => {
      if (takeSettledAnswer(id)) startDictation();
    },
    [takeSettledAnswer, startDictation],
  );
}

export function useBatchVoiceDialogue(options: BatchVoiceDialogueOptions): BatchVoiceDialogue {
  const delivery = useBatchTurnDelivery(options.submit);
  const { flagsRef, acceptTranscript, activate, deactivate, clearError, takeSettledAnswer } =
    delivery;
  const vad = useMemo(() => createBrowserVoiceActivityDetector(), []);
  const dictation = useDictation({
    ...options.dictation,
    onInsert: acceptTranscript,
    captureOwner: options.captureOwner,
    captureLease: options.captureLease,
    vad: options.dictation?.vad ?? vad,
  });
  const { start: startDictation, cancel, retry: retryDictation } = dictation;
  useBatchTranscriptPreview(dictation, flagsRef);
  const { start, reset, preparedRef, preparing, startupError } = useBatchCapturePreparation(
    options,
    flagsRef,
    activate,
    startDictation,
  );
  const stop = useCallback((): void => {
    if (flagsRef.current.active) {
      reportBatchStage("stopped", flagsRef.current.sessionCorrelationId);
    }
    deactivate();
    reset();
    cancel();
  }, [deactivate, reset, cancel, flagsRef]);
  const retry = useCallback((): void => {
    if (!flagsRef.current.active) return;
    clearError();
    if (!preparedRef.current) start();
    else retryDictation();
  }, [flagsRef, clearError, retryDictation, preparedRef, start]);
  const onSpeechSettled = useBatchSpeechSettlement(takeSettledAnswer, startDictation);
  useEffect(() => stop, [stop]);
  return {
    dictation,
    waitingForAnswer: delivery.waitingForAnswer,
    preparing,
    error: startupError ?? delivery.error,
    failedTranscript: delivery.failedTranscript,
    start,
    stop,
    retry,
    onSpeechSettled,
  };
}
