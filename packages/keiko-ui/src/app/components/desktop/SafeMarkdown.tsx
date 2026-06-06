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

import { Component, useCallback, useState, type ReactNode } from "react";
import { parseSafeMarkdown, type SafeMarkdownNode } from "@/lib/safe-markdown";

export interface SafeMarkdownProps {
  readonly source: string;
}

// ---------------------------------------------------------------------------
// Copy button for code blocks
// ---------------------------------------------------------------------------

function CopyButton({ text }: { readonly text: string }): ReactNode {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    // navigator.clipboard is undefined in non-secure contexts (and unimplemented in jsdom).
    // Guard with optional chaining + an explicit existence check so a click in those contexts
    // becomes a no-op rather than a TypeError.
    if (typeof navigator === "undefined" || navigator.clipboard?.writeText === undefined) {
      return;
    }
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 1500);
      },
      () => {
        /* ignore clipboard errors */
      },
    );
  }, [text]);

  return (
    <button
      type="button"
      className="sm-code-copy"
      aria-label="Copy code block"
      title={copied ? "Copied!" : "Copy code block"}
      onClick={handleCopy}
    >
      {copied ? "✓" : "Copy"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Heading tag map — avoids template-literal restrict-template-expressions
// ---------------------------------------------------------------------------

const HEADING_TAGS = {
  1: "h1",
  2: "h2",
  3: "h3",
  4: "h4",
  5: "h5",
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

function renderChildren(node: SafeMarkdownNode, key: string): ReactNode[] | null {
  if (node.children === undefined) return null;
  return node.children.map((child, idx) => renderNode(child, key + "-" + String(idx)));
}

function renderBlockNode(node: SafeMarkdownNode, key: string): ReactNode | null {
  switch (node.kind) {
    case "paragraph":
      return (
        <p key={key} className="sm-p">
          {renderChildren(node, key)}
        </p>
      );

    case "heading": {
      const level = node.level ?? 1;
      const Tag = HEADING_TAGS[level];
      const cls = HEADING_CLASSES[level];
      return (
        <Tag key={key} className={cls}>
          {renderChildren(node, key)}
        </Tag>
      );
    }

    case "blockquote":
      return (
        <blockquote key={key} className="sm-blockquote">
          {renderChildren(node, key)}
        </blockquote>
      );

    case "hr":
      return <hr key={key} className="sm-hr" />;

    case "code-block": {
      const lang = node.language;
      const codeText = node.text ?? "";
      const codeClass = lang !== undefined ? `lang-${lang}` : undefined;
      return (
        <div key={key} className="sm-code-block-frame">
          <div className="sm-code-block-header">
            <span className="sm-code-lang">{lang ?? "untitled"}</span>
            <CopyButton text={codeText} />
          </div>
          <pre className="sm-pre">
            <code className={codeClass}>{codeText}</code>
          </pre>
        </div>
      );
    }

    default:
      return null;
  }
}

function renderListNode(node: SafeMarkdownNode, key: string): ReactNode | null {
  switch (node.kind) {
    case "ul":
      return (
        <ul key={key} className="sm-ul">
          {renderChildren(node, key)}
        </ul>
      );

    case "ol":
      return (
        <ol key={key} className="sm-ol">
          {renderChildren(node, key)}
        </ol>
      );

    case "li":
      return (
        <li key={key} className="sm-li">
          {renderChildren(node, key)}
        </li>
      );

    default:
      return null;
  }
}

function renderTableNode(node: SafeMarkdownNode, key: string): ReactNode | null {
  const alignStyle = node.align !== undefined ? { textAlign: node.align } : undefined;

  switch (node.kind) {
    case "table":
      return (
        <div key={key} className="sm-table-wrapper">
          <table className="sm-table">{renderChildren(node, key)}</table>
        </div>
      );

    case "thead":
      return <thead key={key}>{renderChildren(node, key)}</thead>;

    case "tbody":
      return <tbody key={key}>{renderChildren(node, key)}</tbody>;

    case "tr":
      return <tr key={key}>{renderChildren(node, key)}</tr>;

    case "th":
      return (
        <th key={key} style={alignStyle}>
          {renderChildren(node, key)}
        </th>
      );

    case "td":
      return (
        <td key={key} style={alignStyle}>
          {renderChildren(node, key)}
        </td>
      );

    default:
      return null;
  }
}

function renderInlineNode(node: SafeMarkdownNode, key: string): ReactNode | null {
  switch (node.kind) {
    case "text":
      return <span key={key}>{node.text}</span>;

    case "inline-code":
      return (
        <code key={key} className="sm-inline-code">
          {node.text}
        </code>
      );

    case "link":
      return (
        <a key={key} href={node.href} className="sm-link" rel="noopener noreferrer" target="_blank">
          {node.text}
        </a>
      );

    case "strong":
      return <strong key={key}>{renderChildren(node, key)}</strong>;

    case "em":
      return <em key={key}>{renderChildren(node, key)}</em>;

    default:
      return null;
  }
}

function renderNode(node: SafeMarkdownNode, key: string): ReactNode {
  const block = renderBlockNode(node, key);
  if (block !== null) return block;

  const list = renderListNode(node, key);
  if (list !== null) return list;

  const table = renderTableNode(node, key);
  if (table !== null) return table;

  const inline = renderInlineNode(node, key);
  if (inline !== null) return inline;

  // Exhaustiveness guard — TypeScript narrows node.kind to never here if all
  // cases above are handled. If a new kind is added to SafeMarkdownNode without
  // a handler, this branch renders nothing rather than crashing.
  return null;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function SafeMarkdown({ source }: SafeMarkdownProps): ReactNode {
  const tree = parseSafeMarkdown(source);
  return <div className="sm-root">{tree.map((node, i) => renderNode(node, String(i)))}</div>;
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
    return <SafeMarkdown source={this.props.source} />;
  }
}
