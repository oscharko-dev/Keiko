import { randomBytes as nodeRandomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";

import {
  OPENCODE_GOVERNED_ACTION_PERMISSION,
  OPENCODE_MODEL_VISIBLE_TOOL_NAMES,
  OPENCODE_PINNED_BUILT_IN_TOOLS,
} from "./opencodeToolSchemas.js";

export interface OpenCodeLaunchProfileInput {
  readonly executable: string;
  readonly stateRoot: string;
  readonly randomBytes?: ((size: number) => Buffer) | undefined;
  /**
   * #3414-AC9: an optional tool whose handler/readiness/policy prerequisite is not satisfied for
   * this run (e.g. no live #2387 research grant, no approved skill, no resolvable child-agent
   * model) must be ABSENT from what the model is told exists, not merely denied when called.
   * Omitted or empty leaves every optional tool enabled, preserving this function's prior
   * deterministic output byte-for-byte. See `productionManagedWorktreeTools.ts`'s
   * `deriveOptionalToolAvailability` for the real, non-fake per-run signal this is meant to carry
   * (tracked outOfScopeNeeds against `opencodeRuntimeComposition.ts`'s launch-profile call site,
   * which does not yet thread it through).
   */
  readonly unavailableOptionalTools?: ReadonlySet<OpenCodeOptionalToolName> | undefined;
}

/** The three optional tools #3414-AC9 requires to be absent, never merely denied, when unready. */
export type OpenCodeOptionalToolName = "keiko_research_fetch" | "keiko_skill" | "keiko_child_agent";
export const OPENCODE_RUNTIME_MODEL_ALIAS = "coding";
export const OPENCODE_RUNTIME_READINESS_PROMPT = "Keiko runtime readiness handshake.";
const OPENCODE_PROVIDER_CHUNK_TIMEOUT_MS = 30 * 60_000;

/**
 * Replaces the pinned child's model-family default system prompt (v1.17.17 resolves the unknown
 * model id "coding" to its built-in-tool coding prompt). That default teaches bash/grep/glob/edit
 * workflows and "fewer than 4 lines" text answers while this config removes every built-in tool,
 * which live models followed into text-only turns that never reached a keiko_* tool (#2680
 * follow-up). The v1.17.17 child uses `agent.build.prompt` verbatim INSTEAD of that default and
 * still appends its environment block after it. Every OPENCODE_MODEL_VISIBLE_TOOL_NAMES entry
 * must stay documented here; the launch-profile test enforces that coupling.
 */
export const OPENCODE_GOVERNED_SYSTEM_PROMPT = `You are Keiko's governed autonomous coding agent working on one repository task inside a sandboxed workspace. The governed tools listed below are your ONLY way to observe or change that workspace. This session has no shell and no direct file access: built-in tools such as bash, read, write, edit, glob, grep, task, webfetch, websearch, apply_patch, lsp, plan, execute, git, or skill do not exist here and must never be called; skills run only through keiko_skill.

Governed workflow, in order:
1. Plan: keep a short plan up to date with todowrite so the operator can follow your progress.
2. Discover: keiko_workspace_discover returns only bounded, allowed workspace-relative file paths matching a short query. Use it when the task does not already identify the files; use * only for a bounded repository overview. keiko_repository_search searches repository CONTENTS (mode lexical, literal, regex or symbol) and returns bounded, allowed workspace-relative hits with continuation cursors; use its matches to locate call sites, definitions and strings, then read the relevant window before editing.
3. Read: keiko_workspace_read returns one file as a bounded line window (relativePath, startLine, maxLines). The result reports totalLines, nextStartLine when the window is truncated, and the SHA-256 digest of the whole file. Read every file before you edit it.
4. Edit: keiko_changeset_edit is the only way to change files. Submit one strict unified diff covering every listed file and bind each file to the expectedContentHash digest returned by its most recent keiko_workspace_read. On a digest mismatch, re-read the file and rebuild the patch instead of retrying it unchanged.
5. Verify: keiko_verification runs exactly one vetted verifier — test, targeted-test, typecheck, lint, or build. Verify after your edits and repair failures until verification passes; never report success without it.

Additional governed capabilities: keiko_research_fetch (one exact public https URL), keiko_skill (one approved read-only skill), and keiko_child_agent (one bounded read-only child agent) may be granted for some tasks; a denied result is a policy decision, not a transient error. Use question only when you are blocked on a decision that belongs to the operator.

Delivering your work, when granted: keiko_git_status and keiko_git_diff read the current Git state; keiko_git_stage proposes staging paths. keiko_git_commit proposes a commit message, keiko_git_push proposes pushing the last verified commit, and keiko_pull_request proposes a draft pull request title -- each of these three only PROPOSES, returning a proposalId; you never commit, push or open a pull request directly. When keiko_git_commit is blocked by the message policy, its result carries a violations array of exact codes (for example missing-conventional-prefix or subject-too-long); read it and fix the message yourself, then call keiko_git_commit again -- never ask the operator which commit format to use. A proposal needs a human approval through the operator's own approval channel before it can proceed. Once approved, call keiko_git_execute with the proposal's kind (stage, commit, push or pull-request) and its proposalId to redeem it; a denied result means no matching approval exists yet. keiko_ci_status observes the run's CI readiness (set forceFresh to bypass the cached snapshot) -- use it after a push or pull-request to decide whether to keep repairing before handing off.

Work in small read/edit/verify cycles, keep patches minimal, and never describe an edit in prose instead of submitting it through keiko_changeset_edit. Progress happens only through tool calls.`;
export type OpenCodeLaunchProfileResult =
  | {
      readonly ok: true;
      readonly executable: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly config: string;
    }
  | { readonly ok: false; readonly reason: "invalid-launch-input" | "secret-generation-failed" };

/** Fixed, secret-free-in-config launch shape. The password exists only in the child environment. */
export function buildOpenCodeLaunchProfile(
  input: OpenCodeLaunchProfileInput,
): OpenCodeLaunchProfileResult {
  if (!isAbsolute(input.executable) || !isAbsolute(input.stateRoot))
    return { ok: false, reason: "invalid-launch-input" };
  const secret = (input.randomBytes ?? nodeRandomBytes)(32);
  if (secret.length < 32) return { ok: false, reason: "secret-generation-failed" };
  const home = join(input.stateRoot, "home");
  return {
    ok: true,
    executable: input.executable,
    args: ["serve", "--hostname", "127.0.0.1", "--port", "0", "--no-mdns"],
    env: Object.freeze({
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(input.stateRoot, "config"),
      XDG_STATE_HOME: join(input.stateRoot, "state"),
      TMPDIR: join(input.stateRoot, "tmp"),
      TEMP: join(input.stateRoot, "tmp"),
      TMP: join(input.stateRoot, "tmp"),
      OPENCODE_CONFIG_DIR: join(input.stateRoot, "config", "opencode"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_DB: join(input.stateRoot, "state", "opencode.db"),
      OPENCODE_SERVER_PASSWORD: secret.toString("base64url"),
    }),
    config: JSON.stringify(createFixedOpenCodeConfig(input.unavailableOptionalTools)),
  };
}

function fixedOpenCodeProvider(): Readonly<Record<string, unknown>> {
  return {
    "keiko-runtime": {
      name: "Keiko Governed Coding Gateway",
      npm: "@ai-sdk/openai-compatible",
      env: [],
      models: {
        [OPENCODE_RUNTIME_MODEL_ALIAS]: {
          name: "Keiko Governed Coding",
          tool_call: true,
          limit: { context: 32_768, output: 4_096 },
          cost: { input: 0, output: 0 },
        },
      },
      options: {
        baseURL: "{env:KEIKO_MODEL_GATEWAY_URL}",
        // The pinned v1.17.17 child defaults provider chunks to 10 seconds. Coding turns can
        // legitimately reason longer while Keiko's gateway still enforces its shorter provider
        // deadline; align the child watchdog with the outer hard turn/authority ceiling.
        chunkTimeout: OPENCODE_PROVIDER_CHUNK_TIMEOUT_MS,
        headers: { Authorization: "Bearer {env:KEIKO_MODEL_GATEWAY_CAPABILITY}" },
      },
    },
  };
}

// #3414-AC9: an optional tool whose handler/readiness/policy prerequisite is unavailable for this
// run is excluded from BOTH the tool-enablement map and the permission map -- absent, not merely
// denied at call time. `unavailable` empty (the default) reproduces the prior unconditional
// allow-everything shape byte-for-byte.
function fixedOpenCodeTools(
  unavailable: ReadonlySet<OpenCodeOptionalToolName>,
): Readonly<Record<string, boolean>> {
  return Object.fromEntries([
    ["*", false] as const,
    ...OPENCODE_PINNED_BUILT_IN_TOOLS.map((tool) => [tool, false] as const),
    ...OPENCODE_MODEL_VISIBLE_TOOL_NAMES.map(
      (tool) => [tool, !unavailable.has(tool as OpenCodeOptionalToolName)] as const,
    ),
  ]);
}

function fixedOpenCodePermission(
  unavailable: ReadonlySet<OpenCodeOptionalToolName>,
): Readonly<Record<string, string>> {
  return Object.fromEntries([
    ["*", "deny"] as const,
    ...OPENCODE_PINNED_BUILT_IN_TOOLS.map((tool) => [tool, "deny"] as const),
    [OPENCODE_GOVERNED_ACTION_PERMISSION, "ask"] as const,
    ...OPENCODE_MODEL_VISIBLE_TOOL_NAMES.map(
      (tool) =>
        [tool, unavailable.has(tool as OpenCodeOptionalToolName) ? "deny" : "allow"] as const,
    ),
  ]);
}

export function createFixedOpenCodeConfig(
  unavailableOptionalTools?: ReadonlySet<OpenCodeOptionalToolName>,
): {
  readonly autoupdate: false;
  readonly snapshot: false;
  readonly model: string;
  readonly agent: Readonly<Record<string, { readonly prompt: string }>>;
  readonly provider: Readonly<Record<string, unknown>>;
  readonly tools: Readonly<Record<string, boolean>>;
  readonly permission: Readonly<Record<string, string>>;
} {
  const unavailable = unavailableOptionalTools ?? new Set<OpenCodeOptionalToolName>();
  return {
    autoupdate: false,
    snapshot: false,
    model: `keiko-runtime/${OPENCODE_RUNTIME_MODEL_ALIAS}`,
    // "build" is the pinned child's default primary agent; its prompt override replaces the
    // misleading built-in-tool default prompt for every governed turn.
    agent: { build: { prompt: OPENCODE_GOVERNED_SYSTEM_PROMPT } },
    provider: fixedOpenCodeProvider(),
    tools: fixedOpenCodeTools(unavailable),
    permission: fixedOpenCodePermission(unavailable),
  };
}
