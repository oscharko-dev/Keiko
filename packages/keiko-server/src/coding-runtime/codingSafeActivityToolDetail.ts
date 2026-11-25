import {
  CODING_SAFE_ACTIVITY_MAX_TOOL_COMMAND_CHARS,
  CODING_SAFE_ACTIVITY_MAX_TOOL_ERROR_CHARS,
  CODING_SAFE_ACTIVITY_MAX_TOOL_OUTPUT_PART_CHARS,
  CODING_SAFE_ACTIVITY_TOOL_OUTPUT_HEAD_LINES,
  CODING_SAFE_ACTIVITY_TOOL_OUTPUT_TAIL_LINES,
  type CodingSafeActivityToolFailureOrigin,
  type CodingSafeActivityToolOutput,
  type CodingSafeActivityToolPresentation,
  type CodingSafeActivityToolState,
  type CodingSafeActivityToolText,
} from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/runtime/text-safety";
import { redactContent } from "@oscharko-dev/keiko-security";

// A failed tool row has to say what failed and who caused it: the command, the error the tool
// handed the model, the end of what the command printed, and a closed origin. That text is the
// person's own workspace output: it keeps only the credential floor (owner decision 2026-11-04),
// is rendered as text, and never reaches the Activity Log, Coding History or any evidence — the
// log carries the closed origin and counts alone.

type ToolDetail = Pick<
  CodingSafeActivityToolPresentation,
  "failureOrigin" | "durationMs" | "command" | "output" | "errorText"
>;

/** What one finished or running OpenCode tool part shows beside its state. */
export function openCodeToolDetail(
  name: string,
  part: Readonly<Record<string, unknown>>,
  state: Readonly<Record<string, unknown>>,
  displayState: CodingSafeActivityToolState,
): ToolDetail {
  // Only a shell's output is the command's answer a person reads; another tool's content is a file,
  // a search result or a program's value, which its own row facts already summarise.
  const shell = name === "shell";
  const command = shell ? shellCommand(state) : undefined;
  const output = shell ? toolOutput(state) : undefined;
  const errorText = state.status === "error" ? toolErrorText(state.error) : undefined;
  const origin = failureOrigin(name, state, displayState);
  const durationMs = partDuration(part);
  return {
    ...(origin === undefined ? {} : { failureOrigin: origin }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(command === undefined ? {} : { command }),
    ...(output === undefined ? {} : { output }),
    ...(errorText === undefined ? {} : { errorText }),
  };
}

/**
 * The origin of a call that did not succeed, from the runtime's own status facts: Keiko's permission
 * decision, a shell's timeout, kill signal or exit status, or the tool's own error.
 */
function failureOrigin(
  name: string,
  state: Readonly<Record<string, unknown>>,
  displayState: CodingSafeActivityToolState,
): CodingSafeActivityToolFailureOrigin | undefined {
  if (displayState === "denied") return "keiko-refused";
  if (displayState === "cancelled") return "cancelled";
  if (displayState !== "failed") return undefined;
  return name === "shell" && state.status === "completed"
    ? shellFailureOrigin(record(state.metadata) ?? {})
    : "tool-error";
}

// A shell that ran to its end failed by its clock or by the command itself: its own exit status or
// a signal that killed it (the system's memory guard, a crash). A person's Stop never lands here; it
// settles the call as cancelled.
function shellFailureOrigin(
  metadata: Readonly<Record<string, unknown>>,
): CodingSafeActivityToolFailureOrigin {
  if (metadata.timeout === true) return "timed-out";
  if (typeof metadata.signal === "string") return "command-failed";
  return Number.isInteger(metadata.exit) ? "command-failed" : "tool-error";
}

/** A failed call's origin when its producer named none: the closed state decides it. */
export function stateFailureOrigin(
  state: CodingSafeActivityToolState,
  exitCode: number | undefined,
): CodingSafeActivityToolFailureOrigin | undefined {
  if (state === "denied") return "keiko-refused";
  if (state === "cancelled") return "cancelled";
  if (state !== "failed") return undefined;
  return exitCode !== undefined && exitCode !== 0 ? "command-failed" : "tool-error";
}

function shellCommand(
  state: Readonly<Record<string, unknown>>,
): CodingSafeActivityToolText | undefined {
  const command = record(state.input)?.command;
  return typeof command === "string"
    ? boundedToolText(command, CODING_SAFE_ACTIVITY_MAX_TOOL_COMMAND_CHARS)
    : undefined;
}

// The runtime reports a structured error; only its message is the text the model was handed. The
// provider's response body and every other field stay out.
function toolErrorText(error: unknown): CodingSafeActivityToolText | undefined {
  const message = typeof error === "string" ? error : record(error)?.message;
  return typeof message === "string"
    ? boundedToolText(message, CODING_SAFE_ACTIVITY_MAX_TOOL_ERROR_CHARS)
    : undefined;
}

function toolOutput(
  state: Readonly<Record<string, unknown>>,
): CodingSafeActivityToolOutput | undefined {
  const content = state.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) => {
      const entry = record(item);
      return entry?.type === "text" && typeof entry.text === "string" ? entry.text : "";
    })
    .join("");
  return toolOutputPreview(text);
}

/**
 * An output's first and last lines with the lines between counted. Console control output is made
 * readable first: CRLF and bare-CR progress rewrites keep only what the line finally showed.
 */
export function toolOutputPreview(raw: string): CodingSafeActivityToolOutput | undefined {
  const lines = displayLines(cleanToolText(raw));
  if (lines.length === 0) return undefined;
  const head = CODING_SAFE_ACTIVITY_TOOL_OUTPUT_HEAD_LINES;
  const tail = CODING_SAFE_ACTIVITY_TOOL_OUTPUT_TAIL_LINES;
  const whole = lines.length <= head + tail;
  const headPart = boundedLines(whole ? lines : lines.slice(0, head));
  const tailPart = whole ? { text: "", truncated: false } : boundedLines(lines.slice(-tail));
  return {
    head: headPart.text,
    tail: tailPart.text,
    lineCount: lines.length,
    hiddenLineCount: whole ? 0 : lines.length - head - tail,
    truncated: headPart.truncated || tailPart.truncated,
  };
}

function displayLines(text: string): readonly string[] {
  const lines = text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map(finalConsoleState);
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
  return lines;
}

// What a console line finally showed: the last segment a carriage return left, skipping the empty
// one a trailing "\r" leaves, so "Downloading...\r" keeps its text.
function finalConsoleState(line: string): string {
  let end = line.length;
  while (end > 0 && line.charCodeAt(end - 1) === CARRIAGE_RETURN) end -= 1;
  return line.slice(line.lastIndexOf("\r", end - 1) + 1, end);
}

const CARRIAGE_RETURN = 13;

function boundedLines(lines: readonly string[]): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const joined = lines.join("\n");
  const text = wholeCharacterPrefix(joined, CODING_SAFE_ACTIVITY_MAX_TOOL_OUTPUT_PART_CHARS);
  return { text, truncated: text.length < joined.length };
}

/** A tool text with the credential floor applied, cut on a whole character to `maxChars`. */
export function boundedToolText(
  raw: string,
  maxChars: number,
): CodingSafeActivityToolText | undefined {
  const cleaned = cleanToolText(raw).trim();
  if (cleaned === "") return undefined;
  const text = wholeCharacterPrefix(cleaned, maxChars);
  return { text, truncated: text.length < cleaned.length };
}

function cleanToolText(raw: string): string {
  // ANSI colour and cursor sequences carry no text a reader needs; the redactor then sees plain text.
  const plain = raw.replaceAll(ANSI_ESCAPE, "");
  return stripUnsafeFormatChars(redactContent(plain, "preserve"));
}

const ANSI_ESCAPE =
  // eslint-disable-next-line no-control-regex -- matches the ESC introducer of terminal sequences.
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/gu;

function wholeCharacterPrefix(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const code = text.charCodeAt(maxChars - 1);
  return text.slice(0, code >= 0xd8_00 && code <= 0xdb_ff ? maxChars - 1 : maxChars);
}

function partDuration(part: Readonly<Record<string, unknown>>): number | undefined {
  const time = record(part.time);
  const ran = time?.ran;
  const completed = time?.completed;
  if (typeof ran !== "number" || typeof completed !== "number") return undefined;
  const duration = Math.round(completed - ran);
  return Number.isSafeInteger(duration) && duration >= 0 ? duration : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * Applies the deployment's own secret values (its gateway keys, configured tokens) to every tool
 * text a live update carries, on top of the credential shapes removed at the source: a command that
 * printed a deployment secret shows it redacted. Each text stays inside its bound.
 */
export function redactToolTexts(
  presentation: CodingSafeActivityToolPresentation,
  secrets: readonly string[],
): CodingSafeActivityToolPresentation {
  if (secrets.length === 0) return presentation;
  const { command, output, errorText } = presentation;
  if (command === undefined && output === undefined && errorText === undefined) return presentation;
  return {
    ...presentation,
    ...(command === undefined
      ? {}
      : { command: secretFree(command, CODING_SAFE_ACTIVITY_MAX_TOOL_COMMAND_CHARS, secrets) }),
    ...(errorText === undefined
      ? {}
      : { errorText: secretFree(errorText, CODING_SAFE_ACTIVITY_MAX_TOOL_ERROR_CHARS, secrets) }),
    ...(output === undefined ? {} : { output: secretFreeOutput(output, secrets) }),
  };
}

function secretFree(
  value: CodingSafeActivityToolText,
  maxChars: number,
  secrets: readonly string[],
): CodingSafeActivityToolText {
  const whole = redactContent(value.text, "preserve", secrets);
  // A text the source cut may end in the first characters of a secret the cut split; those go too.
  const redacted = value.truncated ? withoutCutSecretStart(whole, secrets) : whole;
  if (redacted === value.text) return value;
  const text = wholeCharacterPrefix(redacted, maxChars);
  return { text, truncated: value.truncated || text.length < redacted.length };
}

/**
 * The text without a trailing fragment that is the start of one of the secrets: the cut that ended
 * the text may have split a secret, and its first characters must not stay readable.
 */
export function withoutCutSecretStart(text: string, secrets: readonly string[]): string {
  let longest = 0;
  for (const secret of secrets) {
    for (let length = Math.min(secret.length - 1, text.length); length > longest; length -= 1) {
      if (text.endsWith(secret.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest === 0 ? text : text.slice(0, text.length - longest);
}

function secretFreeOutput(
  output: CodingSafeActivityToolOutput,
  secrets: readonly string[],
): CodingSafeActivityToolOutput {
  // Either part may be the one the source cut; both lose a split secret's start.
  const head = secretFree(
    { text: output.head, truncated: output.truncated },
    CODING_SAFE_ACTIVITY_MAX_TOOL_OUTPUT_PART_CHARS,
    secrets,
  );
  const tail =
    output.tail === ""
      ? { text: "", truncated: false }
      : secretFree(
          { text: output.tail, truncated: output.truncated },
          CODING_SAFE_ACTIVITY_MAX_TOOL_OUTPUT_PART_CHARS,
          secrets,
        );
  return {
    ...output,
    head: head.text,
    tail: tail.text,
    truncated: output.truncated || head.truncated || tail.truncated,
  };
}
