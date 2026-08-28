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
import { NATIVE_BLOCK_STYLE } from "../../../native-element-styles";
import { langOf, highlightLines } from "./syntaxHighlight";
import type { Token } from "./syntaxHighlight";
import selectableTextStyles from "./selectableText.module.css";
import type {
  GitEditorDiffFile as DiffFile,
  GitEditorDiffHunk as DiffHunk,
  GitEditorDiffLine as DiffLine,
} from "@oscharko-dev/keiko-contracts";

export interface DiffViewLabels {
  readonly addedLine: string;
  readonly deletedLine: string;
  readonly contextLine: string;
  readonly metadataLine: string;
  readonly hunkHeader: string;
  readonly hunkTruncated: string;
  readonly fileTruncated: string;
  readonly binaryFile: string;
  readonly previousPath: (path: string) => string;
  readonly elevatedReview: string;
}

// Issue #2710 — line-number gutters, the sign gutter, and screen-reader-only
// labels stay unselectable inside the now-selectable diff body, so a copied
// range carries the source text alone.
const CHROME_CLASS = selectableTextStyles["cmp-selectable-text-chrome"] ?? "";

function lineKindLabel(kind: DiffLine["kind"], labels?: DiffViewLabels): string {
  if (kind === "add") return labels?.addedLine ?? "Added line";
  if (kind === "del") return labels?.deletedLine ?? "Deleted line";
  return kind === "ctx"
    ? (labels?.contextLine ?? "Context line")
    : (labels?.metadataLine ?? "Diff metadata");
}

// gutter sign provides a non-color channel for add/del/ctx (WCAG 1.4.1)
function gutterSign(kind: DiffLine["kind"]): string {
  if (kind === "add") return "+";
  if (kind === "del") return "−";
  if (kind === "ctx") return "·";
  return "";
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
  readonly labels?: DiffViewLabels | undefined;
}

function DiffLineView({ line, lang, kindLabel, labels }: DiffLineViewProps): ReactNode {
  const sign = gutterSign(line.kind);
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
      <span className={`rv-sr-only ${CHROME_CLASS}`}>
        {kindLabel ?? lineKindLabel(line.kind, labels)}
      </span>
      <span className={`rv-num-old rv-num ${CHROME_CLASS}`}>{line.oldLine ?? ""}</span>
      <span className={`rv-num-new rv-num ${CHROME_CLASS}`}>{line.newLine ?? ""}</span>
      <span className={`rv-gutter ${CHROME_CLASS}`} aria-hidden="true">
        {sign}
      </span>
      <code className="rv-src">{content}</code>
    </div>
  );
}

interface DiffHunkViewLabels {
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
  readonly viewLabels?: DiffViewLabels | undefined;
}

export function DiffHunkView({ hunk, lang, labels, viewLabels }: DiffHunkViewProps): ReactNode {
  return (
    <>
      <div
        className="rv-hunk mono"
        aria-label={`${viewLabels?.hunkHeader ?? "Hunk header"} ${hunk.header}`}
      >
        <span className="rv-sr-only">
          {labels?.header ?? viewLabels?.hunkHeader ?? "Hunk header"}
        </span>
        {hunk.header}
      </div>
      {hunk.lines.map((line, idx) => (
        <DiffLineView
          key={`${String(line.oldLine ?? "-")}:${String(line.newLine ?? "-")}:${line.kind}:${String(idx)}`}
          line={line}
          lang={lang}
          kindLabel={labels?.[line.kind]}
          labels={viewLabels}
        />
      ))}
      {hunk.truncated ? (
        <output className="rv-truncated" style={NATIVE_BLOCK_STYLE}>
          {viewLabels?.hunkTruncated ??
            "This hunk is incomplete because the bounded diff was truncated."}
        </output>
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
  readonly labels?: DiffViewLabels | undefined;
  readonly idPrefix?: string | undefined;
}

function useTranslate(translate: I18nTranslate | undefined): string {
  return translate?.("chat.repository.role.file") ?? "file";
}

export function DiffFileSection({
  file,
  index,
  changedFiles = [],
  sectionRef,
  translate,
  labels,
  idPrefix = "rv-file",
}: DiffFileSectionProps): ReactNode {
  const fileLabel = useTranslate(translate);
  const cf = changedFiles.find((c) => c.path === file.path);
  const ext = file.path.includes(".") ? (file.path.split(".").pop() ?? "code") : "code";

  return (
    <section
      id={`${idPrefix}-${index}`}
      aria-labelledby={`${idPrefix}-${index}-h`}
      ref={sectionRef}
    >
      <h3 id={`${idPrefix}-${index}-h`} className="rv-file mono">
        <span className="rv-path">{file.path}</span>
        {file.oldPath !== undefined && (
          <span className="rv-oldpath">
            {labels?.previousPath(file.oldPath) ?? ` (was ${file.oldPath})`}
          </span>
        )}
        <span className="rv-sr-only">
          {file.status} {fileLabel}
        </span>
        <span className="spacer" />
        <span className="rv-stat add">+{file.addedLines}</span>
        <span className="rv-stat del">−{file.removedLines}</span>
        {cf?.elevatedReview === true && (
          <span className="rv-elevated" aria-label={labels?.elevatedReview ?? "Elevated review"}>
            !
          </span>
        )}
      </h3>
      {/* Issue #2710 — diff text must be selectable and its copy native;
          data-text-selectable is the interaction-guard contract for both. */}
      <div
        className={`rv-code mono ${selectableTextStyles["cmp-selectable-text"]}`}
        data-text-selectable="true"
      >
        {file.binary ? (
          <p className="rv-empty-p">
            {labels?.binaryFile ?? "Binary file — no text diff to display."}
          </p>
        ) : (
          file.hunks.map((hunk) => (
            <DiffHunkView key={hunk.header} hunk={hunk} lang={ext} viewLabels={labels} />
          ))
        )}
        {file.truncated && !file.hunks.some((hunk) => hunk.truncated) ? (
          <output className="rv-truncated" style={NATIVE_BLOCK_STYLE}>
            {labels?.fileTruncated ??
              "This file diff is incomplete because the bounded diff was truncated."}
          </output>
        ) : null}
      </div>
    </section>
  );
}
