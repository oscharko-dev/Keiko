"use client";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ApiError } from "@/lib/api";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { bffRequestErrorKind } from "@/lib/http";

type DecisionView = { readonly state: string; readonly expiresAt: number };
interface DecisionState<T> {
  readonly key: string;
  readonly resolved?: T;
  readonly busy: boolean;
  readonly failed: boolean;
  readonly uncertain: boolean;
}
interface RequestOwner {
  active: boolean;
  busy: boolean;
}

function useRequestOwner(key: string): RefObject<RequestOwner | undefined> {
  const owner = useRef<RequestOwner | undefined>(undefined);
  useLayoutEffect(() => {
    const current = { active: true, busy: false };
    owner.current = current;
    return (): void => {
      current.active = false;
    };
  }, [key]);
  return owner;
}
function useExpired(expiresAt: number): boolean {
  const [elapsed, setElapsed] = useState<number>();
  useEffect(() => {
    const timer = setTimeout(() => setElapsed(expiresAt), Math.max(0, expiresAt - Date.now()));
    return (): void => clearTimeout(timer);
  }, [expiresAt]);
  return elapsed === expiresAt || Date.now() >= expiresAt;
}
async function performDecision<T>(input: {
  readonly owner: RequestOwner | undefined;
  readonly key: string;
  readonly execute: () => Promise<T>;
  readonly blockAfterFailure: boolean;
  readonly report: (state: DecisionState<T>) => void;
}): Promise<void> {
  const { owner, key, report } = input;
  if (owner === undefined || !owner.active || owner.busy) return;
  owner.busy = true;
  report({ key, busy: true, failed: false, uncertain: false });
  try {
    const resolved = await input.execute();
    if (owner.active) report({ key, resolved, busy: false, failed: false, uncertain: false });
  } catch (error) {
    reportClientDiagnostic("Jira Chat decision failed.", {
      kind: "other",
      correlationId: error instanceof ApiError ? error.correlationId : undefined,
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
    });
    if (owner.active)
      report({ key, busy: false, failed: true, uncertain: input.blockAfterFailure });
  } finally {
    owner.busy = false;
  }
}
const EXPIRABLE_STATES = new Set(["pending", "granted", "approved"]);
const STATE_RANK: Readonly<Record<string, number>> = {
  pending: 0,
  granted: 1,
  approved: 1,
  claimed: 2,
  rejected: 3,
  expired: 3,
  revoked: 4,
};
function latestDecision<T extends DecisionView>(current: T, resolved: T | undefined): T {
  if (resolved === undefined) return current;
  return (STATE_RANK[resolved.state] ?? 0) > (STATE_RANK[current.state] ?? 0) ? resolved : current;
}
function useInitialObservation<T>(input: {
  readonly key: string;
  readonly owner: RefObject<RequestOwner | undefined>;
  readonly observe: (() => Promise<T>) | undefined;
  readonly report: (state: DecisionState<T>) => void;
}): void {
  const { key, owner, observe, report } = input;
  useEffect(() => {
    if (observe !== undefined)
      void performDecision({
        owner: owner.current,
        key,
        execute: observe,
        blockAfterFailure: true,
        report,
      });
  }, [key, owner, observe, report]);
}

function matchingState<T>(key: string, state: DecisionState<T> | undefined): DecisionState<T> {
  return state?.key === key ? state : { key, busy: false, failed: false, uncertain: false };
}

export function useJiraDecision<T extends DecisionView>(input: {
  readonly key: string;
  readonly current: T;
  readonly decide: (decision: "approve" | "reject") => Promise<T>;
  readonly observe?: () => Promise<T>;
}): {
  view: T;
  busy: boolean;
  failed: boolean;
  uncertain: boolean;
  verified: boolean;
  submit: (decision: "approve" | "reject") => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<DecisionState<T>>();
  const owner = useRequestOwner(input.key);
  const local = matchingState(input.key, state);
  const current = latestDecision(input.current, local.resolved);
  useInitialObservation({ key: input.key, owner, observe: input.observe, report: setState });
  const expired = useExpired(current.expiresAt);
  const view =
    expired && EXPIRABLE_STATES.has(current.state) ? { ...current, state: "expired" } : current;
  const run = (execute: () => Promise<T>): Promise<void> =>
    performDecision({
      owner: owner.current,
      key: input.key,
      execute,
      blockAfterFailure: input.observe !== undefined,
      report: setState,
    });
  const verified = input.observe === undefined || local.resolved !== undefined;
  return {
    verified,
    view,
    busy: local.busy,
    failed: local.failed,
    uncertain: local.uncertain,
    submit: async (decision): Promise<void> => {
      if (verified && view.state === "pending" && !local.uncertain)
        await run(() => input.decide(decision));
    },
    refresh: async (): Promise<void> => {
      if (input.observe !== undefined) await run(input.observe);
    },
  };
}
