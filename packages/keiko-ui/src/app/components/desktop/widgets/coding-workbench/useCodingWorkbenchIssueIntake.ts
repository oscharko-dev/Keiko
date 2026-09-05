"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CodingWorkbenchIssueBindingProjection,
  CodingWorkbenchIssueBindingFailure,
} from "@oscharko-dev/keiko-contracts";
import { previewCodingWorkbenchIssue, type GitHubIssuePreviewResponseWire } from "@/lib/api";
import { codingWorkbenchIssueFailure } from "@/lib/coding-workbench-issue-errors";
import { correlationIdOf } from "@/lib/client-error-summary";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";

export interface AcceptedWorkbenchIssue {
  readonly repositoryPath: string;
  readonly issueRef: string;
  readonly label: string;
  readonly binding: CodingWorkbenchIssueBindingProjection;
}

export type IssueIntakeFailure =
  CodingWorkbenchIssueBindingFailure | "unknown" | "unavailable-runtime";
type IssueIntakeState =
  | { readonly kind: "empty" | "loading" | "cancelled" }
  | { readonly kind: "ready"; readonly response: GitHubIssuePreviewResponseWire }
  | {
      readonly kind: "failed";
      readonly failure: IssueIntakeFailure;
      readonly correlationId: string | undefined;
    };

function issueFailure(error: unknown): IssueIntakeFailure {
  if (typeof error !== "object" || error === null || !("code" in error)) return "unknown";
  return codingWorkbenchIssueFailure(error.code) ?? "unknown";
}

export function codingWorkbenchIssueTaskId(issueNumber: number): string {
  return `coding-workbench-issue-${String(issueNumber)}`;
}

export function acceptedWorkbenchIssue(
  response: GitHubIssuePreviewResponseWire,
  repositoryPath: string,
): AcceptedWorkbenchIssue {
  const { ownerAndRepo, issueNumber, url } = response.preview.provenance;
  reportClientDiagnostic(
    `[keiko] coding workbench issue accepted: issue ${String(issueNumber)} binding ${response.binding.bindingDigest.slice(0, 12)}`,
  );
  return {
    repositoryPath: repositoryPath.trim(),
    issueRef: url,
    label: `${ownerAndRepo}#${String(issueNumber)}`,
    binding: response.binding,
  };
}

export interface IssueIntakeController {
  readonly issueRef: string;
  readonly state: IssueIntakeState;
  readonly change: (value: string) => void;
  readonly preview: () => void;
  readonly cancel: () => void;
  readonly reset: () => void;
}

async function resolvePreview(
  repositoryPath: string,
  issueRef: string,
  controller: AbortController,
  publish: (state: IssueIntakeState) => void,
): Promise<void> {
  try {
    const response = await previewCodingWorkbenchIssue(
      { repositoryPath: repositoryPath.trim(), issueRef: issueRef.trim() },
      controller.signal,
    );
    if (controller.signal.aborted) return;
    reportClientDiagnostic(
      `[keiko] coding workbench issue preview ready: issue ${String(response.binding.issueNumber)}`,
    );
    publish({ kind: "ready", response });
  } catch (error) {
    if (controller.signal.aborted) return;
    const failure = issueFailure(error);
    const correlationId = correlationIdOf(error);
    reportClientDiagnostic(`[keiko] coding workbench issue preview failed: ${failure}`, {
      correlationId,
    });
    publish({ kind: "failed", failure, correlationId });
  }
}

export function useCodingWorkbenchIssueIntake(repositoryPath: string): IssueIntakeController {
  const [issueRef, setIssueRef] = useState("");
  const [state, setState] = useState<IssueIntakeState>({ kind: "empty" });
  const request = useRef<AbortController | null>(null);
  const reset = useCallback((): void => {
    request.current?.abort();
    setState({ kind: "empty" });
  }, []);
  useEffect(() => {
    reset();
    return (): void => request.current?.abort();
  }, [repositoryPath, reset]);
  const change = (value: string): void => {
    reset();
    setIssueRef(value);
  };
  const preview = (): void => {
    if (repositoryPath.trim() === "" || issueRef.trim() === "") return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState({ kind: "loading" });
    reportClientDiagnostic("[keiko] coding workbench issue preview requested");
    void resolvePreview(repositoryPath, issueRef, controller, setState);
  };
  const cancel = (): void => {
    request.current?.abort();
    setState({ kind: "cancelled" });
    reportClientDiagnostic("[keiko] coding workbench issue preview cancelled");
  };
  return { issueRef, state, change, preview, cancel, reset };
}
