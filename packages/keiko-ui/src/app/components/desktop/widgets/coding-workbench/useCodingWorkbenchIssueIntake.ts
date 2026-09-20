"use client";

import { useEffect, useRef, useState } from "react";
import type { CodingWorkbenchIssueBindingFailure } from "@oscharko-dev/keiko-contracts";
import {
  findGitHubIssueReferences,
  parseGitHubIssueReference,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { previewCodingWorkbenchIssue } from "@/lib/api";
import { codingWorkbenchIssueFailure } from "@/lib/coding-workbench-issue-errors";
import { correlationIdOf } from "@/lib/client-error-summary";
import { UNKNOWN_REPOSITORY_ERROR_CODE } from "@oscharko-dev/keiko-contracts/runtime/bff-wire";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import type { CodingWorkbenchIssueStartIntent } from "@/lib/coding-workbench-runtime-actions";

type IssueIntakeFailure =
  | CodingWorkbenchIssueBindingFailure
  | "unknown"
  | "read-transient-failure"
  | "unknown-repository"
  | "multiple-issues";
export type IssueIntakeState =
  | { readonly kind: "empty" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "failed";
      readonly failure: IssueIntakeFailure;
      readonly correlationId: string | undefined;
    };
type StartIssue = (issue: CodingWorkbenchIssueStartIntent | undefined) => void | Promise<void>;

function issueFailure(error: unknown): IssueIntakeFailure {
  if (typeof error !== "object" || error === null || !("code" in error)) return "unknown";
  if (error.code === "CODING_WORKBENCH_ISSUE_READ_TRANSIENT_FAILURE")
    return "read-transient-failure";
  if (error.code === UNKNOWN_REPOSITORY_ERROR_CODE) return "unknown-repository";
  return codingWorkbenchIssueFailure(error.code) ?? "unknown";
}

type PromptIssue = { readonly issueRef?: string; readonly qualifiedRef?: string };
type PromptReference = PromptIssue | { readonly failure: IssueIntakeFailure };
const URL_TRAILING_PUNCTUATION = new Set([")", "]", ".", ",", ";", "!", "?"]);

function issueUrlToken(token: string): string | undefined {
  const start = token.search(/https?:\/\//u);
  if (start < 0) return undefined;
  let end = token.length;
  while (end > start && URL_TRAILING_PUNCTUATION.has(token.charAt(end - 1))) end -= 1;
  const candidate = token.slice(start, end);
  if (!/^https?:\/\/github\.com\//iu.test(candidate)) return undefined;
  return /\/(?:issues|pull)\//u.test(candidate) ? candidate : undefined;
}

function promptReference(prompt: string): PromptReference {
  const refs = new Set<string>();
  for (const token of prompt.split(/[\s<>"`]/u)) {
    const candidate = issueUrlToken(token);
    if (candidate === undefined) continue;
    const parsed = parseGitHubIssueReference(candidate);
    if (!parsed.ok) return { failure: "invalid-reference" };
    refs.add(
      `https://github.com/${parsed.reference.ownerAndRepo.toLowerCase()}/issues/${String(parsed.reference.issueNumber)}`,
    );
  }
  for (const reference of findGitHubIssueReferences(prompt, prompt.length))
    refs.add(
      `https://github.com/${reference.ownerAndRepo.toLowerCase()}/issues/${String(reference.issueNumber)}`,
    );
  for (const [, number] of prompt.matchAll(/(?:^|\s)#(\d{1,10})(?=$|[\s.,:;!?])/gu)) {
    refs.add(`#${number}`);
  }
  if (refs.size > 1) return mixedReference(refs);
  const issueRef = [...refs][0];
  return issueRef === undefined ? {} : { issueRef };
}

function mixedReference(refs: ReadonlySet<string>): PromptReference {
  const bare = [...refs].find((ref) => ref.startsWith("#"));
  const qualified = [...refs].find((ref) => ref.startsWith("https://"));
  if (refs.size !== 2 || bare === undefined || qualified?.split("/").at(-1) !== bare.slice(1))
    return { failure: "multiple-issues" };
  // Only the server-resolved checkout remote can tell whether these denote the same issue.
  return { issueRef: bare, qualifiedRef: qualified };
}

async function resolvePromptIssue(
  root: string,
  reference: PromptIssue & { readonly issueRef: string },
  controller: AbortController,
  publish: (state: IssueIntakeState) => void,
  start: StartIssue,
): Promise<void> {
  try {
    const response = await previewCodingWorkbenchIssue(
      { repositoryPath: root.trim(), issueRef: reference.issueRef },
      controller.signal,
    );
    if (controller.signal.aborted) return;
    const qualified = reference.qualifiedRef;
    if (
      qualified !== undefined &&
      qualified !==
        `https://github.com/${response.preview.provenance.ownerAndRepo.toLowerCase()}/issues/${String(response.preview.provenance.issueNumber)}`
    ) {
      reportClientDiagnostic("[keiko] coding workbench prompt issue refused: multiple-issues");
      publish({ kind: "failed", failure: "multiple-issues", correlationId: undefined });
      return;
    }
    reportClientDiagnostic("[keiko] coding workbench prompt issue resolved");
    await start({
      issueRef: qualified ?? reference.issueRef,
      expectedIssueBindingDigest: response.binding.bindingDigest,
    });
    if (!controller.signal.aborted) publish({ kind: "empty" });
  } catch (error) {
    if (controller.signal.aborted) return;
    const failure = issueFailure(error);
    const correlationId = correlationIdOf(error);
    reportClientDiagnostic(`[keiko] coding workbench prompt issue failed: ${failure}`, {
      correlationId,
    });
    publish({ kind: "failed", failure, correlationId });
  }
}

export function useCodingWorkbenchIssueIntake(
  repositoryPath: string,
  scope: string,
): {
  readonly state: IssueIntakeState;
  readonly submit: (prompt: string, start: StartIssue) => Promise<void>;
  readonly cancel: () => void;
} {
  const [state, setState] = useState<IssueIntakeState>({ kind: "empty" });
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    request.current?.abort();
    setState({ kind: "empty" });
    return (): void => request.current?.abort();
  }, [repositoryPath, scope]);
  const cancel = (): void => {
    request.current?.abort();
    setState({ kind: "empty" });
    reportClientDiagnostic("[keiko] coding workbench prompt issue cancelled");
  };
  const submit = async (prompt: string, start: StartIssue): Promise<void> => {
    request.current?.abort();
    const reference = promptReference(prompt);
    if ("failure" in reference) {
      reportClientDiagnostic(`[keiko] coding workbench prompt issue refused: ${reference.failure}`);
      setState({ kind: "failed", failure: reference.failure, correlationId: undefined });
      return;
    }
    setState({ kind: "empty" });
    if (reference.issueRef === undefined) {
      await start(undefined);
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setState({ kind: "loading" });
    reportClientDiagnostic("[keiko] coding workbench prompt issue requested");
    await resolvePromptIssue(
      repositoryPath,
      { ...reference, issueRef: reference.issueRef },
      controller,
      setState,
      start,
    );
  };
  return { state, submit, cancel };
}
