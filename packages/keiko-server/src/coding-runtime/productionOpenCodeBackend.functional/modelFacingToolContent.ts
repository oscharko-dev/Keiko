// #3873: the generated tool shim moves every string carrying a quote, backslash or line break into a
// numbered `<text N>` block after the JSON envelope, so the model reads file text verbatim. The
// real-binary proofs resolve those blocks back into the envelope to inspect the result the model
// consumed. A block is exactly the text between its opening line and its closing tag.
export function decodeModelFacingToolContent(content: string): unknown {
  const newline = content.indexOf("\n");
  const envelope = newline === -1 ? content : content.slice(0, newline);
  const blocks = new Map<string, string>();
  for (const match of content
    .slice(envelope.length)
    .matchAll(/\n<text (\d+)>\n([\s\S]*?)<\/text \1>/gu)) {
    blocks.set(`<text ${match[1] ?? ""}>`, match[2] ?? "");
  }
  return JSON.parse(envelope, (_key: string, value: unknown): unknown =>
    typeof value === "string" ? (blocks.get(value) ?? value) : value,
  );
}
