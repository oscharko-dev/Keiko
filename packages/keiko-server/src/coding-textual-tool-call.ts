import type {
  ChatMessage,
  NormalizedResponse,
} from "@oscharko-dev/keiko-contracts/runtime/gateway";

/**
 * Recovery of a model turn that wrote a tool call as TEXT instead of calling the tool natively
 * (live defect M-1: Gemma 4 31B ended its turn with `<shell command="npm test" />` markup and no
 * native `tool_calls`; the runtime read that as the end of the turn, the requested commit never
 * happened and the user saw raw markup as the answer). The class is common across local models
 * (`<tool_call>{...}</tool_call>`, `<function=name>`, a fenced JSON call, an XML element named after
 * the tool).
 *
 * The coding sidecar gateway owns the recovery because it alone sees the request's tool catalog and
 * both delivery paths (buffered and live). It never parses the text into a tool execution: model text
 * is hostile input. The only effect of a detection is one more model request carrying a fixed hint
 * that asks for the native tool-calling interface, and the markup answer is never handed to the
 * runtime when that request succeeds. A detection is conservative on purpose: a false negative
 * leaves today's behaviour (the response passes through), a false positive costs one extra request.
 */

/**
 * How many further model requests one runtime request may trigger. A retry bound that protects the
 * run from a model that keeps writing markup, never a bound on healthy work: when it is spent the
 * response passes through exactly as it did before the recovery existed.
 */
export const TEXTUAL_TOOL_CALL_MAX_RETRIES = 2;

/** The fixed, body-free correction the retried request carries (it never quotes the markup). */
export const TEXTUAL_TOOL_CALL_RETRY_HINT =
  "Your previous answer wrote a tool call as plain text instead of calling the tool. Do not write tool calls as text or markup: call the tool now through the native tool-calling interface, or give the final answer in plain prose.";

/** How the markup was shaped; closed vocabulary for the evidence line, never the markup itself. */
export type TextualToolCallForm =
  "named-element" | "wrapper-element" | "function-tag" | "json-call";

/** The closed outcome a turn that needed the recovery records. */
export type TextualToolCallRecoveryOutcome = "retried-native" | "retry-exhausted";

// The detector reads at most this much of an answer: a longer one is a document, not a tool call.
const MAX_ANALYZED_CHARS = 32_768;
// The markup must make up at least this share of the answer; prose that merely mentions a tag is
// never a tool call.
const MIN_MARKUP_SHARE = 0.6;
// A tag's opening angle bracket to its closing one; longer is not a tool-call tag.
const MAX_TAG_CHARS = 4_096;
// What a held live answer may buffer before it is released unexamined.
export const TEXTUAL_TOOL_CALL_HOLD_LIMIT_CHARS = MAX_ANALYZED_CHARS;

const WRAPPER_TAGS = [
  "tool_call",
  "tool_calls",
  "function_call",
  "function_calls",
  "tool_use",
  "tool_code",
  "invoke",
] as const;
const NAME_KEYS = ["name", "tool", "tool_name", "function", "function_name"] as const;
const ARGUMENT_KEYS = ["arguments", "parameters", "input", "args", "params"] as const;

interface Span {
  readonly start: number;
  readonly end: number;
  readonly form: TextualToolCallForm;
}

/** The tool names a request advertises, lower-cased; the only names a detection may rest on. */
export function toolNameSet(names: readonly string[]): ReadonlySet<string> {
  return new Set(names.map((name) => name.toLowerCase()).filter((name) => name.length > 0));
}

function isTagBoundary(char: string | undefined): boolean {
  return char === ">" || char === "/" || char === " " || char === "\n" || char === "\t";
}

// The index just past the `>` that ends the tag opened at `from`, quote-aware so an attribute value
// such as `command="a > b"` does not end it early; -1 when the tag does not close within bounds.
function tagEnd(text: string, from: number): number {
  let quote: string | undefined;
  const limit = Math.min(text.length, from + MAX_TAG_CHARS);
  for (let index = from + 1; index < limit; index += 1) {
    const char = text.charAt(index);
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index + 1;
    }
  }
  return -1;
}

function openingTagIndexes(lower: string, tag: string): readonly number[] {
  const needle = `<${tag}`;
  const found: number[] = [];
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
    if (isTagBoundary(lower.charAt(at + needle.length))) found.push(at);
  }
  return found;
}

// A tag's span: a self-closing or unclosed opening tag, or everything up to the last closing tag.
function elementSpan(
  text: string,
  lower: string,
  start: number,
  tag: string,
  form: TextualToolCallForm,
): Span | undefined {
  const opened = tagEnd(text, start);
  if (opened === -1) return undefined;
  if (lower.slice(start, opened).endsWith("/>")) return { start, end: opened, form };
  const closing = `</${tag}>`;
  const closeAt = lower.lastIndexOf(closing);
  return { start, end: closeAt >= opened ? closeAt + closing.length : opened, form };
}

function namedElementSpans(text: string, lower: string, names: ReadonlySet<string>): Span[] {
  const spans: Span[] = [];
  for (const name of names) {
    for (const start of openingTagIndexes(lower, name)) {
      const span = elementSpan(text, lower, start, name, "named-element");
      if (span !== undefined) spans.push(span);
    }
  }
  return spans;
}

function functionTagSpans(text: string, lower: string, names: ReadonlySet<string>): Span[] {
  const spans: Span[] = [];
  for (const name of names) {
    const needle = `<function=${name}`;
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
      if (!isTagBoundary(lower.charAt(at + needle.length))) continue;
      const span = elementSpan(text, lower, at, "function", "function-tag");
      if (span !== undefined) spans.push(span);
    }
  }
  return spans;
}

// A wrapper element counts only when what it wraps names an advertised tool the way a call does:
// a quoted name beside an arguments key, a `name="tool"` attribute or a `<function=tool` tag.
function wrapsKnownCall(innerLower: string, names: ReadonlySet<string>): boolean {
  const hasArguments = ARGUMENT_KEYS.some((key) => innerLower.includes(`"${key}"`));
  for (const name of names) {
    if (innerLower.includes(`name="${name}"`) || innerLower.includes(`<function=${name}`)) {
      return true;
    }
    if (hasArguments && innerLower.includes(`"${name}"`)) return true;
  }
  return false;
}

function wrapperSpans(text: string, lower: string, names: ReadonlySet<string>): Span[] {
  const spans: Span[] = [];
  for (const tag of WRAPPER_TAGS) {
    const [first] = openingTagIndexes(lower, tag);
    if (first === undefined) continue;
    const span = elementSpan(text, lower, first, tag, "wrapper-element");
    if (span !== undefined && wrapsKnownCall(lower.slice(span.start, span.end), names)) {
      spans.push(span);
    }
  }
  return spans;
}

function skipSpaces(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/u.test(text.charAt(index))) index += 1;
  return index;
}

// The quoted string value that follows a JSON key at `from` (`: "value"`), or undefined.
function quotedValueAfterKey(text: string, from: number): string | undefined {
  const colon = skipSpaces(text, from);
  if (text.charAt(colon) !== ":") return undefined;
  const open = skipSpaces(text, colon + 1);
  if (text.charAt(open) !== '"') return undefined;
  const close = text.indexOf('"', open + 1);
  return close === -1 ? undefined : text.slice(open + 1, close);
}

function namesAdvertisedTool(lower: string, names: ReadonlySet<string>): boolean {
  for (const key of NAME_KEYS) {
    const needle = `"${key}"`;
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
      const value = quotedValueAfterKey(lower, at + needle.length);
      if (value !== undefined && names.has(value)) return true;
    }
  }
  return false;
}

// A JSON object (or array) that names an advertised tool beside an arguments key. Read by scanning,
// never by parsing: the text is hostile and a parse would add nothing the scan does not decide.
function looksLikeJsonCall(body: string, names: ReadonlySet<string>): boolean {
  const lower = body.trim().toLowerCase();
  const bracketed =
    (lower.startsWith("{") && lower.endsWith("}")) ||
    (lower.startsWith("[") && lower.endsWith("]"));
  if (!bracketed) return false;
  return (
    ARGUMENT_KEYS.some((key) => lower.includes(`"${key}"`)) && namesAdvertisedTool(lower, names)
  );
}

function fencedBlocks(text: string): readonly { start: number; end: number; body: string }[] {
  const blocks: { start: number; end: number; body: string }[] = [];
  let open = text.indexOf("```");
  while (open !== -1) {
    const close = text.indexOf("```", open + 3);
    if (close === -1) break;
    const inner = text.slice(open + 3, close);
    const newline = inner.indexOf("\n");
    blocks.push({
      start: open,
      end: close + 3,
      body: newline === -1 ? inner : inner.slice(newline),
    });
    open = text.indexOf("```", close + 3);
  }
  return blocks;
}

function jsonCallSpans(text: string, names: ReadonlySet<string>): Span[] {
  const spans: Span[] = [];
  for (const block of fencedBlocks(text)) {
    if (looksLikeJsonCall(block.body, names)) {
      spans.push({ start: block.start, end: block.end, form: "json-call" });
    }
  }
  if (spans.length === 0 && looksLikeJsonCall(text, names)) {
    spans.push({ start: 0, end: text.length, form: "json-call" });
  }
  return spans;
}

function coveredChars(spans: readonly Span[]): number {
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  let covered = 0;
  let reach = 0;
  for (const span of ordered) {
    const from = Math.max(span.start, reach);
    if (span.end > from) covered += span.end - from;
    reach = Math.max(reach, span.end);
  }
  return covered;
}

/**
 * The form of the tool-call markup that dominates `content`, or undefined. Only a tool the request
 * advertised can make a detection: an XML element named after a tool, a wrapper element around a
 * call to one, a `<function=tool>` tag, or a JSON call (fenced or the whole answer). Prose, code
 * blocks and markup that name no advertised tool never match.
 */
export function detectTextualToolCall(
  content: string,
  toolNames: ReadonlySet<string>,
): TextualToolCallForm | undefined {
  const text = content.trim();
  if (toolNames.size === 0 || text.length === 0 || text.length > MAX_ANALYZED_CHARS) {
    return undefined;
  }
  const lower = text.toLowerCase();
  const spans = [
    ...namedElementSpans(text, lower, toolNames),
    ...functionTagSpans(text, lower, toolNames),
    ...wrapperSpans(text, lower, toolNames),
    ...jsonCallSpans(text, toolNames),
  ];
  const [first] = spans;
  if (first === undefined) return undefined;
  return coveredChars(spans) / text.length >= MIN_MARKUP_SHARE ? first.form : undefined;
}

/**
 * Whether a finished response is a turn that wrote its tool call as text: it ended normally (`stop`)
 * with no native tool call and its text is dominated by markup naming an advertised tool.
 */
export function textualToolCallForm(
  response: Pick<NormalizedResponse, "content" | "finishReason" | "toolCalls">,
  toolNames: ReadonlySet<string>,
): TextualToolCallForm | undefined {
  if (response.finishReason !== "stop" || response.toolCalls.length > 0) return undefined;
  return detectTextualToolCall(response.content, toolNames);
}

/** The request of the retry: the original plus the one fixed correction, never the markup. */
export function withTextualToolCallHint<T extends { readonly messages: readonly ChatMessage[] }>(
  request: T,
): T {
  return {
    ...request,
    messages: [...request.messages, { role: "system", content: TEXTUAL_TOOL_CALL_RETRY_HINT }],
  };
}

/** What a turn's retries discarded, folded into the answer's own discarded-attempt usage. */
export interface DiscardedAttempts {
  attemptCount: number;
  promptTokens: number;
  completionTokens: number;
}

export function foldDiscardedAttempt(
  tally: DiscardedAttempts,
  usage: NormalizedResponse["usage"],
): void {
  tally.attemptCount += 1;
  tally.promptTokens += usage.promptTokens;
  tally.completionTokens += usage.completionTokens;
}

/** The answer with the usage of the attempts the recovery discarded counted beside its own. */
export function withDiscardedAttempts(
  response: NormalizedResponse,
  tally: DiscardedAttempts,
): NormalizedResponse {
  if (tally.attemptCount === 0) return response;
  const earlier = response.discardedAttemptUsage;
  return {
    ...response,
    discardedAttemptUsage: {
      attemptCount: tally.attemptCount + (earlier?.attemptCount ?? 0),
      promptTokens: tally.promptTokens + (earlier?.promptTokens ?? 0),
      completionTokens: tally.completionTokens + (earlier?.completionTokens ?? 0),
    },
  };
}

/**
 * Holds back the part of a live answer that may turn out to be tool-call markup. Text that cannot
 * start markup streams through at once; from the first character that can start it (`<`, or a
 * line-leading code fence, `{` or `[`) the rest of the attempt is held until the attempt finishes, so
 * a retry can discard it before the runtime ever receives it. A hold that grows past its bound is
 * released unexamined. A hold that is switched off passes everything through.
 */
export class LiveTextHold {
  private held = "";
  private holding = false;
  private released = false;
  private atLineStart = true;

  constructor(private enabled: boolean) {}

  /** The text to forward now for one provider delta. */
  push(token: string): string {
    if (!this.enabled || this.released) return token;
    if (this.holding) return this.hold(token);
    const cut = this.firstMarkupStart(token);
    this.atLineStart = /\n\s*$/u.test(token) || (this.atLineStart && token.trim().length === 0);
    if (cut === -1) return token;
    this.holding = true;
    return token.slice(0, cut) + this.hold(token.slice(cut));
  }

  private hold(token: string): string {
    this.held += token;
    if (this.held.length <= TEXTUAL_TOOL_CALL_HOLD_LIMIT_CHARS) return "";
    return this.release();
  }

  private firstMarkupStart(token: string): number {
    let lineStart = this.atLineStart;
    for (let index = 0; index < token.length; index += 1) {
      const char = token.charAt(index);
      if (char === "<" || (lineStart && (char === "{" || char === "[" || char === "`"))) {
        return index;
      }
      if (char === "\n") lineStart = true;
      else if (char !== " " && char !== "\t") lineStart = false;
    }
    return -1;
  }

  get isHolding(): boolean {
    return this.holding;
  }

  /** Stops holding and returns what was held; every later delta passes through. */
  release(): string {
    const text = this.held;
    this.held = "";
    this.holding = false;
    this.released = true;
    return text;
  }

  /** Drops what was held and starts over for the next attempt; `enabled` says whether it holds. */
  restart(enabled: boolean): void {
    this.held = "";
    this.holding = false;
    this.released = false;
    this.atLineStart = true;
    this.enabled = enabled;
  }
}
