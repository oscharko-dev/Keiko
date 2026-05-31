"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icons, type IconName } from "../../Icons";
import { useTwinMode, type TwinMode } from "../../hooks/useTwinMode";
import { logActivity } from "../shared/activityBus";
import { AgentGateCard, type GateInfo, type GateKind, type Risk } from "./AgentGateCard";

type LogTool = IconName | "spark" | "check" | "close";
type Status = "running" | "paused" | "gate" | "done" | "stopped";

interface Step {
  readonly text: string;
  readonly tool: LogTool;
  readonly tokens: number;
  readonly dur?: number;
  readonly gate?: GateInfo;
  readonly final?: boolean;
}

interface LogRow {
  readonly id: string;
  readonly tool: LogTool;
  readonly text: string;
  readonly t: string;
}

interface AgentRunCfg {
  role?: string;
  model?: string;
  keikoMode?: boolean;
  access?: "ask" | "full";
}

interface AgentRunWidgetProps {
  cfg?: AgentRunCfg;
  linkedRoot?: string | null;
}

const MAX_LOG = 40;
const TICK_MS = 1000;

const STATUS_META: Readonly<Record<Status, readonly [string, string]>> = {
  running: ["Running", "var(--accent)"],
  paused: ["Paused", "var(--warn)"],
  gate: ["Needs approval", "var(--warn)"],
  done: ["Completed", "var(--info)"],
  stopped: ["Stopped", "var(--danger)"],
};

function fmtClock(s: number): string {
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(m)}:${String(ss).padStart(2, "0")}`;
}

function stamp(): string {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function buildSteps(role: string, root: string | null | undefined): readonly Step[] {
  const f = `${root ?? "src"}/`;
  const lower = role.toLowerCase();
  return [
    { text: `Scanning ${f}`, tool: "files", tokens: 420, dur: 1500 },
    { text: "Reading windows.jsx · app.jsx", tool: "editor", tokens: 1280, dur: 1700 },
    { text: `Planning ${lower} changes`, tool: "spark", tokens: 900, dur: 1600 },
    {
      text: "Applied edits to 3 files",
      tool: "editor",
      tokens: 1640,
      dur: 1700,
      gate: { title: "Write 3 files", detail: `${f}windows.jsx · app.jsx · components.css`, kind: "write" },
    },
    {
      text: "Ran test suite",
      tool: "terminal",
      tokens: 540,
      dur: 1700,
      gate: { title: "Run command", detail: "npm test", kind: "command" },
    },
    { text: "All 42 tests passed", tool: "check", tokens: 120, dur: 1400 },
    {
      text: "Opened pull request #142",
      tool: "git",
      tokens: 300,
      dur: 1500,
      gate: { title: "Open pull request", detail: "keiko/issue-51 → main", kind: "git", risk: "low" },
    },
    {
      text: "Deployed to staging",
      tool: "terminal",
      tokens: 480,
      dur: 1600,
      gate: { title: "Deploy to production", detail: "kubectl apply -f deploy/k8s", kind: "command", risk: "high" },
    },
    { text: "Agent finished", tool: "check", tokens: 60, dur: 1000, final: true },
  ];
}

type GateDecision = "allow" | "ask" | "deny";

// Welle-5-TODO: replace twinDecideShim with twinContext.decide once TwinProvider ships
// (full per-(kind, risk) policy table + bridges/memory). Welle 4 keeps a degraded
// shim that allows safe ops in autonomous mode and escalates everything else.
function twinDecideShim(mode: TwinMode, _kind: GateKind, risk: Risk): GateDecision {
  if (mode !== "autonomous") return "ask";
  if (risk === "high") return "ask";
  return "allow";
}

function logIcon(tool: LogTool): ReactNode {
  const Ico = Icons[tool as IconName];
  if (typeof Ico === "function") return Ico({ size: 12 });
  return Icons.spark({ size: 12 });
}

let LOG_SEQ = 0;
function newRowId(): string {
  LOG_SEQ += 1;
  return `r-${String(Date.now())}-${String(LOG_SEQ)}`;
}

interface GateOutcome {
  readonly kind: "auto-allow" | "auto-deny" | "escalated" | "approve-manual";
}

function evaluateGate(
  gate: GateInfo,
  governed: boolean,
  twinMode: TwinMode,
  access: "ask" | "full" | undefined,
): GateOutcome {
  const risk: Risk = gate.risk ?? "low";
  if (governed && twinMode === "autonomous") {
    const d = twinDecideShim(twinMode, gate.kind, risk);
    if (d === "allow") return { kind: "auto-allow" };
    if (d === "deny") return { kind: "auto-deny" };
    return { kind: "escalated" };
  }
  if (!governed && access === "full") return { kind: "auto-allow" };
  return { kind: "approve-manual" };
}

export function AgentRunWidget({ cfg = {}, linkedRoot = null }: AgentRunWidgetProps): ReactNode {
  const role = cfg.role ?? "Builder";
  const model = cfg.model ?? "orca-5.4";
  const governed = cfg.keikoMode !== false;
  const access = cfg.access;

  const stepsRef = useRef<readonly Step[]>(buildSteps(role, linkedRoot));
  const STEPS = stepsRef.current;

  const [status, setStatus] = useState<Status>("running");
  const [idx, setIdx] = useState(0);
  const [tokens, setTokens] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [log, setLog] = useState<readonly LogRow[]>([]);
  const [escalated, setEscalated] = useState(false);

  const twin = useTwinMode();
  const twinMode = twin.mode;

  const statusRef = useRef<Status>(status);
  statusRef.current = status;

  useEffect(() => {
    const id = setInterval(() => {
      const s = statusRef.current;
      if (s === "running" || s === "gate") setElapsed((e) => e + 1);
    }, TICK_MS);
    return () => { clearInterval(id); };
  }, []);

  const prependRow = useCallback((row: Omit<LogRow, "id">): void => {
    setLog((l) => [{ id: newRowId(), ...row }, ...l].slice(0, MAX_LOG));
  }, []);

  const commit = useCallback((step: Step): void => {
    setTokens((t) => t + step.tokens);
    prependRow({ tool: step.tool, text: step.text, t: stamp() });
    logActivity({ type: "step", agent: role, tool: step.tool, text: step.text });
    if (step.final === true) setStatus("done");
  }, [prependRow, role]);

  useEffect(() => {
    if (status !== "running") return;
    const step = STEPS[idx];
    if (step === undefined) {
      setStatus("done");
      return;
    }
    if (step.gate !== undefined) {
      const outcome = evaluateGate(step.gate, governed, twinMode, access);
      const gate = step.gate;
      if (outcome.kind === "auto-allow") {
        commit(step);
        const isTwin = governed && twinMode === "autonomous";
        if (isTwin) {
          prependRow({ tool: "check", text: `Keiko approved · ${gate.title}`, t: stamp() });
          logActivity({ type: "twin-approved", agent: role, text: `Keiko approved · ${gate.title}` });
        } else {
          logActivity({ type: "approved", agent: role, text: `Full access · ${gate.title}` });
        }
        setIdx((i) => i + 1);
        return;
      }
      if (outcome.kind === "auto-deny") {
        prependRow({ tool: "close", text: `Keiko denied · ${gate.title}`, t: stamp() });
        logActivity({ type: "twin-denied", agent: role, text: `Keiko denied · ${gate.title}` });
        setStatus("stopped");
        return;
      }
      setEscalated(outcome.kind === "escalated");
      setStatus("gate");
      logActivity({
        type: "approval",
        agent: role,
        text: `${outcome.kind === "escalated" ? "Keiko escalated · " : "Approval requested · "}${gate.title}`,
      });
      return;
    }
    const dur = step.dur ?? 1500;
    const id = setTimeout(() => {
      commit(step);
      setIdx((i) => i + 1);
    }, dur);
    return () => { clearTimeout(id); };
  }, [status, idx, STEPS, role, governed, twinMode, access, commit, prependRow]);

  const approve = (): void => {
    const step = STEPS[idx];
    if (step === undefined || step.gate === undefined) return;
    commit(step);
    logActivity({ type: "approved", agent: role, text: step.gate.title });
    setEscalated(false);
    setIdx((i) => i + 1);
    setStatus("running");
  };
  const reject = (): void => {
    const step = STEPS[idx];
    if (step === undefined || step.gate === undefined) return;
    logActivity({ type: "rejected", agent: role, text: step.gate.title });
    prependRow({ tool: "close", text: `Rejected · ${step.gate.title}`, t: "" });
    setEscalated(false);
    setStatus("stopped");
  };
  const pauseResume = (): void => {
    setStatus((s) => (s === "running" ? "paused" : "running"));
  };
  const stop = (): void => {
    setStatus("stopped");
    logActivity({ type: "stopped", agent: role, text: "Agent stopped" });
  };

  const cost = ((tokens / 1000) * 0.9).toFixed(2);
  const pct = Math.round((Math.min(idx, STEPS.length) / STEPS.length) * 100);
  const current = STEPS[idx];
  const meta = STATUS_META[status];
  const isTwinAuto = governed && twinMode === "autonomous";
  const gov = governed
    ? (isTwinAuto ? "Keiko · auto" : "Keiko")
    : (access === "full" ? "Full access" : "You");
  const govColor = governed
    ? (isTwinAuto ? "var(--accent)" : "var(--fg-muted)")
    : (access === "full" ? "var(--warn)" : "var(--info)");

  const showCurrent =
    status !== "done" && status !== "stopped" && status !== "gate" && current !== undefined;
  const showControlsRow = status === "running" || status === "paused";
  const isFinal = status === "done" || status === "stopped";

  return (
    <div className="arun">
      <div className="arun-head">
        <span className="arun-role">{role}</span>
        <span className="ag-model mono">{model}</span>
        <span
          className="arun-gov"
          style={{ color: govColor, borderColor: govColor }}
          title="Governance"
        >
          {gov}
        </span>
        <span className="spacer" />
        <span className="arun-status" style={{ color: meta[1] }}>
          <span
            className="dot"
            style={{
              background: meta[1],
              animation: status === "running" ? "pulse 1.3s infinite" : "none",
            }}
          />
          {meta[0]}
        </span>
      </div>

      <div className="arun-meters">
        <div className="arun-meter">
          <span className="arun-mk">Elapsed</span>
          <span className="arun-mv mono">{fmtClock(elapsed)}</span>
        </div>
        <div className="arun-meter">
          <span className="arun-mk">Tokens</span>
          <span className="arun-mv mono">
            {tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)}
          </span>
        </div>
        <div className="arun-meter">
          <span className="arun-mk">Cost</span>
          <span className="arun-mv mono">${cost}</span>
        </div>
      </div>
      <div className="arun-prog">
        <i style={{ width: `${String(pct)}%`, background: meta[1] }} />
      </div>

      <div className="arun-perms">
        <span className="arun-perm" data-on={linkedRoot !== null}>
          <Icons.files size={11} />
          {linkedRoot !== null ? `${linkedRoot}/` : "no folder"}
        </span>
        <span className="arun-perm">
          <Icons.plugins size={11} />3 MCP
        </span>
        <span className="arun-perm">
          <Icons.terminal size={11} />shell
        </span>
        <span className="arun-perm">
          <Icons.git size={11} />git
        </span>
      </div>

      {status === "gate" && current !== undefined && current.gate !== undefined && (
        <AgentGateCard
          gate={current.gate}
          escalated={escalated}
          onApprove={approve}
          onReject={reject}
        />
      )}

      {showCurrent && current !== undefined && (
        <div className="arun-current">
          <span className="arun-spin" data-paused={status === "paused"}>
            <Icons.reset size={13} />
          </span>
          <span className="arun-cur-text">
            {status === "paused" ? "Paused — " : ""}
            {current.text}
          </span>
        </div>
      )}

      <div className="arun-log">
        {log.map((l) => (
          <div className="arun-log-row" key={l.id}>
            <span className="arun-log-ico">{logIcon(l.tool)}</span>
            <span className="arun-log-text">{l.text}</span>
            <span className="arun-log-t mono">{l.t}</span>
          </div>
        ))}
      </div>

      <div className="arun-controls">
        {showControlsRow && (
          <button type="button" className="arun-btn ghost" onClick={pauseResume}>
            {status === "paused" ? "Resume" : "Pause"}
          </button>
        )}
        {!isFinal ? (
          <button type="button" className="arun-btn danger" onClick={stop}>
            Stop
          </button>
        ) : (
          <span className="arun-final mono">{status === "done" ? "✓ finished" : "■ stopped"}</span>
        )}
      </div>
    </div>
  );
}

export type { AgentRunCfg };
