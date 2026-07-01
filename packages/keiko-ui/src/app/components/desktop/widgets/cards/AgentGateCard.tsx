"use client";

import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useRef } from "react";
import { Icons } from "../../Icons";

export type GateKind = "write" | "command" | "git" | "mail" | "network";
export type Risk = "low" | "high";

export interface GateInfo {
  readonly title: string;
  readonly detail: string;
  readonly kind: GateKind;
  readonly risk?: Risk;
}

interface AgentGateCardProps {
  gate: GateInfo;
  escalated: boolean;
  onApprove: () => void;
  onReject: () => void;
}

export function AgentGateCard({
  gate,
  escalated,
  onApprove,
  onReject,
}: AgentGateCardProps): ReactNode {
  const titleId = useId();
  const detailId = useId();
  const rejectRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    rejectRef.current?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onReject();
    }
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape-to-reject on the alertdialog container mirrors the Reject button for keyboard users
    <div
      className="arun-gate"
      data-esc={escalated}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={detailId}
      onKeyDown={handleKeyDown}
    >
      <div className="arun-gate-h">
        <Icons.bell size={13} /> {escalated ? "Keiko escalated to you" : "Approval required"}
      </div>
      <div className="arun-gate-t" id={titleId}>
        {gate.title}
      </div>
      <div className="arun-gate-d mono" id={detailId}>
        {gate.detail}
      </div>
      <div className="arun-gate-btns">
        <button type="button" className="arun-btn ghost" onClick={onReject} ref={rejectRef}>
          Reject
        </button>
        <button type="button" className="arun-btn primary" onClick={onApprove}>
          Approve
        </button>
      </div>
    </div>
  );
}
