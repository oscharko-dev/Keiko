"use client";

import { useRef, useState, type ChangeEvent, type ReactNode } from "react";

// The upload control lives behind the setup dialog's dynamic boundary, so its copy comes from
// the lazily-loaded optional widget catalog — never the eager first-load catalogs (the
// initial-page gzip ceiling, ADR-0042 D3.6).
import { useOptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import {
  MAX_GATEWAY_CONFIG_BYTES,
  appliedGatewayConfigFieldCount,
  parseGatewayConfigUpload,
  type GatewayConfigUploadFields,
} from "./gatewayConfigParsing";
import styles from "./GatewaySetupDialog.module.css";

interface UploadState {
  readonly issue: "invalid" | "fileTooLarge" | "unsupportedKind" | "unsupportedSetting" | undefined;
  readonly appliedCount: number | undefined;
  readonly realtimeSkipped: boolean;
  readonly profilesReduced: boolean;
  readonly retryTuningReset: boolean;
}

const INITIAL_STATE: UploadState = {
  issue: undefined,
  appliedCount: undefined,
  realtimeSkipped: false,
  profilesReduced: false,
  retryTuningReset: false,
};

async function handleUploadedFile(
  event: ChangeEvent<HTMLInputElement>,
  onApply: (fields: GatewayConfigUploadFields) => void,
  setState: (state: UploadState) => void,
  sequence: { current: number },
  onReadPendingChange?: (pending: boolean) => void,
): Promise<void> {
  const file = event.target.files?.[0];
  // Same file again must re-trigger onChange after a fix-and-retry.
  event.target.value = "";
  if (file === undefined) return;
  // A newer selection supersedes any read still in flight; the slower older read must never
  // overwrite the newer outcome (review finding on #3031).
  const token = sequence.current + 1;
  sequence.current = token;
  if (file.size > MAX_GATEWAY_CONFIG_BYTES) {
    // The token advanced, so any older read is now stale and will never clear the pending flag —
    // this path owns it and must leave it false (review finding on #3031; the flag's contract is
    // "a read for the CURRENT token is in flight").
    onReadPendingChange?.(false);
    setState({ ...INITIAL_STATE, issue: "fileTooLarge" });
    return;
  }
  // The dialog must not submit a half-applied snapshot while the read is in flight (review
  // finding on #3031).
  onReadPendingChange?.(true);
  let serialized;
  try {
    serialized = await file.text();
  } catch {
    // A read failure (revoked permission, vanished file) is the same user outcome as an
    // unreadable configuration — reported, never an unhandled rejection.
    serialized = undefined;
  }
  if (sequence.current !== token) return;
  onReadPendingChange?.(false);
  applyReadOutcome(serialized, onApply, setState);
}

function applyReadOutcome(
  serialized: string | undefined,
  onApply: (fields: GatewayConfigUploadFields) => void,
  setState: (state: UploadState) => void,
): void {
  let result;
  try {
    result = serialized === undefined ? undefined : parseGatewayConfigUpload(serialized);
  } catch {
    // The parser is written to never throw on hostile input — if it ever does, that is a
    // programming error: report it through the page's error channel and show the honest failed
    // state, exactly like a throwing apply callback below. The original error is deliberately
    // NOT forwarded: engine messages can embed excerpts of the uploaded file, which may carry
    // credentials (review findings on #3031; diagnostics stay body-free).
    window.reportError(new Error("gateway config upload: parser threw on an uploaded file"));
    result = undefined;
  }
  if (result === undefined || result.outcome === "invalid") {
    setState({ ...INITIAL_STATE, issue: "invalid" });
    return;
  }
  if (result.outcome !== "fields") {
    setState({ ...INITIAL_STATE, issue: result.outcome });
    return;
  }
  try {
    onApply(result.fields);
  } catch {
    // A throwing apply callback is a programming error, not a user problem: report it through the
    // page's error channel (never an unhandled rejection out of a void handler) and show the
    // honest failed state instead of a success count. Sanitized for the same body-free reason as
    // the parser branch above — field setters receive parsed file values.
    window.reportError(new Error("gateway config upload: apply callback threw"));
    setState({ ...INITIAL_STATE, issue: "invalid" });
    return;
  }
  setState({
    issue: undefined,
    appliedCount: appliedGatewayConfigFieldCount(result.fields),
    realtimeSkipped: result.fields.voiceRealtimeSkipped,
    profilesReduced: result.fields.voiceProfilesReduced,
    retryTuningReset: result.fields.voiceRetryTuningReset,
  });
}

/**
 * The manual-entry alternative on the first setup page: load an existing `keiko.config.json`
 * instead of typing every field. Parsing happens entirely in the browser and the values land in
 * the same form state (and therefore the same validation and one-time token test) as manual
 * input — the upload can never bypass what typing could not.
 */
export function GatewayConfigUpload({
  disabled,
  onApply,
  onReadPendingChange,
}: {
  readonly disabled: boolean;
  readonly onApply: (fields: GatewayConfigUploadFields) => void;
  /** True while a selected file is still being read — the dialog blocks submission meanwhile. */
  readonly onReadPendingChange?: ((pending: boolean) => void) | undefined;
}): ReactNode {
  const t = useOptionalWidgetTranslate();
  const [state, setState] = useState<UploadState>(INITIAL_STATE);
  const sequence = useRef(0);

  return (
    <section className={styles["cmp-config-upload"]} aria-labelledby="gw-config-upload-title">
      <div>
        <h3 id="gw-config-upload-title">{t("gatewaySetup.upload.title")}</h3>
        <p>{t("gatewaySetup.upload.hint")}</p>
      </div>
      <label
        className={[
          styles["cmp-config-upload-action"],
          ...(disabled ? [styles["cmp-config-upload-action-disabled"]] : []),
        ].join(" ")}
      >
        {t("gatewaySetup.upload.action")}
        <input
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          disabled={disabled}
          onChange={(event) =>
            void handleUploadedFile(event, onApply, setState, sequence, onReadPendingChange)
          }
        />
      </label>
      <GatewayConfigUploadStatus state={state} />
    </section>
  );
}

function GatewayConfigUploadStatus({ state }: { readonly state: UploadState }): ReactNode {
  const t = useOptionalWidgetTranslate();
  if (state.issue !== undefined) {
    return (
      <div className={styles["cmp-config-upload-alert"]} role="alert">
        {t(`gatewaySetup.upload.${state.issue}`)}
      </div>
    );
  }
  if (state.appliedCount === undefined) return null;
  return (
    <output className={styles["cmp-config-upload-applied"]}>
      {state.appliedCount === 1
        ? t("gatewaySetup.upload.appliedOne")
        : t("gatewaySetup.upload.appliedMany", { count: state.appliedCount })}
      {state.realtimeSkipped ? ` ${t("gatewaySetup.upload.realtimeSkipped")}` : null}
      {state.profilesReduced ? ` ${t("gatewaySetup.upload.voiceProfilesReduced")}` : null}
      {state.retryTuningReset ? ` ${t("gatewaySetup.upload.voiceRetryTuningReset")}` : null}
    </output>
  );
}
