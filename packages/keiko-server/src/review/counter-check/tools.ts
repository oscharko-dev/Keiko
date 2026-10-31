// The Counter-checker's four tools, bound to one review run's head commit (ADR-0182 D5, #4136).
//
// Every read is served from the Git objects of the reviewed head commit in the review worktree's
// object store, never from a working tree: what the Counter-checker reads is exactly what was
// reviewed, and nothing it can name reaches past that commit. The sensitive-path deny list applies
// to every read, listing and search hit. Each call first passes the session's governance gate
// (`workspace-read`); a denial or a tool the session was not offered stops the session. The verdict
// tool records the first valid verdict and then ends the session.

import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import type { CounterCheckVerdict } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { validateCounterCheckVerdict } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-validation";
import { isPortableWorkspaceRelativePath } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";
import type { ToolCallRequest, ToolCallResult, ToolPort } from "@oscharko-dev/keiko-harness";
import {
  createKeikoToolCatalog,
  gatewayToolDefinitions,
  REVIEW_COUNTER_CHECK_PROFILE,
  REVIEW_COUNTER_CHECK_TOOL_ALIASES,
  reviewCounterCheckRegistrationSet,
} from "@oscharko-dev/keiko-tool-catalog";
import {
  grepGitReviewTree,
  listGitReviewTree,
  type GitProcessRunner,
  type GitReviewTreeEntry,
} from "@oscharko-dev/keiko-git";
import { isDenied } from "@oscharko-dev/keiko-workspace";

import type {
  ReadOnlyChildGateDecision,
  ReadOnlyChildToolAttempt,
} from "../../coding-runtime/readOnlyChildOrchestrator.js";
import { ReviewHeadFileReader } from "../runtime/findingIntake.js";

export const COUNTER_CHECK_CATALOG = createKeikoToolCatalog([reviewCounterCheckRegistrationSet()]);
const TOOL_DEFINITIONS = gatewayToolDefinitions(
  COUNTER_CHECK_CATALOG,
  REVIEW_COUNTER_CHECK_PROFILE,
);
const ALIASES = REVIEW_COUNTER_CHECK_TOOL_ALIASES;

/** Bounds of one tool answer, so a session's context stays within the harness budget. */
const READ_WINDOW_LINES = 200;
const DISCOVER_MAX_ENTRIES = 200;
const SEARCH_MAX_MATCHES = 50;
const SEARCH_MAX_PER_FILE = 5;
const SEARCH_TEXT_MAX_CHARS = 200;
const OUTPUT_MAX_CHARS = 24_000;
const TREE_LIST_MAX_BYTES = 8 * 1024 * 1024;
const SEARCH_MAX_BYTES = 256 * 1024;
const GIT_TIMEOUT_MS = 15_000;
// eslint-disable-next-line no-control-regex -- intentionally matches control characters to reject them
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export interface CounterCheckToolsetInput {
  readonly runner: GitProcessRunner;
  /** The review worktree: its object store holds the head commit. */
  readonly worktreeRoot: string;
  readonly headSha: string;
  readonly fingerprint: string;
  readonly gate: (attempt: ReadOnlyChildToolAttempt) => ReadOnlyChildGateDecision;
  readonly stop: (reason: string) => void;
  readonly reader: ReviewHeadFileReader;
}

/** What one session's tools observed; read by the counter-check after the session ends. */
export interface CounterCheckToolsetState {
  verdict: CounterCheckVerdict | undefined;
  invalidVerdicts: number;
  toolCalls: number;
}

function answer(request: ToolCallRequest, output: string): ToolCallResult {
  const bounded =
    output.length > OUTPUT_MAX_CHARS ? `${output.slice(0, OUTPUT_MAX_CHARS)}\n[truncated]` : output;
  return { toolCallId: request.toolCallId, output: bounded, durationMs: 0, commandExecuted: false };
}

function status(request: ToolCallRequest, value: string): ToolCallResult {
  return answer(request, JSON.stringify({ status: value }));
}

/** A path the tools may name: workspace-relative, portable, no control characters, not denied. */
export function admissibleCounterCheckPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !CONTROL_CHARACTER.test(value) &&
    isPortableWorkspaceRelativePath(value) &&
    !isDenied(value)
  );
}

function lineNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}

class CounterCheckTools {
  private tree: Promise<readonly GitReviewTreeEntry[] | undefined> | undefined;

  public constructor(
    private readonly input: CounterCheckToolsetInput,
    private readonly state: CounterCheckToolsetState,
  ) {}

  public async execute(request: ToolCallRequest): Promise<ToolCallResult> {
    if (!Object.values(ALIASES).includes(request.toolName as never)) {
      this.input.stop("tool-not-offered");
      return status(request, "denied");
    }
    const decision = this.input.gate({ toolClass: "workspace-read" });
    if (!decision.ok) {
      this.input.stop(decision.reasonCode);
      return status(request, "denied");
    }
    this.state.toolCalls += 1;
    return this.dispatch(request);
  }

  private dispatch(request: ToolCallRequest): Promise<ToolCallResult> {
    if (request.toolName === ALIASES.read) return this.read(request);
    if (request.toolName === ALIASES.discover) return this.discover(request);
    if (request.toolName === ALIASES.search) return this.search(request);
    return Promise.resolve(this.verdict(request));
  }

  private async read(request: ToolCallRequest): Promise<ToolCallResult> {
    const path = request.arguments.relativePath;
    if (!admissibleCounterCheckPath(path)) return status(request, "denied");
    const file = await this.input.reader.read(path, request.signal);
    if (file.kind === "refused") return status(request, "not-found");
    const start = lineNumber(request.arguments.startLine, 1);
    const end = Math.min(
      lineNumber(request.arguments.endLine, start + READ_WINDOW_LINES - 1),
      start + READ_WINDOW_LINES - 1,
      file.lines.length,
    );
    if (start > file.lines.length) return status(request, "range-invalid");
    const lines = file.lines
      .slice(start - 1, end)
      .map((line, index) => `${String(start + index)}: ${line}`);
    return answer(
      request,
      [
        `${path} lines ${String(start)}-${String(end)} of ${String(file.lines.length)}`,
        ...lines,
      ].join("\n"),
    );
  }

  private listTree(signal: AbortSignal): Promise<readonly GitReviewTreeEntry[] | undefined> {
    this.tree ??= listGitReviewTree(
      {
        runner: this.input.runner,
        timeoutMs: GIT_TIMEOUT_MS,
        maxBytes: TREE_LIST_MAX_BYTES,
        abortSignal: signal,
      },
      { cwd: this.input.worktreeRoot, sha: this.input.headSha },
    ).then((listed) => (listed.ok ? listed.value : undefined));
    return this.tree;
  }

  private async discover(request: ToolCallRequest): Promise<ToolCallResult> {
    const raw = request.arguments.directory;
    const directory = typeof raw === "string" ? withoutTrailingSlashes(raw) : "";
    if (directory !== "" && !admissibleCounterCheckPath(directory)) {
      return status(request, "denied");
    }
    const entries = await this.listTree(request.signal);
    if (entries === undefined) return status(request, "unavailable");
    const children = directoryChildren(entries, directory);
    const shown = children.slice(0, DISCOVER_MAX_ENTRIES);
    const more =
      children.length > shown.length ? [`[${String(children.length - shown.length)} more]`] : [];
    return answer(request, [...shown, ...more].join("\n") || "[empty]");
  }

  private async search(request: ToolCallRequest): Promise<ToolCallResult> {
    const literal = request.arguments.literal;
    if (typeof literal !== "string" || literal.length < 2 || CONTROL_CHARACTER.test(literal)) {
      return status(request, "invalid");
    }
    const found = await grepGitReviewTree(
      {
        runner: this.input.runner,
        timeoutMs: GIT_TIMEOUT_MS,
        maxBytes: SEARCH_MAX_BYTES,
        abortSignal: request.signal,
      },
      {
        cwd: this.input.worktreeRoot,
        sha: this.input.headSha,
        literal: literal.slice(0, 200),
        maxCountPerFile: SEARCH_MAX_PER_FILE,
      },
    );
    if (!found.ok) return status(request, "unavailable");
    const visible = found.value.matches.filter((match) => admissibleCounterCheckPath(match.path));
    const shown = visible
      .slice(0, SEARCH_MAX_MATCHES)
      .map(
        (match) =>
          `${match.path}:${String(match.line)}: ${match.text.slice(0, SEARCH_TEXT_MAX_CHARS)}`,
      );
    const cut = found.value.truncated || visible.length > shown.length ? ["[more matches]"] : [];
    return answer(request, [...shown, ...cut].join("\n") || "[no matches]");
  }

  private verdict(request: ToolCallRequest): ToolCallResult {
    if (this.state.verdict !== undefined) return status(request, "already-recorded");
    const validated = validateCounterCheckVerdict({
      ...request.arguments,
      findingFingerprint: this.input.fingerprint,
    });
    if (!validated.ok) {
      this.state.invalidVerdicts += 1;
      return status(request, "invalid");
    }
    this.state.verdict = validated.value;
    // The one verdict is recorded: the session has nothing left to do.
    this.input.stop("verdict-recorded");
    return status(request, "recorded");
  }
}

/** The immediate children of one directory of the head tree, directories marked with `/`. */
function directoryChildren(entries: readonly GitReviewTreeEntry[], directory: string): string[] {
  const prefix = directory === "" ? "" : `${directory}/`;
  const children = new Set<string>();
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix) || isDenied(entry.path)) continue;
    const rest = entry.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    children.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
  }
  return [...children].sort(compareStrings);
}

function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

/** Builds the session's tool port; `state` collects the verdict and the call count. */
export function createCounterCheckToolPort(
  input: CounterCheckToolsetInput,
  state: CounterCheckToolsetState,
): ToolPort {
  const tools = new CounterCheckTools(input, state);
  return {
    listTools: () => TOOL_DEFINITIONS,
    execute: (request) => tools.execute(request),
  };
}
