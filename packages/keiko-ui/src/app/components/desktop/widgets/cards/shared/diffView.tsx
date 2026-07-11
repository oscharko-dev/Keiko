"use client";

// Shared parsed-diff view (generalized from ReviewWidget, Epic #1571 / Issue #1574). Renders the
// unified-diff line/hunk/file structure produced by parseUnifiedDiff. Both the agent run-report
// Review surface and the live Git client diff pane consume these components, so the diff rendering
// (gutter signs, syntax highlighting, +N/−M stat chips, elevated-review markers) lives in one place.
//
// Behavior is preserved verbatim from ReviewWidget's prior local definitions; only the home moved.

import type { ReactNode } from "react";
import type { I18nTranslate } from "../../../../../../lib/i18n";
import type { ChangedFile } from "../../../../../../lib/types";
import { langOf, highlightLines } from "./syntaxHighlight";
import type { Token } from "./syntaxHighlight";
import type {
  GitEditorDiffFile as DiffFile,
  GitEditorDiffHunk as DiffHunk,
  GitEditorDiffLine as DiffLine,
} from "@oscharko-dev/keiko-contracts";

export function lineKindLabel(kind: DiffLine["kind"]): string {
  if (kind === "add") return "Added line";
  if (kind === "del") return "Deleted line";
  return kind === "ctx" ? "Context line" : "Diff metadata";
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
  readonly kindLabel?: string | undefined;
}

export function DiffLineView({ line, lang, kindLabel }: DiffLineViewProps): ReactNode {
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
      <span className="rv-sr-only">{kindLabel ?? lineKindLabel(line.kind)}</span>
      <span className="rv-num-old rv-num">{line.oldLine ?? ""}</span>
      <span className="rv-num-new rv-num">{line.newLine ?? ""}</span>
      <span className="rv-gutter" aria-hidden="true">
        {sign}
      </span>
      <code className="rv-src">{content}</code>
    </div>
  );
}

export interface DiffHunkViewLabels {
  readonly header: string;
  readonly add: string;
  readonly del: string;
  readonly ctx: string;
  readonly meta: string;
}

interface DiffHunkViewProps {
  readonly hunk: DiffHunk;
  readonly lang: string;
  readonly labels?: DiffHunkViewLabels | undefined;
}

export function DiffHunkView({ hunk, lang, labels }: DiffHunkViewProps): ReactNode {
  return (
    <>
      <div className="rv-hunk mono" aria-label={`Hunk header ${hunk.header}`}>
        <span className="rv-sr-only">{labels?.header ?? "Hunk header"}</span>
        {hunk.header}
      </div>
      {hunk.lines.map((line, idx) => (
        <DiffLineView key={idx} line={line} lang={lang} kindLabel={labels?.[line.kind]} />
      ))}
      {hunk.truncated ? (
        <p className="rv-truncated" role="status">
          This hunk is incomplete because the bounded diff was truncated.
        </p>
      ) : null}
    </>
  );
}

interface DiffFileSectionProps {
  readonly file: DiffFile;
  readonly index: number;
  readonly changedFiles?: readonly ChangedFile[] | undefined;
  readonly sectionRef: (el: HTMLElement | null) => void;
  readonly translate?: I18nTranslate | undefined;
}

export function DiffFileSection({
  file,
  index,
  changedFiles = [],
  sectionRef,
  translate,
}: DiffFileSectionProps): ReactNode {
  const cf = changedFiles.find((c) => c.path === file.path);
  const ext = file.path.includes(".") ? (file.path.split(".").pop() ?? "code") : "code";

  return (
    <section id={`rv-file-${index}`} aria-labelledby={`rv-file-${index}-h`} ref={sectionRef}>
      <h3 id={`rv-file-${index}-h`} className="rv-file mono">
        <span className="rv-path">{file.path}</span>
        {file.oldPath !== undefined && <span className="rv-oldpath"> (was {file.oldPath})</span>}
        <span className="rv-sr-only">
          {file.status} {translate?.("chat.repository.role.file") ?? "file"}
        </span>
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
        {file.binary ? (
          <p className="rv-empty-p">Binary file — no text diff to display.</p>
        ) : (
          file.hunks.map((hunk, hi) => <DiffHunkView key={hi} hunk={hunk} lang={ext} />)
        )}
        {file.truncated && !file.hunks.some((hunk) => hunk.truncated) ? (
          <p className="rv-truncated" role="status">
            This file diff is incomplete because the bounded diff was truncated.
          </p>
        ) : null}
      </div>
    </section>
  );
}
