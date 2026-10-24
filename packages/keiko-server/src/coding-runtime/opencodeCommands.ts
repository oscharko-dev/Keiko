import {
  CODING_WORKBENCH_COMMANDS_MAX,
  validateCodingWorkbenchRuntimeCommandsChannelPayload,
  type CodingWorkbenchCommand,
  type CodingWorkbenchRuntimePromptInputs,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import {
  activityLogErrorKindOr,
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  causeChain,
  errorKindOf,
  keikoStackFrames,
  type ServerLogSink,
} from "@oscharko-dev/keiko-activity-log";

import { correlationIdOrUnknown } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import {
  recordPromptInputs,
  type AdmittedPromptInputs,
  type PromptInputsAdmission,
  type PromptInputsRefusal,
} from "./opencodePromptInputs.js";
import type { OpenCodeV2Command, OpenCodeV2HttpClient } from "./opencodeV2HttpClient.js";

/**
 * The slash commands of a native run (C02, ADR-0137 D10). A command is a prompt template the
 * runtime owns: `init` (guided AGENTS.md setup) and `review` (review of the changes) are its
 * built-ins, and the project layer that could add more stays off. Keiko lists the names the runtime
 * reports, admits a turn only for one of them, and hands the runtime the name and the text after it;
 * the template, whatever it asks of the model, is untrusted intent like any task text and every
 * effect it causes passes the run's native policy. Nothing here grants a command anything.
 */

/** The part of a ready run the commands need; `ReadyRun` of the composition satisfies it. */
export interface CommandsRun {
  readonly runId: string;
  readonly client: Pick<OpenCodeV2HttpClient, "commands">;
}

export interface OpenCodeCommandsRunPort {
  /**
   * The commands the run's runtime lists right now, bounded and shaped for the browser, or
   * `undefined` when the run offers none: its profile has no commands, it is not live, or the
   * listing failed. Never throws; every outcome is one body-free line.
   */
  readonly listCommands: (
    runId: string,
    correlationId?: string,
  ) => Promise<readonly CodingWorkbenchCommand[] | undefined>;
  /**
   * Confirms, before anything is reserved or sent, that the runtime lists the command an admitted
   * turn names. A turn that names none is returned unchanged. Never throws; a refusal is recorded
   * as one body-free line on the prompt-inputs operation.
   */
  readonly admitCommand: (
    runId: string,
    inputs: AdmittedPromptInputs,
  ) => Promise<PromptInputsAdmission>;
}

export interface OpenCodeCommandsRunPortDeps {
  readonly readyRun: (runId: string) => CommandsRun | undefined;
  readonly capabilities: CodingWorkbenchRuntimePromptInputs;
  readonly activityLog: ServerLogSink | undefined;
}

const COMMANDS_LISTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.commands.listed",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeCommands.recordCommandsListed",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["failed", "listed", "unavailable", "unsupported"],
    },
    // How many commands the browser was given, and how many of the runtime's entries were left out
    // (a name or description the contract does not admit, a repeat, or one past the bound).
    commandCount: { type: "integer", dataClass: "count", required: false },
    skippedCount: { type: "integer", dataClass: "count", required: false },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-prompt-inputs"],
  proofIds: ["coding-runtime.commands.listed.emitted-line"],
  releaseImpact: "patch",
});

type CommandsListedSettlement =
  | { readonly outcome: "unavailable" | "unsupported" }
  | { readonly outcome: "listed"; readonly commandCount: number; readonly skippedCount: number }
  | { readonly outcome: "failed"; readonly error: unknown };

/**
 * One body-free line per listing: the run, the closed outcome and the counts. A failed listing
 * carries the closed error kind, the Keiko frames and the cause chain, so a menu that came up empty
 * is explained by the log alone. No name, description or template ever enters it.
 */
export function recordCommandsListed(
  activityLog: ServerLogSink | undefined,
  runId: string,
  settled: CommandsListedSettlement,
  correlationId?: string,
): void {
  const failed = settled.outcome === "failed";
  (activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      COMMANDS_LISTED_OPERATION,
      {
        level: failed ? "warn" : "info",
        correlationId: correlationIdOrUnknown(correlationId ?? runId),
        ...(failed
          ? { errorKind: activityLogErrorKindOr(errorKindOf(settled.error), "internal") }
          : {}),
      },
      {
        runId,
        outcome: settled.outcome,
        ...(settled.outcome === "listed"
          ? { commandCount: settled.commandCount, skippedCount: settled.skippedCount }
          : {}),
        ...(failed
          ? { frames: keikoStackFrames(settled.error), causeChain: causeChain(settled.error) }
          : {}),
      },
    ),
  );
}

/**
 * The entry as the browser may receive it. The contract's own validator is the judge, so a listing
 * this module returns is one the browser's validation accepts: an entry whose description it
 * refuses (unsafe format characters, say) keeps its name, and an entry whose name it refuses is
 * left out.
 */
function browserEntry(entry: OpenCodeV2Command): CodingWorkbenchCommand | undefined {
  const candidates: readonly CodingWorkbenchCommand[] =
    entry.description === undefined ? [{ name: entry.name }] : [entry, { name: entry.name }];
  return candidates.find(
    (candidate) =>
      validateCodingWorkbenchRuntimeCommandsChannelPayload({
        session: "active",
        commands: [candidate],
      }).ok,
  );
}

interface CommandProjection {
  readonly commands: readonly CodingWorkbenchCommand[];
  readonly skippedCount: number;
}

/** Bounded, duplicate-free and contract-valid: what the browser is given of the runtime's listing. */
export function projectCommands(listing: readonly OpenCodeV2Command[]): CommandProjection {
  const seen = new Set<string>();
  const commands: CodingWorkbenchCommand[] = [];
  for (const entry of listing) {
    const accepted = browserEntry(entry);
    if (accepted === undefined || seen.has(accepted.name)) continue;
    if (commands.length === CODING_WORKBENCH_COMMANDS_MAX) break;
    seen.add(accepted.name);
    commands.push(accepted);
  }
  return { commands, skippedCount: listing.length - commands.length };
}

async function listRunCommands(
  deps: OpenCodeCommandsRunPortDeps,
  runId: string,
  correlationId: string | undefined,
): Promise<readonly CodingWorkbenchCommand[] | undefined> {
  const settle = (settled: CommandsListedSettlement): void => {
    recordCommandsListed(deps.activityLog, runId, settled, correlationId);
  };
  if (deps.capabilities.commands !== true) {
    settle({ outcome: "unsupported" });
    return undefined;
  }
  const run = deps.readyRun(runId);
  if (run === undefined) {
    settle({ outcome: "unavailable" });
    return undefined;
  }
  try {
    const projection = projectCommands(await run.client.commands());
    settle({
      outcome: "listed",
      commandCount: projection.commands.length,
      skippedCount: projection.skippedCount,
    });
    return projection.commands;
  } catch (error) {
    recordCommandsListed(deps.activityLog, runId, { outcome: "failed", error }, correlationId);
    return undefined;
  }
}

function recordRefusal(
  deps: OpenCodeCommandsRunPortDeps,
  runId: string,
  inputs: AdmittedPromptInputs,
  reason: PromptInputsRefusal,
  error?: unknown,
): PromptInputsAdmission {
  recordPromptInputs(deps.activityLog, runId, inputs, {
    outcome: "refused",
    reason,
    ...(error === undefined
      ? {}
      : { errorKind: activityLogErrorKindOr(errorKindOf(error), "internal") }),
  });
  return { ok: false, reason };
}

/**
 * The runtime refused, or could not be told of, a command turn that was admitted: one refused line
 * with the closed error kind. The turn itself fails through the composition's own diagnostics.
 */
export function recordCommandPostRefused(
  activityLog: ServerLogSink | undefined,
  runId: string,
  inputs: AdmittedPromptInputs,
  error: unknown,
): void {
  recordPromptInputs(activityLog, runId, inputs, {
    outcome: "refused",
    reason: "command-refused",
    errorKind: activityLogErrorKindOr(errorKindOf(error), "internal"),
  });
}

async function admitRunCommand(
  deps: OpenCodeCommandsRunPortDeps,
  runId: string,
  inputs: AdmittedPromptInputs,
): Promise<PromptInputsAdmission> {
  const command = inputs.command;
  if (command === undefined) return { ok: true, inputs };
  if (deps.capabilities.commands !== true) {
    return recordRefusal(deps, runId, inputs, "commands-unsupported");
  }
  const run = deps.readyRun(runId);
  if (run === undefined) return recordRefusal(deps, runId, inputs, "run-unavailable");
  try {
    const listed = await run.client.commands();
    return listed.some((entry) => entry.name === command.name)
      ? { ok: true, inputs }
      : recordRefusal(deps, runId, inputs, "command-unknown");
  } catch (error) {
    // A listing the runtime could not give proves nothing about the name: the turn is not started.
    return recordRefusal(deps, runId, inputs, "command-unavailable", error);
  }
}

export function createOpenCodeCommandsRunPort(
  deps: OpenCodeCommandsRunPortDeps,
): OpenCodeCommandsRunPort {
  return {
    listCommands: (runId, correlationId) => listRunCommands(deps, runId, correlationId),
    admitCommand: (runId, inputs) => admitRunCommand(deps, runId, inputs),
  };
}

/**
 * How a command turn is shown (C02). The runtime stores the command's expanded template as the
 * turn's user message and marks no command on it, so the timeline and Coding History would carry
 * the template, which is thousands of characters of the runtime's own instructions, in place of
 * what the operator typed. The turn is armed with its display text (`/review main`) just before the
 * command is posted; the first user message the history then shows that it had not shown before is
 * that command's, and is presented by this text. A turn that is not a command disarms it, so no
 * later message can take a command's place.
 */
export interface OpenCodeCommandPresentation {
  readonly arm: (display: string) => void;
  readonly disarm: () => void;
  /**
   * The text a user message is presented by, when it is a command's. `isNew` says the history had
   * not shown the message before this read; a message bound once keeps its text on every later read.
   */
  readonly displayFor: (messageId: string, isNew: boolean) => string | undefined;
}

/** The most command messages one run remembers; the oldest is forgotten first. */
export const OPENCODE_COMMAND_PRESENTATION_MAX = 64;

export function createOpenCodeCommandPresentation(): OpenCodeCommandPresentation {
  const bound = new Map<string, string>();
  const state: { armed: string | undefined } = { armed: undefined };
  return {
    arm: (display): void => {
      state.armed = display;
    },
    disarm: (): void => {
      state.armed = undefined;
    },
    displayFor: (messageId, isNew): string | undefined => {
      const held = bound.get(messageId);
      if (held !== undefined || !isNew || state.armed === undefined) return held;
      const display = state.armed;
      state.armed = undefined;
      if (bound.size === OPENCODE_COMMAND_PRESENTATION_MAX) {
        const oldest = bound.keys().next().value;
        if (oldest !== undefined) bound.delete(oldest);
      }
      bound.set(messageId, display);
      return display;
    },
  };
}

/** The text a command turn is presented by: the command as the operator typed it. */
export function commandDisplayText(name: string, argumentsText: string): string {
  const trimmed = argumentsText.trim();
  return trimmed.length === 0 ? `/${name}` : `/${name} ${trimmed}`;
}
