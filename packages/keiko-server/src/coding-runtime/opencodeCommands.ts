import {
  CODING_WORKBENCH_COMMANDS_MAX,
  CODING_WORKBENCH_MENTIONABLES_MAX,
  validateCodingWorkbenchRuntimeCommandsChannelPayload,
  type CodingWorkbenchCommand,
  type CodingWorkbenchMentionableAgent,
  type CodingWorkbenchMentionableSkill,
  type CodingWorkbenchPromptMentions,
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
import type {
  OpenCodeV2Agent,
  OpenCodeV2Command,
  OpenCodeV2HttpClient,
  OpenCodeV2Skill,
} from "./opencodeV2HttpClient.js";

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
  /** The run's workspace: the location the runtime lists its subagents and skills for. */
  readonly workspaceRoot: string;
  readonly client: Pick<OpenCodeV2HttpClient, "commands" | "agents" | "skills">;
}

/** The subagents and skills a prompt of the run may mention, as the browser may receive them. */
export interface CodingRuntimeMentionables {
  readonly agents: readonly CodingWorkbenchMentionableAgent[];
  readonly skills: readonly CodingWorkbenchMentionableSkill[];
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
   * The subagents and skills the run's runtime lists right now for the `@` and `$` menus (S15,
   * #3906), or `undefined` when the run offers none. Never throws; one body-free line per listing.
   */
  readonly listMentions: (
    runId: string,
    correlationId?: string,
  ) => Promise<CodingRuntimeMentionables | undefined>;
  /**
   * Confirms, before anything is reserved or sent, that the runtime lists the command an admitted
   * turn names and every subagent and skill it mentions: the runtime itself stores any name it is
   * given, so this check is what keeps an unlisted one out. A turn that names none is returned
   * unchanged. Never throws; a refusal is recorded as one body-free line on the prompt-inputs
   * operation.
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
  /** Waits between the reads of a location that is still loading; injectable for tests. */
  readonly pause?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * The pinned 2.1.4 loads a location's agents and skills on its first touch, and answers that first
 * read with an empty listing (proven on the original executable). Its built-in subagents are always
 * listed once it has loaded, so an empty agent listing means "not loaded yet": it is read again, a
 * bounded number of times, before anything is decided from it.
 */
const LOCATION_LOAD_READS = 6;
const LOCATION_LOAD_PAUSE_MS = 250;

const realPause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function loadedAgents(
  deps: OpenCodeCommandsRunPortDeps,
  run: CommandsRun,
): Promise<readonly OpenCodeV2Agent[]> {
  const pause = deps.pause ?? realPause;
  let agents = await run.client.agents(run.workspaceRoot);
  for (let read = 1; read < LOCATION_LOAD_READS && agents.length === 0; read += 1) {
    await pause(LOCATION_LOAD_PAUSE_MS);
    agents = await run.client.agents(run.workspaceRoot);
  }
  return agents;
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

const MENTIONS_LISTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.mentions.listed",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeCommands.recordMentionsListed",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["failed", "listed", "unavailable", "unsupported"],
    },
    // How many subagents and skills the browser was given, and how many of the runtime's entries
    // were left out (a name or description the contract does not admit, a repeat, past the bound).
    agentCount: { type: "integer", dataClass: "count", required: false },
    skillCount: { type: "integer", dataClass: "count", required: false },
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
  proofIds: ["coding-runtime.mentions.listed.emitted-line"],
  releaseImpact: "patch",
});

type MentionsListedSettlement =
  | { readonly outcome: "unavailable" | "unsupported" }
  | {
      readonly outcome: "listed";
      readonly agentCount: number;
      readonly skillCount: number;
      readonly skippedCount: number;
    }
  | { readonly outcome: "failed"; readonly error: unknown };

/** One body-free line per mentions listing: counts only, never a name or a description. */
export function recordMentionsListed(
  activityLog: ServerLogSink | undefined,
  runId: string,
  settled: MentionsListedSettlement,
  correlationId?: string,
): void {
  const failed = settled.outcome === "failed";
  const { outcome } = settled;
  (activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      MENTIONS_LISTED_OPERATION,
      {
        level: failed ? "warn" : "info",
        correlationId: correlationIdOrUnknown(correlationId ?? runId),
        ...(failed
          ? { errorKind: activityLogErrorKindOr(errorKindOf(settled.error), "internal") }
          : {}),
      },
      {
        runId,
        outcome,
        ...(settled.outcome === "listed"
          ? {
              agentCount: settled.agentCount,
              skillCount: settled.skillCount,
              skippedCount: settled.skippedCount,
            }
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

type ListingFailure =
  | { readonly outcome: "unavailable" | "unsupported" }
  | { readonly outcome: "failed"; readonly error: unknown };

/**
 * The one listing lifecycle of the run's menus: every read ends in exactly one settled line, a
 * failed read included, and the browser is given nothing it was not told about.
 */
async function listForRun<T, S extends { readonly outcome: "listed" }>(
  deps: OpenCodeCommandsRunPortDeps,
  runId: string,
  supported: boolean,
  recordListing: (settled: S | ListingFailure) => void,
  read: (run: CommandsRun) => Promise<readonly [T, S]>,
): Promise<T | undefined> {
  if (!supported) {
    recordListing({ outcome: "unsupported" });
    return undefined;
  }
  const run = deps.readyRun(runId);
  if (run === undefined) {
    recordListing({ outcome: "unavailable" });
    return undefined;
  }
  try {
    const [value, listed] = await read(run);
    recordListing(listed);
    return value;
  } catch (error) {
    recordListing({ outcome: "failed", error });
    return undefined;
  }
}

function listRunCommands(
  deps: OpenCodeCommandsRunPortDeps,
  runId: string,
  correlationId: string | undefined,
): Promise<readonly CodingWorkbenchCommand[] | undefined> {
  return listForRun(
    deps,
    runId,
    deps.capabilities.commands === true,
    (settled: CommandsListedSettlement) => {
      recordCommandsListed(deps.activityLog, runId, settled, correlationId);
    },
    async (run) => {
      const projection = projectCommands(await run.client.commands());
      const listed = {
        outcome: "listed",
        commandCount: projection.commands.length,
        skippedCount: projection.skippedCount,
      } as const;
      return [projection.commands, listed] as const;
    },
  );
}

// An entry the browser's validation would refuse is first offered without its description, then
// left out; the contract's validator is the judge, as for a command.
function acceptedEntry<T extends { readonly description?: string | undefined }>(
  entry: T,
  key: "agents" | "skills",
): T | undefined {
  const { description, ...bare } = entry;
  const candidates = description === undefined ? [entry] : [entry, bare as T];
  return candidates.find(
    (candidate) =>
      validateCodingWorkbenchRuntimeCommandsChannelPayload({
        session: "active",
        [key]: [candidate],
      }).ok,
  );
}

function projectList<T extends { readonly description?: string | undefined }>(
  listing: readonly T[],
  key: "agents" | "skills",
  identity: (entry: T) => string,
): readonly T[] {
  const seen = new Set<string>();
  const accepted: T[] = [];
  for (const entry of listing) {
    const kept = acceptedEntry(entry, key);
    if (kept === undefined || seen.has(identity(kept))) continue;
    if (accepted.length === CODING_WORKBENCH_MENTIONABLES_MAX) break;
    seen.add(identity(kept));
    accepted.push(kept);
  }
  return accepted;
}

/** Bounded, duplicate-free and contract-valid: what the browser is given of both listings. */
export function projectMentionables(
  agents: readonly OpenCodeV2Agent[],
  skills: readonly OpenCodeV2Skill[],
): CodingRuntimeMentionables & { readonly skippedCount: number } {
  const keptAgents = projectList(agents, "agents", (entry) => entry.name);
  const keptSkills = projectList(skills, "skills", (entry) => entry.id);
  return {
    agents: keptAgents,
    skills: keptSkills,
    skippedCount: agents.length + skills.length - keptAgents.length - keptSkills.length,
  };
}

function listRunMentions(
  deps: OpenCodeCommandsRunPortDeps,
  runId: string,
  correlationId: string | undefined,
): Promise<CodingRuntimeMentionables | undefined> {
  return listForRun(
    deps,
    runId,
    deps.capabilities.mentions === true,
    (settled: MentionsListedSettlement) => {
      recordMentionsListed(deps.activityLog, runId, settled, correlationId);
    },
    async (run) => {
      // The skills are read once the location has loaded, which the agent listing shows.
      const agents = await loadedAgents(deps, run);
      const skills = await run.client.skills(run.workspaceRoot);
      const projected = projectMentionables(agents, skills);
      const listed = {
        outcome: "listed",
        agentCount: projected.agents.length,
        skillCount: projected.skills.length,
        skippedCount: projected.skippedCount,
      } as const;
      return [{ agents: projected.agents, skills: projected.skills }, listed] as const;
    },
  );
}

// Every mention must name an entry the runtime lists for the run's workspace right now, read once
// the location has loaded.
async function unlistedMention(
  deps: OpenCodeCommandsRunPortDeps,
  run: CommandsRun,
  mentions: CodingWorkbenchPromptMentions,
): Promise<boolean> {
  const agents = await loadedAgents(deps, run);
  const skills = mentions.skills === undefined ? [] : await run.client.skills(run.workspaceRoot);
  const agentNames = new Set(agents.map((entry) => entry.name));
  const skillIds = new Set(skills.map((entry) => entry.id));
  return (
    (mentions.agents ?? []).some((entry) => !agentNames.has(entry.name)) ||
    (mentions.skills ?? []).some((entry) => !skillIds.has(entry.id))
  );
}

async function admitRunMentions(
  deps: OpenCodeCommandsRunPortDeps,
  runId: string,
  inputs: AdmittedPromptInputs,
): Promise<PromptInputsAdmission> {
  const mentions = inputs.mentions;
  if (mentions === undefined) return { ok: true, inputs };
  if (deps.capabilities.mentions !== true) {
    return recordRefusal(deps, runId, inputs, "mentions-unsupported");
  }
  const run = deps.readyRun(runId);
  if (run === undefined) return recordRefusal(deps, runId, inputs, "run-unavailable");
  try {
    return (await unlistedMention(deps, run, mentions))
      ? recordRefusal(deps, runId, inputs, "mention-unknown")
      : { ok: true, inputs };
  } catch (error) {
    // A listing the runtime could not give proves nothing about a name: the turn is not started.
    return recordRefusal(deps, runId, inputs, "mention-unavailable", error);
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
    listMentions: (runId, correlationId) => listRunMentions(deps, runId, correlationId),
    // The command first, then the mentions: each refusal is its own closed line, and a turn that
    // names neither passes through both unchanged.
    admitCommand: async (runId, inputs): Promise<PromptInputsAdmission> => {
      const command = await admitRunCommand(deps, runId, inputs);
      return command.ok ? admitRunMentions(deps, runId, command.inputs) : command;
    },
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
