"use client";

// Shared parsed-diff view (generalized from ReviewWidget, Epic #1571 / Issue #1574). Renders the
// unified-diff line/hunk/file structure produced by parseUnifiedDiff. Both the agent run-report
// Review surface and the live Git client diff pane consume these components, so the diff rendering
// (gutter signs, syntax highlighting, +N/−M stat chips, elevated-review markers) lives in one place.
//
// Behavior is preserved verbatim from ReviewWidget's prior local definitions; only the home moved.

import type { ReactNode } from "react";
import type { ChangedFile } from "../../../../../../lib/types";
import { langOf, highlightLines } from "./syntaxHighlight";
import type { Token } from "./syntaxHighlight";
import type { DiffFile, DiffHunk, DiffLine } from "./diffParser";

export function lineKindLabel(kind: DiffLine["kind"]): string {
  const map: Record<DiffLine["kind"], string> = {
    add: "Added line",
    del: "Deleted line",
    ctx: "Context line",
    meta: "Diff metadata",
  };
  return map[kind];
}

interface TokensProps {
  readonly tokens: readonly Token[];
}

function TokenSpans({ tokens }: TokensProps): ReactNode {
  return (
    <>
      {tokens.map((tok, idx) => (
        <span key={idx} className={`hl-${tok[0]}`}>
          {tok[1]}
        </span>
      ))}
    </>
  );
}

interface DiffLineViewProps {
  readonly line: DiffLine;
  readonly lang: string;
}

export function DiffLineView({ line, lang }: DiffLineViewProps): ReactNode {
  // gutter sign provides a non-color channel for add/del/ctx (WCAG 1.4.1)
  const sign =
    line.kind === "add" ? "+" : line.kind === "del" ? "−" : line.kind === "ctx" ? "·" : "";
  const cls = line.kind === "ctx" ? "" : ` rv-${line.kind}`;

  let content: ReactNode;
  if (line.kind !== "meta" && lang !== "code") {
    const tokenLines = highlightLines(line.text, langOf(lang));
    const toks = tokenLines[0] ?? [];
    content = <TokenSpans tokens={toks} />;
  } else {
    content = line.text;
  }

  return (
    <div className={`rv-line${cls}`}>
      <span className="rv-sr-only">{lineKindLabel(line.kind)}</span>
      <span className="rv-num-old rv-num">{line.oldLine ?? ""}</span>
      <span className="rv-num-new rv-num">{line.newLine ?? ""}</span>
      <span className="rv-gutter" aria-hidden="true">
        {sign}
      </span>
      <code className="rv-src">{content}</code>
    </div>
  );
}

interface DiffHunkViewProps {
  readonly hunk: DiffHunk;
  readonly lang: string;
}

export function DiffHunkView({ hunk, lang }: DiffHunkViewProps): ReactNode {
  return (
    <>
      <div className="rv-hunk mono" aria-label={`Hunk header ${hunk.header}`}>
        <span className="rv-sr-only">Hunk header</span>
        {hunk.header}
      </div>
      {hunk.lines.map((line, idx) => (
        <DiffLineView key={idx} line={line} lang={lang} />
      ))}
    </>
  );
}

interface DiffFileSectionProps {
  readonly file: DiffFile;
  readonly index: number;
  readonly changedFiles: readonly ChangedFile[];
  readonly sectionRef: (el: HTMLElement | null) => void;
}

export function DiffFileSection({
  file,
  index,
  changedFiles,
  sectionRef,
}: DiffFileSectionProps): ReactNode {
  const cf = changedFiles.find((c) => c.path === file.path);
  const ext = file.path.includes(".") ? (file.path.split(".").pop() ?? "code") : "code";

  return (
    <section id={`rv-file-${index}`} aria-labelledby={`rv-file-${index}-h`} ref={sectionRef}>
      <h3 id={`rv-file-${index}-h`} className="rv-file mono">
        <span className="rv-path">{file.path}</span>
        {file.oldPath !== undefined && <span className="rv-oldpath"> (was {file.oldPath})</span>}
        <span className="spacer" />
        <span className="rv-stat add">+{file.addedLines}</span>
        <span className="rv-stat del">−{file.removedLines}</span>
        {cf?.elevatedReview === true && (
          <span className="rv-elevated" aria-label="Elevated review">
            !
          </span>
        )}
      </h3>
      <div className="rv-code mono">
        {file.hunks.map((hunk, hi) => (
          <DiffHunkView key={hi} hunk={hunk} lang={ext} />
        ))}
      </div>
    </section>
  );
}
