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
export type TextualToolCallRecoveryOutcome =
  "retried-native" | "retry-exhausted" | "retry-skipped" | "retry-interrupted";

// The detector reads at most this much of an answer: a longer one is a document, not a tool call.
const MAX_ANALYZED_CHARS = 32_768;
// The markup must be at least this share of the answer's non-whitespace characters: essentially the
// whole answer. Prose that merely shows or mentions a tag is never a tool call.
const MIN_MARKUP_SHARE = 0.85;
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

/** The advertised tools, lower-cased, each with its lower-cased parameter names. */
export type ToolIndex = ReadonlyMap<string, ReadonlySet<string>>;

/** The tools a request advertises: the only names a detection may rest on. */
export function toolIndex(
  tools: readonly {
    readonly name: string;
    readonly parameters?: Readonly<Record<string, unknown>> | undefined;
  }[],
): ToolIndex {
  const index = new Map<string, ReadonlySet<string>>();
  for (const tool of tools) {
    const properties = tool.parameters?.properties;
    const params =
      typeof properties === "object" && properties !== null ? Object.keys(properties) : [];
    if (tool.name.length > 0) {
      index.set(tool.name.toLowerCase(), new Set(params.map((param) => param.toLowerCase())));
    }
  }
  return index;
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

// A named element has a tool call's shape when its opening tag carries an attribute, or its body
// names one of the tool's parameters (or holds an element of the same name); a bare `<read>` or
// `<task>text</task>` is a word in a sentence or a prompt template, not a call.
function hasToolCallShape(
  lower: string,
  start: number,
  opened: number,
  tag: string,
  params: ReadonlySet<string>,
): boolean {
  const opening = lower.slice(start + tag.length + 1, opened);
  if (opening.includes("=")) return true;
  const closeAt = lower.lastIndexOf(`</${tag}>`);
  if (closeAt < opened) return false;
  const body = lower.slice(opened, closeAt);
  return (
    body.includes(`<${tag}`) ||
    [...params].some((param) => body.includes(`<${param}`) || body.includes(`"${param}"`))
  );
}

function namedElementSpans(text: string, lower: string, tools: ToolIndex): Span[] {
  const spans: Span[] = [];
  for (const [name, params] of tools) {
    for (const start of openingTagIndexes(lower, name)) {
      const opened = tagEnd(text, start);
      if (opened === -1 || !hasToolCallShape(lower, start, opened, name, params)) continue;
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

interface FencedBlock {
  readonly start: number;
  readonly end: number;
  readonly label: string;
  readonly body: string;
}

function fencedBlocks(text: string): readonly FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let open = text.indexOf("```");
  while (open !== -1) {
    const close = text.indexOf("```", open + 3);
    if (close === -1) break;
    const inner = text.slice(open + 3, close);
    const label = /^[A-Za-z_]*/u.exec(inner)?.[0] ?? "";
    blocks.push({
      start: open,
      end: close + 3,
      label: label.toLowerCase(),
      body: inner.slice(label.length),
    });
    open = text.indexOf("```", close + 3);
  }
  return blocks;
}

// Fences that may hold a tool call: unlabelled or labelled as a tool or XML marker, and only when
// the fence is the entire answer. Any other fence (`json`, `ts`, …) shows a sample, never a call.
const TOOL_FENCE_LABELS: ReadonlySet<string> = new Set([
  "",
  "tool",
  "tool_call",
  "tool_code",
  "xml",
]);

function soleToolFence(text: string, blocks: readonly FencedBlock[]): FencedBlock | undefined {
  const [only] = blocks;
  if (blocks.length !== 1 || only === undefined) return undefined;
  if (only.start !== 0 || only.end !== text.length) return undefined;
  return TOOL_FENCE_LABELS.has(only.label) ? only : undefined;
}

function jsonCallSpans(
  text: string,
  names: ReadonlySet<string>,
  blocks: readonly FencedBlock[],
): Span[] {
  const fence = soleToolFence(text, blocks);
  const whole = { start: 0, end: text.length, form: "json-call" } as const;
  if (fence !== undefined) return looksLikeJsonCall(fence.body, names) ? [whole] : [];
  return blocks.length === 0 && looksLikeJsonCall(text, names) ? [whole] : [];
}

function insideFence(span: Span, blocks: readonly FencedBlock[]): boolean {
  return blocks.some((block) => span.start >= block.start && span.end <= block.end);
}

// The share of the answer's non-whitespace characters that the spans cover.
function markupShare(text: string, spans: readonly Span[]): number {
  const covered = new Uint8Array(text.length);
  for (const span of spans) covered.fill(1, span.start, Math.min(span.end, text.length));
  let total = 0;
  let marked = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (/\s/u.test(text.charAt(index))) continue;
    total += 1;
    marked += covered[index] ?? 0;
  }
  return total === 0 ? 0 : marked / total;
}

/**
 * The form of the tool-call markup that makes up the answer, or undefined. Only a tool the request
 * advertised can make a detection: an XML element named after a tool that has a tool call's shape
 * (attributes, or a body naming one of the tool's parameters), a wrapper element around a call to
 * one, a `<function=tool>` tag, or a JSON call. The markup must be essentially the whole answer
 * (`MIN_MARKUP_SHARE`) and outside any code fence, except an unlabelled or tool/XML-labelled fence
 * that is the entire answer. Prose, an answer that shows markup as a sample, a prompt template and
 * markup naming no advertised tool never match.
 */
export function detectTextualToolCall(
  content: string,
  tools: ToolIndex,
): TextualToolCallForm | undefined {
  const text = content.trim();
  if (tools.size === 0 || text.length === 0 || text.length > MAX_ANALYZED_CHARS) return undefined;
  const lower = text.toLowerCase();
  const names: ReadonlySet<string> = new Set(tools.keys());
  const blocks = fencedBlocks(text);
  const sole = soleToolFence(text, blocks);
  const spans = [
    ...namedElementSpans(text, lower, tools),
    ...functionTagSpans(text, lower, names),
    ...wrapperSpans(text, lower, names),
  ].filter((span) => (sole === undefined ? !insideFence(span, blocks) : insideFence(span, [sole])));
  spans.push(...jsonCallSpans(text, names, blocks));
  const [first] = spans;
  if (first === undefined) return undefined;
  return markupShare(text, spans) >= MIN_MARKUP_SHARE ? first.form : undefined;
}

/**
 * Whether a finished response is a turn that wrote its tool call as text: it ended normally (`stop`)
 * with no native tool call and its text is essentially markup naming an advertised tool.
 */
export function textualToolCallForm(
  response: Pick<NormalizedResponse, "content" | "finishReason" | "toolCalls">,
  tools: ToolIndex,
): TextualToolCallForm | undefined {
  if (response.finishReason !== "stop" || response.toolCalls.length > 0) return undefined;
  return detectTextualToolCall(response.content, tools);
}

/**
 * The request of the retry: the original with the one fixed correction merged into its leading system
 * message (or added as one when it has none), never the markup. It is not appended as a late message
 * after the tool messages, which chat templates behind LiteLLM (Gemma) may reject or reorder.
 */
export function withTextualToolCallHint<T extends { readonly messages: readonly ChatMessage[] }>(
  request: T,
): T {
  const [first, ...rest] = request.messages;
  const messages: readonly ChatMessage[] =
    first?.role === "system"
      ? [{ ...first, content: `${first.content}\n\n${TEXTUAL_TOOL_CALL_RETRY_HINT}` }, ...rest]
      : [{ role: "system", content: TEXTUAL_TOOL_CALL_RETRY_HINT }, ...request.messages];
  return { ...request, messages };
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
  // A trailing `<` whose next character has not arrived: it starts a tag only if a letter or `/` follows.
  private carry = "";
  private holding = false;
  private released = false;
  private atLineStart = true;

  constructor(private enabled: boolean) {}

  /** The text to forward now for one provider delta. */
  push(token: string): string {
    if (!this.enabled || this.released) return token;
    if (this.holding) return this.hold(token);
    const text = this.carry + token;
    this.carry = "";
    const scan = scanMarkupStart(text, this.atLineStart);
    if (scan.cut !== -1) {
      this.holding = true;
      return text.slice(0, scan.cut) + this.hold(text.slice(scan.cut));
    }
    this.atLineStart = scan.lineStart;
    if (!text.endsWith("<")) return text;
    this.carry = "<";
    return text.slice(0, -1);
  }

  private hold(token: string): string {
    this.held += token;
    if (this.held.length <= TEXTUAL_TOOL_CALL_HOLD_LIMIT_CHARS) return "";
    return this.release();
  }

  get isHolding(): boolean {
    return this.holding;
  }

  /** Stops holding and returns what was held; every later delta passes through. */
  release(): string {
    const text = this.carry + this.held;
    this.held = "";
    this.carry = "";
    this.holding = false;
    this.released = true;
    return text;
  }

  /** Drops what was held and starts over for the next attempt; `enabled` says whether it holds. */
  restart(enabled: boolean): void {
    this.held = "";
    this.carry = "";
    this.holding = false;
    this.released = false;
    this.atLineStart = true;
    this.enabled = enabled;
  }
}

function isTagStart(next: string): boolean {
  return /^[A-Za-z/]$/u.test(next);
}

function startsMarkup(text: string, index: number, lineStart: boolean): boolean {
  const char = text.charAt(index);
  if (char === "<") return isTagStart(text.charAt(index + 1));
  return lineStart && (char === "{" || char === "[" || char === "`");
}

// Where in `text` markup may start (a `<` followed by a letter or `/`, or a line-leading code fence,
// `{` or `[`), and whether the text ends at the start of a line. A comparison or a generic such as
// `a < b` never starts markup.
function scanMarkupStart(
  text: string,
  atLineStart: boolean,
): { readonly cut: number; readonly lineStart: boolean } {
  let lineStart = atLineStart;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (startsMarkup(text, index, lineStart)) return { cut: index, lineStart };
    if (char === "\n") lineStart = true;
    else if (char !== " " && char !== "\t") lineStart = false;
  }
  return { cut: -1, lineStart };
}
