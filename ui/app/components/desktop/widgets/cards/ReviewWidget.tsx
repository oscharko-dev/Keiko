"use client";

import type { ReactNode } from "react";
import { Icons } from "../../Icons";

type DiffKind = "ctx" | "add" | "del";

interface DiffLine {
  readonly t: DiffKind;
  readonly n: string;
  readonly s: string;
}

const LINES: readonly DiffLine[] = [
  { t: "ctx", n: "12", s: "  const [w, setW] = useState(def.w);" },
  { t: "del", n: "13", s: "  resize(card)" },
  { t: "add", n: "13", s: "  resize(card, { axis })" },
  { t: "add", n: "14", s: "  persist(id, w, h)" },
  { t: "ctx", n: "15", s: "  return clamp(min, max)" },
];

function gutter(t: DiffKind): string {
  if (t === "add") return "+";
  if (t === "del") return "−";
  return "";
}

interface ReviewWidgetProps {
  base?: string;
  head?: string;
}

export function ReviewWidget({
  base = "main",
  head = "keiko/issue-51",
}: ReviewWidgetProps): ReactNode {
  return (
    <div className="review">
      <div className="rv-file mono">
        <Icons.branch size={13} /> {base} <span className="rv-arrow">→</span> {head}
        <span className="spacer" />
        <span className="rv-stat add">+18</span>
        <span className="rv-stat del">−4</span>
      </div>
      <div className="rv-code mono">
        {LINES.map((l, i) => (
          <div key={`${l.t}-${l.n}-${String(i)}`} className={`rv-line rv-${l.t}`}>
            <span className="rv-gutter">{gutter(l.t)}</span>
            <span className="rv-num">{l.n}</span>
            <span className="rv-src">{l.s}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
