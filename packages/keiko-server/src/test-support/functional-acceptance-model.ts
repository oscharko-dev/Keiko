// The scripted model of the acceptance task (#4492). It plays the part of a model that is given
// the task "the tests fail; fix src/ and run npm test until it passes": it runs the check in the
// runtime's own shell, reads the target file, replaces it with the runtime's own `edit` and runs
// the check again, unless the case skips that check or makes it stale with one more edit.
//
// It lives here and not in `productionOpenCodeBackend.functional/_support.ts` on purpose: that
// file is part of the coding-runtime performance ruler (`CODING_PERFORMANCE_TOOLCHAIN_PATHS`), and
// a scripted model the measurement never uses must not change the ruler's digest. The pipeline
// installs it through `withFunctionalChat` (`functional-bff-server`); it imports no other
// test-support module (ADR-0019 trust rule 8), so the caller names the model it answers as.

import type { GatewayRequest, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";

import { scriptedTranscript } from "../coding-runtime/productionOpenCodeBackend.functional/_support.js";

/** The Node.js projects' check an acceptance run runs in its own shell, before and after its edit. */
export const ACCEPTANCE_CHECK_COMMAND = "npm test";

/** The Maven project's check: quiet, so a passing run prints nothing, and non-interactive. */
export const ACCEPTANCE_MAVEN_CHECK_COMMAND = "mvn -B -q test";

/** The command of a project whose dependency only a registry behind a token serves (#4530). */
export const ACCEPTANCE_NPM_INSTALL_COMMAND = "npm install";

/** A cold Maven build resolves its plugins first; a Node.js check needs far less. */
const CHECK_TIMEOUT_MS = 120_000;

/** What a `stale-check` acceptance turn appends after its check passed. */
export const ACCEPTANCE_STALE_SUFFIX = "// Reviewed after the tests passed.\n";

/** Whether the turn reruns the check after its edit, never does, or edits again after it. */
export type AcceptancePlan = "verify" | "skip-check" | "stale-check";

/**
 * Where a `verify` turn also calls Keiko's governed verifier (#4519): directly after its edit, so
 * its own shell check follows the governed answer, or after that shell check.
 */
export type AcceptanceGovernedCall = "after-edit" | "after-check";

export interface AcceptanceModelScript {
  /** The model the answers name: the pipeline's own chat model. */
  readonly modelId: string;
  /** The workspace-relative file the turn reads and repairs. */
  readonly target: string;
  /** The project's own check, run in the runtime's shell before and after the edit. */
  readonly checkCommand: string;
  readonly old: string;
  readonly next: string;
  readonly plan: AcceptancePlan;
  /**
   * The installation of the project's dependencies, run in its own shell call before the turn's
   * read and edit; a turn with one skips the check before its edit. Only the `verify` plan runs it.
   */
  readonly installCommand?: string;
  /** The turn's governed verifier call, if any; only the `verify` plan without an install has one. */
  readonly governedVerification?: AcceptanceGovernedCall;
}

/** One tool call of the turn: the runtime tool's name and its arguments. */
export type AcceptanceToolCall = readonly [
  name: "shell" | "read" | "edit" | "keiko_verification",
  args: object,
];

/** The governed verifier call: the project's configured test verifier, found from the root. */
const GOVERNED_TEST: AcceptanceToolCall = [
  "keiko_verification",
  { verifierId: "test", targetPath: "", packageDir: "" },
];

/** The turn's tool calls, in order; after the last one the model answers without a tool. */
export function acceptanceToolCalls(script: AcceptanceModelScript): readonly AcceptanceToolCall[] {
  const check: AcceptanceToolCall = [
    "shell",
    { command: script.checkCommand, timeout: CHECK_TIMEOUT_MS },
  ];
  const opening: readonly AcceptanceToolCall[] = [
    check,
    ["read", { path: script.target }],
    ["edit", { path: script.target, oldString: script.old, newString: script.next }],
  ];
  if (script.plan === "skip-check") return opening;
  if (script.plan === "verify") {
    if (script.installCommand === undefined) {
      return verifyCalls(opening, check, script.governedVerification);
    }
    // The dependencies are missing, so a check before the install says nothing. The install comes
    // first on purpose: the runtime weighs the files a shell command wrote only after the step
    // ended, so an install directly before the check is counted as an edit the check did not
    // see and the run would need a second check.
    const [, ...repair] = opening;
    return [
      ["shell", { command: script.installCommand, timeout: CHECK_TIMEOUT_MS }],
      ...repair,
      check,
    ];
  }
  return [
    ...opening,
    check,
    [
      "edit",
      {
        path: script.target,
        oldString: script.next,
        newString: `${script.next}${ACCEPTANCE_STALE_SUFFIX}`,
      },
    ],
  ];
}

function verifyCalls(
  opening: readonly AcceptanceToolCall[],
  check: AcceptanceToolCall,
  governed: AcceptanceGovernedCall | undefined,
): readonly AcceptanceToolCall[] {
  if (governed === "after-edit") return [...opening, GOVERNED_TEST, check];
  if (governed === "after-check") return [...opening, check, GOVERNED_TEST];
  return [...opening, check];
}

/**
 * The model's answer to one gateway request. The turn advances by the tool replies the runtime
 * resends, never by how often the model was called, so a repeated call cannot skip or repeat a
 * step. A request that offers no tools (the runtime's own title request) gets a plain answer.
 */
export function acceptanceResponse(
  script: AcceptanceModelScript,
  request: GatewayRequest,
): NormalizedResponse {
  if (request.toolCatalog === undefined) return answer(script.modelId);
  const call = acceptanceToolCalls(script)[toolReplyCount(scriptedTranscript(request))];
  return call === undefined ? answer(script.modelId) : toolCallResponse(script.modelId, call);
}

function toolReplyCount(transcript: string): number {
  const messages: unknown = transcript === "" ? [] : JSON.parse(transcript);
  if (!Array.isArray(messages)) return 0;
  return messages.filter(
    (message: unknown) =>
      typeof message === "object" &&
      message !== null &&
      (message as { readonly role?: unknown }).role === "tool",
  ).length;
}

let toolCallSequence = 0;

function toolCallResponse(modelId: string, [name, args]: AcceptanceToolCall): NormalizedResponse {
  toolCallSequence += 1;
  return {
    ...answer(modelId),
    content: "",
    finishReason: "tool_calls",
    toolCalls: [
      {
        id: `acceptance-${name}-${String(toolCallSequence)}`,
        name,
        arguments: { ...args },
      },
    ],
  };
}

function answer(modelId: string): NormalizedResponse {
  return {
    modelId,
    content: "The acceptance turn is complete.",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "acceptance",
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
      costClass: "low",
    },
  };
}
