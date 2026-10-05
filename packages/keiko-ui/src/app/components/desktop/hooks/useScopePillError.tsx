import { useRef, useState, type ReactNode } from "react";
import type { Chat } from "@/lib/types";

interface ScopePillFailure {
  readonly chatId: string;
  readonly projectPath: string;
  readonly message: string | null;
}

// The group outlives a removed/re-keyed pill. Bind its notice to the chat that started the action.
export function useScopePillError(chat: Chat): {
  readonly error: string | null;
  readonly setError: (message: string | null) => void;
} {
  const [failure, setFailure] = useState<ScopePillFailure>();
  const current = useRef(chat);
  current.current = chat;
  const belongsToChat = failure?.chatId === chat.id && failure.projectPath === chat.projectPath;
  return {
    error: belongsToChat ? failure.message : null,
    setError(message): void {
      if (current.current.id !== chat.id || current.current.projectPath !== chat.projectPath)
        return;
      setFailure({ chatId: chat.id, projectPath: chat.projectPath, message });
    },
  };
}

export function ScopePillError({ error }: { readonly error: string | null }): ReactNode {
  return error === null ? null : (
    <span role="alert" className="scope-connect-error">
      {error}
    </span>
  );
}

export function emptyScopePill(
  announcement: string,
  announcer: ReactNode,
  error: string | null,
): ReactNode {
  if (announcement === "" && error === null) return null;
  return (
    <>
      {announcer}
      <ScopePillError error={error} />
    </>
  );
}
