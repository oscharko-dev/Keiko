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

import { Component, useCallback, useState, type CSSProperties, type ReactNode } from "react";
import { parseSafeMarkdown, type SafeMarkdownNode } from "@/lib/safe-markdown";
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

export interface SafeMarkdownProps {
  readonly source: string;
  readonly repositoryRoots?: readonly RepositoryReferenceRoot[] | undefined;
  readonly openRepositoryReference?: OpenRepositoryReference | undefined;
}

interface RenderOptions {
  readonly repositoryRoots: readonly RepositoryReferenceRoot[];
  readonly openRepositoryReference: OpenRepositoryReference | undefined;
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
  const lines = highlightLines(text, codeLangFromMarkdown(language));
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
            <CopyButton text={codeText} />
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

function renderRepositoryText(text: string, key: string, options: RenderOptions): ReactNode {
  const sanitizedText = sanitizeRepositoryEvidenceText(text);
  if (options.openRepositoryReference === undefined || options.repositoryRoots.length === 0) {
    return <span key={key}>{sanitizedText}</span>;
  }
  const parts = repositoryReferenceTextParts(sanitizedText);
  if (parts.length === 1 && parts[0]?.kind === "text")
    return <span key={key}>{sanitizedText}</span>;
  return (
    <span key={key}>
      {parts.map((part, index) => {
        const partKey = `${key}-repo-${String(index)}`;
        if (part.kind === "text") return <span key={partKey}>{part.text}</span>;
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
    options.openRepositoryReference === undefined || options.repositoryRoots.length === 0
      ? null
      : parseExactRepositoryReference(text);
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

export function SafeMarkdown({
  source,
  repositoryRoots = [],
  openRepositoryReference,
}: SafeMarkdownProps): ReactNode {
  const tree = parseSafeMarkdown(source);
  const options: RenderOptions = { repositoryRoots, openRepositoryReference };
  return (
    <div className="sm-root">{tree.map((node, i) => renderNode(node, String(i), options))}</div>
  );
}

// ---------------------------------------------------------------------------
// SM-1: per-message error boundary. A parser/render defect in one assistant
// message must degrade THAT message to plain text rather than crashing the whole
// conversation view (which has no enclosing boundary). The fallback preserves the
// AST-only / no-dangerouslySetInnerHTML invariant — it renders the raw source as
// React-escaped text.
// ---------------------------------------------------------------------------

interface SafeMarkdownBoundaryProps {
  readonly source: string;
  readonly repositoryRoots?: readonly RepositoryReferenceRoot[] | undefined;
  readonly openRepositoryReference?: OpenRepositoryReference | undefined;
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
        repositoryRoots={this.props.repositoryRoots}
        openRepositoryReference={this.props.openRepositoryReference}
      />
    );
  }
}
