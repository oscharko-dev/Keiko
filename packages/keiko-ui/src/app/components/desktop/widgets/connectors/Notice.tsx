// Issue #2245 (Epic #2238) — a small tone-coded notice block (label + body) reused across the
// connector surfaces for verify/result/denied feedback. Body text is already translated by the
// caller; the label is a catalog key. `role` defaults to "status" so outcomes are announced.

import type { ReactNode } from "react";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import type { WidgetMessageKey as MessageKey } from "@/lib/optional-widget-i18n";
import type { ConnectorTone } from "./connector-labels";

export interface NoticeProps {
  readonly tone: ConnectorTone;
  readonly labelKey: MessageKey;
  readonly body: string;
  readonly testId?: string;
  readonly role?: "status" | "alert";
}

export function Notice({ tone, labelKey, body, testId, role = "status" }: NoticeProps): ReactNode {
  const t = useTranslate();
  return (
    <p
      className="acx-notice"
      data-tone={tone}
      role={role}
      {...(testId === undefined ? {} : { "data-testid": testId })}
    >
      <span className="acx-notice-label">{t(labelKey)}</span>
      <span>{body}</span>
    </p>
  );
}
