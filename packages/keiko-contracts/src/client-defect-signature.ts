import { isClientDiagnosticKind, isPersistedClientDiagnosticFrame } from "./diagnostics.js";

const CLIENT_CONTEXT_VALUES: ReadonlySet<string> = new Set([
  "kind:boundary",
  "kind:unhandled-rejection",
  "kind:window-error",
  "kind:sse-error",
  "kind:voice-dialogue",
  "kind:voice-playback",
  "kind:markdown-layout",
  "kind:delivery-loss",
  "kind:other",
  "render:shell",
  "render:window-body",
  "module:git-sync",
  "module:git-history",
  "stage:files-directory-load",
  "stage:files-directory-navigation",
  "stage:files-project-selection",
  "stage:editor-project-selection",
  "stage:window-chunk",
  "stage:chat-window-chunk",
  "stage:editor-widget-chunk",
  "stage:files-widget-chunk",
  "stage:chat-bind",
  "stage:command-palette",
  "stage:chat-history-deletion",
]);

export interface ClientDefectContextFacts {
  readonly clientKind?: unknown;
  readonly renderFailure?: unknown;
  readonly moduleLoadFailure?: unknown;
  readonly stage?: unknown;
}

/** Only closed product context enters an incident's identity; messages and customer labels do not. */
export function clientDefectContext(facts: ClientDefectContextFacts): readonly string[] {
  const context: string[] = [];
  if (isClientDiagnosticKind(facts.clientKind)) context.push(`kind:${facts.clientKind}`);
  for (const [prefix, value] of [
    ["render", facts.renderFailure],
    ["module", facts.moduleLoadFailure],
    ["stage", facts.stage],
  ] as const) {
    const token = typeof value === "string" ? `${prefix}:${value}` : "";
    if (CLIENT_CONTEXT_VALUES.has(token)) context.push(token);
  }
  return context.filter((token) => CLIENT_CONTEXT_VALUES.has(token));
}

export function isClientDefectContext(value: readonly string[]): boolean {
  return value.length <= 4 && value.every((token) => CLIENT_CONTEXT_VALUES.has(token));
}

/** Browser frames are already reduced to shipped chunk digests before they reach this layer. */
export function normalizeClientDefectFrames(frames: readonly unknown[]): readonly string[] {
  const signature: string[] = [];
  for (const frame of frames) {
    if (signature.length >= 8) break;
    if (!isPersistedClientDiagnosticFrame(frame)) continue;
    const module = frame.slice(0, frame.indexOf(".js:"));
    if (signature.at(-1) !== module) signature.push(module);
  }
  return signature;
}
