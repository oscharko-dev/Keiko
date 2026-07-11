"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { FeedbackReceiptV1 } from "@/lib/feedback-api";
import type { FeedbackClipboardWriter } from "./FeedbackPublicHandoff";
import type { FeedbackReceiptCopyState } from "./FeedbackSubmissionReview";

function clipboardText(receipt: FeedbackReceiptV1): string {
  return [
    `Receipt ID: ${receipt.receiptId}`,
    `Receipt secret: ${receipt.receiptSecret}`,
    `Expires at: ${receipt.expiresAt}`,
  ].join("\n");
}

export function useFeedbackReceipt(writeClipboard: FeedbackClipboardWriter) {
  const [receipt, setReceipt] = useState<FeedbackReceiptV1 | undefined>();
  const [copyState, setCopyState] = useState<FeedbackReceiptCopyState>("idle");
  const receiptRef = useRef<FeedbackReceiptV1 | undefined>();
  const clear = useCallback((): void => {
    receiptRef.current = undefined;
    setReceipt(undefined);
    setCopyState("idle");
  }, []);
  const accept = useCallback(
    (value: FeedbackReceiptV1 | undefined): void => {
      clear();
      if (value === undefined) return;
      receiptRef.current = value;
      setReceipt(value);
    },
    [clear],
  );
  const copy = useCallback((): void => {
    const current = receiptRef.current;
    if (current === undefined || copyState === "copying") return;
    setCopyState("copying");
    void writeClipboard(clipboardText(current))
      .then(() => {
        receiptRef.current = undefined;
        setReceipt(undefined);
        setCopyState("copied");
      })
      .catch(() => setCopyState("error"));
  }, [copyState, writeClipboard]);
  useEffect(
    () => () => {
      receiptRef.current = undefined;
    },
    [],
  );
  return { receipt, copyState, accept, clear, copy } as const;
}
