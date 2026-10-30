"use client";
import type { ReactNode } from "react";
import styles from "./JiraChatTools.module.css";
export function JiraDecisionActions({
  disabled,
  approve,
  reject,
  submit,
}: {
  readonly disabled: boolean;
  readonly approve: string;
  readonly reject: string;
  readonly submit: (decision: "approve" | "reject") => Promise<void>;
}): ReactNode {
  return (
    <div className={styles.cmpActions}>
      <button
        type="button"
        className="lk-btn lk-btn-primary"
        disabled={disabled}
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
