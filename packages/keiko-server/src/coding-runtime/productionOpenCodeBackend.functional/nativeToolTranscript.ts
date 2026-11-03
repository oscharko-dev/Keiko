// Reads the original runtime's own tool results and prompt back out of a gateway transcript for the
// real-binary lane's scripted MODEL boundary (#3897). A native run executes `grep`, `read`, `skill`
// and `edit` inside OpenCode, so a result reaches the model as the runtime's plain text, never as a
// Keiko JSON envelope; a failed call reaches it as a JSON error object. The proofs built on this
// module therefore refuse anything that is not a result the runtime itself produced.

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messages(transcript: string): readonly Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(transcript);
  if (!Array.isArray(parsed)) throw new TypeError("native proof requires gateway messages");
  return parsed.filter(record);
}

// The runtime answers a failed tool call (an unknown tool, a failed ripgrep run, a refused read)
// with an error object instead of the tool's text: `{"error":{"type":...,"message":...},"content":[]}`.
const RUNTIME_FAILURE = /^\{\s*"error"\s*:\s*\{/u;

/** The text of the tool result correlated to `toolCallId`; a missing or failed result throws. */
export function nativeToolResultText(transcript: string, toolCallId: string): string {
  const reply = messages(transcript).find(
    (message) => message.role === "tool" && message.toolCallId === toolCallId,
  );
  if (reply === undefined || typeof reply.content !== "string") {
    throw new TypeError("native proof requires the correlated runtime tool result");
  }
  if (RUNTIME_FAILURE.test(reply.content)) {
    throw new TypeError("native proof requires a completed tool result");
  }
  return reply.content;
}

/** Every system message of the request, joined: the runtime's own prompt, skill listing included. */
export function nativeSystemPrompt(transcript: string): string {
  return messages(transcript)
    .filter((message) => message.role === "system" && typeof message.content === "string")
    .map((message) => String(message.content))
    .join("\n");
}

const WORKING_DIRECTORY = /^[ \t]*Working directory: (\S.*)$/mu;

/** The run's working directory as the runtime itself states it in the environment block. */
export function nativeWorkingDirectory(transcript: string): string {
  const root = WORKING_DIRECTORY.exec(nativeSystemPrompt(transcript))?.[1];
  if (root === undefined)
    throw new TypeError("native proof requires the runtime working directory");
  return root;
}
