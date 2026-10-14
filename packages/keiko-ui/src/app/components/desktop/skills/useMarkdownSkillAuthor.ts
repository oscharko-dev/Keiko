"use client";

import { useEffect, useRef, useState } from "react";
import { MARKDOWN_SKILL_LIMITS } from "@oscharko-dev/keiko-contracts/bff-wire";
import { enhancePrompt } from "@/lib/api";
import { codingAppSessionPairingSettled } from "@/lib/coding-app-session-client";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { correlationIdOf } from "@/lib/client-error-summary";
import { bffRequestErrorKind } from "@/lib/http";

type DraftError = "source" | "generation" | undefined;

export function skillTextFits(text: string): boolean {
  return (
    text.trim().length > 0 &&
    new TextEncoder().encode(text).byteLength <= MARKDOWN_SKILL_LIMITS.importBytes
  );
}

export interface MarkdownSkillAuthorState {
  readonly source: string;
  readonly draft: string | undefined;
  readonly busy: boolean;
  readonly error: DraftError;
  readonly setSource: (value: string) => void;
  readonly setDraft: (value: string) => void;
  readonly load: (file: File) => Promise<void>;
  readonly generate: () => Promise<void>;
  readonly cancel: () => void;
}

async function generateSkill(
  source: string,
  modelId: string,
  signal: AbortSignal,
): Promise<string> {
  await codingAppSessionPairingSettled();
  signal.throwIfAborted();
  const result = await enhancePrompt(
    { text: source, modelId, outputKind: "markdown-skill", candidateCount: 1 },
    AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
  );
  if (
    result.outputKind !== "markdown-skill" ||
    result.modelRouting.executionStatus !== "model-applied" ||
    !skillTextFits(result.renderedPrompt)
  )
    throw new TypeError("No complete skill draft returned.");
  return result.renderedPrompt;
}

async function readSource(file: File): Promise<string> {
  if (!/\.(?:md|txt)$/iu.test(file.name) || file.size > MARKDOWN_SKILL_LIMITS.importBytes)
    throw new TypeError("Unsupported skill source file.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  if (!skillTextFits(text) || text.length > 100_000) throw new TypeError("Invalid skill source.");
  return text;
}

function reportAuthorFailure(error: unknown): void {
  reportClientDiagnostic("Private skill draft request failed.", {
    correlationId: correlationIdOf(error),
    errorKind: bffRequestErrorKind(error),
    errorEvidence: clientErrorEvidence(error),
  });
}

function useAuthorRequest(): {
  readonly busy: boolean;
  readonly error: DraftError;
  readonly setError: (value: DraftError) => void;
  readonly cancel: () => void;
  readonly run: (
    operation: (signal: AbortSignal) => Promise<void>,
    failure: DraftError,
  ) => Promise<void>;
} {
  const current = useRef<AbortController | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DraftError>();
  useEffect(
    () => (): void => {
      current.current?.abort();
    },
    [],
  );
  const cancel = (): void => {
    current.current?.abort();
    current.current = undefined;
    setBusy(false);
  };
  const run = async (
    operation: (signal: AbortSignal) => Promise<void>,
    failure: DraftError,
  ): Promise<void> => {
    if (current.current !== undefined) return;
    const controller = new AbortController();
    current.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      await operation(controller.signal);
    } catch (error_) {
      if (!controller.signal.aborted) {
        setError(failure);
        reportAuthorFailure(error_);
      }
    } finally {
      if (!controller.signal.aborted) {
        current.current = undefined;
        setBusy(false);
      }
    }
  };
  return { busy, error, setError, run, cancel };
}

export function useMarkdownSkillAuthor(modelId: string | undefined): MarkdownSkillAuthorState {
  const [source, setSource] = useState("");
  const [draft, setDraft] = useState<string>();
  const request = useAuthorRequest();
  return {
    source,
    draft,
    busy: request.busy,
    error: request.error,
    setDraft,
    cancel: request.cancel,
    setSource: (value): void => {
      setSource(value);
      setDraft(undefined);
      request.setError(undefined);
    },
    load: (file) =>
      request.run(async (signal) => {
        const text = await readSource(file);
        if (!signal.aborted) {
          setSource(text);
          setDraft(undefined);
        }
      }, "source"),
    generate: async (): Promise<void> => {
      if (!modelId) return;
      if (!skillTextFits(source) || source.length > 100_000) {
        request.setError("source");
        return;
      }
      setDraft(undefined);
      await request.run(async (signal) => {
        const next = await generateSkill(source, modelId, signal);
        if (!signal.aborted) setDraft(next);
      }, "generation");
    },
  };
}
