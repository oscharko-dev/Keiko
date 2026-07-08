// Shared process-level types for the single hardened git spawn path. These are runtime-layer
// types (not wire contracts): server routes, tool adapters, and workspace detection all execute
// git through this one interface so byte caps, timeouts, and error mapping behave identically.

export interface GitProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Output was cut at the byte cap OR the run was cut by the timeout (see `timedOut`). */
  readonly truncated: boolean;
  /**
   * The run exceeded its wall-clock budget and was killed. Implies `truncated`. Optional so that
   * result literals predating this field (fake runners in tests) stay valid; the real runner
   * always sets it.
   */
  readonly timedOut?: boolean | undefined;
}

export interface GitProcessOptions {
  readonly cwd: string;
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

export type GitProcessRunner = (
  args: readonly string[],
  options: GitProcessOptions,
) => Promise<GitProcessResult>;
