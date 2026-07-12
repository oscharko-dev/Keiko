import { createHash } from "node:crypto";
import {
  EDITOR_AGENT_SCHEMA_VERSION,
  type EditorAgentAction,
  type EditorAgentChangeset,
  type EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import type { EditorAgentHttpClient } from "@oscharko-dev/keiko-tools";
import { isDenied } from "@oscharko-dev/keiko-workspace";

import type { CodingToolMutationGuard } from "./codingToolFacadePorts.js";
import { isExactEditorAgentChangeset } from "./codingToolIpc.js";
import type { CodingToolActionOf, GovernedCodingToolPort } from "./codingToolGovernedDelegate.js";
import type {
  CodingRuntimeEditorMutationLeaseCoordinator,
  CodingRuntimeEditorMutationLeaseRequest,
} from "./codingRuntimeEditorMutationLeaseCoordinator.js";
import type { SecureWorkspaceTextReadPort } from "./secureWorkspaceTextRead.js";

const MAX_READ_BYTES = 65_536;

type RepositoryReadRequest = CodingToolActionOf<"read">;
type EditorChangesetRequest = CodingToolActionOf<"edit">;

type EditorAgentActionClient = Pick<EditorAgentHttpClient, "action">;

export interface CodingToolReadEditPorts {
  readonly repositoryRead: GovernedCodingToolPort<"read">;
  readonly editorChangeset: GovernedCodingToolPort<"edit">;
}

export interface CodingToolReadEditPortDeps {
  readonly secureWorkspaceTextRead: SecureWorkspaceTextReadPort;
  readonly editorAgentClient: EditorAgentActionClient;
  readonly resolveEditorActionContext: () => EditorActionContext;
  readonly resolveRepositoryReadContext?: (() => RuntimeProducerBinding) | undefined;
  readonly mutationLeaseCoordinator?:
    Pick<CodingRuntimeEditorMutationLeaseCoordinator, "register" | "discard"> | undefined;
}

interface EditorActionContext {
  readonly sessionId: string;
  readonly authorityRef: EditorAgentGovernedAuthorityReference;
  readonly origin: "agent";
  readonly workspaceId?: string | undefined;
  readonly workspaceRootDigest?: string | undefined;
  readonly expiresAt?: string | undefined;
}

interface RuntimeProducerBinding {
  readonly runId: string;
  readonly envelopeDigest: string;
  readonly workspaceId: string;
  readonly workspaceRootDigest: string;
  readonly expiresAt: string;
}

/**
 * Server-private producer adapters. They intentionally retain no invocation content: the facade's
 * invocation registry owns that lifecycle, while this bridge only passes a bounded value onward.
 */
export function createCodingToolReadEditPorts(
  deps: CodingToolReadEditPortDeps,
): CodingToolReadEditPorts {
  return {
    repositoryRead: {
      execute: (request, signal, mutationGuard) =>
        executeRead(deps, request, signal, mutationGuard),
    },
    editorChangeset: {
      execute: (request, signal, mutationGuard) =>
        executeEdit(deps, request, signal, mutationGuard),
    },
  };
}

async function executeRead(
  deps: CodingToolReadEditPortDeps,
  request: RepositoryReadRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): Promise<
  | {
      readonly status: "completed";
      readonly read: { readonly text: string; readonly byteCount: number; readonly digest: string };
    }
  | { readonly status: "failed" }
> {
  const binding = readPreflight(deps, request, signal, mutationGuard);
  if (binding === false) return { status: "failed" };
  const result = await deps.secureWorkspaceTextRead.readText({
    relativePath: request.relativePath,
    signal,
  });
  if (!readPostflight(deps, result, binding, signal, mutationGuard)) return { status: "failed" };
  const byteCount = Buffer.byteLength(result.text, "utf8");
  if (byteCount > MAX_READ_BYTES) return { status: "failed" };
  return {
    status: "completed",
    read: {
      text: result.text,
      byteCount,
      digest: createHash("sha256").update(result.text, "utf8").digest("hex"),
    },
  };
}

function readPreflight(
  deps: CodingToolReadEditPortDeps,
  request: RepositoryReadRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): RuntimeProducerBinding | undefined | false {
  if (isAborted(signal) || isDenied(request.relativePath)) return false;
  const binding = mutationBinding(mutationGuard);
  if (binding === null) return false;
  if (!readContextMatches(deps, binding) || !checkGuard(mutationGuard)) return false;
  return isDenied(request.relativePath) ? false : binding;
}

function readPostflight(
  deps: CodingToolReadEditPortDeps,
  result: Awaited<ReturnType<SecureWorkspaceTextReadPort["readText"]>>,
  binding: RuntimeProducerBinding | undefined,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): result is Extract<typeof result, { readonly ok: true }> {
  return (
    result.ok &&
    checkGuard(mutationGuard) &&
    readContextMatches(deps, binding) &&
    !isAborted(signal)
  );
}

interface PreparedEdit {
  readonly action: EditorAgentAction;
  readonly leaseRequest: CodingRuntimeEditorMutationLeaseRequest | undefined;
  readonly signal: AbortSignal;
}

async function executeEdit(
  deps: CodingToolReadEditPortDeps,
  request: EditorChangesetRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): Promise<{ readonly status: "completed" | "failed" }> {
  const prepared = prepareEdit(deps, request, signal, mutationGuard);
  if (prepared === undefined) return { status: "failed" };
  try {
    const result = await deps.editorAgentClient.action(prepared.action, prepared.signal);
    const completed = result.ok && editorStatusCompleted(result.value.result.status);
    if (!completed) discardMutationLease(deps, prepared.leaseRequest);
    return editOutcome(completed);
  } catch {
    return { status: "failed" };
  }
}

function prepareEdit(
  deps: CodingToolReadEditPortDeps,
  request: EditorChangesetRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): PreparedEdit | undefined {
  const changeset = validatedChangeset(request, signal, mutationGuard);
  if (changeset === undefined) return undefined;
  const binding = mutationBinding(mutationGuard);
  if (binding === null) return undefined;
  const context = resolveEditorContext(deps);
  if (context === undefined || !editorContextMatches(context, binding)) return undefined;
  const action = changesetAction(request, changeset, context);
  const leaseRequest = registerMutationLease(deps, action, context, binding, mutationGuard);
  if (binding !== undefined && leaseRequest === undefined) return undefined;
  return { action, leaseRequest, signal: signal ?? new AbortController().signal };
}

function validatedChangeset(
  request: EditorChangesetRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): EditorAgentChangeset | undefined {
  if (isAborted(signal) || !checkGuard(mutationGuard) || !("changeset" in request)) {
    return undefined;
  }
  return isExactEditorAgentChangeset(request.changeset) ? request.changeset : undefined;
}

function editorStatusCompleted(status: string): boolean {
  return status === "queued" || status === "succeeded";
}

function editOutcome(completed: boolean): { readonly status: "completed" | "failed" } {
  return { status: completed ? "completed" : "failed" };
}

function discardMutationLease(
  deps: CodingToolReadEditPortDeps,
  request: CodingRuntimeEditorMutationLeaseRequest | undefined,
): void {
  if (request !== undefined) deps.mutationLeaseCoordinator?.discard(request);
}

function registerMutationLease(
  deps: CodingToolReadEditPortDeps,
  action: EditorAgentAction,
  context: EditorActionContext,
  binding: RuntimeProducerBinding | undefined,
  mutationGuard: CodingToolMutationGuard,
): CodingRuntimeEditorMutationLeaseRequest | undefined {
  if (binding === undefined) return undefined;
  const coordinator = deps.mutationLeaseCoordinator;
  if (coordinator === undefined || context.workspaceId === undefined) return undefined;
  const request = leaseRequest(action, binding);
  const registered = coordinator.register({
    authorityRef: action.authorityRef ?? context.authorityRef,
    workspaceId: context.workspaceId,
    workspaceRootDigest: binding.workspaceRootDigest,
    actionId: action.actionId,
    idempotencyKey: action.idempotencyKey,
    mutationGuard: (): boolean => checkGuard(mutationGuard),
  });
  return registered ? request : undefined;
}

function leaseRequest(
  action: EditorAgentAction,
  binding: RuntimeProducerBinding,
): CodingRuntimeEditorMutationLeaseRequest {
  return {
    authorityRef: action.authorityRef ?? {
      runId: binding.runId,
      envelopeDigest: binding.envelopeDigest,
    },
    runId: binding.runId,
    envelopeDigest: binding.envelopeDigest,
    workspaceId: binding.workspaceId,
    workspaceRootDigest: binding.workspaceRootDigest,
    actionId: action.actionId,
    idempotencyKey: action.idempotencyKey,
  };
}

function changesetAction(
  request: EditorChangesetRequest,
  changeset: EditorAgentChangeset,
  context: EditorActionContext,
): EditorAgentAction {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: request.actionId,
    idempotencyKey: request.idempotencyKey,
    sessionId: context.sessionId,
    type: "applyChangeset",
    authorityRef: context.authorityRef,
    origin: context.origin,
    changeset,
  };
}

function resolveEditorContext(deps: CodingToolReadEditPortDeps): EditorActionContext | undefined {
  try {
    return deps.resolveEditorActionContext();
  } catch {
    return undefined;
  }
}

function readContextMatches(
  deps: CodingToolReadEditPortDeps,
  binding: RuntimeProducerBinding | undefined,
): boolean {
  if (binding === undefined) return true;
  try {
    const context = deps.resolveRepositoryReadContext?.();
    return context !== undefined && bindingMatches(binding, context);
  } catch {
    return false;
  }
}

function editorContextMatches(
  context: EditorActionContext,
  binding: RuntimeProducerBinding | undefined,
): boolean {
  if (binding === undefined) return true;
  return (
    context.authorityRef.runId === binding.runId &&
    context.authorityRef.envelopeDigest === binding.envelopeDigest &&
    context.workspaceId === binding.workspaceId &&
    context.workspaceRootDigest === binding.workspaceRootDigest &&
    context.expiresAt === binding.expiresAt &&
    !expired(binding.expiresAt)
  );
}

function bindingMatches(left: RuntimeProducerBinding, right: RuntimeProducerBinding): boolean {
  return (
    left.runId === right.runId &&
    left.envelopeDigest === right.envelopeDigest &&
    left.workspaceId === right.workspaceId &&
    left.workspaceRootDigest === right.workspaceRootDigest &&
    left.expiresAt === right.expiresAt &&
    !expired(left.expiresAt)
  );
}

function expired(expiresAt: string): boolean {
  const expiry = Date.parse(expiresAt);
  return !Number.isFinite(expiry) || Date.now() >= expiry;
}

function checkGuard(mutationGuard: CodingToolMutationGuard): boolean {
  try {
    return mutationGuard.check();
  } catch {
    return false;
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function mutationBinding(
  mutationGuard: CodingToolMutationGuard,
): RuntimeProducerBinding | undefined | null {
  const record = mutationGuard as unknown as Record<string, unknown>;
  if (!("binding" in record)) return undefined;
  return isRuntimeProducerBinding(record.binding) ? record.binding : null;
}

function isRuntimeProducerBinding(value: unknown): value is RuntimeProducerBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    nonEmpty(record.runId) &&
    digest(record.envelopeDigest) &&
    nonEmpty(record.workspaceId) &&
    digest(record.workspaceRootDigest) &&
    typeof record.expiresAt === "string" &&
    Number.isFinite(Date.parse(record.expiresAt))
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
