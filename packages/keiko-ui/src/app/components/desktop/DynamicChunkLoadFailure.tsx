"use client";

import type { ReactNode } from "react";
import { useTranslate } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages.en";

/**
 * Shared loading fallback for gesture-opened dynamic chunks: a failed chunk load must not leave
 * the opening gesture satisfied with nothing on screen — surface the redacted error and a retry
 * (review findings on #3031/#3037). `next/dynamic` drives the `error`/`retry` props (so a call
 * site that needs a different message wraps this in its own component supplying `messageKey`);
 * while the chunk is merely loading there is no error and the fallback stays invisible.
 */
export function DynamicChunkLoadFailure({
  error,
  retry,
  messageKey = "gatewaySetup.loading.error",
}: {
  readonly error?: Error | null | undefined;
  readonly retry?: (() => void) | null | undefined;
  readonly messageKey?: MessageKey;
}): ReactNode {
  const t = useTranslate();
  if (!error) return null;
  return (
    <div role="alert">
      {t(messageKey)}{" "}
      <button type="button" onClick={retry ?? ((): void => window.location.reload())}>
        {t("common.retry")}
      </button>
    </div>
  );
}
