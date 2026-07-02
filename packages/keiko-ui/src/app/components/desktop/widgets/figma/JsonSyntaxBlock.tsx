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

export const JsonSyntaxBlock = memo(function JsonSyntaxBlock({
  text,
  className,
}: {
  readonly text: string;
  readonly className: string;
}): ReactNode {
  const tokens = useMemo(() => tokenizeJson(text), [text]);
  return (
    <pre className={className}>
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
