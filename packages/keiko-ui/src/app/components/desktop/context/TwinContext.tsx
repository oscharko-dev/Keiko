"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

export type TwinMode = "manual" | "autonomous";
export type Decision = "allow" | "ask" | "deny";
export type GateKind = "write" | "command" | "git" | "mail" | "network";
export type Risk = "low" | "high";
export type Persona = "Developer" | "Product Owner" | "Designer";

export interface PolicyRow {
  readonly id: string;
  readonly action: string;
  readonly scope: string;
  readonly decision: Decision;
}

export interface Bridges {
  readonly calendar: boolean;
  readonly mail: boolean;
  readonly jira: boolean;
  readonly docs: boolean;
}

const DEFAULT_POLICY: readonly PolicyRow[] = [
  { id: "read", action: "Read files", scope: "workspace", decision: "allow" },
  { id: "write", action: "Write files", scope: "src/** · docs/**", decision: "allow" },
  { id: "write-prod", action: "Write files", scope: "prod/** · infra/**", decision: "deny" },
  { id: "command", action: "Run commands", scope: "test · build · lint", decision: "allow" },
  { id: "command-danger", action: "Run commands", scope: "deploy · rm · db", decision: "ask" },
  { id: "network", action: "Network / fetch", scope: "allowlist", decision: "ask" },
  { id: "pr", action: "Open pull request", scope: "feature branches", decision: "allow" },
  { id: "mail", action: "Mail / calendar", scope: "any", decision: "ask" },
];

const DEFAULT_BRIDGES: Bridges = {
  calendar: true,
  mail: false,
  jira: true,
  docs: true,
};

const KEY_MODE = "keiko.twin.mode";
const KEY_PERSONA = "keiko.twin.persona";
const KEY_POLICY = "keiko.twin.policy";
const KEY_BRIDGES = "keiko.twin.bridges";
const LEGACY_KEY_MEMORY = "keiko.twin.memory";

export interface TwinContextValue {
  readonly mode: TwinMode;
  readonly setMode: (next: TwinMode) => void;
  readonly persona: Persona;
  readonly setPersona: (next: Persona) => void;
  readonly policy: readonly PolicyRow[];
  readonly setPolicy: (
    next: readonly PolicyRow[] | ((prev: readonly PolicyRow[]) => readonly PolicyRow[]),
  ) => void;
  readonly bridges: Bridges;
  readonly setBridges: (next: Bridges | ((prev: Bridges) => Bridges)) => void;
  readonly decide: (kind: GateKind, risk: Risk) => Decision;
}

function twinDecide(policy: readonly PolicyRow[], kind: GateKind, risk: Risk): Decision {
  const d = (id: string): Decision | null => policy.find((p) => p.id === id)?.decision ?? null;
  if (kind === "write") {
    return risk === "high" ? (d("write-prod") ?? "deny") : (d("write") ?? "allow");
  }
  if (kind === "command") {
    return risk === "high" ? (d("command-danger") ?? "ask") : (d("command") ?? "allow");
  }
  if (kind === "git") return d("pr") ?? "allow";
  if (kind === "mail") return d("mail") ?? "ask";
  if (kind === "network") return d("network") ?? "ask";
  return "ask";
}

const TwinContext = createContext<TwinContextValue | null>(null);

const DECISIONS: ReadonlySet<Decision> = new Set(["allow", "ask", "deny"]);

function isDecision(value: unknown): value is Decision {
  return typeof value === "string" && DECISIONS.has(value as Decision);
}

function isPolicyRow(value: unknown): value is PolicyRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row["id"] === "string" &&
    typeof row["action"] === "string" &&
    typeof row["scope"] === "string" &&
    isDecision(row["decision"])
  );
}

function isBridges(value: unknown): value is Bridges {
  if (typeof value !== "object" || value === null) return false;
  const bridges = value as Record<string, unknown>;
  return (
    typeof bridges["calendar"] === "boolean" &&
    typeof bridges["mail"] === "boolean" &&
    typeof bridges["jira"] === "boolean" &&
    typeof bridges["docs"] === "boolean"
  );
}

// F2 — the parsed value used to be blind-cast (`parsed as T`) with zero shape validation, so a
// malformed persisted `keiko.twin.policy`/`keiko.twin.bridges` reached KeikoTwinPanel's render as
// garbage typed as PolicyRow[]/Bridges. `policy.map(...)` throws when policy isn't an array at
// all, and `DEC_META[r.decision]` is undefined (a further throw) when a row's `decision` isn't
// one of the three known values — both inside the panel's render, with only WindowBodyBoundary's
// generic retry fallback to show for it and no way to actually see or fix the twin's governance
// policy. Validate the shape at the read boundary and fail closed to the safe default, exactly
// like the readMode()/readPersona() readers below already do for their own keys.
function readPolicy(): readonly PolicyRow[] {
  if (typeof window === "undefined") return DEFAULT_POLICY;
  try {
    const raw = window.localStorage.getItem(KEY_POLICY);
    if (raw === null) return DEFAULT_POLICY;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_POLICY;
    const rows = parsed.filter(isPolicyRow);
    return rows.length > 0 ? rows : DEFAULT_POLICY;
  } catch {
    return DEFAULT_POLICY;
  }
}

function readBridges(): Bridges {
  if (typeof window === "undefined") return DEFAULT_BRIDGES;
  try {
    const raw = window.localStorage.getItem(KEY_BRIDGES);
    if (raw === null) return DEFAULT_BRIDGES;
    const parsed: unknown = JSON.parse(raw);
    return isBridges(parsed) ? parsed : DEFAULT_BRIDGES;
  } catch {
    return DEFAULT_BRIDGES;
  }
}

function readMode(): TwinMode {
  if (typeof window === "undefined") return "manual";
  try {
    const raw = window.localStorage.getItem(KEY_MODE);
    return raw === "manual" || raw === "autonomous" ? raw : "manual";
  } catch {
    return "manual";
  }
}

function readPersona(): Persona {
  if (typeof window === "undefined") return "Developer";
  try {
    const raw = window.localStorage.getItem(KEY_PERSONA);
    if (raw === "Developer" || raw === "Product Owner" || raw === "Designer") return raw;
    return "Developer";
  } catch {
    return "Developer";
  }
}

function writeString(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* localStorage may be unavailable; ignore. */
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* localStorage may be unavailable; ignore. */
  }
}

function removeLegacyKey(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* localStorage may be unavailable; ignore. */
  }
}

export function TwinProvider({ children }: { readonly children: ReactNode }): ReactNode {
  // Start from static defaults so the build-time prerender and the client's first
  // render agree; adopt persisted values right after mount. Reading localStorage in
  // the initializers would diverge from the static export and trip React #418
  // (hydration mismatch) on the footer governance pill and the ModeSwitch.
  const [mode, setMode] = useState<TwinMode>("manual");
  const [persona, setPersona] = useState<Persona>("Developer");
  const [policy, setPolicy] = useState<readonly PolicyRow[]>(DEFAULT_POLICY);
  const [bridges, setBridges] = useState<Bridges>(DEFAULT_BRIDGES);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setMode(readMode());
    setPersona(readPersona());
    setPolicy(readPolicy());
    setBridges(readBridges());
    removeLegacyKey(LEGACY_KEY_MEMORY);
    setHydrated(true);
  }, []);

  // Persist only after adoption so the mount pass can't clobber stored values
  // with the transient defaults.
  useEffect(() => {
    if (hydrated) writeString(KEY_MODE, mode);
  }, [mode, hydrated]);
  useEffect(() => {
    if (hydrated) writeString(KEY_PERSONA, persona);
  }, [persona, hydrated]);
  useEffect(() => {
    if (hydrated) writeJson(KEY_POLICY, policy);
  }, [policy, hydrated]);
  useEffect(() => {
    if (hydrated) writeJson(KEY_BRIDGES, bridges);
  }, [bridges, hydrated]);

  const decide = useCallback(
    (kind: GateKind, risk: Risk): Decision => twinDecide(policy, kind, risk),
    [policy],
  );

  const value = useMemo<TwinContextValue>(
    () => ({
      mode,
      setMode,
      persona,
      setPersona,
      policy,
      setPolicy,
      bridges,
      setBridges,
      decide,
    }),
    [mode, persona, policy, bridges, decide],
  );

  return <TwinContext.Provider value={value}>{children}</TwinContext.Provider>;
}

export function useTwin(): TwinContextValue {
  const ctx = useContext(TwinContext);
  if (ctx === null) throw new Error("useTwin must be used inside <TwinProvider>");
  return ctx;
}
