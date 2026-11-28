import {
  type CodingSafeActivityOutputShortened,
  CODING_SAFE_ACTIVITY_MAX_TOOL_COMMAND_CHARS,
  CODING_SAFE_ACTIVITY_MAX_TOOL_AGENT_NAME_CHARS,
  CODING_SAFE_ACTIVITY_MAX_TOOL_ERROR_CHARS,
  CODING_SAFE_ACTIVITY_MAX_TOOL_OUTPUT_PART_CHARS,
  CODING_SAFE_ACTIVITY_MAX_TOOL_TASK_DESCRIPTION_CHARS,
  CODING_SAFE_ACTIVITY_MAX_TOOL_TASK_PROMPT_CHARS,
  CODING_SAFE_ACTIVITY_TOOL_OUTPUT_HEAD_LINES,
  CODING_SAFE_ACTIVITY_TOOL_OUTPUT_TAIL_LINES,
  type CodingSafeActivityProgramKind,
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
  | "failureOrigin"
  | "durationMs"
  | "command"
  | "output"
  | "errorText"
  | "outputShortened"
  | "agentName"
  | "taskDescription"
  | "taskPrompt"
  | "programKind"
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
  const shortened = shortenedOutput(state);
  return {
    ...programKindDetail(name, state),
    ...(shortened === undefined ? {} : { outputShortened: shortened }),
    ...(origin === undefined ? {} : { failureOrigin: origin }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(command === undefined ? {} : { command }),
    ...(output === undefined ? {} : { output }),
    ...(errorText === undefined ? {} : { errorText }),
    ...subagentDetail(name, state),
  };
}

// A subagent call says which agent it started, for what and with which prompt: the model's own
// arguments, with the credential floor applied and each bounded like every other tool text.
function subagentDetail(
  name: string,
  state: Readonly<Record<string, unknown>>,
): Pick<ToolDetail, "agentName" | "taskDescription" | "taskPrompt"> {
  if (name !== "subagent") return {};
  const input = record(state.input);
  const agentName = inputText(input?.agent, CODING_SAFE_ACTIVITY_MAX_TOOL_AGENT_NAME_CHARS);
  const taskDescription = inputText(
    input?.description,
    CODING_SAFE_ACTIVITY_MAX_TOOL_TASK_DESCRIPTION_CHARS,
  );
  const taskPrompt = inputText(input?.prompt, CODING_SAFE_ACTIVITY_MAX_TOOL_TASK_PROMPT_CHARS);
  return {
    ...(agentName === undefined ? {} : { agentName }),
    ...(taskDescription === undefined ? {} : { taskDescription }),
    ...(taskPrompt === undefined ? {} : { taskPrompt }),
  };
}

function inputText(value: unknown, maxChars: number): CodingSafeActivityToolText | undefined {
  return typeof value === "string" ? boundedToolText(value, maxChars) : undefined;
}

function programKindDetail(
  name: string,
  state: Readonly<Record<string, unknown>>,
): Pick<ToolDetail, "programKind"> {
  const programKind = name === "execute" ? openCodeProgramKind(state) : undefined;
  return programKind === undefined ? {} : { programKind };
}

// The Code Mode namespaces a program reaches a tool through: `tools.automation.*` changes a
// scheduled task, `tools.shell(` / `tools.bash(` runs a command, and any other server namespace is a
// connected tool. Only a call in the program's own code names a kind: a string, a template's text, a
// comment or an uncalled reference (`typeof tools.automation.create`) proves no invocation and keeps
// the neutral program label. The program's text is matched, never kept: only the closed kind leaves
// here. `tools.opencode.*` is the runtime's own management surface and names no kind.
const PROGRAM_SCHEDULE_CALL =
  /(?<![\w$.])tools\.automation\.(?:create|pause|resume|delete|update|run)\s*\(/u;
const PROGRAM_COMMAND_CALL = /(?<![\w$.])tools\.(?:shell|bash)\s*\(/u;
const PROGRAM_TOOL_CALL =
  /(?<![\w$.])tools\.(?!opencode\b|automation\b|shell\b|bash\b)[A-Za-z_]\w*\.[A-Za-z_]\w*\s*\(/u;

// Template interpolations nest; a program that nests deeper than any real one stops being read.
const PROGRAM_MAX_TEMPLATE_DEPTH = 16;

interface ProgramScan {
  readonly out: string;
  readonly end: number;
}

/**
 * The executable text of a program: string, template and comment text becomes a space, the code
 * inside a template's `${}` is kept. One forward scan; a nested scan stops at its closing brace.
 */
function programCode(code: string, start: number, nested: boolean, depth: number): ProgramScan {
  let out = "";
  let i = start;
  let braces = 0;
  while (i < code.length) {
    const span = programSpan(code, i, depth);
    if (span !== undefined) {
      out += span.out;
      i = span.end;
      continue;
    }
    const ch = code.charAt(i);
    if (nested && ch === "}" && braces === 0) return { out, end: i + 1 };
    if (nested && ch === "{") braces += 1;
    if (nested && ch === "}") braces -= 1;
    out += ch;
    i += 1;
  }
  return { out, end: i };
}

// A literal or comment starting at `i`, as the text it leaves in the code; undefined for code.
function programSpan(code: string, i: number, depth: number): ProgramScan | undefined {
  const ch = code.charAt(i);
  const next = code.charAt(i + 1);
  if (ch === '"' || ch === "'") return { out: " ", end: quotedEnd(code, i, ch) };
  if (ch === "`") return templateSpan(code, i, depth);
  if (ch === "/" && next === "/") {
    const eol = code.indexOf("\n", i);
    return { out: " ", end: eol === -1 ? code.length : eol };
  }
  if (ch === "/" && next === "*") {
    const close = code.indexOf("*/", i + 2);
    return { out: " ", end: close === -1 ? code.length : close + 2 };
  }
  return undefined;
}

function quotedEnd(code: string, open: number, quote: string): number {
  let i = open + 1;
  while (i < code.length && code.charAt(i) !== quote) i += code.charAt(i) === "\\" ? 2 : 1;
  return Math.min(i + 1, code.length);
}

function templateSpan(code: string, open: number, depth: number): ProgramScan {
  if (depth >= PROGRAM_MAX_TEMPLATE_DEPTH) return { out: " ", end: code.length };
  let out = " ";
  let i = open + 1;
  while (i < code.length && code.charAt(i) !== "`") {
    if (code.charAt(i) === "\\") {
      i += 2;
    } else if (code.startsWith("${", i)) {
      const inner = programCode(code, i + 2, true, depth + 1);
      out += ` ${inner.out} `;
      i = inner.end;
    } else {
      i += 1;
    }
  }
  return { out, end: Math.min(i + 1, code.length) };
}

/** What a Code Mode program does, from the tools its code calls; undefined when it calls none. */
export function openCodeProgramKind(
  state: Readonly<Record<string, unknown>>,
): CodingSafeActivityProgramKind | undefined {
  const source = record(state.input)?.code;
  if (typeof source !== "string") return undefined;
  const code = programCode(source, 0, false, 0).out;
  if (PROGRAM_SCHEDULE_CALL.test(code)) return "schedule";
  if (PROGRAM_COMMAND_CALL.test(code)) return "command";
  return PROGRAM_TOOL_CALL.test(code) ? "tool" : undefined;
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
  if (unreadableArguments(state)) return "invalid-arguments";
  return name === "shell" && state.status === "completed"
    ? shellFailureOrigin(record(state.metadata) ?? {})
    : "tool-error";
}

// The runtime's own closed error type for a call whose arguments it could not read as JSON, or that
// the model's output ended in the middle of: the tool never ran. Only this type is a fact; an unknown
// tool or arguments that miss the tool's schema share `tool.execution` with every other tool error,
// and the row shows the runtime's own message for them.
function unreadableArguments(state: Readonly<Record<string, unknown>>): boolean {
  if (state.status !== "error") return false;
  const type = record(state.error)?.type;
  return type === "tool.input-json" || type === "tool.input-incomplete";
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

function contentText(state: Readonly<Record<string, unknown>>): string | undefined {
  const content = state.content;
  if (!Array.isArray(content)) return undefined;
  return content
    .map((item) => {
      const entry = record(item);
      return entry?.type === "text" && typeof entry.text === "string" ? entry.text : "";
    })
    .join("");
}

// A finished call's result is its `content`. A running shell has no content yet: the runtime streams
// what the command printed so far into `metadata.output`, and keeps it when a Stop or an error ends
// the call, so the same text is the row's output until (and unless) a content result replaces it.
function toolOutput(
  state: Readonly<Record<string, unknown>>,
): CodingSafeActivityToolOutput | undefined {
  const text = contentText(state);
  const streamed = record(state.metadata)?.output;
  const shown = text === undefined || text.trim() === "" ? streamed : text;
  return typeof shown === "string" ? toolOutputPreview(shown) : undefined;
}

// The runtime ends a result it shortened with `[showing lines 1-N of M; full output saved to
// <path>]` and reports `metadata.truncated`. Only the counts are read; the path stays out.
const SHORTENING_MARKER =
  /\n?\[showing (?:lines 1-(\d+)|0 lines) of (\d+); full output saved to [^\]\n]*\]\s*$/u;

/** What the runtime kept of a result it shortened for the model, as counts alone. */
export function shortenedOutput(
  state: Readonly<Record<string, unknown>>,
): CodingSafeActivityOutputShortened | undefined {
  if (record(state.metadata)?.truncated !== true) return undefined;
  const text = contentText(state) ?? "";
  const marker = SHORTENING_MARKER.exec(text);
  const keptBytes = Buffer.byteLength(marker === null ? text : text.slice(0, marker.index), "utf8");
  if (marker === null) return { keptBytes };
  const totalLines = Number(marker[2]);
  const keptLines = Number(marker[1] ?? 0);
  return Number.isSafeInteger(totalLines) && keptLines < totalLines
    ? { keptBytes, keptLines, totalLines }
    : { keptBytes };
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
    .map((line) => finalConsoleState(line));
  // One slice, never a shift per line: a large blank prefix stays linear.
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first === -1) return [];
  let end = lines.length;
  while (lines[end - 1]?.trim() === "") end -= 1;
  return lines.slice(first, end);
}

// What a console line finally showed: the last segment a carriage return left, skipping the empty
// one a trailing "\r" leaves, so "Downloading...\r" keeps its text.
function finalConsoleState(line: string): string {
  let end = line.length;
  while (end > 0 && line.codePointAt(end - 1) === CARRIAGE_RETURN) end -= 1;
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
  // ANSI colour and cursor sequences carry no text a reader needs, and a bidi or zero-width mark
  // inside a token would hide it from the credential patterns: both go before the redactor runs.
  const plain = stripUnsafeFormatChars(stripTerminalSequences(raw));
  return redactContent(plain, "preserve");
}

const ESC = "\u001b";
const BEL = "\u0007";

/**
 * Removes terminal escape sequences (ECMA-48) in one forward scan, without a regex: CSI (`ESC [`,
 * its parameter and intermediate bytes and its final byte), the control strings OSC, DCS, SOS, PM
 * and APC (`ESC ]`, `ESC P`, `ESC X`, `ESC ^`, `ESC _`, each up to BEL or `ESC \\`) and the
 * two-character `ESC` forms. A sequence cut off early ends at the first byte that cannot belong
 * to it, so it never swallows the next line.
 */
function stripTerminalSequences(text: string): string {
  if (!text.includes(ESC)) return text;
  let out = "";
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf(ESC, index);
    if (start === -1) return out + text.slice(index);
    out += text.slice(index, start);
    index = terminalSequenceEnd(text, start);
  }
  return out;
}

// The index just past the escape sequence that starts at `start`.
function terminalSequenceEnd(text: string, start: number): number {
  const kind = text.charAt(start + 1);
  if (kind === "[") return csiEnd(text, start + 2);
  if (CONTROL_STRING_INTRODUCERS.has(kind)) return controlStringEnd(text, start + 2);
  const code = text.codePointAt(start + 1) ?? 0;
  return code >= 0x30 && code <= 0x7e ? start + 2 : start + 1;
}

// Parameter bytes are 0x30–0x3F, intermediate bytes 0x20–0x2F and the final byte 0x40–0x7E.
function csiEnd(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    const code = text.codePointAt(index) ?? 0;
    if (code >= 0x40 && code <= 0x7e) return index + 1;
    if (code < 0x20 || code > 0x3f) return index;
  }
  return text.length;
}

// OSC, DCS, SOS, PM and APC carry a payload up to their string terminator.
const CONTROL_STRING_INTRODUCERS: ReadonlySet<string> = new Set(["]", "P", "X", "^", "_"]);

function controlStringEnd(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === BEL) return index + 1;
    if (char === "\n") return index;
    if (char === ESC) return text.charAt(index + 1) === "\\" ? index + 2 : index;
  }
  return text.length;
}

function wholeCharacterPrefix(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // The unit before the cut on its own: a high surrogate there would be left without its pair.
  const code = text.slice(maxChars - 1, maxChars).codePointAt(0) ?? 0;
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
  const { command, output, errorText, agentName, taskDescription, taskPrompt } = presentation;
  const texts = [command, output, errorText, agentName, taskDescription, taskPrompt];
  if (texts.every((text) => text === undefined)) return presentation;
  return {
    ...presentation,
    ...redacted("command", command, CODING_SAFE_ACTIVITY_MAX_TOOL_COMMAND_CHARS, secrets),
    ...redacted("errorText", errorText, CODING_SAFE_ACTIVITY_MAX_TOOL_ERROR_CHARS, secrets),
    ...redacted("agentName", agentName, CODING_SAFE_ACTIVITY_MAX_TOOL_AGENT_NAME_CHARS, secrets),
    ...redacted(
      "taskDescription",
      taskDescription,
      CODING_SAFE_ACTIVITY_MAX_TOOL_TASK_DESCRIPTION_CHARS,
      secrets,
    ),
    ...redacted("taskPrompt", taskPrompt, CODING_SAFE_ACTIVITY_MAX_TOOL_TASK_PROMPT_CHARS, secrets),
    ...(output === undefined ? {} : { output: secretFreeOutput(output, secrets) }),
  };
}

function redacted<K extends string>(
  key: K,
  value: CodingSafeActivityToolText | undefined,
  maxChars: number,
  secrets: readonly string[],
): Partial<Record<K, CodingSafeActivityToolText>> {
  return (value === undefined ? {} : { [key]: secretFree(value, maxChars, secrets) }) as Partial<
    Record<K, CodingSafeActivityToolText>
  >;
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
