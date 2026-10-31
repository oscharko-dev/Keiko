"use client";
import type { ReactNode } from "react";
import styles from "./JiraChatTools.module.css";
export function JiraDecisionActions({
  disabled,
  approveDisabled = false,
  approve,
  reject,
  submit,
}: {
  readonly disabled: boolean;
  /** Only approval is unavailable, for example when nothing was left selected. */
  readonly approveDisabled?: boolean;
  readonly approve: string;
  readonly reject: string;
  readonly submit: (decision: "approve" | "reject") => Promise<void>;
}): ReactNode {
  return (
    <div className={styles.cmpActions}>
      <button
        type="button"
        className="lk-btn lk-btn-primary"
        disabled={disabled || approveDisabled}
        onClick={() => {
          void submit("approve");
        }}
      >
        {approve}
      </button>
      <button
        type="button"
        className="lk-btn"
        disabled={disabled}
        onClick={() => {
          void submit("reject");
        }}
      >
        {reject}
      </button>
    </div>
  );
}
