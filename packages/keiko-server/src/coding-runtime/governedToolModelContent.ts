/**
 * The model-facing rendering of a governed tool result (#3873), owned in one place: the generated
 * tool shim's source, the body-free facts the tool facade logs for every rendered result, and the
 * decoder the real-binary proofs and the customer-shape twin read the rendering back with.
 *
 * The tool facade answers in JSON, and JSON escapes every quote, backslash and control character of
 * the file content a read returns. In the live Gemma qualification the model copied those escapes
 * into its patches: context lines carrying `\"` no longer matched the file (INVALID_EDITS), and added
 * lines wrote literal backslashes into it. The shim therefore moves every string that JSON would
 * escape verbatim into a text block after the JSON envelope, which names the block in the string's
 * place:
 *
 *     {"status":"completed","read":{"text":"<text 1 3fa94c0e12d7>",...}}
 *     <text 1 3fa94c0e12d7>
 *     ...file text, byte for byte...</text 1 3fa94c0e12d7>
 *
 * The tag carries a nonce drawn after the data exists and checked against every block, so neither
 * workspace text nor a fetched page can close a block early or forge a block of its own. A string
 * that itself contains `<text ` is always moved into a block, so every placeholder in the envelope
 * is one this rendering wrote. A block is exactly the text between its opening line and its closing
 * tag, so a missing final line break stays visible. A result without such a string reaches the model
 * as the facade's own JSON text, unchanged.
 */

import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

/** A result string the rendering moves into a text block: one JSON would escape, or a tag lookalike. */
export const MODEL_TEXT_BLOCK_STRING_PATTERN = String.raw`[\u0000-\u001f"\\]|<text `;

const GOVERNED_TOOL_RESULT_STATUSES = [
  "completed",
  "failed",
  "denied",
  "invalid",
  "cancelled",
  "timeout",
  "busy",
  "observed",
] as const;

const CODING_RUNTIME_TOOL_RESULT_RENDERED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.tool-result-rendered",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.governedToolModelContent.recordGovernedToolModelContent",
  fields: {
    framing: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["json", "blocks"],
    },
    textBlockCount: { type: "integer", dataClass: "count", required: true },
    resultStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: GOVERNED_TOOL_RESULT_STATUSES,
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-tool-result"],
  proofIds: ["coding-runtime.tool-result-rendered.emitted-line"],
  releaseImpact: "patch",
});

const MODEL_TEXT_BLOCK_STRING = new RegExp(MODEL_TEXT_BLOCK_STRING_PATTERN, "u");
const BLOCK_OPENING = /^<text (\d+) ([0-9a-f]{12})>\n/u;

/** The dependency-free JavaScript the generated tool shim embeds; `crypto` is the shim's global. */
export const GOVERNED_TOOL_MODEL_CONTENT_SOURCE: readonly string[] = [
  `const MODEL_TEXT_BLOCK_STRING = new RegExp(${JSON.stringify(MODEL_TEXT_BLOCK_STRING_PATTERN)}, "u");`,
  "function modelTextBlock(value) {",
  '  return typeof value === "string" && MODEL_TEXT_BLOCK_STRING.test(value);',
  "}",
  "function modelContentNonce() {",
  '  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, "0")).join("");',
  "}",
  "function modelContent(result, text) {",
  "  const blocks = [];",
  "  JSON.stringify(result, (_key, value) => {",
  "    if (modelTextBlock(value)) blocks.push(value);",
  "    return value;",
  "  });",
  "  if (blocks.length === 0) return text;",
  "  let nonce = modelContentNonce();",
  "  while (blocks.some((block) => block.includes(nonce))) nonce = modelContentNonce();",
  '  const tag = (index) => index + " " + nonce + ">";',
  "  let next = 0;",
  '  const envelope = JSON.stringify(result, (_key, value) => (modelTextBlock(value) ? "<text " + tag(++next) : value));',
  String.raw`  const rendered = blocks.map((block, index) => "<text " + tag(index + 1) + "\n" + block + "</text " + tag(index + 1));`,
  String.raw`  return [envelope, ...rendered].join("\n");`,
  "}",
];

export type GovernedToolModelFraming = "json" | "blocks";

export interface GovernedToolModelContentFacts {
  readonly framing: GovernedToolModelFraming;
  readonly textBlockCount: number;
}

/** The body-free facts of how the shim renders `result`: the same predicate, the same traversal. */
export function governedToolModelContentFacts(result: unknown): GovernedToolModelContentFacts {
  let textBlockCount = 0;
  JSON.stringify(result, (_key: string, value: unknown): unknown => {
    if (typeof value === "string" && MODEL_TEXT_BLOCK_STRING.test(value)) textBlockCount += 1;
    return value;
  });
  return { framing: textBlockCount === 0 ? "json" : "blocks", textBlockCount };
}

/**
 * Records, body-free, how the shim renders one governed tool result for the model, under the run's
 * correlation: a run whose edits fail after a read can then be told apart in the log from one whose
 * model received a block rendering, and how many blocks it held.
 */
export function recordGovernedToolModelContent(
  sink: ServerLogSink,
  correlationId: string,
  result: unknown,
): void {
  const status =
    typeof result === "object" && result !== null && "status" in result ? result.status : undefined;
  const resultStatus = GOVERNED_TOOL_RESULT_STATUSES.find((candidate) => candidate === status);
  if (resultStatus === undefined) return;
  const facts = governedToolModelContentFacts(result);
  sink.write(
    activityLogEvent(
      CODING_RUNTIME_TOOL_RESULT_RENDERED_OPERATION,
      { correlationId },
      { framing: facts.framing, textBlockCount: facts.textBlockCount, resultStatus },
    ),
  );
}

/**
 * Reads a rendering back into the result it was made from. Throws a SyntaxError for content that is
 * not a well-formed rendering: a malformed block, a block under a second nonce, or text outside the
 * frames.
 */
export function decodeGovernedToolModelContent(content: string): unknown {
  const newline = content.indexOf("\n");
  if (newline === -1) return JSON.parse(content);
  const blocks = governedToolModelContentBlocks(content.slice(newline + 1));
  return JSON.parse(content.slice(0, newline), (_key: string, value: unknown): unknown =>
    typeof value === "string" && blocks.has(value) ? blocks.get(value) : value,
  );
}

function governedToolModelContentBlocks(framed: string): ReadonlyMap<string, string> {
  const blocks = new Map<string, string>();
  let nonce: string | undefined;
  let rest = framed;
  while (rest.length > 0) {
    const block = readTextBlock(rest, nonce);
    nonce = block.nonce;
    blocks.set(block.placeholder, block.text);
    rest = block.rest;
  }
  return blocks;
}

interface TextBlock {
  readonly placeholder: string;
  readonly nonce: string;
  readonly text: string;
  readonly rest: string;
}

/** Reads the block at the start of `framed`; every block of one rendering shares one nonce. */
function readTextBlock(framed: string, expectedNonce: string | undefined): TextBlock {
  const opening = blockOpening(framed, expectedNonce);
  const closing = `</text ${opening.index} ${opening.nonce}>`;
  const end = framed.indexOf(closing, opening.length);
  if (end === -1) throw new SyntaxError("Governed tool content has an unterminated text block.");
  const after = framed.slice(end + closing.length);
  if (after.length > 0 && !after.startsWith("\n"))
    throw new SyntaxError("Governed tool content has text outside a block.");
  return {
    placeholder: `<text ${opening.index} ${opening.nonce}>`,
    nonce: opening.nonce,
    text: framed.slice(opening.length, end),
    rest: after.slice(1),
  };
}

function blockOpening(
  framed: string,
  expectedNonce: string | undefined,
): { readonly index: string; readonly nonce: string; readonly length: number } {
  const opening = BLOCK_OPENING.exec(framed);
  const index = opening?.[1];
  const nonce = opening?.[2];
  if (opening === null || index === undefined || nonce === undefined)
    throw new SyntaxError("Governed tool content has a malformed text block.");
  if (expectedNonce !== undefined && expectedNonce !== nonce)
    throw new SyntaxError("Governed tool content mixes text block nonces.");
  return { index, nonce, length: opening[0].length };
}
