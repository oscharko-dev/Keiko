"use client";

import { useRef, useState, type ChangeEvent, type ReactNode } from "react";

import { useTranslate } from "@/lib/i18n";
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
}

const INITIAL_STATE: UploadState = {
  issue: undefined,
  appliedCount: undefined,
  realtimeSkipped: false,
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
    setState({ issue: "fileTooLarge", appliedCount: undefined, realtimeSkipped: false });
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
  } catch (error) {
    // The parser is written to never throw on hostile input — if it ever does, that is a
    // programming error: report it through the page's error channel and show the honest
    // failed state, exactly like a throwing apply callback below (review finding on #3031).
    window.reportError(error);
    result = undefined;
  }
  if (result === undefined || result.outcome === "invalid") {
    setState({ issue: "invalid", appliedCount: undefined, realtimeSkipped: false });
    return;
  }
  if (result.outcome !== "fields") {
    setState({ issue: result.outcome, appliedCount: undefined, realtimeSkipped: false });
    return;
  }
  try {
    onApply(result.fields);
  } catch (error) {
    // A throwing apply callback is a programming error, not a user problem: report it through the
    // page's error channel (never an unhandled rejection out of a void handler) and show the
    // honest failed state instead of a success count.
    window.reportError(error);
    setState({ issue: "invalid", appliedCount: undefined, realtimeSkipped: false });
    return;
  }
  setState({
    issue: undefined,
    appliedCount: appliedGatewayConfigFieldCount(result.fields),
    realtimeSkipped: result.fields.voiceRealtimeSkipped,
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
  const t = useTranslate();
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
  const t = useTranslate();
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
      {t("gatewaySetup.upload.applied", { count: state.appliedCount })}
      {state.realtimeSkipped ? ` ${t("gatewaySetup.upload.realtimeSkipped")}` : null}
    </output>
  );
}
