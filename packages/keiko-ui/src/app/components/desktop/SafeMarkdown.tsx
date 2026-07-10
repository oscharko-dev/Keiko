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
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { EditorAgentConflictCode } from "@oscharko-dev/keiko-contracts";
import { parseSafeMarkdown, type SafeMarkdownNode } from "@/lib/safe-markdown";
import { useTranslate } from "@/lib/i18n";
import {
  highlightLines,
  langOf,
  type Lang,
  type Token,
} from "./widgets/cards/shared/syntaxHighlight";
import { Icons } from "./Icons";
import {
  parseExactRepositoryReference,
  RepositoryReferenceInline,
  repositoryReferenceTextParts,
  sanitizeRepositoryEvidenceText,
  type OpenRepositoryReference,
  type RepositoryReferenceRoot,
} from "./repositoryReferences";
import type { CitationPreviewController } from "./hooks/usePdfCitationPreview";
import {
  useEditorAgentTranslate,
  type EditorAgentTranslate,
} from "./widgets/cards/editor-agent-i18n";

export interface AssistantCodeBlockApplyRequest {
  readonly codeBlockText: string;
  readonly language?: string | undefined;
}

export type AssistantCodeBlockApplyOutcome =
  | { readonly kind: "queued" }
  | {
      readonly kind: "conflict";
      readonly code: EditorAgentConflictCode;
      readonly message?: string | undefined;
    }
  | { readonly kind: "rejected"; readonly message?: string | undefined }
  | { readonly kind: "outcome-unknown" };

export type AssistantCodeBlockApply = (
  request: AssistantCodeBlockApplyRequest,
) => Promise<AssistantCodeBlockApplyOutcome>;

export interface SafeMarkdownProps {
  readonly source: string;
  readonly applyScopeId?: string | undefined;
  readonly repositoryRoots?: readonly RepositoryReferenceRoot[] | undefined;
  readonly openRepositoryReference?: OpenRepositoryReference | undefined;
  readonly citationPreview?: CitationPreviewController | undefined;
  readonly onApplyCodeBlock?: AssistantCodeBlockApply | undefined;
}

interface RenderOptions {
  readonly applyScopeId: string | undefined;
  readonly citationPreview: CitationPreviewController | undefined;
  readonly repositoryRoots: readonly RepositoryReferenceRoot[];
  readonly openRepositoryReference: OpenRepositoryReference | undefined;
  readonly onApplyCodeBlock: AssistantCodeBlockApply | undefined;
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
        <Icons.copy size={13} aria-hidden="true" />
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
      {/* WCAG 4.1.3 — the visible label swap alone is silent for screen readers
          (the aria-label is not re-announced on change); a status region carries
          the copy success / unavailable feedback (audit C135). */}
      <span role="status" className="sm-code-copy-status">
        {status}
      </span>
    </div>
  );
}

type ApplyState =
  | { readonly kind: "idle" }
  | { readonly kind: "preparing" }
  | { readonly kind: "queued" }
  | { readonly kind: "conflict"; readonly code: EditorAgentConflictCode }
  | { readonly kind: "rejected" }
  | { readonly kind: "outcome-unknown" };

type TerminalApplyState = Extract<ApplyState, { readonly kind: "queued" | "outcome-unknown" }>;

const APPLY_TERMINAL_STATE_CAPACITY = 256;
const terminalApplyStates = new Map<string, TerminalApplyState>();

function cachedApplyState(stateKey: string | undefined): ApplyState {
  return stateKey === undefined
    ? { kind: "idle" }
    : (terminalApplyStates.get(stateKey) ?? { kind: "idle" });
}

function cacheTerminalApplyState(stateKey: string | undefined, state: ApplyState): void {
  if (stateKey === undefined || (state.kind !== "queued" && state.kind !== "outcome-unknown"))
    return;
  terminalApplyStates.delete(stateKey);
  terminalApplyStates.set(stateKey, state);
  while (terminalApplyStates.size > APPLY_TERMINAL_STATE_CAPACITY) {
    const oldest = terminalApplyStates.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    terminalApplyStates.delete(oldest);
  }
}

function applyStateFromOutcome(outcome: AssistantCodeBlockApplyOutcome): ApplyState {
  if (outcome.kind === "conflict") return { kind: "conflict", code: outcome.code };
  return { kind: outcome.kind };
}

function applyButtonLabel(state: ApplyState, t: EditorAgentTranslate, retryLabel: string): string {
  if (state.kind === "idle") return t("chat.codeApply.action");
  if (state.kind === "preparing") return t("chat.codeApply.preparing");
  if (state.kind === "queued") return t("chat.codeApply.queued");
  if (state.kind === "outcome-unknown") return t("chat.codeApply.outcomeUnknown");
  return retryLabel;
}

function applyStatusLabel(state: ApplyState, t: EditorAgentTranslate): string {
  if (state.kind === "idle") return "";
  if (state.kind === "conflict") return t("chat.codeApply.conflict", { code: state.code });
  if (state.kind === "rejected") return t("chat.codeApply.unavailable");
  if (state.kind === "outcome-unknown") return t("chat.codeApply.outcomeUnknownStatus");
  return state.kind === "queued" ? t("chat.codeApply.queued") : t("chat.codeApply.preparing");
}

function ApplyCodeBlockButton({
  text,
  language,
  onApply,
  stateKey,
}: {
  readonly text: string;
  readonly language: string | undefined;
  readonly onApply: AssistantCodeBlockApply;
  readonly stateKey: string | undefined;
}): ReactNode {
  const commonT = useTranslate();
  const t = useEditorAgentTranslate();
  const [state, setState] = useState<ApplyState>(() => cachedApplyState(stateKey));
  const inFlight = useRef(false);
  const handleApply = useCallback((): void => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState({ kind: "preparing" });
    void Promise.resolve<AssistantCodeBlockApplyRequest>({ codeBlockText: text, language })
      .then(onApply)
      .then(
        (outcome) => {
          inFlight.current = false;
          const next = applyStateFromOutcome(outcome);
          cacheTerminalApplyState(stateKey, next);
          setState(next);
        },
        () => {
          inFlight.current = false;
          setState({ kind: "rejected" });
        },
      );
  }, [language, onApply, stateKey, text]);
  const label = applyButtonLabel(state, t, commonT("common.retry"));
  const status = applyStatusLabel(state, t);
  const disabled =
    state.kind === "preparing" || state.kind === "queued" || state.kind === "outcome-unknown";
  const failed =
    state.kind === "conflict" || state.kind === "rejected" || state.kind === "outcome-unknown";
  return (
    <div className="sm-code-copy-wrap">
      <button
        type="button"
        className="sm-code-copy"
        aria-label={label}
        title={label}
        disabled={disabled}
        data-apply-state={state.kind}
        data-failed={failed ? "true" : "false"}
        onClick={handleApply}
      >
        <Icons.editor size={13} aria-hidden="true" />
        <span>{label}</span>
      </button>
      <span role="status" className="sm-code-copy-status">
        {status}
      </span>
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

function HighlightedCodeBlock({
  text,
  language,
  codeClass,
  long,
}: {
  readonly text: string;
  readonly language: string | undefined;
  readonly codeClass: string | undefined;
  readonly long: boolean;
}): ReactNode {
  // GEN-PERF-CHAT-010 — highlightLines tokenises the whole code block; keying the memo on the
  // immutable [text, language] source keeps it a once-per-block cost instead of re-running on every
  // parent re-render (mirrors FilePreview.tsx which already memoizes highlightLines).
  const lines = useMemo(
    () => highlightLines(text, codeLangFromMarkdown(language)),
    [text, language],
  );
  const lineCountWidth = Math.max(2, String(lines.length).length);
  return (
    <pre
      className="sm-pre"
      data-long={long ? "true" : "false"}
      role="region"
      aria-label={`${language ?? "text"} code block`}
      // Scrollable code pane: tabIndex makes the overflow region keyboard-scrollable.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      style={{ "--sm-code-line-no-width": `${String(lineCountWidth)}ch` } as CSSProperties}
    >
      <code className={codeClass}>
        {lines.map((tokens, lineIndex) => (
          <span key={lineIndex} className="sm-code-line">
            <span className="sm-code-line-no" aria-hidden="true">
              {lineIndex + 1}
            </span>
            <span className="sm-code-line-src">{tokenSpans(tokens, lineIndex)}</span>
          </span>
        ))}
      </code>
    </pre>
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

function renderChildren(
  node: SafeMarkdownNode,
  key: string,
  options: RenderOptions,
): ReactNode[] | null {
  if (node.children === undefined) return null;
  return node.children.map((child, idx) => renderNode(child, key + "-" + String(idx), options));
}

function renderBlockNode(
  node: SafeMarkdownNode,
  key: string,
  options: RenderOptions,
): ReactNode | null {
  switch (node.kind) {
    case "paragraph":
      return (
        <p key={key} className="sm-p">
          {renderChildren(node, key, options)}
        </p>
      );

    case "heading": {
      const level = node.level ?? 1;
      const Tag = HEADING_TAGS[level];
      const cls = HEADING_CLASSES[level];
      return (
        <Tag key={key} className={cls}>
          {renderChildren(node, key, options)}
        </Tag>
      );
    }

    case "blockquote":
      return (
        <blockquote key={key} className="sm-blockquote">
          {renderChildren(node, key, options)}
        </blockquote>
      );

    case "hr":
      return <hr key={key} className="sm-hr" />;

    case "code-block": {
      const lang = node.language;
      const codeText = node.text ?? "";
      const codeClass = lang !== undefined ? `lang-${lang}` : undefined;
      const lineCount = codeText.length === 0 ? 1 : codeText.split(/\r\n|\r|\n/u).length;
      const long = lineCount > 24;
      return (
        <div key={key} className="sm-code-block-frame" data-long={long ? "true" : "false"}>
          <div className="sm-code-block-header">
            {/* "untitled" read like a missing file name; untagged fences are plain text (C307) */}
            <span className="sm-code-lang">{lang ?? "text"}</span>
            <div className="sm-code-copy-wrap">
              {options.onApplyCodeBlock === undefined ? null : (
                <ApplyCodeBlockButton
                  text={codeText}
                  language={lang}
                  onApply={options.onApplyCodeBlock}
                  stateKey={
                    options.applyScopeId === undefined
                      ? undefined
                      : `${options.applyScopeId}:${key}`
                  }
                />
              )}
              <CopyButton text={codeText} />
            </div>
          </div>
          <HighlightedCodeBlock text={codeText} language={lang} codeClass={codeClass} long={long} />
        </div>
      );
    }

    default:
      return null;
  }
}

function renderListNode(
  node: SafeMarkdownNode,
  key: string,
  options: RenderOptions,
): ReactNode | null {
  switch (node.kind) {
    case "ul":
      return (
        <ul key={key} className="sm-ul">
          {renderChildren(node, key, options)}
        </ul>
      );

    case "ol":
      return (
        <ol key={key} className="sm-ol">
          {renderChildren(node, key, options)}
        </ol>
      );

    case "li":
      return (
        <li key={key} className="sm-li">
          {renderChildren(node, key, options)}
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
): ReactNode | null {
  const alignStyle = node.align !== undefined ? { textAlign: node.align } : undefined;

  switch (node.kind) {
    case "table":
      return (
        <div key={key} className="sm-table-wrapper">
          <table className="sm-table">{renderChildren(node, key, options)}</table>
        </div>
      );

    case "thead":
      return <thead key={key}>{renderChildren(node, key, options)}</thead>;

    case "tbody":
      return <tbody key={key}>{renderChildren(node, key, options)}</tbody>;

    case "tr":
      return <tr key={key}>{renderChildren(node, key, options)}</tr>;

    case "th":
      return (
        <th key={key} style={alignStyle}>
          {renderChildren(node, key, options)}
        </th>
      );

    case "td":
      return (
        <td key={key} style={alignStyle}>
          {renderChildren(node, key, options)}
        </td>
      );

    default:
      return null;
  }
}

const INLINE_CITATION_MARKER_PATTERN = /(\[\d+\]|【\d+】|［\d+］)/gu;
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
      data-tip={
        blocked
          ? BLOCKED_CITATION_MESSAGE
          : affordance.state === "recoverable"
            ? "Open PDF recovery"
            : "Open PDF preview"
      }
      onClick={() => {
        if (blocked || opening) return;
        void preview.openCitation(affordance.citation, "inline-marker");
      }}
    >
      {marker}
    </button>
  );
}

function renderCitationText(
  text: string,
  key: string,
  citationPreview: CitationPreviewController | undefined,
): ReactNode {
  if (citationPreview === undefined) {
    return <span key={key}>{text}</span>;
  }
  INLINE_CITATION_MARKER_PATTERN.lastIndex = 0;
  const fragments: ReactNode[] = [];
  let cursor = 0;
  let match = INLINE_CITATION_MARKER_PATTERN.exec(text);
  while (match !== null) {
    const marker = match[0];
    const index = match.index;
    if (index > cursor) {
      fragments.push(
        <span key={`${key}-text-${String(cursor)}`}>{text.slice(cursor, index)}</span>,
      );
    }
    fragments.push(
      <InlineCitationMarker
        key={`${key}-marker-${String(index)}`}
        marker={marker}
        preview={citationPreview}
      />,
    );
    cursor = index + marker.length;
    match = INLINE_CITATION_MARKER_PATTERN.exec(text);
  }
  if (cursor < text.length) {
    fragments.push(<span key={`${key}-tail`}>{text.slice(cursor)}</span>);
  }
  return <span key={key}>{fragments.length === 0 ? text : fragments}</span>;
}

function renderRepositoryText(text: string, key: string, options: RenderOptions): ReactNode {
  const sanitizedText = sanitizeRepositoryEvidenceText(text);
  if (options.openRepositoryReference === undefined) {
    return renderCitationText(sanitizedText, key, options.citationPreview);
  }
  const parts = repositoryReferenceTextParts(sanitizedText);
  if (parts.length === 1 && parts[0]?.kind === "text")
    return renderCitationText(sanitizedText, key, options.citationPreview);
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
          />
        );
      })}
    </span>
  );
}

function renderInlineCode(node: SafeMarkdownNode, key: string, options: RenderOptions): ReactNode {
  const text = node.text ?? "";
  const reference =
    options.openRepositoryReference === undefined ? null : parseExactRepositoryReference(text);
  return (
    <code key={key} className="sm-inline-code">
      {reference === null ? (
        text
      ) : (
        <RepositoryReferenceInline
          reference={reference}
          roots={options.repositoryRoots}
          openReference={options.openRepositoryReference}
          className="repo-ref-link repo-ref-link-inline-code"
        />
      )}
    </code>
  );
}

function renderInlineNode(
  node: SafeMarkdownNode,
  key: string,
  options: RenderOptions,
): ReactNode | null {
  switch (node.kind) {
    case "text":
      return renderRepositoryText(node.text ?? "", key, options);

    case "inline-code":
      return renderInlineCode(node, key, options);

    case "link":
      return (
        <a key={key} href={node.href} className="sm-link" rel="noopener noreferrer" target="_blank">
          {node.text}
          {/* target="_blank" is invisible to screen readers — announce the context
              switch in the accessible name without changing the visual layout (C316). */}
          <span className="sr-only"> (opens in new tab)</span>
        </a>
      );

    case "strong":
      return <strong key={key}>{renderChildren(node, key, options)}</strong>;

    case "em":
      return <em key={key}>{renderChildren(node, key, options)}</em>;

    default:
      return null;
  }
}

function renderNode(node: SafeMarkdownNode, key: string, options: RenderOptions): ReactNode {
  const block = renderBlockNode(node, key, options);
  if (block !== null) return block;

  const list = renderListNode(node, key, options);
  if (list !== null) return list;

  const table = renderTableNode(node, key, options);
  if (table !== null) return table;

  const inline = renderInlineNode(node, key, options);
  if (inline !== null) return inline;

  // Exhaustiveness guard — TypeScript narrows node.kind to never here if all
  // cases above are handled. If a new kind is added to SafeMarkdownNode without
  // a handler, this branch renders nothing rather than crashing.
  return null;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

// GEN-PERF-CHAT-010 — a module-level frozen empty array so the `repositoryRoots = []` default does
// not mint a fresh identity per render (which would defeat the options useMemo and the React.memo
// prop compare below).
const EMPTY_ROOTS: readonly RepositoryReferenceRoot[] = Object.freeze([]);

function SafeMarkdownImpl({
  source,
  applyScopeId,
  repositoryRoots = EMPTY_ROOTS,
  openRepositoryReference,
  citationPreview,
  onApplyCodeBlock,
}: SafeMarkdownProps): ReactNode {
  const tree = useMemo(() => parseSafeMarkdown(source), [source]);
  const options = useMemo<RenderOptions>(
    () => ({
      applyScopeId,
      citationPreview,
      repositoryRoots,
      openRepositoryReference,
      onApplyCodeBlock,
    }),
    [applyScopeId, citationPreview, onApplyCodeBlock, openRepositoryReference, repositoryRoots],
  );
  return (
    <div className="sm-root">{tree.map((node, i) => renderNode(node, String(i), options))}</div>
  );
}

// GEN-PERF-CHAT-010 — memoized so a settled assistant bubble does not re-parse/re-highlight its
// Markdown when an unrelated parent (draft/streaming) re-renders. Keying is a shallow prop compare;
// `source` is immutable per message and repositoryRoots/openRepositoryReference/citationPreview/
// onApplyCodeBlock are caller-memoized, so the compare is cheap and the security invariants
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
  readonly source: string;
  readonly applyScopeId?: string | undefined;
  readonly repositoryRoots?: readonly RepositoryReferenceRoot[] | undefined;
  readonly openRepositoryReference?: OpenRepositoryReference | undefined;
  readonly citationPreview?: CitationPreviewController | undefined;
  readonly onApplyCodeBlock?: AssistantCodeBlockApply | undefined;
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
        </div>
      );
    }
    return (
      <SafeMarkdown
        source={this.props.source}
        applyScopeId={this.props.applyScopeId}
        repositoryRoots={this.props.repositoryRoots}
        openRepositoryReference={this.props.openRepositoryReference}
        citationPreview={this.props.citationPreview}
        onApplyCodeBlock={this.props.onApplyCodeBlock}
      />
    );
  }
}
