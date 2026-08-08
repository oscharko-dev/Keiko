"use client";

import type { ReactNode } from "react";
import { useTranslate } from "@/lib/i18n";

/**
 * Shared loading fallback for gesture-opened dynamic chunks: a failed chunk load must not leave
 * the opening gesture satisfied with nothing on screen — surface the redacted error and a retry
 * (review findings on #3031/#3037). `next/dynamic` drives the props: `error` is set when the
 * chunk load failed and `retry` re-attempts the import; while the chunk is merely loading there
 * is no error and the fallback stays invisible.
 */
export function DynamicChunkLoadFailure({
  error,
  retry,
}: {
  readonly error?: Error | null | undefined;
  readonly retry?: (() => void) | null | undefined;
}): ReactNode {
  const t = useTranslate();
  if (!error) return null;
  return (
    <div role="alert">
      {t("gatewaySetup.loading.error")}{" "}
      <button type="button" onClick={retry ?? ((): void => window.location.reload())}>
        {t("common.retry")}
      </button>
    </div>
  );
}
