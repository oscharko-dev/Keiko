// Issue #2245 (Epic #2238) — renders one closed verify-connection status as actionable copy.
//
// Each member of the shared closed status union maps to a
// distinct label + remediation line and a tone; a raw provider error is never shown. The `<output>`
// element (implicit role="status", a polite live region) announces the outcome when it replaces the
// "Verifying…" state.

import type { ReactNode } from "react";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import type { AtlassianConnectorVerifyStatus } from "@/lib/atlassian-connectors-api";
import { verifyStatusCopyKey, verifyStatusLabelKey, verifyStatusTone } from "./connector-labels";

/** The label and the guidance of one closed status: the words every verification surface uses. */
export function VerifyStatusText({
  status,
}: {
  readonly status: AtlassianConnectorVerifyStatus;
}): ReactNode {
  const t = useTranslate();
  return (
    <>
      <span className="acx-notice-label">{t(verifyStatusLabelKey(status))}</span>
      <span>{t(verifyStatusCopyKey(status))}</span>
    </>
  );
}

export function VerifyConnectionStatus({
  status,
}: {
  readonly status: AtlassianConnectorVerifyStatus;
}): ReactNode {
  return (
    <output
      className="acx-notice"
      data-tone={verifyStatusTone(status)}
      data-status={status}
      data-testid="acx-verify-status"
    >
      <VerifyStatusText status={status} />
    </output>
  );
}
