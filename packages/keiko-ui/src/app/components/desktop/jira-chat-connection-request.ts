/** UI command only. The receiving form still submits the authenticated, optimistic-lock PATCH. */
export const JIRA_CHAT_CONNECTION_REQUEST_EVENT = "keiko:jira-chat-connection-request";

export interface JiraChatConnectionRequest {
  readonly chatWindowId: string;
  readonly chatId: string;
  readonly podId: string;
  readonly isCurrent: () => boolean;
  accept: () => boolean;
  settle: (accepted: boolean) => void;
}

class ConnectionRequest implements JiraChatConnectionRequest {
  received = false;
  constructor(
    readonly chatWindowId: string,
    readonly chatId: string,
    readonly podId: string,
    readonly isCurrent: () => boolean,
    readonly settle: (accepted: boolean) => void,
  ) {}
  accept(): boolean {
    if (this.received) return false;
    this.received = true;
    return true;
  }
}

export function requestJiraChatConnection(
  chatWindowId: string,
  chatId: string,
  podId: string,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  return new Promise((resolve) => {
    const detail = new ConnectionRequest(chatWindowId, chatId, podId, isCurrent, resolve);
    window.dispatchEvent(new CustomEvent(JIRA_CHAT_CONNECTION_REQUEST_EVENT, { detail }));
    if (!detail.received) resolve(false);
  });
}

export function connectionRequest(event: Event): JiraChatConnectionRequest | undefined {
  if (!(event instanceof CustomEvent)) return undefined;
  return event.detail instanceof ConnectionRequest ? event.detail : undefined;
}
