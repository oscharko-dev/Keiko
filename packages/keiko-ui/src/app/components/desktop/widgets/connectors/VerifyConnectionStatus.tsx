// Issue #2245 (Epic #2238) — renders one closed verify-connection status as actionable copy.
//
// The five-member union (ok | auth-failed | forbidden | unreachable | timeout) each maps to a
// distinct label + remediation line and a tone; a raw provider error is never shown. `role="status"`
// makes the outcome announced when it replaces the "Verifying…" state.

import type { ReactNode } from "react";
import { useTranslate } from "@/lib/i18n";
import type { AtlassianConnectorVerifyStatus } from "@/lib/atlassian-connectors-api";
import { verifyStatusCopyKey, verifyStatusLabelKey, verifyStatusTone } from "./connector-labels";

export function VerifyConnectionStatus({
  status,
}: {
  readonly status: AtlassianConnectorVerifyStatus;
}): ReactNode {
  const t = useTranslate();
  return (
    <p
      className="acx-notice"
      data-tone={verifyStatusTone(status)}
      data-status={status}
      data-testid="acx-verify-status"
      role="status"
    >
      <span className="acx-notice-label">{t(verifyStatusLabelKey(status))}</span>
      <span>{t(verifyStatusCopyKey(status))}</span>
    </p>
  );
}
