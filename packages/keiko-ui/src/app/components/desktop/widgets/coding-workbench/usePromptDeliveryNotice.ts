"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CodingWorkbenchPromptDelivery } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import type { CodingWorkbenchMutationState } from "@/lib/coding-workbench-live-state";

/** What the last message sent to the running turn came to; `null` is nothing to say. */
export type PromptDeliveryNotice = CodingWorkbenchPromptDelivery | "failed" | null;

export interface PromptDeliveryNoticeController {
  readonly notice: PromptDeliveryNotice;
  /** Call as a message is sent: the next follow-up mutation to settle is that message. */
  readonly begin: (delivery: CodingWorkbenchPromptDelivery) => void;
}

/**
 * Turns the settlement of a delivered message into a notice the composer announces. The mutation
 * queue reports success and failure only through its state, so the settlement is read from the
 * transition of that state: a pending follow-up that returns to idle was accepted, one that ends in
 * an error was refused. A new run clears the notice; so does the start of any other action.
 */
export function usePromptDeliveryNotice(
  mutation: CodingWorkbenchMutationState,
  runId: string | undefined,
): PromptDeliveryNoticeController {
  const [notice, setNotice] = useState<PromptDeliveryNotice>(null);
  const awaiting = useRef<CodingWorkbenchPromptDelivery | null>(null);
  const previous = useRef(mutation);
  useEffect(() => {
    const before = previous.current;
    previous.current = mutation;
    if (mutation.status === "pending") {
      if (before.status !== "pending") setNotice(null);
      return;
    }
    if (before.status !== "pending" || before.kind !== "follow-up") return;
    const delivery = awaiting.current;
    awaiting.current = null;
    if (delivery !== null) setNotice(mutation.status === "idle" ? delivery : "failed");
  }, [mutation]);
  useEffect(() => {
    awaiting.current = null;
    setNotice(null);
  }, [runId]);
  const begin = useCallback((delivery: CodingWorkbenchPromptDelivery): void => {
    awaiting.current = delivery;
  }, []);
  return { notice, begin };
}
