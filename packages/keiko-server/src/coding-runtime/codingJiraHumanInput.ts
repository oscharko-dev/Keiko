import {
  copyHumanInputBinding,
  createJiraReadRequest,
  checkJiraManagedMutation,
  prepareJiraHumanInput,
  prepareJiraHumanInputReview,
  JiraHumanInputCustodyError,
  type JiraHumanInputBinding,
  type JiraHumanInputSelection,
  type JiraManagedConnection,
} from "@oscharko-dev/keiko-connectors";
import {
  JIRA_HUMAN_INPUT_MAX_LIFETIME_MS,
  JIRA_HUMAN_INPUT_PURPOSES,
  JIRA_MUTATION_OPERATIONS,
  type JiraHumanInputView,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { ManagedMcpError } from "@oscharko-dev/keiko-mcp";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  captureCatalogJson,
  describeCatalogSchemaMismatch,
} from "@oscharko-dev/keiko-tool-catalog";
import type { CodingNativeToolTranscript } from "../store/codingHistory.js";
import type { UiHandlerDeps } from "../deps.js";
import type { AtlassianConnectorCredentialDeps } from "../atlassian/credentialRoutes.js";
import type { JiraLivePodCredential } from "../atlassian/jiraPodAccess.js";
import { jiraOperationForTool } from "../atlassian/jiraManagedProvider.js";
import {
  cancelUnclaimedJiraHumanInput,
  recordJiraHumanInput,
  reportJiraHumanInputCleanupFailure,
} from "../atlassian/credentialActivity.js";

export interface CodingJiraInputAuthority {
  readonly taskId: string;
  readonly principalDigest: string;
  readonly authority: JiraHumanInputBinding["authority"];
  readonly expiresAt: number;
}
export interface CodingJiraCurrentInputContext {
  readonly publish: (view: JiraHumanInputView) => void;
}
export type CodingJiraCurrentInputResolver = (
  binding: JiraHumanInputBinding,
  requestId: string,
) => CodingJiraCurrentInputContext | undefined;
/** Held only by the existing Pod entry while its actual invocation is awaiting/completing input. */
export interface PendingCodingJiraInput {
  readonly binding: JiraHumanInputBinding;
  readonly argumentsValue: CatalogJsonObject;
  readonly current: () => boolean;
  readonly publish: (view: JiraHumanInputView) => void;
  readonly release: () => void;
  requestId: string | undefined;
  selection: JiraHumanInputSelection | undefined;
}
interface Dependencies {
  readonly store: Pick<UiHandlerDeps["store"], "codingHistory">;
  readonly codingRuntimeOrchestrator?:
    Pick<NonNullable<UiHandlerDeps["codingRuntimeOrchestrator"]>, "refreshHistory"> | undefined;
  readonly atlassianConnectorCredentials?:
    | Pick<
        AtlassianConnectorCredentialDeps,
        "custody" | "httpBodyPortFactory" | "activityLog" | "diagnostics"
      >
    | undefined;
}
interface PrepareInput {
  readonly deps: Dependencies;
  readonly operation: string;
  readonly args: CatalogJsonObject;
  readonly context: ManagedMcpInvocationContext;
  readonly inputs: Map<string, PendingCodingJiraInput>;
  readonly currentAuthority: () => CodingJiraInputAuthority | undefined;
  readonly currentCredential: () => JiraLivePodCredential | undefined;
}
function refuse(): never {
  throw new ManagedMcpError("not-admitted", undefined, "none");
}
function isObject(value: CatalogJsonValue): value is CatalogJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function ownedArgs(args: CatalogJsonObject): CatalogJsonObject {
  const value = captureCatalogJson(args, TOOL_CATALOG_LIMITS.maxArgumentBytes);
  if (!isObject(value)) return refuse();
  return deepFreeze(value);
}
function authorityCurrent(input: PrepareInput, selected: CodingJiraInputAuthority): boolean {
  const current = input.currentAuthority();
  return (
    !input.context.signal.aborted &&
    input.context.beforeEffect() &&
    current !== undefined &&
    canonicalise(current) === canonicalise(selected) &&
    selected.expiresAt > Date.now()
  );
}
function boundHistory(
  input: PrepareInput,
  authority: CodingJiraInputAuthority,
): {
  readonly transcript: CodingNativeToolTranscript;
  readonly current: () => boolean;
} {
  const history = input.deps.store.codingHistory;
  const runId = authority.authority.runId;
  const task = history?.forRun(runId);
  const turn = history?.nativeTurn(runId);
  if (
    history === undefined ||
    task?.taskId !== authority.taskId ||
    turn === undefined ||
    history.get(task.id, authority.principalDigest) === undefined
  )
    return refuse();
  return {
    transcript: history.nativeToolTranscript(runId, turn),
    current: (): boolean => {
      const latest = history.nativeTurn(runId);
      return (
        latest?.chatId === turn.chatId &&
        latest.userMessageId === turn.userMessageId &&
        latest.turnRef === turn.turnRef &&
        history.get(task.id, authority.principalDigest)?.taskId === authority.taskId
      );
    },
  };
}
function credentialCurrent(input: PrepareInput, selected: JiraLivePodCredential): boolean {
  const current = input.currentCredential();
  return (
    current?.authRef === selected.authRef &&
    current.generation === selected.generation &&
    current.livePod.verificationRevision === selected.livePod.verificationRevision
  );
}
async function actor(
  input: PrepareInput,
  credential: JiraLivePodCredential,
  args: CatalogJsonObject,
  current: () => boolean,
): Promise<{ key: string; name: string }> {
  if (typeof args.expectedActorKey !== "string") return refuse();
  const request = createJiraReadRequest(readConnection(input, credential, current), {
    ...input.context,
    beforeEffect: current,
  });
  const result = await request("myself", "GET", undefined, "json");
  const body = result.ok && result.status === 200 ? result.body : undefined;
  if (!current() || body?.key !== args.expectedActorKey || typeof body.name !== "string")
    return refuse();
  return { key: args.expectedActorKey, name: body.name };
}
function readConnection(
  input: PrepareInput,
  credential: JiraLivePodCredential,
  current: () => boolean,
): Pick<JiraManagedConnection, "deployment" | "baseUrl" | "http"> {
  const factory = input.deps.atlassianConnectorCredentials?.httpBodyPortFactory;
  if (factory === undefined) return refuse();
  return {
    deployment: credential.deployment,
    baseUrl: credential.baseUrl,
    http: factory(credential, input.context.correlationId, { beforeDispatch: current }),
  };
}
async function needsInput(
  input: PrepareInput,
  args: CatalogJsonObject,
  credential: JiraLivePodCredential,
  current: () => boolean,
): Promise<boolean> {
  const operation = JIRA_MUTATION_OPERATIONS.find((name) => name === input.operation);
  if (operation === undefined) return true;
  const checked = await checkJiraManagedMutation(
    operation,
    args,
    { ...input.context, beforeEffect: current },
    readConnection(input, credential, current),
  );
  // The existing executor supplies its typed refusal/no-op; no private value is requested first.
  return checked.ok;
}
function pendingBinding(
  input: PrepareInput,
  authority: CodingJiraInputAuthority,
  credential: JiraLivePodCredential,
  args: CatalogJsonObject,
  observed: { key: string; name: string },
  review: NonNullable<JiraHumanInputBinding["review"]>,
): JiraHumanInputBinding {
  const binding = copyHumanInputBinding({
    context: {
      kind: "coding",
      taskId: authority.taskId,
      runId: authority.authority.runId,
      callId: input.context.invocationId,
    },
    authority: authority.authority,
    principalDigest: authority.principalDigest,
    operationCorrelationId: input.context.correlationId,
    authRef: credential.authRef,
    authenticationGeneration: credential.generation,
    verificationRevision: credential.livePod.verificationRevision,
    operation: input.operation,
    argumentsDigest: sha256Hex(canonicalise(args)),
    actorUserKey: observed.key,
    actorUsername: observed.name,
    review,
    expiresAt: Math.min(authority.expiresAt, Date.now() + JIRA_HUMAN_INPUT_MAX_LIFETIME_MS),
  });
  return binding ?? refuse();
}
function pendingState(
  input: PrepareInput,
  binding: JiraHumanInputBinding,
  args: CatalogJsonObject,
  transcript: CodingNativeToolTranscript,
  current: () => boolean,
): PendingCodingJiraInput {
  const contract = jiraOperationForTool(input.operation);
  if (contract === undefined) return refuse();
  const mutation = (JIRA_MUTATION_OPERATIONS as readonly string[]).includes(input.operation);
  const started = {
    kind: "started" as const,
    call: {
      id: input.context.invocationId,
      name: input.operation.replace(/[.-]/gu, "_"),
      arguments: args,
    },
    ...(mutation
      ? { operationBinding: contract.binding, nativeArgumentsDigest: binding.argumentsDigest }
      : {}),
  };
  const pending: PendingCodingJiraInput = {
    binding,
    argumentsValue: args,
    requestId: undefined,
    selection: undefined,
    current: () => input.inputs.get(input.context.invocationId) === pending && current(),
    release: () => {
      if (pending.requestId !== undefined)
        cancelUnclaimedJiraHumanInput(
          input.deps.atlassianConnectorCredentials,
          pending.requestId,
          pending.binding,
        );
    },
    publish: (view) => {
      if (
        !pending.current() ||
        (pending.requestId !== undefined && pending.requestId !== view.requestId)
      )
        return refuse();
      transcript.humanInput(started, view, input.context.correlationId);
      pending.requestId = view.requestId;
      // The real graph is late-bound by installCodingJiraPods. Persist first; notify without
      // changing the authority snapshot which current() compares during submit and consume.
      void input.deps.codingRuntimeOrchestrator?.refreshHistory(binding.authority.runId);
    },
  };
  return pending;
}
function selectedAuthority(input: PrepareInput): {
  readonly authority: CodingJiraInputAuthority;
  readonly credential: JiraLivePodCredential;
  readonly custody: NonNullable<
    NonNullable<Dependencies["atlassianConnectorCredentials"]>["custody"]["humanInputs"]
  >;
} {
  const observed = input.currentAuthority();
  const currentCredential = input.currentCredential();
  const custody = input.deps.atlassianConnectorCredentials?.custody.humanInputs;
  if (
    observed === undefined ||
    currentCredential === undefined ||
    custody === undefined ||
    observed.authority.runId !== input.context.correlationId ||
    currentCredential.livePod.ownerDigest !== observed.principalDigest
  )
    return refuse();
  const authority = deepFreeze({ ...observed, authority: { ...observed.authority } });
  const credential = deepFreeze({
    ...currentCredential,
    livePod: { ...currentCredential.livePod },
  });
  return { authority, credential, custody };
}
async function awaitSelection(
  input: PrepareInput,
  pending: PendingCodingJiraInput,
  custody: NonNullable<
    NonNullable<Dependencies["atlassianConnectorCredentials"]>["custody"]["humanInputs"]
  >,
): Promise<PendingCodingJiraInput> {
  try {
    pending.selection = await prepareJiraHumanInput(
      custody,
      pending.binding,
      (view) => {
        if (input.context.signal.aborted) throw new ManagedMcpError("aborted", undefined, "none");
        pending.publish(view);
        if (view.state === "awaiting-input")
          recordJiraHumanInput(
            input.deps.atlassianConnectorCredentials,
            input.context.correlationId,
            "requested",
          );
      },
      input.context.signal,
      (error): void => {
        reportJiraHumanInputCleanupFailure(
          input.deps.atlassianConnectorCredentials,
          pending.binding,
          error,
        );
      },
    );
    if (!pending.current()) return refuse();
    return pending;
  } catch (error) {
    pending.release();
    if (!(error instanceof JiraHumanInputCustodyError)) throw error;
    throw new ManagedMcpError(
      error.code === "cancelled" ? "aborted" : "not-admitted",
      undefined,
      "none",
    );
  }
}
/** Metadata is retained by the real invocation; no OpenCode question or model argument receives input. */
export async function prepareCodingJiraHumanInput(
  input: PrepareInput,
): Promise<PendingCodingJiraInput | undefined> {
  const purpose = JIRA_HUMAN_INPUT_PURPOSES.find((value) => `jira.${value}` === input.operation);
  if (purpose === undefined) return undefined;
  const contract = jiraOperationForTool(input.operation);
  const args = ownedArgs(input.args);
  if (
    contract === undefined ||
    describeCatalogSchemaMismatch(contract.declaration.descriptor.inputSchema, args) !== undefined
  )
    return undefined;
  const { authority, credential, custody } = selectedAuthority(input);
  const current = (): boolean =>
    authorityCurrent(input, authority) && credentialCurrent(input, credential);
  if (!(await needsInput(input, args, credential, current))) return undefined;
  const observed = await actor(input, credential, args, current);
  const review = await prepareJiraHumanInputReview(
    purpose,
    args,
    credential.baseUrl,
    createJiraReadRequest(readConnection(input, credential, current), {
      ...input.context,
      beforeEffect: current,
    }),
  );
  if (!current() || review?.actorUserKey !== observed.key || review.actorUsername !== observed.name)
    return refuse();
  const binding = pendingBinding(input, authority, credential, args, observed, review);
  const history = boundHistory(input, authority);
  const pending = pendingState(
    input,
    binding,
    args,
    history.transcript,
    () => current() && history.current(),
  );
  if (input.inputs.has(input.context.invocationId)) return refuse();
  input.inputs.set(input.context.invocationId, pending);
  return awaitSelection(input, pending, custody);
}
export function currentCodingJiraInput(
  pending: PendingCodingJiraInput | undefined,
  binding: JiraHumanInputBinding,
  requestId: string,
): CodingJiraCurrentInputContext | undefined {
  if (
    pending === undefined ||
    !pending.current() ||
    pending.requestId !== requestId ||
    canonicalise(pending.binding) !== canonicalise(binding)
  )
    return undefined;
  return { publish: pending.publish };
}
