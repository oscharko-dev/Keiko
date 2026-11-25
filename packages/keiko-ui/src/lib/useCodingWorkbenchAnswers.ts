"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityTextDelta,
  CodingSafeActivityTextPart,
} from "@oscharko-dev/keiko-contracts";

import {
  CodingWorkbenchModelTextReader,
  type CodingWorkbenchModelTexts,
} from "./codingWorkbenchModelTextReader";

export type {
  CodingWorkbenchAnswers,
  CodingWorkbenchAnswerText,
  CodingWorkbenchModelTexts,
} from "./codingWorkbenchModelTextReader";

const NO_TEXTS: CodingWorkbenchModelTexts = { answers: new Map(), reasoning: new Map() };

export interface UseCodingWorkbenchModelTextsResult extends CodingWorkbenchModelTexts {
  /** Appends a live update's deltas at once, before render batching could drop the update. */
  readonly ingestDeltas: (deltas: readonly CodingSafeActivityTextDelta[] | undefined) => void;
  /** Someone opened a reasoning block: read the rest of that reasoning. */
  readonly readReasoning: (messageId: string) => void;
  /** Read a text whose read failed again. */
  readonly retryText: (part: CodingSafeActivityTextPart, messageId: string) => void;
}

interface PublishedTexts {
  readonly runId: string;
  readonly texts: CodingWorkbenchModelTexts;
}

/**
 * One run's complete model texts beside its bounded feed. The texts are held per run: another run
 * starts from nothing, and the previous run's texts are never rendered for it.
 */
export function useCodingWorkbenchModelTexts(
  runId: string | undefined,
  feed: AvailableCodingSafeActivityFeed | null,
): UseCodingWorkbenchModelTextsResult {
  const [published, setPublished] = useState<PublishedTexts | null>(null);
  const readerRef = useRef<CodingWorkbenchModelTextReader | undefined>(undefined);
  useEffect(() => {
    if (runId === undefined) return undefined;
    const reader = new CodingWorkbenchModelTextReader(runId, (texts) => {
      setPublished({ runId, texts });
    });
    readerRef.current = reader;
    return () => {
      reader.dispose();
      if (readerRef.current === reader) readerRef.current = undefined;
    };
  }, [runId]);
  useEffect(() => {
    if (feed !== null) readerRef.current?.sync(feed);
  }, [feed, runId]);
  const ingestDeltas = useCallback(
    (deltas: readonly CodingSafeActivityTextDelta[] | undefined): void => {
      readerRef.current?.ingestDeltas(deltas);
    },
    [],
  );
  const readReasoning = useCallback((messageId: string): void => {
    readerRef.current?.wantReasoning(messageId);
  }, []);
  const retryText = useCallback((part: CodingSafeActivityTextPart, messageId: string): void => {
    readerRef.current?.retry(part, messageId);
  }, []);
  const texts = published !== null && published.runId === runId ? published.texts : NO_TEXTS;
  return { ...texts, ingestDeltas, readReasoning, retryText };
}
