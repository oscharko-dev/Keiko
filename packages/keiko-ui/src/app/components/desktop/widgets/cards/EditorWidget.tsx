"use client";

import type { ReactNode } from "react";
import { Icons } from "../../Icons";

// Mock highlighted source for the editor card. Verbatim from project/widgets.jsx
// 142-151. Token class "" means "no highlight class" — rendered as a bare span.
// Welle 5+ may swap this for a real editor binding once the workflow store
// exposes per-file diffs.
type Token = readonly [cls: string, text: string];

interface CodeLine {
  readonly n: number;
  readonly t: readonly Token[];
}

const CODE: readonly CodeLine[] = [
  {
    n: 1,
    t: [
      ["k", "const"],
      ["", " "],
      ["v", "{ useState }"],
      ["", " = "],
      ["v", "React"],
    ],
  },
  { n: 2, t: [] },
  {
    n: 3,
    t: [
      ["k", "function"],
      ["", " "],
      ["f", "WindowFrame"],
      ["p", "({ win, on })"],
      ["", " {"],
    ],
  },
  {
    n: 4,
    t: [
      ["", "  "],
      ["k", "const"],
      ["", " [drag, setDrag] = "],
      ["f", "useState"],
      ["p", "(null)"],
    ],
  },
  {
    n: 5,
    t: [
      ["", "  "],
      ["k", "return"],
      ["", " "],
      ["p", "<section"],
      ["a", " className"],
      ["", "="],
      ["s", '"window"'],
      ["p", ">"],
    ],
  },
  {
    n: 6,
    t: [
      ["", "    "],
      ["c", "// drag · resize · snap"],
    ],
  },
  {
    n: 7,
    t: [
      ["", "  "],
      ["p", "</section>"],
    ],
  },
  { n: 8, t: [["", "}"]] },
];

interface EditorWidgetProps {
  file?: string;
}

export function EditorWidget({ file = "windows.jsx" }: EditorWidgetProps): ReactNode {
  return (
    <div className="editor">
      <div className="ed-tabs mono">
        <span className="ed-tab active">
          <Icons.editor size={12} /> {file}
        </span>
        <span className="ed-tab">styles.css</span>
      </div>
      <div className="ed-code mono">
        {CODE.map((l) => (
          <div key={l.n} className="ed-line">
            <span className="ed-num">{l.n}</span>
            <span className="ed-src">
              {l.t.map((s, i) => (
                <span key={i} className={s[0] === "" ? undefined : `tk-${s[0]}`}>
                  {s[1]}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
