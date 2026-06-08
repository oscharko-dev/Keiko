"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { Icons, type IconName } from "../../Icons";
import {
  useTwin,
  type Bridges,
  type Decision,
  type GateKind,
  type Persona,
  type PolicyRow,
  type Risk,
} from "../../context/TwinContext";

const DEC_META: Readonly<Record<Decision, readonly [string, string]>> = {
  allow: ["Allow", "var(--accent)"],
  ask: ["Ask", "var(--warn)"],
  deny: ["Deny", "var(--danger)"],
};
const DEC_CYCLE: Readonly<Record<Decision, Decision>> = {
  allow: "ask",
  ask: "deny",
  deny: "allow",
};

interface EvalScenario {
  readonly id: number;
  readonly label: string;
  readonly kind: GateKind;
  readonly risk: Risk;
  readonly expect: Decision;
}

const EVAL_SCENARIOS: readonly EvalScenario[] = [
  { id: 1, label: "Write src/windows.jsx", kind: "write", risk: "low", expect: "allow" },
  { id: 2, label: "Overwrite prod/secrets.env", kind: "write", risk: "high", expect: "deny" },
  { id: 3, label: "Run `npm test`", kind: "command", risk: "low", expect: "allow" },
  { id: 4, label: "Run `kubectl apply` → prod", kind: "command", risk: "high", expect: "ask" },
  { id: 5, label: "Open pull request #142", kind: "git", risk: "low", expect: "allow" },
  { id: 6, label: "Email the customer", kind: "mail", risk: "low", expect: "ask" },
];

const PERSONAS: readonly (readonly [Persona, string])[] = [
  ["Developer", "Codes, reviews diffs, runs tests, opens PRs"],
  ["Product Owner", "Searches docs, drafts Jira tickets, plans releases"],
  ["Designer", "Explores UI options, reviews flows, writes specs"],
];

const BRIDGE_DEFS: readonly (readonly [keyof Bridges, string, IconName])[] = [
  ["calendar", "Calendar", "automations"],
  ["mail", "Mail", "bell"],
  ["jira", "Jira", "review"],
  ["docs", "Docs", "files"],
];

type Tab = "policy" | "eval" | "memory" | "bridges" | "persona";

function PolicyTab({
  policy,
  setPolicy,
}: {
  policy: readonly PolicyRow[];
  setPolicy: (next: (prev: readonly PolicyRow[]) => readonly PolicyRow[]) => void;
}): ReactNode {
  const cycle = (id: string): void =>
    setPolicy((p) => p.map((r) => (r.id === id ? { ...r, decision: DEC_CYCLE[r.decision] } : r)));
  return (
    <div className="pol">
      <div className="pol-hint">
        Rights an agent inherits when Keiko governs. Tap a decision to cycle through Allow → Ask →
        Deny.
      </div>
      {policy.map((r) => {
        const m = DEC_META[r.decision];
        return (
          <div className="pol-row" key={r.id}>
            <div className="pol-text">
              <span className="pol-action">{r.action}</span>
              <span className="pol-scope mono">{r.scope}</span>
            </div>
            <button
              type="button"
              className="pol-dec"
              style={{ color: m[1], borderColor: m[1] }}
              onClick={() => cycle(r.id)}
            >
              {m[0]}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function EvalTab({ decide }: { decide: (kind: GateKind, risk: Risk) => Decision }): ReactNode {
  const [run, setRun] = useState(false);
  const results = EVAL_SCENARIOS.map((s) => {
    const actual = decide(s.kind, s.risk);
    return { ...s, actual, pass: actual === s.expect };
  });
  const passed = results.filter((r) => r.pass).length;
  return (
    <div className="evl">
      <div className="evl-head">
        <button type="button" className="evl-run" onClick={() => setRun(true)}>
          <Icons.spark size={13} /> Run evaluation
        </button>
        {run && (
          <span className={"evl-score" + (passed === results.length ? " ok" : "")}>
            {passed}/{results.length} passed
          </span>
        )}
      </div>
      <div className="evl-hint">Mock scenarios against your policy before going autonomous.</div>
      {results.map((r) => (
        <div className="evl-row" key={r.id} data-state={!run ? "idle" : r.pass ? "pass" : "fail"}>
          <span className="evl-ico">
            {!run ? (
              <span className="evl-dot" />
            ) : r.pass ? (
              <Icons.check size={13} />
            ) : (
              <Icons.close size={13} />
            )}
          </span>
          <span className="evl-label">{r.label}</span>
          {run && (
            <span className="evl-res mono" style={{ color: DEC_META[r.actual][1] }}>
              {DEC_META[r.actual][0]}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function MemoryTab({
  memory,
  setMemory,
}: {
  memory: readonly string[];
  setMemory: (next: (prev: readonly string[]) => readonly string[]) => void;
}): ReactNode {
  const [text, setText] = useState("");
  const add = (): void => {
    const t = text.trim();
    if (t === "") return;
    setMemory((m) => [t, ...m]);
    setText("");
  };
  return (
    <div className="mem">
      <div className="mem-add">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Teach Keiko something about you…"
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button type="button" onClick={add} aria-label="Add memory">
          <Icons.plus size={15} />
        </button>
      </div>
      {memory.map((m, i) => (
        <div className="mem-row" key={`${String(i)}-${m}`}>
          <Icons.spark size={12} />
          <span className="mem-text">{m}</span>
          <button
            type="button"
            className="mem-x"
            aria-label={`Remove memory: ${m}`}
            onClick={() => setMemory((mm) => mm.filter((_, j) => j !== i))}
          >
            <Icons.close size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

function BridgesTab({
  bridges,
  setBridges,
}: {
  bridges: Bridges;
  setBridges: (next: (prev: Bridges) => Bridges) => void;
}): ReactNode {
  return (
    <div className="brg">
      <div className="evl-hint">What your twin can reach on your behalf.</div>
      {BRIDGE_DEFS.map(([k, lbl, ic]) => {
        const Icon = Icons[ic];
        const on = bridges[k];
        return (
          <button
            type="button"
            key={k}
            className="brg-row"
            data-on={on}
            aria-pressed={on}
            onClick={() => setBridges((b) => ({ ...b, [k]: !b[k] }))}
          >
            <span className="brg-ico">
              <Icon size={16} />
            </span>
            <span className="brg-name">{lbl}</span>
            <span className={"brg-tg" + (on ? " on" : "")}>
              <span />
            </span>
          </button>
        );
      })}
    </div>
  );
}

function PersonaTab({
  persona,
  setPersona,
}: {
  persona: Persona;
  setPersona: (next: Persona) => void;
}): ReactNode {
  return (
    <div className="prs">
      <div className="evl-hint">Keiko adapts behaviour &amp; tools to who is at the wheel.</div>
      {PERSONAS.map(([p, d]) => (
        <button
          type="button"
          key={p}
          className="prs-row"
          data-on={persona === p}
          aria-pressed={persona === p}
          onClick={() => setPersona(p)}
        >
          <span className="prs-dot" />
          <span className="prs-text">
            <span className="prs-name">{p}</span>
            <span className="prs-desc">{d}</span>
          </span>
          {persona === p && <Icons.check size={14} style={{ color: "var(--accent)" }} />}
        </button>
      ))}
    </div>
  );
}

const TAB_LABELS: readonly (readonly [Tab, string])[] = [
  ["policy", "Policy"],
  ["eval", "EVAL"],
  ["memory", "MemoriaViva"],
  ["bridges", "Connections"],
  ["persona", "Persona"],
];

export function KeikoTwinPanel(): ReactNode {
  const twin = useTwin();
  const [tab, setTab] = useState<Tab>("policy");
  return (
    <div className="twin">
      <div className="twin-hero">
        {/* eslint-disable-next-line @next/next/no-img-element -- raw SVG sized by .twin-orca */}
        <img className="twin-orca" src="/assets/keiko-logo.svg" alt="" />
        <div className="twin-id">
          <span className="twin-name">Keiko — Digital Twin</span>
          <span className="twin-sub mono">mirroring · {twin.persona}</span>
        </div>
        <span className={"twin-mode " + (twin.mode === "autonomous" ? "on" : "")}>
          {twin.mode === "autonomous" ? "Autonomous" : "Manual"}
        </span>
      </div>
      <div className="twin-tabs">
        {TAB_LABELS.map(([id, lbl]) => (
          <button
            type="button"
            key={id}
            className="twin-tab"
            data-on={tab === id}
            onClick={() => setTab(id)}
          >
            {lbl}
          </button>
        ))}
      </div>
      <div className="twin-body">
        {tab === "policy" && <PolicyTab policy={twin.policy} setPolicy={twin.setPolicy} />}
        {tab === "eval" && <EvalTab decide={twin.decide} />}
        {tab === "memory" && <MemoryTab memory={twin.memory} setMemory={twin.setMemory} />}
        {tab === "bridges" && <BridgesTab bridges={twin.bridges} setBridges={twin.setBridges} />}
        {tab === "persona" && <PersonaTab persona={twin.persona} setPersona={twin.setPersona} />}
      </div>
    </div>
  );
}
