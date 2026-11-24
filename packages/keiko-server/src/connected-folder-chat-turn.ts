import {
  createConnectedFolderToolBudget,
  createTurnScopedWorkspaceIndex,
  type SearchScope,
  type TurnScopedWorkspaceIndex,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import {
  chatModelSupportsTools,
  mintAndBoundChatTurn,
  type ConnectedFolderTurnReadout,
} from "./chat-tool-turn.js";
import {
  connectedFolderConfigurationDigest,
  mintAcceptedConnectedFolderChatAuthority,
  reserveCurrentConnectedFolderChatAuthority,
  resolveCurrentConnectedFolderChatAuthority,
  soleConnectedFolderScope,
  type MintedConnectedFolderChatAuthority,
} from "./connected-folder-chat-authority.js";
import {
  CONNECTED_FOLDER_TOOL_TURN_LIMITS,
  type ConnectedFolderToolWindow,
} from "./connectedFolderTool.js";
import { CONNECTED_FOLDER_CHAT_TOOLS } from "./connectedFolderToolName.js";
import {
  logConnectedFolderTurnSelection,
  type ConnectedFolderTurnSelection,
} from "./connected-folder-tool-activity.js";
import { correlationIdOrUnknown } from "./correlation.js";
import type { UiHandlerDeps } from "./deps.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import {
  localChatSourceConsumerPort,
  type LocalChatSourceOwner,
} from "./local-chat-source-consumer.js";
import {
  LocalChatSourceToolTurn,
  type LocalChatSourceTurnOptions,
} from "./local-chat-source-turn.js";
import type { ChatMessage } from "./store/index.js";

/**
 * The admitted folder of the turn: the search scope and the filesystem that admission granted, and
 * the digest of the Chat selection it was admitted from, which the turn's authority must cover.
 */
export interface ConnectedFolderToolSource {
  readonly scope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly configurationDigest: string;
}

/**
 * Admits the Chat's one connected folder the way the single retrieval of the same request does.
 * Only the grounded route supplies it; undefined means the folder is not admitted.
 */
export type ConnectedFolderToolSourceAdmission = () => ConnectedFolderToolSource | undefined;

export interface ConnectedFolderChatTurnOptions extends LocalChatSourceTurnOptions {
  readonly authority: Extract<MintedConnectedFolderChatAuthority, { readonly ok: true }>;
  readonly source: ConnectedFolderToolSource;
}

const CONSUMER_PORT = localChatSourceConsumerPort("connected-folder-chat");
export const CONNECTED_FOLDER_CHAT_SOURCE_OWNER: LocalChatSourceOwner = {
  reads: new Set<string>(CONNECTED_FOLDER_CHAT_TOOLS),
  resolve: resolveCurrentConnectedFolderChatAuthority,
  reserve: reserveCurrentConnectedFolderChatAuthority,
};

type FlushOwner = Pick<ConnectedFolderChatTurnOptions, "deps" | "correlationId">;

function reportIndexFlushFailure(options: FlushOwner, error: unknown): void {
  emitServerDiagnostic(
    options.deps.diagnostics,
    serverDiagnosticFromError({
      correlationId: options.correlationId,
      operation: "folder.files.index-flush",
      source: "connected-folder-chat-turn",
      error,
      redact: () => "server-operation-failed",
    }),
  );
}

/**
 * The index work of the turn reaches the store once; a rejected save is reported, never dropped.
 * Never rejects: it runs detached from the answer, so nothing awaits it that could handle a throw.
 */
async function flushTurnIndex(index: TurnScopedWorkspaceIndex, options: FlushOwner): Promise<void> {
  try {
    await index.flush((cause) => {
      reportIndexFlushFailure(options, cause);
    });
  } catch (error) {
    reportIndexFlushFailure(options, error);
  }
}

interface TurnIndexFlusher {
  /** Starts a flush behind the previous one and returns at once. */
  readonly start: () => Promise<void>;
  readonly settled: () => Promise<void>;
}

/**
 * Sealing and syncing the turn's index takes seconds on a large folder, so the answer does not wait
 * for it. Flushes of one turn run one after another: a later one never lands before an earlier one
 * and so never leaves the older snapshot in the store.
 */
function createTurnIndexFlusher(
  index: TurnScopedWorkspaceIndex | undefined,
  options: FlushOwner,
): TurnIndexFlusher {
  let flushed: Promise<void> = Promise.resolve();
  return {
    start: (): Promise<void> => {
      if (index !== undefined) flushed = flushed.then(() => flushTurnIndex(index, options));
      return Promise.resolve();
    },
    settled: (): Promise<void> => flushed,
  };
}

/** A read-only tool turn on the one folder a person connected to the Chat. */
export class ConnectedFolderChatToolTurn extends LocalChatSourceToolTurn {
  public readonly connectedFolder: ConnectedFolderTurnReadout;
  constructor(options: ConnectedFolderChatTurnOptions) {
    const windows: ConnectedFolderToolWindow[] = [];
    const { scope, fs } = options.source;
    const base = options.deps.workspaceIndexForRoot?.(scope.workspace.root);
    const index = base === undefined ? undefined : createTurnScopedWorkspaceIndex(base);
    const flusher = createTurnIndexFlusher(index, options);
    super(options, {
      consumerPort: CONSUMER_PORT,
      owner: CONNECTED_FOLDER_CHAT_SOURCE_OWNER,
      context: {
        connectedFolder: {
          scope,
          fs,
          budget: createConnectedFolderToolBudget(CONNECTED_FOLDER_TOOL_TURN_LIMITS),
          workspaceIndex: index,
          recordWindow: (window): void => {
            windows.push(window);
          },
        },
      },
      turn: { finalizeTurn: flusher.start },
    });
    this.connectedFolder = {
      returnedWindows: (): readonly ConnectedFolderToolWindow[] => [...windows],
      indexFlushed: flusher.settled,
    };
  }
}

/** Why a folder-only Chat keeps the single retrieval; the first reason that applies. */
function oneShotReason(
  deps: Pick<UiHandlerDeps, "gatewayConfig" | "connectedFolderChatCatalog">,
  modelId: string,
): Exclude<ConnectedFolderTurnSelection, "tool-turn"> {
  if (!chatModelSupportsTools(deps, modelId)) return "one-shot-model-not-tool-ready";
  return deps.connectedFolderChatCatalog === undefined
    ? "one-shot-catalog-unavailable"
    : "one-shot-scope-unavailable";
}

/**
 * The tool turn of a Chat that is connected to exactly one folder and to nothing else. Every other
 * Chat, and a request that supplies no folder admission, gets none and leaves no record. A model
 * that is not ready for tools keeps the single retrieval: the folder is still answered from.
 */
export async function createConnectedFolderChatToolTurn(
  deps: UiHandlerDeps,
  modelId: string,
  message: ChatMessage,
  signal: AbortSignal,
  correlationId: string | undefined,
  admitSource: ConnectedFolderToolSourceAdmission | undefined,
): Promise<ConnectedFolderChatToolTurn | undefined> {
  const chat = deps.store.findChatById(message.chatId);
  if (admitSource === undefined || soleConnectedFolderScope(chat) === undefined) return undefined;
  const correlation = correlationIdOrUnknown(correlationId);
  const catalog = deps.connectedFolderChatCatalog;
  // The folder is admitted only for a turn that will run: a model that is not ready for tools, or
  // a missing catalog, costs no root admission.
  const source =
    catalog !== undefined && chatModelSupportsTools(deps, modelId) ? admitSource() : undefined;
  if (catalog === undefined || source === undefined) {
    logConnectedFolderTurnSelection(correlation, oneShotReason(deps, modelId));
    return undefined;
  }
  const managed = await catalog.get();
  // The authority is minted from the Chat as it is now, after the await. A folder admitted from an
  // earlier selection would be read under an authority for another one: no tool turn then.
  const current = connectedFolderConfigurationDigest(deps.store.findChatById(message.chatId));
  if (current !== source.configurationDigest) {
    logConnectedFolderTurnSelection(correlation, "one-shot-scope-unavailable");
    return undefined;
  }
  const bound = mintAndBoundChatTurn<ConnectedFolderChatTurnOptions["authority"]>(
    deps,
    modelId,
    message,
    correlation,
    (turn) => mintAcceptedConnectedFolderChatAuthority(deps, turn),
    [signal],
  );
  const turn = new ConnectedFolderChatToolTurn({
    deps,
    message,
    ...bound,
    managed,
    source,
    correlationId: correlation,
  });
  logConnectedFolderTurnSelection(correlation, "tool-turn");
  return turn;
}
