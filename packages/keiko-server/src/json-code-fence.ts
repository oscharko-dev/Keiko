const CODE_FENCE = "```";
const JSON_FENCE_TAG = /^json/iu;

// Strips a wrapping ```/```json markdown code fence from a (trusted-boundary, model-provided)
// response, via plain string ops instead of the previous
// `/^```(?:json)?\s*([\s\S]*?)\s*```$/iu` (S8786). That pattern's lazy `([\s\S]*?)` sits directly
// between two greedy `\s*` runs whose character class is a strict subset of `[\s\S]` — an
// adjacent-overlapping-quantifier shape — so a fenced-looking string with no real closing fence
// forces the engine to explore every way of splitting the whitespace between the three
// quantifiers before concluding failure: empirically over a second at ~2,000 characters, seconds
// climbing fast beyond that. Because both anchors (`^`/`$`) pin the fence to the very start/end
// of the string, "strip the first 3 and last 3 characters, then trim" is exactly equivalent to
// what the regex matched, in a single linear pass.
export function stripJsonCodeFence(raw: string): string {
  if (
    raw.length < CODE_FENCE.length * 2 ||
    !raw.startsWith(CODE_FENCE) ||
    !raw.endsWith(CODE_FENCE)
  ) {
    return raw;
  }
  let body = raw.slice(CODE_FENCE.length, raw.length - CODE_FENCE.length);
  if (JSON_FENCE_TAG.test(body)) {
    body = body.slice(4);
  }
  return body.trim();
}
