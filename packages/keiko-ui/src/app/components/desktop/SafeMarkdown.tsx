"use client";

/**
 * SafeMarkdown.tsx — renders assistant Markdown responses safely.
 *
 * Security invariants (Issue #150):
 * - Never uses dangerouslySetInnerHTML.
 * - All text is rendered via JSX text nodes (auto-escaped by React).
 * - HTML tag detection uses indexOf, never regex (CodeQL js/bad-tag-filter HIGH).
 * - Links only emit when the href scheme is http:// or https://.
 * - Links always carry rel="noopener noreferrer" target="_blank".
 */

import {
  Component,
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  findCitationMarkerGroups,
  type CitationMarkerGroup,
} from "@oscharko-dev/keiko-contracts/runtime/citation-markers";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { parseSafeUserInput, parseSafeMarkdown, type SafeMarkdownNode } from "@/lib/safe-markdown";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import {
  highlightLines,
  langOf,
  type Lang,
  type Token,
} from "./widgets/cards/shared/syntaxHighlight";
import { Icons } from "./Icons";
import {
  consumeRepositoryReferenceLineSuffix,
  parseExactRepositoryReference,
  RepositoryReferenceInline,
  repositoryReferenceTextParts,
  repositoryReferencePathLabels,
  sanitizeRepositoryEvidenceText,
  type OpenRepositoryReference,
  type RepositoryReferenceRoot,
} from "./repositoryReferences";
import type { CitationPreviewController } from "./hooks/usePdfCitationPreview";
// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const CopyIcon = Icons.copy;

export interface SafeMarkdownProps {
  readonly literalUserInput?: boolean | undefined;
  readonly source: string;
  readonly diagnosticCorrelationId?: string | undefined;
  readonly diagnosticMessageId?: string | undefined;
  readonly repositoryRoots?: readonly RepositoryReferenceRoot[] | undefined;
  readonly openRepositoryReference?: OpenRepositoryReference | undefined;
  readonly citationPreview?: CitationPreviewController | undefined;
  readonly streaming?: boolean | undefined;
  readonly trailing?: ReactNode | undefined;
}

interface RenderOptions {
  readonly literalUserInput: boolean;
  readonly citationPreview: CitationPreviewController | undefined;
  readonly repositoryRoots: readonly RepositoryReferenceRoot[];
  readonly openRepositoryReference: OpenRepositoryReference | undefined;
  readonly streaming: boolean;
  readonly repositoryPathLabels: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Copy button for code blocks
// ---------------------------------------------------------------------------

type CopyState = "idle" | "copied" | "failed";

function CopyButton({ text }: { readonly text: string }): ReactNode {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [status, setStatus] = useState("");

  const handleCopy = useCallback(() => {
    // navigator.clipboard is undefined in non-secure contexts (and unimplemented in jsdom).
    // Guard with optional chaining + an explicit existence check, and surface the failure as
    // an announced status message rather than a silent no-op (audit C135).
    if (typeof navigator === "undefined" || navigator.clipboard?.writeText === undefined) {
      setCopyState("failed");
      setStatus("Clipboard unavailable. Select the code manually and copy it.");
      return;
    }
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopyState("copied");
        setStatus("Code copied");
        setTimeout(() => {
          setCopyState("idle");
          setStatus("");
        }, 1500);
      },
      () => {
        setCopyState("failed");
        setStatus("Clipboard access failed. Select the code manually and copy it.");
      },
    );
  }, [text]);

  const copied = copyState === "copied";
  const failed = copyState === "failed";

  return (
    <div className="sm-code-copy-wrap">
      <button
        type="button"
        className="sm-code-copy"
        aria-label={copied ? "Copied" : "Copy code block"}
        title={copied ? "Copied" : "Copy code block"}
        data-copied={copied ? "true" : "false"}
        data-failed={failed ? "true" : "false"}
        onClick={handleCopy}
      >
        <CopyIcon size={13} aria-hidden="true" />
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
      {/* WCAG 4.1.3 — the visible label swap alone is silent for screen readers
          (the aria-label is not re-announced on change); a status region carries
          the copy success / unavailable feedback (audit C135). <output> is the
          native status live region (S6819) and is inline like the <span> it
          replaces, so the surface keeps its box. */}
      <output className="sm-code-copy-status">{status}</output>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Code highlighting
// ---------------------------------------------------------------------------

function codeLangFromMarkdown(language: string | undefined): Lang {
  const normalized = language?.trim().toLowerCase() ?? "";
  if (normalized.length === 0) return "code";
  if (normalized === "typescript" || normalized === "tsx") return "ts";
  if (normalized === "javascript" || normalized === "jsx" || normalized === "node") return "js";
  if (normalized === "python") return "py";
  if (normalized === "shell" || normalized === "bash" || normalized === "zsh") return "sh";
  if (normalized === "markdown") return "md";
  if (normalized === "yml") return "yaml";
  if (normalized === "plaintext" || normalized === "text" || normalized === "plain") return "code";
  return langOf(`snippet.${normalized}`);
}

function tokenSpans(tokens: readonly Token[], lineIndex: number): ReactNode {
  return tokens.map((token, tokenIndex) => (
    <span key={`${String(lineIndex)}-${String(tokenIndex)}`} className={`hl-${token[0]}`}>
      {token[1]}
    </span>
  ));
}

function codeBlockLabel(language: string | undefined, t: I18nTranslate): string {
  return t("markdown.codeBlock.regionAria", {
    language: language ?? t("markdown.codeBlock.languageText"),
  });
}

function HighlightedCodeBlock({
  text,
  language,
  codeClass,
  long,
  trailing,
}: {
  readonly text: string;
  readonly language: string | undefined;
  readonly codeClass: string | undefined;
  readonly long: boolean;
  readonly trailing?: ReactNode | undefined;
}): ReactNode {
  // GEN-PERF-CHAT-010 — highlightLines tokenises the whole code block; keying the memo on the
  // immutable [text, language] source keeps it a once-per-block cost instead of re-running on every
  // parent re-render (mirrors FilePreview.tsx which already memoizes highlightLines).
  const lines = useMemo(
    () => highlightLines(text, codeLangFromMarkdown(language)),
    [text, language],
  );
  const t = useTranslate();
  const lineCountWidth = Math.max(2, String(lines.length).length);
  return (
    <section aria-label={codeBlockLabel(language, t)}>
      <pre
        className="sm-pre"
        data-long={long ? "true" : "false"}
        // Scrollable code pane: tabIndex makes the overflow region keyboard-scrollable.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        style={{ "--sm-code-line-no-width": `${String(lineCountWidth)}ch` } as CSSProperties}
      >
        <code className={codeClass}>
          {lines.map((tokens, lineIndex) => (
            <span
              key={`${lineIndex}:${tokens.map((token) => token[1]).join("")}`}
              className="sm-code-line"
            >
              <span className="sm-code-line-no" aria-hidden="true">
                {lineIndex + 1}
              </span>
              <span className="sm-code-line-src">
                {tokenSpans(tokens, lineIndex)}
                {lineIndex === lines.length - 1 ? trailing : null}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </section>
  );
}

function PlainCodeBlock({
  text,
  language,
  codeClass,
  long,
  trailing,
}: {
  readonly text: string;
  readonly language: string | undefined;
  readonly codeClass: string | undefined;
  readonly long: boolean;
  readonly trailing?: ReactNode | undefined;
}): ReactNode {
  const t = useTranslate();
  return (
    <section aria-label={codeBlockLabel(language, t)}>
      <pre
        className="sm-pre"
        data-long={long ? "true" : "false"}
        // Scrollable code pane: tabIndex makes the overflow region keyboard-scrollable.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
      >
        <code className={codeClass}>
          {text}
          {trailing}
        </code>
      </pre>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Heading tag map — avoids template-literal restrict-template-expressions
// ---------------------------------------------------------------------------

// Markdown levels are demoted two steps (1→h3, 2→h4, …) so model-generated
// "# Title" headings do not land as top-level h1/h2 in the document outline and
// flood the screen-reader heading rotor alongside the app's own headings
// (audit C315). HEADING_CLASSES below keeps the visual hierarchy unchanged.
const HEADING_TAGS = {
  1: "h3",
  2: "h4",
  3: "h5",
  4: "h6",
  5: "h6",
  6: "h6",
} as const satisfies Record<1 | 2 | 3 | 4 | 5 | 6, string>;

const HEADING_CLASSES = {
  1: "sm-h sm-h1",
  2: "sm-h sm-h2",
  3: "sm-h sm-h3",
  4: "sm-h sm-h4",
  5: "sm-h sm-h5",
  6: "sm-h sm-h6",
} as const satisfies Record<1 | 2 | 3 | 4 | 5 | 6, string>;

// ---------------------------------------------------------------------------
// Node renderer — split into sub-functions to stay within max-lines-per-function
// ---------------------------------------------------------------------------

function repositoryCodeLinePair(
  code: SafeMarkdownNode | undefined,
  following: SafeMarkdownNode | undefined,
): readonly [SafeMarkdownNode, SafeMarkdownNode] | undefined {
  if (code?.kind !== "inline-code" || following?.kind !== "text") return undefined;
  const text = following.text ?? "";
  const suffix = consumeRepositoryReferenceLineSuffix(code.text ?? "", text);
  if (suffix === undefined) return undefined;
  return [
    { ...code, text: suffix.reference.label },
    { ...following, text: text.slice(suffix.length) },
  ];
}

function adjacentRepositoryCodeLocations(
  children: readonly SafeMarkdownNode[],
): readonly SafeMarkdownNode[] {
  let adjusted: SafeMarkdownNode[] | undefined;
  for (let index = 0; index < children.length - 1; index += 1) {
    const pair = repositoryCodeLinePair(children[index], children[index + 1]);
    if (pair === undefined) continue;
    adjusted ??= [...children];
    adjusted[index] = pair[0];
    adjusted[index + 1] = pair[1];
  }
  return adjusted ?? children;
}

function tableRepositoryLocationChildren(node: SafeMarkdownNode): readonly SafeMarkdownNode[] {
  const children = node.children ?? [];
  if (node.kind !== "td" && node.kind !== "th") return children;
  const text = children.length === 1 && children[0]?.kind === "text" ? children[0].text : undefined;
  if (text === undefined) return children;
  const reference = parseExactRepositoryReference(text.trim(), true);
  if (reference?.lineStart === undefined) return children;
  return [{ ...children[0], kind: "inline-code", text: reference.label }];
}

function renderChildren(
  node: SafeMarkdownNode,
  key: string,
  options: RenderOptions,
  trailing?: ReactNode | undefined,
): ReactNode[] {
  const children =
    options.literalUserInput || options.openRepositoryReference === undefined
      ? (node.children ?? [])
      : adjacentRepositoryCodeLocations(tableRepositoryLocationChildren(node));
  if (children.length === 0) {
    return trailing === undefined ? [] : [<Fragment key={`${key}-trailing`}>{trailing}</Fragment>];
  }
  const lastIndex = children.length - 1;
  return children.map((child, idx) =>
    renderNode(child, key + "-" + String(idx), options, idx === lastIndex ? trailing : undefined),
  );
}

function renderCodeBlockHeader(
  codeText: string,
  lang: string | undefined,
  options: RenderOptions,
): ReactNode {
  if (options.streaming) return null;
  return (
    <div className="sm-code-block-header">
      {/* "untitled" read like a missing file name; untagged fences are plain text (C307) */}
      <span className="sm-code-lang">{lang ?? "text"}</span>
      <div className="sm-code-copy-wrap">
        <CopyButton text={codeText} />
      </div>
    </div>
  );
}

function renderCodeBlockNode(
  node: SafeMarkdownNode,
  key: string,
  options: RenderOptions,
  trailing?: ReactNode | undefined,
): ReactNode {
  const lang = node.language;
  const codeText = node.text ?? "";
  const codeClass = lang !== undefined ? `lang-${lang}` : undefined;
  const lineCount = codeText.length === 0 ? 1 : codeText.split(/\r\n|\r|\n/u).length;
  const long = lineCount > 24;
  return (
    <div key={key} className="sm-code-block-frame" data-long={long ? "true" : "false"}>
      {renderCodeBlockHeader(codeText, lang, options)}
      {options.streaming ? (
        <PlainCodeBlock
          text={codeText}
          language={lang}
          codeClass={codeClass}
          long={long}
          trailing={trailing}
        />
      ) : (
        <HighlightedCodeBlock
          text={codeText}
          language={lang}
          codeClass={codeClass}
          long={long}
          trailing={trailing}
        />
      )}
    </div>
  );
}

function renderBlockNode(
  node: SafeMarkdownNode,
  key: string,
  options: RenderOptions,
  trailing?: ReactNode | undefined,
): ReactNode | null {
  switch (node.kind) {
    case "paragraph":
      return (
        <p key={key} className="sm-p">
          {renderChildren(node, key, options, trailing)}
        </p>
      );

    case "heading": {
      const level = node.level ?? 1;
      const Tag = HEADING_TAGS[level];
      const cls = HEADING_CLASSES[level];
      return (
        <Tag key={key} className={cls}>
          {renderChildren(node, key, options, trailing)}
        </Tag>
      );
    }

    case "blockquote":
      return (
        <blockquote key={key} className="sm-blockquote">
          {renderChildren(node, key, options, trailing)}
        </blockquote>
      );

    case "hr":
      return (
        <Fragment key={key}>
          <hr className="sm-hr" />
          {trailing}
        </Fragment>
      );

    case "code-block":
      return renderCodeBlockNode(node, key, options, trailing);

    default:
      return null;
  }
}

function renderListNode(
  node: SafeMarkdownNode,
  key: string,
  options: RenderOptions,
  trailing?: ReactNode | undefined,
): ReactNode | null {
  switch (node.kind) {
    case "ul":
      return (
        <ul key={key} className="sm-ul">
          {renderChildren(node, key, options, trailing)}
        </ul>
      );

    case "ol":
      return (
        <ol key={key} className="sm-ol" start={node.start}>
          {renderChildren(node, key, options, trailing)}
        </ol>
      );

    case "li":
      return (
        <li key={key} className="sm-li">
          {renderChildren(node, key, options, trailing)}
        </li>
      );

    default:
      return null;
  }
}

function renderTableNode(
  node: SafeMarkdownNode,
  key: string,
  options: RenderOptions,
  trailing?: ReactNode | undefined,
): ReactNode | null {
  const alignStyle = node.align !== undefined ? { textAlign: node.align } : undefined;

  switch (node.kind) {
    case "table":
      return (
        <div key={key} className="sm-table-wrapper">
          <table className="sm-table">{renderChildren(node, key, options, trailing)}</table>
        </div>
      );

    case "thead":
      return <thead key={key}>{renderChildren(node, key, options, trailing)}</thead>;

    case "tbody":
      return <tbody key={key}>{renderChildren(node, key, options, trailing)}</tbody>;

    case "tr":
      return <tr key={key}>{renderChildren(node, key, options, trailing)}</tr>;

    case "th":
      return (
        <th key={key} style={alignStyle}>
          {renderChildren(node, key, options, trailing)}
        </th>
      );

    case "td":
      return (
        <td key={key} style={alignStyle}>
          {renderChildren(node, key, options, trailing)}
        </td>
      );

    default:
      return null;
  }
}

const BLOCKED_CITATION_MESSAGE = "PDF preview unavailable";

function markerButtonLabel(marker: string, state: "available" | "recoverable" | "blocked"): string {
  if (state === "recoverable") {
    return `Open PDF recovery for citation ${marker}`;
  }
  if (state === "blocked") {
    return `Citation ${marker}. PDF preview unavailable.`;
  }
  return `Open PDF preview for citation ${marker}`;
}

function markerTipText(state: "available" | "recoverable" | "blocked"): string {
  let tip: string;
  if (state === "blocked") {
    tip = BLOCKED_CITATION_MESSAGE;
  } else if (state === "recoverable") {
    tip = "Open PDF recovery";
  } else {
    tip = "Open PDF preview";
  }
  return tip;
}

function InlineCitationMarker({
  marker,
  preview,
}: {
  readonly marker: string;
  readonly preview: CitationPreviewController;
}): ReactNode {
  const affordance = preview.forMarker(marker);
  if (affordance === undefined) {
    return marker;
  }
  const opening = preview.isOpening(affordance.citation);
  const blocked = affordance.state === "blocked";
  return (
    <button
      type="button"
      className={`citation-inline-marker ui-tip citation-inline-marker--${affordance.state}`}
      aria-disabled={blocked || opening ? "true" : undefined}
      aria-label={markerButtonLabel(marker, affordance.state)}
      data-tip={markerTipText(affordance.state)}
      onClick={() => {
        if (blocked || opening) return;
        void preview.openCitation(affordance.citation, "inline-marker");
      }}
    >
      {marker}
    </button>
  );
}

// One bracket pair holding one or more cited indices (`[1]`, `[1, 7, 8]`, `【2】`). Every index with
// structured metadata renders as its OWN marker link (the whole group used to be dead text); a group
// with no linkable index keeps its original text untouched, and an unlinked index inside a linked
// group stays plain text.
function InlineCitationGroup({
  group,
  preview,
}: {
  readonly group: CitationMarkerGroup;
  readonly preview: CitationPreviewController;
}): ReactNode {
  if (!group.entries.some((entry) => preview.forMarker(entry.marker) !== undefined)) {
    return group.text;
  }
  return (
    <>
      {group.entries.map((entry, position) => (
        <Fragment key={`${entry.marker}-${String(position)}`}>
          {position > 0 ? " " : null}
          <InlineCitationMarker marker={entry.marker} preview={preview} />
        </Fragment>
      ))}
    </>
  );
}

function renderCitationText(
  text: string,
  key: string,
  citationPreview: CitationPreviewController | undefined,
  trailing?: ReactNode | undefined,
): ReactNode {
  if (citationPreview === undefined) {
    return (
      <span key={key}>
        {text}
        {trailing}
      </span>
    );
  }
  const fragments: ReactNode[] = [];
  let cursor = 0;
  for (const group of findCitationMarkerGroups(text)) {
    if (group.start > cursor) {
      fragments.push(
        <span key={`${key}-text-${String(cursor)}`}>{text.slice(cursor, group.start)}</span>,
      );
    }
    fragments.push(
      <InlineCitationGroup
        key={`${key}-marker-${String(group.start)}`}
        group={group}
        preview={citationPreview}
      />,
    );
    cursor = group.end;
  }
  if (cursor < text.length) {
    fragments.push(<span key={`${key}-tail`}>{text.slice(cursor)}</span>);
  }
  if (trailing !== undefined) {
    fragments.push(<Fragment key={`${key}-trailing`}>{trailing}</Fragment>);
  }
  return <span key={key}>{fragments.length === 0 ? text : fragments}</span>;
}

function renderRepositoryText(
  text: string,
  key: string,
  options: RenderOptions,
  trailing?: ReactNode | undefined,
): ReactNode {
  const sanitizedText = sanitizeRepositoryEvidenceText(text);
  if (options.openRepositoryReference === undefined) {
    return renderCitationText(sanitizedText, key, options.citationPreview, trailing);
  }
  const parts = repositoryReferenceTextParts(sanitizedText);
  if (parts.length === 1 && parts[0]?.kind === "text")
    return renderCitationText(sanitizedText, key, options.citationPreview, trailing);
  return (
    <span key={key}>
      {parts.map((part, index) => {
        const partKey = `${key}-repo-${String(index)}`;
        if (part.kind === "text") {
          return renderCitationText(part.text ?? "", partKey, options.citationPreview);
        }
        const reference = part.reference;
        if (reference === undefined) return null;
        return (
          <RepositoryReferenceInline
            key={partKey}
            reference={reference}
            roots={options.repositoryRoots}
            openReference={options.openRepositoryReference}
            displayPath={options.repositoryPathLabels.get(reference.path)}
          />
        );
      })}
      {trailing}
    </span>
  );
}

function renderInlineCode(
  node: SafeMarkdownNode,
  key: string,
  options: RenderOptions,
  trailing?: ReactNode | undefined,
): ReactNode {
  const text = node.text ?? "";
  const reference =
    options.openRepositoryReference === undefined
      ? null
      : parseExactRepositoryReference(text, true);
  return (
    <code key={key} className="sm-inline-code">
      {reference === null ? (
        text
      ) : (
        <RepositoryReferenceInline
          reference={reference}
          roots={options.repositoryRoots}
          openReference={options.openRepositoryReference}
          displayPath={options.repositoryPathLabels.get(reference.path)}
          className="repo-ref-link repo-ref-link-inline-code"
        />
      )}
      {trailing}
    </code>
  );
}

function renderInlineNode(
  node: SafeMarkdownNode,
  key: string,
  options: RenderOptions,
  trailing?: ReactNode | undefined,
): ReactNode | null {
  switch (node.kind) {
    case "text":
      if (options.literalUserInput)
        return (
          <span key={key}>
            {node.text}
            {trailing}
          </span>
        );
      return renderRepositoryText(node.text ?? "", key, options, trailing);

    case "inline-code":
      return renderInlineCode(node, key, options, trailing);

    case "link":
      return (
        <a key={key} href={node.href} className="sm-link" rel="noopener noreferrer" target="_blank">
          {node.text}
          {/* target="_blank" is invisible to screen readers — announce the context
              switch in the accessible name without changing the visual layout (C316). */}
          <span className="sr-only"> (opens in new tab)</span>
          {trailing}
        </a>
      );

    case "strong":
      return <strong key={key}>{renderChildren(node, key, options, trailing)}</strong>;

    case "em":
      return <em key={key}>{renderChildren(node, key, options, trailing)}</em>;

    default:
      return null;
  }
}

function renderNode(
  node: SafeMarkdownNode,
  key: string,
  options: RenderOptions,
  trailing?: ReactNode | undefined,
): ReactNode {
  const block = renderBlockNode(node, key, options, trailing);
  if (block !== null) return block;

  const list = renderListNode(node, key, options, trailing);
  if (list !== null) return list;

  const table = renderTableNode(node, key, options, trailing);
  if (table !== null) return table;

  const inline = renderInlineNode(node, key, options, trailing);
  if (inline !== null) return inline;

  // Exhaustiveness guard — TypeScript narrows node.kind to never here if all
  // cases above are handled. If a new kind is added to SafeMarkdownNode without
  // a handler, this branch renders nothing rather than crashing.
  return null;
}

function renderMarkdownTree(
  tree: readonly SafeMarkdownNode[],
  options: RenderOptions,
  trailing: ReactNode | undefined,
): ReactNode[] {
  if (tree.length === 0) {
    return trailing === undefined ? [] : [<Fragment key="trailing">{trailing}</Fragment>];
  }
  const lastIndex = tree.length - 1;
  return tree.map((node, i) =>
    renderNode(node, String(i), options, i === lastIndex ? trailing : undefined),
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

// GEN-PERF-CHAT-010 — a module-level frozen empty array so the `repositoryRoots = []` default does
// not mint a fresh identity per render (which would defeat the options useMemo and the React.memo
// prop compare below).
const EMPTY_ROOTS: readonly RepositoryReferenceRoot[] = Object.freeze([]);

// Emit layout coordinates only; the stable message identity joins re-renders to their message.
function reportListStarts(
  tree: readonly SafeMarkdownNode[],
  correlationId: string | undefined,
  cursor: { index: number; messageId?: string | undefined },
  depth = 0,
): void {
  for (const node of tree) {
    if (node.kind === "ol") {
      const listIndex = cursor.index++;
      if (node.start !== undefined && node.start !== 1) {
        reportClientDiagnostic("markdown:ordered-list-source-start", {
          kind: "markdown-layout",
          correlationId,
          markdownLayout: { listStart: node.start, listIndex, depth, messageId: cursor.messageId },
        });
      }
    }
    if (node.children !== undefined)
      reportListStarts(node.children, correlationId, cursor, depth + 1);
  }
}

function useMarkdownListEvidence(
  tree: readonly SafeMarkdownNode[],
  streaming: boolean,
  correlationId: string | undefined,
  messageId: string | undefined,
): void {
  const lastReported = useRef<readonly SafeMarkdownNode[] | undefined>(undefined);
  useEffect(() => {
    if (streaming || lastReported.current === tree) return;
    lastReported.current = tree;
    reportListStarts(tree, correlationId, { index: 0, messageId });
  }, [tree, streaming, correlationId, messageId]);
}

function referencePathsInNode(node: SafeMarkdownNode): readonly string[] {
  const text = node.text ?? "";
  if (node.kind === "inline-code") {
    const reference = parseExactRepositoryReference(text, true);
    return reference === null ? [] : [reference.path];
  }
  if (node.kind !== "text") return [];
  return repositoryReferenceTextParts(sanitizeRepositoryEvidenceText(text)).flatMap((part) =>
    part.reference === undefined ? [] : [part.reference.path],
  );
}

function referencePathsInTree(tree: readonly SafeMarkdownNode[]): readonly string[] {
  const paths: string[] = [];
  for (const node of tree) {
    paths.push(...referencePathsInNode(node));
    if (node.children !== undefined) paths.push(...referencePathsInTree(node.children));
  }
  return paths;
}

function SafeMarkdownImpl({
  source,
  literalUserInput = false,
  diagnosticCorrelationId,
  diagnosticMessageId,
  repositoryRoots = EMPTY_ROOTS,
  openRepositoryReference,
  citationPreview,
  streaming = false,
  trailing,
}: SafeMarkdownProps): ReactNode {
  const tree = useMemo(
    () => (literalUserInput ? parseSafeUserInput(source) : parseSafeMarkdown(source)),
    [source, literalUserInput],
  );
  useMarkdownListEvidence(tree, streaming, diagnosticCorrelationId, diagnosticMessageId);
  const repositoryPathLabels = useMemo(
    () => repositoryReferencePathLabels(referencePathsInTree(tree)),
    [tree],
  );
  const options = useMemo<RenderOptions>(
    () => ({
      literalUserInput,
      citationPreview,
      streaming,
      repositoryRoots,
      openRepositoryReference,
      repositoryPathLabels,
    }),
    [
      literalUserInput,
      citationPreview,
      openRepositoryReference,
      repositoryRoots,
      repositoryPathLabels,
      streaming,
    ],
  );
  return (
    <div className="sm-root" style={literalUserInput ? { whiteSpace: "pre-wrap" } : undefined}>
      {renderMarkdownTree(tree, options, trailing)}
    </div>
  );
}

// GEN-PERF-CHAT-010 — memoized so a settled assistant bubble does not re-parse/re-highlight its
// Markdown when an unrelated parent (draft/streaming) re-renders. Keying is a shallow prop compare;
// `source` is immutable per message and repositoryRoots/openRepositoryReference/citationPreview
// are caller-memoized, so the compare is cheap and the security invariants
// (AST-only parse keyed on the source text) are unchanged.
export const SafeMarkdown = memo(SafeMarkdownImpl);

// ---------------------------------------------------------------------------
// SM-1: per-message error boundary. A parser/render defect in one assistant
// message must degrade THAT message to plain text rather than crashing the whole
// conversation view (which has no enclosing boundary). The fallback preserves the
// AST-only / no-dangerouslySetInnerHTML invariant — it renders the raw source as
// React-escaped text.
// ---------------------------------------------------------------------------

export interface SafeMarkdownBoundaryProps {
  readonly literalUserInput?: boolean | undefined;
  readonly source: string;
  readonly diagnosticCorrelationId?: string | undefined;
  readonly diagnosticMessageId?: string | undefined;
  readonly repositoryRoots?: readonly RepositoryReferenceRoot[] | undefined;
  readonly openRepositoryReference?: OpenRepositoryReference | undefined;
  readonly citationPreview?: CitationPreviewController | undefined;
  readonly streaming?: boolean | undefined;
  readonly trailing?: ReactNode | undefined;
}

interface SafeMarkdownBoundaryState {
  readonly failed: boolean;
}

export class SafeMarkdownBoundary extends Component<
  SafeMarkdownBoundaryProps,
  SafeMarkdownBoundaryState
> {
  public override state: SafeMarkdownBoundaryState = { failed: false };

  public static getDerivedStateFromError(): SafeMarkdownBoundaryState {
    return { failed: true };
  }

  public override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="sm-root sm-fallback" data-markdown-fallback="true">
          {this.props.source}
          {this.props.trailing}
        </div>
      );
    }
    return (
      <SafeMarkdown
        source={this.props.source}
        literalUserInput={this.props.literalUserInput}
        diagnosticCorrelationId={this.props.diagnosticCorrelationId}
        diagnosticMessageId={this.props.diagnosticMessageId}
        repositoryRoots={this.props.repositoryRoots}
        openRepositoryReference={this.props.openRepositoryReference}
        citationPreview={this.props.citationPreview}
        streaming={this.props.streaming}
        trailing={this.props.trailing}
      />
    );
  }
}
