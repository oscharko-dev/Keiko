"use client";

import type { ReactNode } from "react";

interface TerminalWidgetProps {
  cwd?: string;
  shell?: string;
}

export function TerminalWidget({
  cwd = "~/orca-intelligence",
  shell: _shell = "zsh",
}: TerminalWidgetProps): ReactNode {
  return (
    <div className="terminal mono">
      <div className="tm-line tm-dim">cd {cwd}</div>
      <div className="tm-line">
        <span className="tm-prompt">keiko ▸</span> npm run dev
      </div>
      <div className="tm-line tm-dim">VITE v5.4 ready in 312 ms</div>
      <div className="tm-line">
        <span className="tm-ok">➜</span> Local: http://localhost:5173
      </div>
      <div className="tm-line tm-dim">watching for changes…</div>
      <div className="tm-line">
        <span className="tm-prompt">keiko ▸</span> <span className="tm-cursor" />
      </div>
    </div>
  );
}
