"use client";

import type { ReactNode } from "react";
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
  return (
    <div className="arun-gate" data-esc={escalated}>
      <div className="arun-gate-h">
        <Icons.bell size={13} /> {escalated ? "Keiko escalated to you" : "Approval required"}
      </div>
      <div className="arun-gate-t">{gate.title}</div>
      <div className="arun-gate-d mono">{gate.detail}</div>
      <div className="arun-gate-btns">
        <button type="button" className="arun-btn ghost" onClick={onReject}>
          Reject
        </button>
        <button type="button" className="arun-btn primary" onClick={onApprove}>
          Approve
        </button>
      </div>
    </div>
  );
}
