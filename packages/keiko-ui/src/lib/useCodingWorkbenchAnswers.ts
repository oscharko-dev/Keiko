"use client";

import { useEffect, useRef, useState } from "react";
import type { AvailableCodingSafeActivityFeed } from "@oscharko-dev/keiko-contracts";
import { isActivityLogCorrelationId } from "@oscharko-dev/keiko-contracts/runtime/observability";

import { getCodingAppSessionAnswerPage } from "./coding-app-session-channel-api";
import { clientErrorEvidence } from "./client-error-evidence";
import { reportClientDiagnostic } from "./client-diagnostics";

/**
 * The complete text of one assistant answer the feed names as longer than it carries
 * (`fullAnswer`). A model's answer is never cut to fit the bounded feed: its text is read page by
 * page from the server and shown whole.
 */
export interface CodingWorkbenchAnswerText {
  readonly text: string;
  /** The text holds every character the feed last said the answer has. */
  readonly complete: boolean;
  /** The server's memory bound cut the answer: the shown text ends with a truncation mark. */
  readonly truncated: boolean;
  /** Reading the rest failed; the feed's part stays shown and the cut is marked. */
  readonly failed: boolean;
}

/** Complete answers by message id, for one run. */
export type CodingWorkbenchAnswers = ReadonlyMap<string, CodingWorkbenchAnswerText>;

const NO_ANSWERS: CodingWorkbenchAnswers = new Map();

interface NamedAnswer {
  readonly messageId: string;
  readonly length: number;
  readonly truncated: boolean;
}

function namedAnswers(feed: AvailableCodingSafeActivityFeed | null): readonly NamedAnswer[] {
  if (feed === null) return [];
  return feed.turns.flatMap((turn) =>
    turn.messages.flatMap((message) =>
      message.fullAnswer === undefined
        ? []
        : [{ messageId: message.messageId, ...message.fullAnswer }],
    ),
  );
}

interface AnswerReader {
  readonly runId: string;
  readonly controller: AbortController;
  readonly held: Map<string, CodingWorkbenchAnswerText>;
  readonly targets: Map<string, NamedAnswer>;
  readonly reading: Set<string>;
  readonly publish: () => void;
}

/**
 * Reads every answer the feed names until it holds the whole answer, one request per answer at a
 * time, and reads on while a streaming answer grows. Each page continues exactly where the held
 * text ends, so the text is always a true prefix of the answer.
 */
export function useCodingWorkbenchAnswers(
  feed: AvailableCodingSafeActivityFeed | null,
): CodingWorkbenchAnswers {
  const [answers, setAnswers] = useState<CodingWorkbenchAnswers>(NO_ANSWERS);
  const readerRef = useRef<AnswerReader | undefined>(undefined);
  const runId = feed?.runId;
  useEffect(() => {
    if (runId === undefined) return undefined;
    const reader: AnswerReader = {
      runId,
      controller: new AbortController(),
      held: new Map(),
      targets: new Map(),
      reading: new Set(),
      publish: () => {
        if (!reader.controller.signal.aborted) setAnswers(new Map(reader.held));
      },
    };
    readerRef.current = reader;
    setAnswers(NO_ANSWERS);
    return () => {
      reader.controller.abort();
      if (readerRef.current === reader) readerRef.current = undefined;
    };
  }, [runId]);
  useEffect(() => {
    const reader = readerRef.current;
    if (reader === undefined || feed === null || reader.runId !== feed.runId) return;
    for (const named of namedAnswers(feed)) {
      reader.targets.set(named.messageId, named);
      if (!reader.reading.has(named.messageId)) void readAnswer(reader, named.messageId);
    }
  }, [feed]);
  return runId === undefined ? NO_ANSWERS : answers;
}

async function readAnswer(reader: AnswerReader, messageId: string): Promise<void> {
  reader.reading.add(messageId);
  try {
    while (!reader.controller.signal.aborted && !holdsWholeAnswer(reader, messageId)) {
      if (!(await readNextPage(reader, messageId))) return;
    }
  } finally {
    reader.reading.delete(messageId);
  }
}

function holdsWholeAnswer(reader: AnswerReader, messageId: string): boolean {
  const held = reader.held.get(messageId);
  const target = reader.targets.get(messageId);
  return target === undefined || (held !== undefined && held.text.length >= target.length);
}

// One page from where the held text ends; false once reading cannot go on.
async function readNextPage(reader: AnswerReader, messageId: string): Promise<boolean> {
  const held = reader.held.get(messageId)?.text ?? "";
  try {
    const { page } = await getCodingAppSessionAnswerPage(
      { runId: reader.runId, messageId, offset: held.length },
      reader.controller.signal,
    );
    if (reader.controller.signal.aborted) return false;
    if (page?.offset !== held.length || (page.text.length === 0 && page.length > held.length)) {
      markFailed(reader, messageId, held, undefined);
      return false;
    }
    const text = held + page.text;
    const target = reader.targets.get(messageId);
    reader.held.set(messageId, {
      text,
      complete: text.length >= Math.max(page.length, target?.length ?? 0),
      truncated: page.truncated,
      failed: false,
    });
    reader.publish();
    return page.text.length > 0;
  } catch (error) {
    if (!reader.controller.signal.aborted) markFailed(reader, messageId, held, error);
    return false;
  }
}

function markFailed(reader: AnswerReader, messageId: string, held: string, error: unknown): void {
  reader.held.set(messageId, {
    text: held,
    complete: false,
    truncated: reader.targets.get(messageId)?.truncated ?? false,
    failed: true,
  });
  reader.publish();
  // Body-free: the run joins it to the server's page lines; never the message id or any text.
  reportClientDiagnostic("Keiko Coding Workbench could not read the rest of a long answer.", {
    correlationId: isActivityLogCorrelationId(reader.runId) ? reader.runId : undefined,
    errorKind: "unavailable",
    ...(error === undefined ? {} : { errorEvidence: clientErrorEvidence(error) }),
  });
}
