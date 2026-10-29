import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { captureCatalogJson } from "@oscharko-dev/keiko-tool-catalog";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpMutationInvocation } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type { UiStore } from "../store/types.js";
import type {
  ChatToolMutationPreparation,
  ChatToolMutationStore,
} from "../store/chatToolMutationTypes.js";
import { journalConflict } from "../store/chatToolMutationState.js";
import type { CodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import { CodingRuntimeHistory } from "./codingRuntimeHistory.js";

export interface NativeMcpCallIdentity {
  readonly runId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly callId: string;
  readonly mcpActionDigest?: string | undefined;
}
export interface NativeMcpMutationSource {
  readonly serverName: string;
  readonly toolName: string;
  readonly configurationDigest: string;
}
export interface NativeMcpMutationJournal {
  readonly bindTurn: (runId: string, nativeMessageId: string, text: string) => void;
  readonly prepare: (
    input: NativeMcpCallIdentity & NativeMcpMutationSource & { readonly argumentsValue: unknown },
  ) => ChatToolMutationPreparation;
  readonly begin: (
    input: NativeMcpMutationSource & {
      readonly runId: string;
      readonly sessionId: string | undefined;
      readonly argumentsValue: CatalogJsonObject;
      readonly beforeEffect: (identity: NativeMcpCallIdentity) => boolean;
    },
  ) => ManagedMcpMutationInvocation | undefined;
  /** Only the existing committed producer-history observer calls this, after Code Mode finishes. */
  readonly observeCompletion: (
    identity: Pick<NativeMcpCallIdentity, "runId" | "messageId" | "callId">,
    success: boolean,
  ) => "ignored" | "confirmed" | "uncertain";
  readonly unsettled: (runId: string) => boolean;
  readonly settleUnconfirmed: (runId: string) => void;
}

export function nativeMcpInvocationId(
  identity: NativeMcpCallIdentity & NativeMcpMutationSource & { readonly argumentsValue: unknown },
): string {
  return `mcp-${sha256Hex(
    canonicalise([
      identity.runId,
      identity.sessionId,
      identity.messageId,
      identity.callId,
      identity.serverName,
      identity.toolName,
      sha256Hex(canonicalise(capturedArguments(identity.argumentsValue))),
    ]),
  )}`;
}

function capturedArguments(value: unknown): CatalogJsonObject {
  const captured = captureCatalogJson(value, TOOL_CATALOG_LIMITS.maxArgumentBytes);
  if (captured === null || typeof captured !== "object" || Array.isArray(captured))
    throw journalConflict();
  return captured as CatalogJsonObject;
}

function retainUnconfirmed(journal: ChatToolMutationStore, invocationId: string): void {
  const current = journal.find(invocationId);
  if (current === undefined || current.phase === "settled") return;
  const observed = current.sourceKind === "configured-mcp" && current.protocolOutcome === "success";
  journal.settle(invocationId, observed ? "succeeded-unconfirmed" : "unknown");
}

interface NativeMcpJournalInput {
  readonly store: UiStore;
  readonly snapshots: Pick<CodingRuntimeSnapshotStore, "get">;
  readonly log?: ServerLogSink | undefined;
}

class NativeMutationJournal implements NativeMcpMutationJournal {
  readonly #journal: ChatToolMutationStore;
  readonly #history: NonNullable<UiStore["codingHistory"]>;
  readonly #historyOwner: CodingRuntimeHistory;
  readonly #preparedNative: NonNullable<ChatToolMutationStore["preparedNative"]>;
  readonly #unsettledNative: NonNullable<ChatToolMutationStore["unsettledNative"]>;
  constructor(private readonly input: NativeMcpJournalInput) {
    const journal = input.store.chatToolMutations;
    const history = input.store.codingHistory;
    if (
      journal?.preparedNative === undefined ||
      journal.unsettledNative === undefined ||
      history === undefined
    )
      throw journalConflict();
    this.#journal = journal;
    this.#history = history;
    this.#preparedNative = journal.preparedNative.bind(journal);
    this.#unsettledNative = journal.unsettledNative.bind(journal);
    this.#historyOwner = new CodingRuntimeHistory(input.store, () => undefined, input.log);
  }
  bindTurn(runId: string, nativeMessageId: string, text: string): void {
    this.#historyOwner.bindNativeTurn(runId, nativeMessageId, text);
  }
  prepare(
    request: Parameters<NativeMcpMutationJournal["prepare"]>[0],
  ): ChatToolMutationPreparation {
    const turn = this.#history.nativeTurn(request.runId);
    const snapshot = this.input.snapshots.get(request.runId);
    if (turn === undefined || snapshot === undefined) throw journalConflict();
    const argumentsDigest = sha256Hex(canonicalise(capturedArguments(request.argumentsValue)));
    const invocationId = nativeMcpInvocationId(request);
    return this.#journal.prepare({
      invocationId,
      ...turn,
      actorId: snapshot.operatorDigest,
      authorityDigest: snapshot.authorityDigest,
      actionDigest: sha256Hex(
        canonicalise([
          invocationId,
          request.configurationDigest,
          request.serverName,
          request.toolName,
          argumentsDigest,
        ]),
      ),
      correlationId: request.runId,
      sourceKind: "configured-mcp",
      podId: null,
      bindingGeneration: null,
      credentialGeneration: null,
      operation: "mcp.call",
      configurationDigest: request.configurationDigest,
      serverName: request.serverName,
      toolName: request.toolName,
      consumer: {
        kind: "coding",
        runId: request.runId,
        sessionId: request.sessionId,
        messageId: request.messageId,
        callId: request.callId,
        argumentsDigest,
        mcpActionDigest: request.mcpActionDigest,
      },
    });
  }
  begin(
    request: Parameters<NativeMcpMutationJournal["begin"]>[0],
  ): ReturnType<NativeMcpMutationJournal["begin"]> {
    if (request.sessionId === undefined) return undefined;
    const turn = this.#history.nativeTurn(request.runId);
    if (turn === undefined) return undefined;
    const record = this.#preparedNative({
      ...request,
      turnRef: turn.turnRef,
      sessionId: request.sessionId,
      argumentsDigest: sha256Hex(canonicalise(capturedArguments(request.argumentsValue))),
    });
    const consumer = record?.consumer;
    if (
      record?.sourceKind !== "configured-mcp" ||
      consumer?.mcpActionDigest === undefined ||
      record.configurationDigest !== request.configurationDigest
    )
      return undefined;
    if (
      !this.#journal.beginDispatch(record.invocationId, () =>
        request.beforeEffect({
          runId: consumer.runId,
          sessionId: consumer.sessionId,
          messageId: consumer.messageId,
          callId: consumer.callId,
          mcpActionDigest: consumer.mcpActionDigest,
        }),
      )
    )
      return undefined;
    return {
      invocationId: record.invocationId,
      acknowledge: (): void => {
        this.#journal.acknowledgeMcp(record.invocationId, true);
      },
      fail: (): void => {
        retainUnconfirmed(this.#journal, record.invocationId);
      },
    };
  }
  observeCompletion(
    identity: Parameters<NativeMcpMutationJournal["observeCompletion"]>[0],
    success: boolean,
  ): ReturnType<NativeMcpMutationJournal["observeCompletion"]> {
    const records = this.#unsettledNative(identity.runId).filter(
      (record) =>
        record.consumer?.messageId === identity.messageId &&
        record.consumer.callId === identity.callId,
    );
    if (records.length === 0) return "ignored";
    const confirmed = success && records.every((record) => record.phase === "acknowledged");
    for (const record of records) {
      if (confirmed) this.#journal.settle(record.invocationId, "succeeded");
      else retainUnconfirmed(this.#journal, record.invocationId);
    }
    return confirmed ? "confirmed" : "uncertain";
  }
  settleUnconfirmed(runId: string): void {
    for (const record of this.#unsettledNative(runId))
      retainUnconfirmed(this.#journal, record.invocationId);
  }
  unsettled(runId: string): boolean {
    return this.#unsettledNative(runId).length > 0;
  }
}

/** One effect journal; real Coding History rows supply the accepted human-turn identity. */
export function createNativeMcpMutationJournal(
  input: NativeMcpJournalInput,
): NativeMcpMutationJournal {
  return new NativeMutationJournal(input);
}

/** Internal continuations retain the accepted human turn; only a newly bound human message opens it. */
export function bindNativeMcpHumanTurn(
  journal: NativeMcpMutationJournal | undefined,
  run: { readonly runId: string; nativeMutationTurnBound?: boolean | undefined },
  input: { readonly messageId: string; readonly text: string; readonly origin: string | undefined },
): void {
  if (input.origin !== undefined) return;
  run.nativeMutationTurnBound = false;
  if (journal === undefined) return;
  journal.bindTurn(run.runId, input.messageId, input.text);
  run.nativeMutationTurnBound = true;
}
