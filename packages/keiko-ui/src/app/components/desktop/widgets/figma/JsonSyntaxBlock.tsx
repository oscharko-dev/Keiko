"use client";

import { memo, useMemo, type ReactNode } from "react";

type JsonTokenKind = "key" | "string" | "number" | "boolean" | "null" | "punctuation";

interface JsonToken {
  readonly kind: JsonTokenKind;
  readonly text: string;
}

const JSON_TOKEN_RE =
  /"(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\])*"\s*:?|[-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}\[\],:]/gu;

function tokenKind(token: string): JsonTokenKind {
  if (token.startsWith('"')) return token.endsWith(":") ? "key" : "string";
  if (token === "true" || token === "false") return "boolean";
  if (token === "null") return "null";
  if (/^-?\d/u.test(token)) return "number";
  return "punctuation";
}

function tokenizeJson(text: string): readonly (JsonToken | string)[] {
  const parts: (JsonToken | string)[] = [];
  let cursor = 0;
  for (const match of text.matchAll(JSON_TOKEN_RE)) {
    const token = match[0];
    const index = match.index;
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push({ kind: tokenKind(token), text: token });
    cursor = index + token.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export function jsonTextByteLength(text: string): number {
  if (text.length === 0) return 0;
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).byteLength;
  return text.length;
}

// GEN-PERF-WIDGET-002 — above this size the per-token syntax highlighting explodes into
// 10^5–10^6 React spans in one synchronous commit (screen IR is bounded only by the
// server-side node cap). Fall back to a single un-tokenized text node; the full content
// is still shown and copy-to-clipboard (which operates on the raw string) is unaffected.
export const MAX_HIGHLIGHT_JSON_BYTES = 256_000;

export const JsonSyntaxBlock = memo(function JsonSyntaxBlock({
  text,
  className,
  ariaLabel,
}: {
  readonly text: string;
  readonly className: string;
  // GEN-UI-KEYBOARD-005 — the rendered <pre> is an overflow:auto scroll container that can
  // exceed its box. When an accessible name is threaded in, the block becomes a keyboard-
  // focusable region (WCAG 2.1.1) so keyboard-only users can scroll the JSON. Callers that
  // omit ariaLabel keep the plain, non-focusable <pre> (behaviour-preserving default).
  readonly ariaLabel?: string;
}): ReactNode {
  const highlightDisabled = useMemo(
    () => jsonTextByteLength(text) > MAX_HIGHLIGHT_JSON_BYTES,
    [text],
  );
  const tokens = useMemo(
    () => (highlightDisabled ? null : tokenizeJson(text)),
    [text, highlightDisabled],
  );
  // Only a named block is exposed as a focusable region; unnamed callers stay unchanged.
  const regionProps =
    ariaLabel !== undefined && ariaLabel.length > 0
      ? // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG 2.1.1 focusable scroll region
        ({ tabIndex: 0, role: "region", "aria-label": ariaLabel } as const)
      : {};
  if (highlightDisabled || tokens === null) {
    return (
      <pre className={className} data-highlight-disabled="true" {...regionProps}>
        <code>{text}</code>
      </pre>
    );
  }
  return (
    <pre className={className} {...regionProps}>
      <code>
        {tokens.map((part, index) =>
          typeof part === "string" ? (
            part
          ) : (
            <span key={`${part.kind}-${index.toString()}`} className={`json-token-${part.kind}`}>
              {part.text}
            </span>
          ),
        )}
      </code>
    </pre>
  );
});
