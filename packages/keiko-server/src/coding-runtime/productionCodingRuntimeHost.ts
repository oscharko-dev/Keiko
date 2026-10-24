import type { CodingWorkbenchAgent } from "@oscharko-dev/keiko-contracts";
import type {
  CodingWorkbenchCommand,
  CodingWorkbenchCommandRequest,
  CodingWorkbenchPromptMentions,
  CodingWorkbenchPromptDelivery,
  CodingWorkbenchPromptReference,
  CodingWorkbenchRuntimeInboxAction,
  CodingWorkbenchRuntimeRevertAction,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import type { CodingRuntimeHost } from "./codingRuntimeControlPlane.js";
import type { CodingRuntimeMentionables } from "./opencodeCommands.js";
import type { CodingRuntimeInboxItems, CodingRuntimeInboxResult } from "./codingRuntimeInbox.js";
import type { CodingRuntimeRevertResult, CodingRuntimeRevertState } from "./codingRuntimeRevert.js";

export type CodingRuntimeTaskOutcome = "cancelled" | "failed" | "succeeded";

export type CodingRuntimeTaskDispatchResult =
  | { readonly ok: true; readonly completion: Promise<CodingRuntimeTaskOutcome> }
  | {
      readonly ok: false;
      /**
       * The closed cause when the refusal is the request's own and not a transport or authority
       * failure: the run's runtime cannot honour the requested primary agent (#3897), or the prompt
       * carries inputs it cannot take (a delivery its profile does not offer or no turn is running
       * for, a reference that is not a contained text file). Absent for every other refusal, which
       * keeps its existing answer.
       */
      readonly reason?: "agent-unsupported" | "inputs-refused" | undefined;
    };

/** The answer to a message delivered into the turn in flight: it starts no turn, so no completion. */
export type CodingRuntimeTaskDeliveryResult =
  { readonly ok: true } | { readonly ok: false; readonly reason?: "inputs-refused" | undefined };

export interface CodingRuntimeRunOperation {
  readonly runId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
}

export interface CodingRuntimeTaskDispatchRequest extends CodingRuntimeRunOperation {
  readonly taskIntent: string;
  /** Request-scoped diagnostic join; never persisted or forwarded to the model. */
  readonly correlationId?: string | undefined;
  /** Transient server-owned context; never user intent, persistence or skill authorization. */
  readonly initialContext?: string | undefined;
  /**
   * The primary agent the turn runs under. Absent keeps the run's current agent (the default
   * `build` for a run that never named one), exactly as before.
   */
  readonly agent?: CodingWorkbenchAgent | undefined;
  /**
   * Set only on a delivery (`CodingRuntimeTaskDispatcher.deliver`): the message joins the turn in
   * flight as `steer` or `queue` and starts none, so a dispatch or replacement never carries it.
   */
  readonly delivery?: CodingWorkbenchPromptDelivery | undefined;
  /** Workspace files the prompt references, relative to the run's workspace root (ADR-0137 D10). */
  readonly references?: readonly CodingWorkbenchPromptReference[] | undefined;
  /**
   * Runs the turn as one of the runtime's slash commands, `taskIntent` being the text after it.
   * Only a dispatch or a replacement carries it; the dispatcher confirms the run's runtime lists
   * the name before anything is reserved.
   */
  readonly command?: CodingWorkbenchCommandRequest | undefined;
  /**
   * The runtime's subagents and skills the prompt mentions (S15, #3906). The dispatcher confirms the
   * run's runtime lists every one before anything is reserved.
   */
  readonly mentions?: CodingWorkbenchPromptMentions | undefined;
}

/** One undo or restore of the run's newest turn, admitted like any other operator operation. */
export interface CodingRuntimeRevertRequest extends CodingRuntimeRunOperation {
  readonly action: CodingWorkbenchRuntimeRevertAction;
  /** Request-scoped diagnostic join; never persisted or forwarded to the model. */
  readonly correlationId?: string | undefined;
}

/** One withdrawal or promotion of a pending message, admitted like any other operator operation. */
export interface CodingRuntimeInboxActionRequest extends CodingRuntimeRunOperation {
  readonly action: CodingWorkbenchRuntimeInboxAction;
  /** The runtime's id of the pending message; the run port proves it is the operator's own. */
  readonly itemId: string;
  /** Request-scoped diagnostic join; never persisted or forwarded to the model. */
  readonly correlationId?: string | undefined;
}

export interface CodingRuntimeTaskDispatcher {
  readonly dispatch: (
    request: CodingRuntimeTaskDispatchRequest,
  ) => Promise<CodingRuntimeTaskDispatchResult>;
  /** Replaces one operator-paused turn after interrupting it at the native adapter boundary. */
  readonly replace?:
    | ((request: CodingRuntimeTaskDispatchRequest) => Promise<CodingRuntimeTaskDispatchResult>)
    | undefined;
  readonly abort: (request: CodingRuntimeRunOperation) => Promise<boolean>;
  /**
   * Delivers a `steer` or `queue` message into the turn that is running. It is admitted like any
   * other delegation (live authority, one revision, a single-use request id) but starts, replaces
   * and settles no turn. Absent for a runtime that cannot take one, which then refuses it as the
   * request's own fault. Never rejects.
   */
  readonly deliver?:
    | ((request: CodingRuntimeTaskDispatchRequest) => Promise<CodingRuntimeTaskDeliveryResult>)
    | undefined;
  /**
   * The slash commands the run's runtime lists right now, or `undefined` when the run offers none.
   * Never rejects; the run port records one body-free line for each listing.
   */
  readonly commands?:
    | ((
        runId: string,
        correlationId?: string,
      ) => Promise<readonly CodingWorkbenchCommand[] | undefined>)
    | undefined;
  /**
   * The subagents and skills the run's runtime lists right now (S15, #3906), or `undefined` when the
   * run offers none. Never rejects; the run port records one body-free line for each listing.
   */
  readonly mentions?:
    | ((runId: string, correlationId?: string) => Promise<CodingRuntimeMentionables | undefined>)
    | undefined;
  /**
   * Undoes the run's newest turn or restores an undo (B3, S04). Absent for a runtime without
   * snapshots, which then refuses the operation as the request's own fault. Never rejects.
   */
  readonly revert?:
    ((request: CodingRuntimeRevertRequest) => Promise<CodingRuntimeRevertResult>) | undefined;
  /** The counts the Workbench shows beside the undo control; absent when no undo is available. */
  readonly revertState?:
    ((runId: string) => Promise<CodingRuntimeRevertState | undefined>) | undefined;
  /**
   * The messages the operator sent into the running turn that the runtime has not handed to the
   * model yet, or `undefined` when the run offers none (S07). Never rejects; the run port records
   * one body-free line for each listing.
   */
  readonly inbox?:
    | ((runId: string, correlationId?: string) => Promise<CodingRuntimeInboxItems | undefined>)
    | undefined;
  /**
   * Withdraws or promotes one pending message. Admitted like a revert: the live authority is
   * revalidated, the revision is consumed once and the request id is single-use. Absent for a
   * runtime that takes no delivery, which then refuses it as the request's own fault. Never rejects.
   */
  readonly inboxAction?:
    ((request: CodingRuntimeInboxActionRequest) => Promise<CodingRuntimeInboxResult>) | undefined;
}

export interface QualifiedProductionCodingRuntime extends Omit<
  CodingRuntimeHost,
  "launchResolver"
> {
  readonly mintLaunch: CodingRuntimeHost["launchResolver"];
  readonly taskDispatcher: CodingRuntimeTaskDispatcher;
}

export interface ProductionCodingRuntimeResolver {
  /** Returns a qualified server-owned runtime composition or no capability. */
  readonly resolve: () => QualifiedProductionCodingRuntime | undefined;
}

export interface ProductionCodingRuntimeHost extends CodingRuntimeHost {
  readonly taskDispatcher: CodingRuntimeTaskDispatcher;
}

/** A missing, throwing, or unqualified production resolver never creates a runtime host. */
export function createProductionCodingRuntimeHost(
  resolver?: ProductionCodingRuntimeResolver,
): ProductionCodingRuntimeHost | undefined {
  if (resolver === undefined) return undefined;
  let runtime: QualifiedProductionCodingRuntime | undefined;
  try {
    runtime = resolver.resolve();
  } catch {
    return undefined;
  }
  if (runtime === undefined) return undefined;
  return {
    createManager: runtime.createManager,
    launchResolver: runtime.mintLaunch,
    approvalAuthority: runtime.approvalAuthority,
    taskDispatcher: runtime.taskDispatcher,
    cancellationRegistry: runtime.cancellationRegistry,
    ...runtimeInteractionPorts(runtime),
    ...optionalRuntimeCapabilities(runtime),
  };
}

function runtimeInteractionPorts(
  runtime: QualifiedProductionCodingRuntime,
): Pick<ProductionCodingRuntimeHost, "permissionPort" | "questionPort"> {
  return {
    ...(runtime.questionPort ? { questionPort: runtime.questionPort } : {}),
    ...(runtime.permissionPort ? { permissionPort: runtime.permissionPort } : {}),
  };
}

// Every one of these is an OPTIONAL pass-through: present on `QualifiedProductionCodingRuntime`
// only when the resolver supplied it, forwarded onto `ProductionCodingRuntimeHost` unchanged. A
// per-field ternary here would grow `createProductionCodingRuntimeHost`'s cyclomatic complexity by
// one per capability (AGENTS.md §6's complexity <=10 ceiling), so the ONE decision — "was it
// supplied?" — is a single loop over the closed key list instead of N branches.
const OPTIONAL_RUNTIME_CAPABILITY_KEYS = [
  "safeActivityProjection",
  "researchGrants",
  "approvedSkills",
  "pendingResearchApprovals",
  "runtimeCapabilityAuthenticator",
  "gitDeliveryAuthority",
  "gitDeliveryDescriptionAuthority",
  "mintDescriptionAuthority",
  "attachVerifiedHeadNotifier",
  "attachEditOutcomeObserver",
  "attachRepositorySemanticSearch",
  "openCodeGatewayReadinessRegistry",
  "toolFacadeBridge",
  "contextUsage",
  "secureWorkspaceTextRead",
  "runEffort",
  "promptAllowanceExhausted",
  "envelopeDurationExhausted",
] as const;

type OptionalRuntimeCapabilities = Pick<
  ProductionCodingRuntimeHost,
  (typeof OPTIONAL_RUNTIME_CAPABILITY_KEYS)[number]
>;

function optionalRuntimeCapabilities(
  runtime: QualifiedProductionCodingRuntime,
): OptionalRuntimeCapabilities {
  const capabilities: Partial<OptionalRuntimeCapabilities> = {};
  for (const key of OPTIONAL_RUNTIME_CAPABILITY_KEYS) {
    const value = runtime[key];
    if (value !== undefined) Object.assign(capabilities, { [key]: value });
  }
  return capabilities;
}
